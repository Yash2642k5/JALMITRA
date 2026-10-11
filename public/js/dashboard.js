(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const EVENT_LABEL = {
    delivery_scheduled: 'Tanker scheduled · ward notified',
    token_created: 'Quota reserved',
    duplicate_attempt: 'Duplicate blocked',
    capacity_full: 'Refused — tanker fully booked',
    claim_rejected: 'Refused — no open delivery',
    claims_closed: 'Claims closed',
    delivery_completed: 'Delivery complete',
    dispense_start: 'Dispensing',
    dispense_done: 'Dispensed',
    validation_failed: 'Rejected',
  };

  let seenIds = new Set();
  let selectedWard = ''; // '' means all wards
  let latestState = null;
  let blockedOnly = false;
  let waitingOnly = false;

  const LOG_ROWS = 6;

  const fmtNum = (n) => Math.round(n).toLocaleString();
  const fmtTime = (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Axis ticks drop the AM/PM, and add seconds on a short shift so a burst of
  // deliveries inside one minute still reads as a sequence.
  const fmtTick = (iso, withSeconds) =>
    new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: withSeconds ? '2-digit' : undefined,
      hour12: false,
    });
  const initials = (name) =>
    (name || '?')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();

  // ---------- theme ------------------------------------------------------

  function setTheme(mode) {
    document.documentElement.dataset.theme = mode;
    try {
      localStorage.setItem('jm-theme', mode);
    } catch (err) {}
    document.querySelectorAll('[data-theme-set]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.dataset.themeSet === mode));
    });
    if (latestState) renderCharts(latestState);
  }

  document.querySelectorAll('[data-theme-set]').forEach(function (btn) {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeSet));
  });
  setTheme(document.documentElement.dataset.theme || 'dark');

  $('today').textContent = new Date().toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  // ---------- insight carousel ------------------------------------------

  let insights = [];
  let insightIdx = 0;

  function buildInsights(state) {
    const served = state.households.filter((h) => h.litresServed > 0).length;
    const blocked = state.totals.duplicateAttempts + state.totals.capacityRejections;
    const live = state.deliveries.filter((d) => d.status !== 'completed');
    const entitled = state.wards.reduce((s, w) => s + w.entitledLitres, 0);
    const coverage = entitled ? Math.round((state.totals.litresDispensed / entitled) * 100) : 0;
    const behind = state.wards
      .slice()
      .sort((a, b) => a.litresServed / (a.entitledLitres || 1) - b.litresServed / (b.entitledLitres || 1))[0];

    return [
      served
        ? served + ' of ' + state.totals.households + ' households have drawn their share today'
        : 'No household has drawn water yet this shift',
      live.length
        ? fmtNum(state.fleet.remainingLitres) +
          ' L still on the road across ' +
          live.length +
          (live.length === 1 ? ' ward' : ' wards')
        : 'No tanker is out right now — schedule one from dispatch',
      blocked
        ? blocked + (blocked === 1 ? ' claim' : ' claims') + ' blocked, so nobody drew twice'
        : 'Not one duplicate claim has got through today',
      behind
        ? behind.ward + ' is furthest behind at ' + coverage + '% of its entitlement'
        : 'Every ward is on its entitlement',
    ];
  }

  function paintInsight() {
    $('insightText').textContent = insights[insightIdx] || '';
    $('insightDots').innerHTML = insights
      .map(
        (_, i) =>
          '<button type="button" role="tab" aria-selected="' +
          (i === insightIdx) +
          '" data-i="' +
          i +
          '"><span class="sr-only">Insight ' +
          (i + 1) +
          '</span></button>'
      )
      .join('');
  }

  $('insightDots').addEventListener('click', function (ev) {
    const btn = ev.target.closest('button');
    if (!btn) return;
    insightIdx = Number(btn.dataset.i);
    paintInsight();
  });

  $('insightNext').addEventListener('click', function () {
    insightIdx = (insightIdx + 1) % Math.max(1, insights.length);
    paintInsight();
  });

  // ---------- flow chart: litres delivered across the shift --------------

  function flowSeries(state) {
    const done = state.events
      .filter((e) => e.type === 'dispense_done' && typeof e.litres === 'number')
      .filter((e) => !selectedWard || e.ward === selectedWard)
      .slice()
      .reverse(); // events arrive newest-first

    let total = 0;
    const pts = done.map(function (e) {
      total += e.litres;
      return { t: e.timestamp, v: total, who: e.householdName, litres: e.litres };
    });
    if (pts.length) pts.unshift({ t: pts[0].t, v: 0, who: null, litres: 0 });
    return pts;
  }

  function renderFlow(state) {
    const box = $('flowChart');
    const svg = box.querySelector('svg');
    const peak = box.querySelector('.peak');
    const pts = flowSeries(state);

    box.querySelectorAll('.mark').forEach((m) => m.remove());

    const W = 320;
    const H = 96;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.height = H + 'px';

    if (pts.length < 2) {
      svg.innerHTML =
        '<line x1="0" y1="' +
        (H - 10) +
        '" x2="' +
        W +
        '" y2="' +
        (H - 10) +
        '" stroke="var(--track)" stroke-width="2" stroke-dasharray="3 5" vector-effect="non-scaling-stroke"/>';
      peak.hidden = true;
      $('flowAxis').innerHTML = '<span>Waiting for the first delivery</span>';
      box._pts = null;
      return;
    }

    const max = Math.max.apply(null, pts.map((p) => p.v)) || 1;
    const x = (i) => (i / (pts.length - 1)) * W;
    const y = (v) => H - 8 - (v / max) * (H - 20);

    // Catmull-Rom style smoothing, clamped so the line never dips below zero.
    let d = 'M ' + x(0) + ' ' + y(pts[0].v);
    for (let i = 1; i < pts.length; i++) {
      const cx = (x(i - 1) + x(i)) / 2;
      d += ' C ' + cx + ' ' + y(pts[i - 1].v) + ', ' + cx + ' ' + y(pts[i].v) + ', ' + x(i) + ' ' + y(pts[i].v);
    }

    svg.innerHTML =
      '<defs>' +
      '<linearGradient id="flowFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.34"/>' +
      '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path d="' + d + ' L ' + W + ' ' + H + ' L 0 ' + H + ' Z" fill="url(#flowFill)"/>' +
      '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>';

    // Markers live in HTML so they stay round under the non-uniform scale.
    const last = pts.length - 1;
    [Math.max(1, Math.round(last * 0.62)), last].forEach(function (i) {
      const m = document.createElement('span');
      m.className = 'mark';
      m.style.left = (x(i) / W) * 100 + '%';
      m.style.top = (y(pts[i].v) / H) * 100 + '%';
      box.appendChild(m);
    });

    // The newest point always sits on the right edge, so the label hangs back
    // inside the card rather than over its border.
    peak.hidden = false;
    peak.classList.add('end');
    peak.textContent = '+' + fmtNum(pts[last].litres) + ' L';
    peak.style.left = (x(last) / W) * 100 + '%';
    peak.style.top = (y(pts[last].v) / H) * 100 + '%';

    // Time axis: deduped ticks (a busy minute would otherwise repeat itself),
    // with the last two marked as the live window.
    const span = new Date(pts[last].t) - new Date(pts[0].t);
    const seconds = span < 10 * 60000;
    const maxTicks = seconds ? 5 : 7;
    const step = Math.max(1, Math.ceil((pts.length - 1) / maxTicks));
    const ticks = [];
    for (let i = 1; i < pts.length; i += step) ticks.push(pts[i]);
    if (ticks[ticks.length - 1] !== pts[last]) ticks.push(pts[last]);
    const labels = [];
    ticks.forEach(function (p) {
      const label = fmtTick(p.t, seconds);
      if (!labels.length || labels[labels.length - 1] !== label) labels.push(label);
    });
    const liveFrom = Math.max(0, labels.length - 2);
    $('flowAxis').innerHTML = labels
      .map((l, i) => '<span class="' + (i >= liveFrom ? 'on' : '') + '">' + l + '</span>')
      .join('');

    box._pts = { pts: pts, x: x, y: y, W: W, H: H };
  }

  (function wireFlowHover() {
    const box = $('flowChart');
    const tip = box.querySelector('.tip');

    box.addEventListener('mousemove', function (ev) {
      const data = box._pts;
      if (!data) return;
      const r = box.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const i = Math.round(frac * (data.pts.length - 1));
      const p = data.pts[i];
      tip.innerHTML =
        '<b>' + fmtNum(p.v) + ' L delivered</b><span>' +
        (p.who ? p.who + ' · ' + fmtNum(p.litres) + ' L · ' : '') +
        fmtTime(p.t) + '</span>';
      const topPct = (data.y(p.v) / data.H) * 100;
      tip.style.left = (data.x(i) / data.W) * 100 + '%';
      tip.style.top = topPct + '%';
      // High on the plot there is no room above the point, so drop it below.
      tip.classList.toggle('below', topPct < 45);
      tip.classList.add('show');
    });

    box.addEventListener('mouseleave', () => tip.classList.remove('show'));
  })();

  // ---------- gauge: share of water still on board -----------------------

  function renderGauge(fleet) {
    const svg = $('gauge').querySelector('svg');
    const pct = Math.max(0, Math.min(100, fleet.fillPercent));
    const track = 'M 26 118 A 94 94 0 0 1 214 118';

    svg.innerHTML =
      '<defs>' +
      '<linearGradient id="gaugeArc" x1="0" y1="1" x2="1" y2="0">' +
      '<stop offset="0%" stop-color="#2748c9"/>' +
      '<stop offset="55%" stop-color="var(--accent)"/>' +
      '<stop offset="100%" stop-color="var(--accent-2)"/>' +
      '</linearGradient></defs>' +
      '<path d="' + track + '" fill="none" stroke="var(--track)" stroke-width="22" stroke-linecap="round"/>' +
      '<path d="' + track + '" fill="none" stroke="url(#gaugeArc)" stroke-width="22" ' +
      'stroke-linecap="round" pathLength="100" stroke-dasharray="' + pct + ' 100" ' +
      'style="transition:stroke-dasharray .6s ease"/>';

    $('fillPct').textContent = pct.toFixed(pct % 1 ? 1 : 0);
  }

  // ---------- ward bars --------------------------------------------------

  function renderWards(wards) {
    const rows = wards.map(function (w) {
      const pct = w.entitledLitres ? (w.litresServed / w.entitledLitres) * 100 : 0;
      return { ward: w.ward, pct: pct, w: w };
    });
    const max = Math.max(1, ...rows.map((r) => r.pct));
    const leadPct = Math.max.apply(null, rows.map((r) => r.pct));

    $('wardBars').innerHTML = rows
      .map(function (r) {
        const h = Math.max(14, (r.pct / max) * 100);
        return (
          '<button type="button" class="bar' +
          (r.pct === leadPct && r.pct > 0 ? ' lead' : '') +
          (selectedWard === r.ward ? ' lead' : '') +
          '" data-ward="' +
          r.ward +
          '" style="height:' +
          h +
          '%"><span class="num">' +
          Math.round(r.pct) +
          '%</span></button>'
        );
      })
      .join('');

    $('wardLabels').innerHTML = rows.map((r) => '<span>' + r.ward + '</span>').join('');

    const totalServed = wards.reduce((s, w) => s + w.litresServed, 0);
    const totalEntitled = wards.reduce((s, w) => s + w.entitledLitres, 0);
    $('wardsLitres').textContent = fmtNum(totalServed);
    const cov = totalEntitled ? Math.round((totalServed / totalEntitled) * 100) : 0;
    $('wardsDelta').querySelector('span').textContent = cov + '%';

    $('wardBars')._rows = rows;
  }

  (function wireBarHover() {
    const box = $('wardBars').closest('.chart');
    const tip = box.querySelector('.tip');

    $('wardBars').addEventListener('mousemove', function (ev) {
      const bar = ev.target.closest('.bar');
      if (!bar) return;
      const rows = $('wardBars')._rows || [];
      const r = rows.find((row) => row.ward === bar.dataset.ward);
      if (!r) return;
      tip.innerHTML =
        '<b>' + fmtNum(r.w.litresServed) + ' L of ' + fmtNum(r.w.entitledLitres) + ' L</b>' +
        '<span>' + r.w.served + ' of ' + r.w.households + ' households · ' + r.w.people + ' people</span>';
      const br = bar.getBoundingClientRect();
      const pr = box.getBoundingClientRect();
      tip.style.left = br.left - pr.left + br.width / 2 + 'px';
      tip.style.top = br.top - pr.top + 'px';
      tip.classList.add('show');
    });

    $('wardBars').addEventListener('mouseleave', () => tip.classList.remove('show'));

    $('wardBars').addEventListener('click', function (ev) {
      const bar = ev.target.closest('.bar');
      if (!bar) return;
      selectWard(bar.dataset.ward === selectedWard ? '' : bar.dataset.ward);
    });
  })();

  // ---------- deliveries -------------------------------------------------

  function renderDeliveries(list) {
    const live = list.filter(
      (d) => d.status !== 'completed' && (!selectedWard || d.ward === selectedWard)
    );
    const box = $('deliveryBox');

    if (!live.length) {
      box.innerHTML =
        '<p class="hint">No tanker is scheduled' +
        (selectedWard ? ' for ' + selectedWard : '') +
        '. Residents cannot claim until dispatch schedules one.</p>';
      return;
    }

    box.innerHTML = live
      .map(function (d) {
        const reservedPct = Math.min(100, (d.reservedLitres / d.capacityLitres) * 100);
        const servedPct = Math.min(100, (d.dispensedLitres / d.capacityLitres) * 100);
        return (
          '<div class="dlv"><div class="dlv-head"><span>' +
          d.ward +
          '</span><span class="tag ' +
          d.status +
          '">' +
          d.status +
          '</span></div>' +
          '<div class="stack"><span class="served" style="width:' +
          servedPct +
          '%"></span><span class="booked" style="width:' +
          Math.max(0, reservedPct - servedPct) +
          '%"></span></div><small>' +
          fmtNum(d.dispensedLitres) +
          ' L delivered · ' +
          fmtNum(d.reservedLitres - d.dispensedLitres) +
          ' L booked · ' +
          fmtNum(d.unreservedLitres) +
          ' L unclaimed · ' +
          d.claimCount +
          '/' +
          d.householdsInWard +
          ' households</small></div>'
        );
      })
      .join('');
  }

  // ---------- register ---------------------------------------------------

  function renderRegister(state) {
    const perPerson = state.config.litresPerPerson;
    let rows = state.households.filter((h) => !selectedWard || h.ward === selectedWard);
    const scope = rows;
    if (waitingOnly) rows = rows.filter((h) => h.litresServed <= 0);

    const people = scope.reduce((sum, h) => sum + h.registeredMembers, 0);
    const served = scope.reduce((sum, h) => sum + h.litresServed, 0);
    $('registerSummary').textContent =
      (selectedWard || 'All wards') +
      ' · ' +
      scope.length +
      ' households · ' +
      people +
      ' people · entitled ' +
      (people * perPerson).toLocaleString() +
      ' L · served ' +
      fmtNum(served) +
      ' L' +
      (waitingOnly ? ' · showing those still waiting' : '');

    $('registerBody').innerHTML = rows.length
      ? rows
          .map(function (h) {
            const status = h.tokenStatus
              ? '<span class="tag ' + h.tokenStatus + '">' + h.tokenStatus + '</span>'
              : '<span class="tag">waiting</span>';
            return (
              '<tr><td class="num">' +
              (h.houseNo || '—') +
              '</td><td><strong>' +
              h.name +
              '</strong>' +
              (selectedWard ? '' : '<br><span class="log-meta">' + h.ward + '</span>') +
              '</td><td class="r num">' +
              h.registeredMembers +
              '</td><td class="r num">' +
              h.registeredMembers * perPerson +
              ' L</td><td class="r num' +
              (h.litresServed > 0 ? ' got' : '') +
              '">' +
              fmtNum(h.litresServed) +
              ' L</td><td>' +
              status +
              '</td></tr>'
            );
          })
          .join('')
      : '<tr><td colspan="6"><p class="hint" style="padding:14px 0">Every household here has been served.</p></td></tr>';
  }

  // ---------- audit log --------------------------------------------------

  function isBlocked(ev) {
    return (
      ev.type === 'duplicate_attempt' ||
      ev.type === 'capacity_full' ||
      ev.type === 'claim_rejected' ||
      ev.type === 'validation_failed'
    );
  }

  function rowHtml(ev, fresh) {
    const dup = ev.type === 'duplicate_attempt';
    const classes = ['log-row'];
    if (dup) classes.push('dup');
    if (fresh) classes.push('fresh');

    const statusKey = dup
      ? 'duplicate'
      : ev.type === 'validation_failed' || ev.type === 'claim_rejected' || ev.type === 'capacity_full'
        ? 'rejected'
        : ev.status || 'reserved';

    const name = ev.householdName || 'Unknown household';
    const litres =
      ev.litres !== null && ev.litres !== undefined ? fmtNum(ev.litres) + ' L' : '—';
    // The note only earns its place when something went wrong; routine notes
    // just repeat what the event label already says.
    const note = ev.note && (dup || isBlocked(ev) || ev.note.indexOf('FLAGGED') === 0)
      ? ' · ' + ev.note
      : '';

    return (
      '<div class="' + classes.join(' ') + '">' +
      '<div class="log-who"><span class="log-avatar' + (dup ? ' dup' : '') + '">' +
      (dup ? '!' : initials(name)) +
      '</span><span style="min-width:0"><b>' + name + '</b>' +
      '<span class="log-meta">' + (EVENT_LABEL[ev.type] || ev.type) + '</span></span></div>' +
      '<div class="log-meta">' + (ev.ward || '—') + note + '</div>' +
      '<div class="log-time num">' + fmtTime(ev.timestamp) + '</div>' +
      '<div class="log-litres num' +
      (statusKey === 'dispensed' || statusKey === 'served' ? ' up' : dup ? '' : ' off') +
      '">' + litres + '</div>' +
      '</div>'
    );
  }

  const inScope = (ev) =>
    (!selectedWard || ev.ward === selectedWard) && (!blockedOnly || isBlocked(ev));

  function renderLog(events) {
    seenIds = new Set(events.map((e) => e.id));
    const rows = events.filter(inScope).slice(0, LOG_ROWS);
    $('logBody').innerHTML = rows.length
      ? rows.map((e) => rowHtml(e, false)).join('')
      : '<p class="hint" style="padding:18px 10px">Nothing logged' +
        (selectedWard ? ' in ' + selectedWard : '') +
        (blockedOnly ? ' — no claim has been blocked' : ' yet') +
        '.</p>';
  }

  function prependEvent(ev) {
    if (!ev || seenIds.has(ev.id)) return;
    seenIds.add(ev.id);
    if (!inScope(ev)) return;
    const body = $('logBody');
    if (body.querySelector('.hint')) body.innerHTML = '';
    body.insertAdjacentHTML('afterbegin', rowHtml(ev, true));
    while (body.children.length > LOG_ROWS) body.lastElementChild.remove();
  }

  // ---------- top figures ------------------------------------------------

  function renderFigures(state) {
    const fleet = state.fleet;
    $('remaining').textContent = fmtNum(fleet.remainingLitres);
    $('dispensed').textContent = fmtNum(state.totals.litresDispensed);
    $('servedCount').textContent = state.households.filter((h) => h.litresServed > 0).length;
    $('pillTokens').textContent = state.totals.tokensIssued;
    $('pillWards').textContent = state.deliveries.filter((d) => d.status !== 'completed').length;

    const onRoad = fleet.capacityLitres
      ? Math.round((fleet.remainingLitres / fleet.capacityLitres) * 100)
      : 0;
    const delta = $('roadDelta');
    delta.querySelector('span').textContent = onRoad + '%';
    delta.className = 'delta ' + (onRoad >= 50 ? 'up' : 'down');
    delta.querySelector('use').setAttribute('href', onRoad >= 50 ? '#i-up' : '#i-down');

    $('navDeliveries').textContent = state.deliveries.filter((d) => d.status !== 'completed').length;
    $('navWards').textContent = state.wards.length;
    $('navHouses').textContent = state.totals.households;
    $('navEvents').textContent = state.events.length;
  }

  function renderCharts(state) {
    renderGauge(state.fleet);
    renderFlow(state);
  }

  function renderAll(state) {
    latestState = state;

    const picker = $('wardPicker');
    if (picker.options.length <= 1) {
      state.wardNames.forEach(function (w) {
        const opt = document.createElement('option');
        opt.value = w;
        opt.textContent = w;
        picker.appendChild(opt);
      });
    }

    renderFigures(state);
    renderCharts(state);
    renderDeliveries(state.deliveries);
    renderWards(state.wards);
    renderRegister(state);
    renderLog(state.events);

    insights = buildInsights(state);
    if (insightIdx >= insights.length) insightIdx = 0;
    paintInsight();
  }

  // ---------- AWS strip --------------------------------------------------

  function renderAws(status) {
    $('awsRegion').textContent = status.region;
    $('awsList').innerHTML = status.services
      .map(
        (s) =>
          '<span class="aws-svc' + (s.on ? ' on' : '') + '" title="' + s.role + '"><i></i>' +
          s.name + '</span>'
      )
      .join('');
    $('awsNote').textContent = status.services.every((s) => !s.on)
      ? 'Offline mode — fill .env to connect'
      : status.credentials;
  }

  fetch('/api/aws/status')
    .then((r) => r.json())
    .then(renderAws)
    .catch(() => {
      $('awsNote').textContent = 'Service status unavailable';
    });

  // ---------- live + alert strips ---------------------------------------

  function showLive(s) {
    $('liveStrip').classList.add('show');
    $('lsWho').textContent = s.householdName;
    $('lsLitres').textContent = s.litresServed.toFixed(1) + ' / ' + s.quotaLitres + ' L';
    $('lsBar').style.width = (s.litresServed / s.quotaLitres) * 100 + '%';
  }

  let bannerTimer = null;

  function flagDuplicate(payload) {
    const banner = $('dupBanner');
    $('dupText').textContent =
      'Blocked — ' +
      (payload.household ? payload.household.name : 'Unknown household') +
      ' already holds a token this shift (PIN ' +
      (payload.token ? payload.token.pin : '----') +
      ', ' +
      (payload.token ? payload.token.status : '') +
      ')';
    banner.classList.remove('show');
    void banner.offsetWidth; // restart the nudge
    banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove('show'), 12000);
  }

  // ---------- data -------------------------------------------------------

  function refresh() {
    return fetch('/api/dashboard/state')
      .then((r) => r.json())
      .then(renderAll);
  }

  let lastRefresh = 0;
  function throttledRefresh() {
    const now = Date.now();
    if (now - lastRefresh < 400) return;
    lastRefresh = now;
    refresh();
  }

  window.JalMitra.connect(
    {
      snapshot: renderAll,
      demo_reset: function (state) {
        $('liveStrip').classList.remove('show');
        $('dupBanner').classList.remove('show');
        renderAll(state);
      },
      token_created: function (p) {
        prependEvent(p.event);
        refresh();
      },
      duplicate_attempt: function (p) {
        prependEvent(p.event);
        flagDuplicate(p);
        refresh();
      },
      delivery_scheduled: function (p) {
        prependEvent(p.event);
        refresh();
      },
      claims_closed: function (p) {
        prependEvent(p.event);
        refresh();
      },
      delivery_completed: function (p) {
        prependEvent(p.event);
        refresh();
      },
      capacity_full: function (p) {
        prependEvent(p.event);
        refresh();
      },
      claim_rejected: function (p) {
        prependEvent(p.event);
        refresh();
      },
      dispense_start: showLive,
      dispense_progress: function (s) {
        showLive(s);
        throttledRefresh(); // keeps the gauge falling in step
      },
      dispense_done: function () {
        setTimeout(() => $('liveStrip').classList.remove('show'), 2500);
        refresh();
      },
      validation_failed: refresh,
    },
    $('status')
  );

  // ---------- controls ---------------------------------------------------

  function selectWard(ward) {
    selectedWard = ward;
    $('wardPicker').value = ward;
    if (latestState) renderAll(latestState);
  }

  $('wardPicker').addEventListener('change', function () {
    selectWard(this.value);
  });

  $('resetBtn').addEventListener('click', function () {
    window.JalMitra.post('/api/demo/reset');
  });

  $('dupOnly').addEventListener('click', function () {
    blockedOnly = !blockedOnly;
    this.classList.toggle('on', blockedOnly);
    this.setAttribute(
      'aria-label',
      blockedOnly ? 'Show every claim' : 'Show blocked claims only'
    );
    if (latestState) renderLog(latestState.events);
  });

  $('unservedOnly').addEventListener('click', function () {
    waitingOnly = !waitingOnly;
    this.classList.toggle('on', waitingOnly);
    this.setAttribute(
      'aria-label',
      waitingOnly ? 'Show every household' : 'Show households still waiting'
    );
    if (latestState) renderRegister(latestState);
  });

  window.addEventListener('resize', function () {
    if (latestState) renderFlow(latestState);
  });

  refresh();
  setInterval(refresh, 10000); // safety net if a WS event is missed
})();

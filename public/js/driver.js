(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const screens = {
    scan: $('screenScan'),
    confirm: $('screenConfirm'),
    dispense: $('screenDispense'),
    done: $('screenDone'),
  };

  let current = null; // { token, household }
  let sessionId = null;
  let scanner = null;
  let scanning = false;

  function show(name) {
    Object.keys(screens).forEach((k) => screens[k].classList.toggle('active', k === name));
  }

  function err(message) {
    const box = $('scanErr');
    box.textContent = message;
    box.classList.add('show');
    clearTimeout(err.timer);
    err.timer = setTimeout(() => box.classList.remove('show'), 6000);
  }

  function setTank(fillPercent, remaining, label) {
    const chip = $('tankChip');
    chip.querySelector('span:last-child').textContent =
      (label ? label + ' · ' : '') + fillPercent + '% · ' + Math.round(remaining) + 'L';
    chip.querySelector('.dot').className = 'dot ' + (fillPercent > 10 ? 'live' : 'down');
  }

  /** Which deliveries this tanker could be serving right now. */
  function renderActive(state) {
    const live = (state.deliveries || []).filter((d) => d.status !== 'completed');
    const box = $('serving');
    if (!live.length) {
      box.textContent = 'No delivery scheduled. Ask the coordinator to schedule one.';
      setTank(0, 0, 'No tanker');
      return;
    }
    box.textContent =
      'Now serving: ' +
      live
        .map((d) => d.ward + ' (' + Math.round(d.remainingLitres) + 'L of ' + d.capacityLitres + 'L)')
        .join(' · ');
    const first = live[0];
    setTank(first.fillPercent, first.remainingLitres, first.ward);
  }

  // --- validation -------------------------------------------------------

  function validate(code) {
    return window.JalMitra.post('/api/token/validate', { code: code }).then(function (res) {
      if (!res.data.ok) {
        err(res.data.message || 'Invalid code.');
        return false;
      }
      current = res.data;
      $('cName').textContent = res.data.household.name;
      $('cMeta').textContent =
        res.data.household.ward +
        ' · ' +
        res.data.household.registeredMembers +
        ' members · PIN ' +
        res.data.token.pin;
      $('cLitres').textContent = res.data.token.quotaLitres;

      const flag = $('cFlag');
      if (res.data.token.flagged) {
        flag.textContent = '⚠ Flagged: ' + res.data.token.flagNote;
        flag.style.display = 'block';
      } else {
        flag.style.display = 'none';
      }

      const d = res.data.delivery;
      if (d) {
        setTank(d.fillPercent, d.remainingLitres, d.ward);
        $('cMeta').textContent += ' · ' + d.ward + ' tanker';
      }
      stopCamera();
      show('confirm');
      return true;
    });
  }

  // --- camera QR scanning ----------------------------------------------

  function startCamera() {
    if (typeof Html5Qrcode === 'undefined') {
      $('camMsg').textContent = 'QR library unavailable offline — use the PIN pad below.';
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('camMsg').textContent = 'Camera needs HTTPS or localhost — use the PIN pad below.';
      return;
    }

    scanner = scanner || new Html5Qrcode('reader', { verbose: false });
    scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        function onDecoded(text) {
          if (!scanning) return;
          scanning = false;
          validate(text).then(function (ok) {
            if (!ok) scanning = true;
          });
        },
        function () {
          /* per-frame decode misses are normal */
        }
      )
      .then(function () {
        scanning = true;
        $('camToggle').textContent = 'Stop camera';
        const frame = document.createElement('div');
        frame.className = 'scan-frame';
        $('reader').appendChild(frame);
      })
      .catch(function (e) {
        $('camMsg').textContent = 'Camera blocked (' + e + '). Use the PIN pad below.';
      });
  }

  function stopCamera() {
    scanning = false;
    $('camToggle').textContent = 'Start camera';
    const frame = document.querySelector('.scan-frame');
    if (frame) frame.remove();
    // html5-qrcode throws synchronously if it was never actually running,
    // which must not block the handover to the confirm screen.
    try {
      if (scanner) scanner.stop().catch(function () {});
    } catch (e) {
      /* camera was not running */
    }
  }

  $('camToggle').addEventListener('click', function () {
    if (scanning) stopCamera();
    else startCamera();
  });

  // --- PIN pad ----------------------------------------------------------

  const pin = $('pin');

  $('keypad').addEventListener('click', function (ev) {
    const key = ev.target.dataset.k;
    if (!key) return;
    if (key === 'clear') pin.value = '';
    else if (key === 'del') pin.value = pin.value.slice(0, -1);
    else if (pin.value.length < 4) pin.value += key;

    if (pin.value.length === 4) validate(pin.value).then(() => (pin.value = ''));
  });

  pin.addEventListener('input', function () {
    pin.value = pin.value.replace(/\D/g, '').slice(0, 4);
    if (pin.value.length === 4) validate(pin.value).then(() => (pin.value = ''));
  });

  pin.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && pin.value.length === 4) validate(pin.value).then(() => (pin.value = ''));
  });

  $('checkBtn').addEventListener('click', function () {
    validate(pin.value).then(() => (pin.value = ''));
  });

  // --- dispense ---------------------------------------------------------

  $('backBtn').addEventListener('click', function () {
    current = null;
    show('scan');
  });

  $('startBtn').addEventListener('click', function () {
    if (!current) return;
    $('startBtn').disabled = true;

    window.JalMitra
      .post('/api/dispense/start', { code: current.token.id })
      .then(function (res) {
        $('startBtn').disabled = false;
        if (!res.data.ok) {
          err(res.data.message || 'Could not start.');
          show('scan');
          return;
        }
        const s = res.data.session;
        sessionId = s.sessionId;
        $('dName').textContent = s.householdName;
        $('dMeta').textContent = (s.ward || '') + ' · session ' + s.sessionId;
        $('dQuota').textContent = s.quotaLitres;
        $('dServed').textContent = '0';
        $('dLeft').textContent = s.quotaLitres;
        $('dBar').style.width = '0%';
        show('dispense');
      });
  });

  $('stopBtn').addEventListener('click', function () {
    if (!sessionId) return;
    window.JalMitra.post('/api/dispense/stop', { sessionId: sessionId });
  });

  $('nextBtn').addEventListener('click', function () {
    current = null;
    sessionId = null;
    show('scan');
  });

  // --- live updates -----------------------------------------------------

  window.JalMitra.connect(
    {
      snapshot: renderActive,
      delivery_scheduled: refreshActive,
      claims_closed: refreshActive,
      delivery_completed: refreshActive,
      dispense_progress: function (s) {
        if (s.sessionId !== sessionId) return;
        $('dServed').textContent = s.litresServed.toFixed(1);
        $('dLeft').textContent = s.remainingLitres.toFixed(1);
        $('dBar').style.width = (s.litresServed / s.quotaLitres) * 100 + '%';
        setTank(s.tankerFillPercent, s.tankerRemaining, s.ward);
      },
      dispense_done: function (s) {
        setTank(s.tankerFillPercent, s.tankerRemaining, s.ward);
        refreshActive();
        if (s.sessionId !== sessionId) return;
        const early = s.status !== 'completed';
        $('doneMark').textContent = early ? '!' : '✓';
        $('doneTitle').textContent = early ? 'Stopped early' : 'Dispense complete';
        $('doneMeta').textContent =
          s.householdName + ' · ' + (s.note || 'Token locked, cannot be reused');
        $('doneLitres').textContent = s.litresServed.toFixed(1);
        $('dBar').style.width = (s.litresServed / s.quotaLitres) * 100 + '%';
        show('done');
      },
      demo_reset: function (state) {
        current = null;
        sessionId = null;
        renderActive(state);
        show('scan');
      },
    },
    $('status')
  );

  function refreshActive() {
    return fetch('/api/dashboard/state')
      .then((r) => r.json())
      .then(renderActive);
  }

  refreshActive();
  startCamera();
  pin.focus();
})();

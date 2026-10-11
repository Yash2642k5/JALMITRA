(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let defaults = { litresPerPerson: 40 };
  let wardInfo = {};

  const clock = (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function countdown(ms) {
    if (ms <= 0) return 'closed';
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return mins + 'm ' + String(secs).padStart(2, '0') + 's';
  }

  function showErr(message) {
    const box = $('formErr');
    box.textContent = message;
    box.classList.add('show');
    clearTimeout(showErr.t);
    showErr.t = setTimeout(() => box.classList.remove('show'), 7000);
  }

  // --- broadcast preview -------------------------------------------------

  function renderPreview() {
    const ward = $('ward').value;
    const capacity = Number($('capacity').value) || 0;
    const arriveIn = Number($('arrivalIn').value) || 0;
    const windowMin = Number($('windowMin').value) || 0;
    const claimMin = Math.min(Number($('claimMin').value) || 0, arriveIn);

    const from = new Date(Date.now() + arriveIn * 60000);
    const to = new Date(from.getTime() + windowMin * 60000);
    const deadline = new Date(Date.now() + claimMin * 60000);

    const info = wardInfo[ward];
    const demand = info ? info.members * defaults.litresPerPerson : null;

    $('previewText').textContent =
      'Jal-Mitra: Tanker arriving in ' +
      ward +
      ' between ' +
      clock(from) +
      ' and ' +
      clock(to) +
      '. Reply WATER <family size> by ' +
      clock(deadline) +
      ' to reserve your quota. Tanker load ' +
      capacity +
      'L — first claims are served until it is fully booked.';

    const note = $('preview').querySelector('small');
    if (info) {
      const verdict =
        demand > capacity
          ? '⚠ ' + info.households + ' households need ~' + demand + 'L — tanker is short by ' + (demand - capacity) + 'L'
          : '✓ ' + info.households + ' households need ~' + demand + 'L — tanker covers the ward';
      note.textContent = 'Broadcast preview · ' + verdict;
      note.style.color = demand > capacity ? 'var(--amber)' : 'var(--green)';
    } else {
      note.textContent = 'Broadcast preview';
      note.style.color = '';
    }
  }

  ['ward', 'capacity', 'arrivalIn', 'windowMin', 'claimMin'].forEach((id) =>
    $(id).addEventListener('input', renderPreview)
  );

  // --- deliveries list ---------------------------------------------------

  function deliveryCard(d) {
    const reservedPct = Math.min(100, (d.reservedLitres / d.capacityLitres) * 100);
    const dispensedPct = Math.min(100, (d.dispensedLitres / d.capacityLitres) * 100);

    const actions =
      d.status === 'claiming'
        ? '<button class="btn" data-close="' + d.id + '">Close claims early</button>'
        : d.status === 'closed'
          ? '<button class="btn" data-complete="' + d.id + '">Mark delivery complete</button>'
          : '';

    const deadline =
      d.status === 'claiming'
        ? '<span class="chip"><span class="dot live"></span><span>Claims close in ' +
          countdown(d.msToDeadline) +
          '</span></span>'
        : '<span class="chip"><span class="dot"></span><span>' + (d.closedReason || d.status) + '</span></span>';

    return (
      '<article class="delivery">' +
      '<header><div><b>' +
      d.ward +
      '</b><small>' +
      d.tankerId +
      ' · arrives ' +
      clock(d.arrivalFrom) +
      '-' +
      clock(d.arrivalTo) +
      '</small></div><span class="tag ' +
      d.status +
      '">' +
      d.status +
      '</span></header>' +
      '<div class="stack-bar"><span class="served" style="width:' +
      dispensedPct +
      '%"></span><span class="booked" style="width:' +
      (reservedPct - dispensedPct) +
      '%"></span></div>' +
      '<div class="legend"><span><i class="sw served"></i>' +
      Math.round(d.dispensedLitres) +
      'L delivered</span><span><i class="sw booked"></i>' +
      (d.reservedLitres - d.dispensedLitres) +
      'L booked</span><span><i class="sw free"></i>' +
      d.unreservedLitres +
      'L unclaimed</span></div>' +
      '<footer><span class="hint">' +
      d.claimCount +
      ' of ' +
      d.householdsInWard +
      ' households claimed · ' +
      d.capacityLitres +
      'L load</span>' +
      deadline +
      actions +
      '</footer>' +
      '</article>'
    );
  }

  function renderDeliveries(list) {
    const box = $('deliveries');
    if (!list.length) {
      box.innerHTML = '<p class="hint">No deliveries scheduled yet.</p>';
      return;
    }
    box.innerHTML = list.map(deliveryCard).join('');
  }

  function refresh() {
    return fetch('/api/deliveries')
      .then((r) => r.json())
      .then(function (data) {
        defaults = data.defaults;
        $('coordLabel').textContent = data.coordinatorLabel;
        if (!$('ward').options.length) {
          data.wardNames.forEach(function (w) {
            const opt = document.createElement('option');
            opt.value = w;
            opt.textContent = w;
            $('ward').appendChild(opt);
          });
          $('capacity').value = data.defaults.capacityLitres;
          // Claims should close before the tanker rolls, never exactly on arrival.
          const arriveIn = Number($('arrivalIn').value);
          $('claimMin').value = Math.max(5, Math.min(data.defaults.claimMinutes, arriveIn - 15));
        }
        renderDeliveries(data.deliveries);
        renderPreview();
      });
  }

  // Ward demand figures, so the coordinator can size the tanker.
  fetch('/api/demo/households')
    .then((r) => r.json())
    .then(function (data) {
      data.households.forEach(function (h) {
        wardInfo[h.ward] = wardInfo[h.ward] || { households: 0, members: 0 };
        wardInfo[h.ward].households += 1;
        wardInfo[h.ward].members += h.registeredMembers;
      });
      renderPreview();
    });

  // --- actions -----------------------------------------------------------

  $('scheduleForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    window.JalMitra
      .post('/api/delivery/schedule', {
        ward: $('ward').value,
        capacityLitres: Number($('capacity').value),
        arrivalInMinutes: Number($('arrivalIn').value),
        windowMinutes: Number($('windowMin').value),
        claimMinutes: Number($('claimMin').value),
      })
      .then(function (res) {
        if (!res.data.ok) return showErr(res.data.message || 'Could not schedule.');
        refresh();
      });
  });

  $('deliveries').addEventListener('click', function (ev) {
    const close = ev.target.dataset.close;
    const complete = ev.target.dataset.complete;
    if (close) {
      window.JalMitra.post('/api/delivery/close', { deliveryId: close }).then(refresh);
    } else if (complete) {
      window.JalMitra.post('/api/delivery/complete', { deliveryId: complete }).then(refresh);
    }
  });

  window.JalMitra.connect(
    {
      '*': function (_payload, msg) {
        if (msg.type === 'snapshot') return;
        refresh();
      },
    },
    $('status')
  );

  refresh();
  setInterval(refresh, 1000); // keeps the claim countdown ticking
})();

(function () {
  'use strict';

  const chat = document.getElementById('chat');
  const form = document.getElementById('sendForm');
  const input = document.getElementById('msg');
  const sender = document.getElementById('sender');
  const senderInfo = document.getElementById('senderInfo');
  const wardState = document.getElementById('wardState');
  const resetBtn = document.getElementById('resetBtn');

  let households = [];

  function bubble(kind, text, extraClass) {
    const el = document.createElement('div');
    el.className = 'bubble ' + kind + (extraClass ? ' ' + extraClass : '');
    const body = document.createElement('div');
    body.textContent = text;
    el.appendChild(body);
    const time = document.createElement('time');
    time.textContent = window.JalMitra.clock();
    el.appendChild(time);
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }

  const currentHousehold = () => households.find((h) => h.phone === sender.value) || null;

  function refreshWardState() {
    const h = currentHousehold();
    if (!h) return;
    fetch('/api/resident/inbox?phone=' + encodeURIComponent(h.phone))
      .then((r) => r.json())
      .then(function (data) {
        wardState.textContent = data.delivery
          ? h.ward + ' · tanker ' + data.delivery.status + ' · ' + data.delivery.unreservedLitres + 'L unclaimed'
          : 'No tanker scheduled for ' + h.ward + ' yet.';
      });
  }

  // --- inbox: what this household should be looking at right now ---------

  function loadInbox() {
    const h = currentHousehold();
    senderInfo.textContent = h
      ? h.ward + ' · ' + h.registeredMembers + ' members on record · +91 ' + h.phone
      : 'Not registered with Jal-Mitra.';

    chat.innerHTML = '';
    if (!h) {
      wardState.textContent = 'Unregistered number.';
      bubble('in', 'Welcome to Jal-Mitra. This number is not registered — a reply will explain how to register.');
      return;
    }

    fetch('/api/resident/inbox?phone=' + encodeURIComponent(h.phone))
      .then((r) => r.json())
      .then(function (data) {
        if (!data.delivery) {
          wardState.textContent = 'No tanker scheduled for ' + h.ward + ' yet.';
          bubble('in', 'Welcome to Jal-Mitra. You will get a message here as soon as a tanker is scheduled for ' + h.ward + '.');
          return;
        }

        wardState.textContent =
          h.ward + ' · tanker ' + data.delivery.status + ' · ' + data.delivery.unreservedLitres + 'L unclaimed';
        bubble('in', data.announcement);

        if (data.token) {
          bubble(
            'in',
            'Your reservation: ' + data.token.quotaLitres + 'L, PIN ' + data.token.pin + ' (' + data.token.status + ').',
            data.token.status === 'used' ? '' : 'ok'
          );
        }
      });
  }

  fetch('/api/demo/households')
    .then((r) => r.json())
    .then(function (data) {
      households = data.households;
      sender.innerHTML = '';
      households.forEach(function (h) {
        const opt = document.createElement('option');
        opt.value = h.phone;
        opt.textContent = h.name + ' · ' + h.ward + ' (' + h.registeredMembers + ')';
        sender.appendChild(opt);
      });
      const opt = document.createElement('option');
      opt.value = '9999999999';
      opt.textContent = 'Unregistered number';
      sender.appendChild(opt);
      loadInbox();
    });

  sender.addEventListener('change', loadInbox);

  document.querySelectorAll('.quick button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      input.value = btn.dataset.m;
      input.focus();
    });
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    bubble('out', text);
    input.value = '';
    const pending = bubble('in', '• • •');

    window.JalMitra
      .post('/api/sms/incoming', { From: '+91' + sender.value, Body: text })
      .then(function (res) {
        pending.remove();
        const data = res.data;
        const el = bubble('in', data.reply, data.ok ? 'ok' : 'reject');

        if (data.qrDataUrl) {
          const img = document.createElement('img');
          img.src = data.qrDataUrl;
          img.alt = 'Scan at the tanker';
          el.insertBefore(img, el.querySelector('time'));
          chat.scrollTop = chat.scrollHeight;
        }
        refreshWardState();
      })
      .catch(function () {
        pending.remove();
        bubble('in', 'Network error — is the server running?', 'reject');
      });
  });

  resetBtn.addEventListener('click', function () {
    window.JalMitra.post('/api/demo/reset').then(loadInbox);
  });

  // --- live: the coordinator's broadcast lands here -----------------------

  window.JalMitra.connect({
    delivery_scheduled: function (p) {
      const h = currentHousehold();
      if (!h || p.delivery.ward !== h.ward) return;
      bubble('in', p.announcement);
      wardState.textContent = h.ward + ' · tanker claiming · ' + p.delivery.unreservedLitres + 'L unclaimed';
    },
    claims_closed: function (p) {
      const h = currentHousehold();
      if (!h || p.delivery.ward !== h.ward) return;
      bubble('in', 'Claims for the ' + h.ward + ' tanker are now closed.');
      wardState.textContent = h.ward + ' · claims closed';
    },
    demo_reset: loadInbox,
  });

  input.focus();
  input.select();
})();

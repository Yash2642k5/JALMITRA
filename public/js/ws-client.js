/* Shared WebSocket helper: auto-reconnects and keeps a status dot in sync. */
(function () {
  'use strict';

  window.JalMitra = window.JalMitra || {};

  window.JalMitra.connect = function connect(handlers, statusEl) {
    let socket = null;
    let retry = 0;

    function setStatus(state, label) {
      if (!statusEl) return;
      const dot = statusEl.querySelector('.dot');
      if (dot) dot.className = 'dot ' + state;
      const text = statusEl.querySelector('span:last-child');
      if (text) text.textContent = label;
    }

    function open() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(proto + '://' + location.host + '/ws');

      socket.onopen = function () {
        retry = 0;
        setStatus('live', 'Live');
      };

      socket.onmessage = function (ev) {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (err) {
          return;
        }
        const fn = handlers[msg.type] || handlers['*'];
        if (fn) fn(msg.payload, msg);
      };

      socket.onclose = function () {
        setStatus('down', 'Reconnecting');
        retry += 1;
        setTimeout(open, Math.min(500 * retry, 4000));
      };

      socket.onerror = function () {
        setStatus('down', 'Offline');
      };
    }

    open();
    return {
      close: function () {
        if (socket) socket.close();
      },
    };
  };

  window.JalMitra.post = function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().then(function (data) {
        return { status: res.status, data: data };
      });
    });
  };

  window.JalMitra.clock = function clock() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
})();

'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const store = require('./store');
const dispense = require('./dispense');
const createRoutes = require('./routes');
const aws = require('./aws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(type, payload) {
  const message = JSON.stringify({ type, payload, at: new Date().toISOString() });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

dispense.setBroadcaster(broadcast);

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded

app.use('/api', createRoutes(broadcast));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/', (_req, res) => res.redirect('/dashboard'));
app.get('/dispatch', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dispatch.html')));
app.get('/phone', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'phone.html')));
app.get('/driver', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'driver.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Claim windows close on time even when nobody is looking at a screen.
setInterval(() => {
  for (const delivery of store.sweepDeliveries()) {
    const released = store.unreservedLitres(delivery);
    const event = store.addEvent('claims_closed', {
      ward: delivery.ward,
      deliveryId: delivery.id,
      litres: released,
      status: 'closed',
      note: `${released}L unclaimed, released back to the pool`,
    });
    aws.metrics.unclaimedLitres(released, delivery.ward);
    broadcast('claims_closed', { event, delivery: store.deliveryView(delivery) });
  }
}, 5000);

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'snapshot', payload: store.dashboardState(), at: new Date().toISOString() }));
});

async function boot() {
  const registers = await store.loadRegisters();

  server.listen(config.port, () => {
    const base = `http://localhost:${config.port}`;
    const status = aws.status();
    const on = status.services.filter((s) => s.on).map((s) => s.name);

    console.log('');
    console.log('  Jal-Mitra running');
    console.log(`  Dispatch:  ${base}/dispatch`);
    console.log(`  Resident:  ${base}/phone`);
    console.log(`  Driver:    ${base}/driver`);
    console.log(`  Dashboard: ${base}/dashboard`);
    console.log('');
    console.log(`  Registers: ${registers.count} households from ${registers.source}`);
    console.log(`  AWS:       ${status.region} · ${on.length ? on.join(', ') : 'all services off (offline mode)'}`);
    console.log('');
  });
}

boot();

const shutdown = () => {
  dispense.stopAll();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

'use strict';

const express = require('express');
const QRCode = require('qrcode');

const config = require('./config');
const store = require('./store');
const tokens = require('./tokens');
const dispense = require('./dispense');
const quota = require('./quota');
const aws = require('./aws');
const { t } = require('./messages');

const escapeXml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

const clockTime = (iso) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

function twiml(res, message, mediaUrl) {
  const media = mediaUrl ? `<Media>${escapeXml(mediaUrl)}</Media>` : '';
  res
    .type('text/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message><Body>${escapeXml(message)}</Body>${media}</Message></Response>`);
}

const announcementFor = (d) =>
  t(
    'announcement',
    d.ward,
    clockTime(d.arrivalFrom),
    clockTime(d.arrivalTo),
    clockTime(d.claimDeadline),
    d.capacityLitres
  );

module.exports = function createRoutes(broadcast) {
  const router = express.Router();

  // ======================================================================
  // COORDINATOR: schedule a delivery, then broadcast it to the ward.
  // Nothing can be claimed until this happens.
  // ======================================================================
  router.post('/delivery/schedule', async (req, res) => {
    const body = req.body || {};
    const ward = String(body.ward || '').trim();

    const households = store.householdsInWard(ward);
    if (!households.length) {
      return res.status(400).json({ ok: false, message: 'Unknown ward, or no households registered in it.' });
    }
    if (store.openDeliveryForWard(ward)) {
      return res.status(409).json({ ok: false, message: `${ward} already has an open delivery taking claims.` });
    }

    const capacityLitres = Number(body.capacityLitres) || config.defaultTankerCapacityLitres;
    if (capacityLitres <= 0) {
      return res.status(400).json({ ok: false, message: 'Tanker capacity must be greater than zero.' });
    }

    const now = Date.now();
    const arrivalFrom = body.arrivalFrom
      ? new Date(body.arrivalFrom)
      : new Date(now + (Number(body.arrivalInMinutes) || 60) * 60000);
    const arrivalTo = body.arrivalTo
      ? new Date(body.arrivalTo)
      : new Date(arrivalFrom.getTime() + (Number(body.windowMinutes) || 60) * 60000);
    const claimMinutes = Number(body.claimMinutes) || config.defaultClaimWindowMinutes;
    // Claims must close before the tanker rolls, so the driver knows the load.
    const claimDeadline = new Date(Math.min(now + claimMinutes * 60000, arrivalFrom.getTime()));

    const delivery = store.createDelivery({
      ward,
      capacityLitres,
      tankerId: body.tankerId,
      arrivalFrom: arrivalFrom.toISOString(),
      arrivalTo: arrivalTo.toISOString(),
      claimDeadline: claimDeadline.toISOString(),
    });

    const announcement = announcementFor(delivery);
    delivery.announcement = announcement;

    // Real SMS fan-out via Amazon SNS. Falls back to the on-screen simulator.
    const sms = await aws.sns.broadcast(households, announcement);

    const event = store.addEvent('delivery_scheduled', {
      ward,
      deliveryId: delivery.id,
      litres: capacityLitres,
      status: 'claiming',
      note:
        `${households.length} households notified · claims close ${clockTime(delivery.claimDeadline)}` +
        (sms.enabled ? ` · SNS sent ${sms.sent}, failed ${sms.failed}` : ' · SMS simulated'),
    });

    broadcast('delivery_scheduled', {
      event,
      delivery: store.deliveryView(delivery),
      announcement,
      sms,
      recipients: households.map((h) => ({ id: h.id, name: h.name, phone: h.phone })),
    });

    res.json({
      ok: true,
      delivery: store.deliveryView(delivery),
      announcement,
      notified: households.length,
      sms,
    });
  });

  router.post('/delivery/close', (req, res) => {
    const delivery = store.getDelivery(String((req.body || {}).deliveryId || ''));
    if (!delivery) return res.status(404).json({ ok: false, message: 'No such delivery.' });
    if (!store.closeDelivery(delivery, 'Closed by coordinator')) {
      return res.status(409).json({ ok: false, message: 'Claims are not open on that delivery.' });
    }
    const released = store.unreservedLitres(delivery);
    const event = store.addEvent('claims_closed', {
      ward: delivery.ward,
      deliveryId: delivery.id,
      litres: released,
      status: 'closed',
      note: `${released}L unclaimed, released back to the pool`,
    });
    broadcast('claims_closed', { event, delivery: store.deliveryView(delivery) });
    res.json({ ok: true, delivery: store.deliveryView(delivery) });
  });

  router.post('/delivery/complete', (req, res) => {
    const delivery = store.getDelivery(String((req.body || {}).deliveryId || ''));
    if (!delivery) return res.status(404).json({ ok: false, message: 'No such delivery.' });
    delivery.status = 'completed';
    const event = store.addEvent('delivery_completed', {
      ward: delivery.ward,
      deliveryId: delivery.id,
      litres: delivery.dispensedLitres,
      status: 'completed',
      note: `${delivery.dispensedLitres}L delivered of ${delivery.capacityLitres}L loaded`,
    });
    broadcast('delivery_completed', { event, delivery: store.deliveryView(delivery) });
    res.json({ ok: true, delivery: store.deliveryView(delivery) });
  });

  router.get('/deliveries', (_req, res) => {
    store.sweepDeliveries();
    res.json({
      coordinatorLabel: config.coordinatorLabel,
      wardNames: store.dashboardState().wardNames,
      defaults: {
        capacityLitres: config.defaultTankerCapacityLitres,
        claimMinutes: config.defaultClaimWindowMinutes,
        litresPerPerson: config.litresPerPerson,
      },
      deliveries: store.listDeliveries().map(store.deliveryView),
    });
  });

  // ======================================================================
  // RESIDENT: claim against a scheduled delivery.
  // ======================================================================
  router.post('/sms/incoming', async (req, res) => {
    const body = req.body || {};
    const isTwilio = Boolean(body.AccountSid || req.get('x-twilio-signature') || req.query.twiml === '1');
    const from = body.From || body.from || '';
    const text = body.Body || body.body || '';

    const reply = (payload) => {
      if (isTwilio) return twiml(res, payload.reply, payload.qrUrl);
      return res.json(payload);
    };

    const household = store.getHouseholdByPhone(from);
    if (!household) {
      return reply({ ok: false, code: 'not_registered', reply: t('notRegistered') });
    }

    const parsed = quota.parseMessage(text);
    if (!parsed.ok) {
      return reply({ ok: false, code: 'bad_format', reply: t('help'), household: household.name });
    }

    store.sweepDeliveries();

    // You cannot claim water that nobody has scheduled.
    const delivery = store.openDeliveryForWard(household.ward);
    if (!delivery) {
      const live = store.liveDeliveryForWard(household.ward);
      const message = live ? t('claimsClosed', household.ward) : t('noDelivery', household.ward);
      const event = store.addEvent('claim_rejected', {
        householdId: household.id,
        status: live ? 'claims_closed' : 'no_delivery',
        note: live ? `Claims closed: ${live.closedReason || 'closed'}` : 'No delivery scheduled',
      });
      aws.metrics.claimBlocked('no_open_delivery', household.ward);
      broadcast('claim_rejected', { event, household });
      return reply({ ok: false, code: live ? 'claims_closed' : 'no_delivery', reply: message, household: household.name });
    }

    // Rule 1: one active token per household per delivery.
    const existing = store.activeTokenFor(household.id, delivery.id);
    if (existing) {
      const event = store.addEvent('duplicate_attempt', {
        householdId: household.id,
        deliveryId: delivery.id,
        status: existing.status,
        note: `Second claim on this delivery (PIN ${existing.pin} is ${existing.status})`,
      });
      aws.metrics.claimBlocked('duplicate', household.ward);
      broadcast('duplicate_attempt', { event, household, token: { pin: existing.pin, status: existing.status } });

      const message =
        existing.status === 'used'
          ? t('alreadyCollected', existing.quotaLitres)
          : t('alreadyClaimed', existing.pin, existing.quotaLitres);
      return reply({ ok: false, code: 'duplicate', reply: message, household: household.name });
    }

    const q = quota.computeQuota(household, parsed.requestedMembers);

    // Rule 2: reservations can never exceed what the tanker is carrying.
    // A claim that does not fit is refused, but the tanker stays open so a
    // smaller household can still use the remaining litres. Closing here
    // would strand water on the truck.
    const free = store.unreservedLitres(delivery);
    if (q.litres > free) {
      const message =
        free > 0
          ? t('capacityShort', free, q.litres, household.ward)
          : t('capacityFull', household.ward);
      const event = store.addEvent('capacity_full', {
        householdId: household.id,
        deliveryId: delivery.id,
        litres: q.litres,
        status: 'rejected',
        note: `Needed ${q.litres}L, only ${free}L unreserved`,
      });
      aws.metrics.claimBlocked('capacity', household.ward);
      broadcast('capacity_full', { event, household, delivery: store.deliveryView(delivery) });
      return reply({ ok: false, code: 'capacity_full', reply: message, household: household.name });
    }

    // Token stays valid until the tanker has left, plus a grace period.
    const expiresAt = new Date(
      Math.max(Date.now() + config.tokenTtlMinutes * 60000, new Date(delivery.arrivalTo).getTime() + 30 * 60000)
    ).toISOString();

    const token = tokens.createToken({
      householdId: household.id,
      deliveryId: delivery.id,
      quotaLitres: q.litres,
      expiresAt,
      flagged: q.flagged,
      flagNote: q.flagNote,
    });
    delivery.reservedLitres += q.litres;
    if (store.unreservedLitres(delivery) <= 0) store.closeDelivery(delivery, 'Tanker fully booked');

    const event = store.addEvent('token_created', {
      householdId: household.id,
      deliveryId: delivery.id,
      litres: q.litres,
      status: 'reserved',
      note: q.flagged ? `FLAGGED: ${q.flagNote}` : null,
    });
    aws.metrics.tokenIssued(q.litres, household.ward);
    broadcast('token_created', {
      event,
      household,
      delivery: store.deliveryView(delivery),
      token: { id: token.id, pin: token.pin, quotaLitres: token.quotaLitres, flagged: token.flagged },
    });

    let message = t(
      'reserved',
      q.litres,
      token.pin,
      clockTime(delivery.arrivalFrom),
      clockTime(delivery.arrivalTo),
      household.ward
    );
    if (q.flagged) message += ` (${q.members} members on record.)`;
    if (q.capped) message += ` Max ${config.maxLitresPerHousehold}L per household.`;

    const qrDataUrl = await tokens.toQrDataUrl(token.qrToken);

    // S3 gives the QR a real URL so it can ride along as an SMS/WhatsApp media
    // message; without S3 we fall back to serving it from this host.
    const s3Url = await aws.s3.putQr(token.id, await tokens.toQrBuffer(token.qrToken));
    const qrUrl =
      s3Url || (config.publicBaseUrl ? `${config.publicBaseUrl}/api/qr/${token.id}.png` : null);

    const sms = await aws.sns.sendSms(household.phone, message);

    return reply({
      ok: true,
      reply: message,
      household: household.name,
      ward: household.ward,
      token: { id: token.id, pin: token.pin, quotaLitres: token.quotaLitres, expiresAt: token.expiresAt },
      qrDataUrl,
      qrUrl,
      sms,
    });
  });

  /** What the resident's phone should currently show. */
  router.get('/resident/inbox', (req, res) => {
    const household = store.getHouseholdByPhone(req.query.phone || '');
    if (!household) return res.json({ ok: false, code: 'not_registered' });

    store.sweepDeliveries();
    const delivery = store.liveDeliveryForWard(household.ward);
    const token = delivery ? store.activeTokenFor(household.id, delivery.id) : null;

    res.json({
      ok: true,
      household,
      delivery: delivery ? store.deliveryView(delivery) : null,
      announcement: delivery ? delivery.announcement || announcementFor(delivery) : null,
      token: token ? { pin: token.pin, quotaLitres: token.quotaLitres, status: token.status } : null,
    });
  });

  router.get('/qr/:tokenId.png', async (req, res) => {
    const token = store.getToken(req.params.tokenId);
    if (!token) return res.status(404).send('Not found');
    const buffer = await QRCode.toBuffer(token.qrToken, { margin: 1, width: 400 });
    res.type('png').send(buffer);
  });

  // ======================================================================
  // DRIVER
  // ======================================================================
  router.post('/token/validate', (req, res) => {
    const input = (req.body && (req.body.code ?? req.body.pin ?? req.body.token)) || '';
    const result = tokens.resolveToken(input);

    if (!result.ok) {
      store.addEvent('validation_failed', { status: result.code, note: result.message });
      broadcast('validation_failed', { code: result.code, message: result.message });
      return res.status(400).json({ ok: false, code: result.code, message: result.message });
    }

    const token = result.token;
    const delivery = result.delivery;
    const household = store.getHousehold(token.householdId);
    return res.json({
      ok: true,
      token: {
        id: token.id,
        pin: token.pin,
        quotaLitres: token.quotaLitres,
        status: token.status,
        expiresAt: token.expiresAt,
        flagged: token.flagged,
        flagNote: token.flagNote,
      },
      household: {
        id: household.id,
        name: household.name,
        ward: household.ward,
        registeredMembers: household.registeredMembers,
      },
      delivery: store.deliveryView(delivery),
    });
  });

  router.post('/dispense/start', (req, res) => {
    const input = (req.body && (req.body.code ?? req.body.pin ?? req.body.tokenId)) || '';
    const byId = store.getToken(String(input));
    const result = byId && byId.status === 'reserved' ? { ok: true, token: byId } : tokens.resolveToken(input);

    if (!result.ok) return res.status(400).json({ ok: false, code: result.code, message: result.message });

    const started = dispense.start(result.token);
    if (!started.ok) return res.status(409).json({ ok: false, code: started.code, message: started.message });
    return res.json({ ok: true, session: started.session });
  });

  router.post('/dispense/stop', (req, res) => {
    const result = dispense.stop(String((req.body || {}).sessionId || ''));
    if (!result.ok) return res.status(400).json({ ok: false, code: result.code, message: result.message });
    return res.json({ ok: true, session: result.session });
  });

  // ======================================================================
  // AWS IoT Core: real flow-meter readings
  // An ESP32 on the tanker publishes litres to the IoT topic; an IoT Rule
  // forwards the message here. With a real meter attached the dispense engine
  // stops guessing and reports MEASURED litres.
  // ======================================================================
  router.post('/meter/reading', (req, res) => {
    const key = config.aws.iot.ingestKey;
    if (key && req.get('x-meter-key') !== key) {
      return res.status(401).json({ ok: false, message: 'Bad meter key.' });
    }

    const body = req.body || {};
    const litres = Number(body.litres);
    if (!Number.isFinite(litres) || litres < 0) {
      return res.status(400).json({ ok: false, message: 'litres must be a non-negative number.' });
    }

    const result = dispense.applyMeterReading(String(body.sessionId || ''), litres);
    if (!result.ok) return res.status(400).json({ ok: false, code: result.code, message: result.message });
    return res.json({ ok: true, session: result.session });
  });

  // ======================================================================
  // AWS status + ledger export
  // ======================================================================
  router.get('/aws/status', (_req, res) => res.json(aws.status()));

  router.post('/ledger/export', async (_req, res) => {
    if (!aws.s3.enabled()) {
      return res.status(400).json({ ok: false, message: 'S3 is not configured. Set S3_ENABLED and S3_BUCKET.' });
    }
    const result = await aws.s3.putLedger(store.listEvents(300));
    if (!result) return res.status(500).json({ ok: false, message: 'Export failed. Check server logs.' });
    store.addEvent('ledger_exported', { status: 'completed', note: `${result.rows} rows to s3://${result.key}` });
    res.json({ ok: true, ...result });
  });

  // ======================================================================
  // DASHBOARD + DEMO
  // ======================================================================
  router.get('/dashboard/state', (_req, res) => res.json(store.dashboardState()));

  router.get('/demo/households', (_req, res) =>
    res.json({
      litresPerPerson: config.litresPerPerson,
      households: store.listHouseholds().map(({ id, name, phone, ward, registeredMembers }) => ({
        id,
        name,
        phone,
        ward,
        registeredMembers,
      })),
    })
  );

  router.post('/demo/reset', (_req, res) => {
    dispense.stopAll();
    store.reset();
    broadcast('demo_reset', store.dashboardState());
    res.json({ ok: true });
  });

  return router;
};

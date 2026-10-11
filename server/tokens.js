'use strict';

const crypto = require('crypto');
const QRCode = require('qrcode');

const config = require('./config');
const store = require('./store');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payloadB64) {
  return crypto.createHmac('sha256', config.hmacSecret).update(payloadB64).digest('base64url');
}

function generatePin() {
  for (let i = 0; i < 500; i++) {
    const pin = String(crypto.randomInt(1000, 10000));
    if (store.pinIsFree(pin)) return pin;
  }
  throw new Error('No free PIN available');
}

function createToken({ householdId, deliveryId, quotaLitres, expiresAt, flagged = false, flagNote = null }) {
  const now = Date.now();
  const pin = generatePin();
  const id = store.nextId('TK');

  const payload = {
    t: id,
    h: householdId,
    q: quotaLitres,
    d: deliveryId,
    p: pin,
    e: expiresAt,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const qrToken = `${payloadB64}.${sign(payloadB64)}`;

  return store.saveToken({
    id,
    householdId,
    deliveryId,
    pin,
    qrToken,
    quotaLitres,
    litresServed: 0,
    status: 'reserved',
    flagged,
    flagNote,
    createdAt: new Date(now).toISOString(),
    expiresAt,
  });
}

/** Verifies the HMAC and returns the embedded payload, or null. */
function verifyQrToken(qrToken) {
  const raw = String(qrToken || '').trim();
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;

  const payloadB64 = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = sign(payloadB64);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolves either a 4-digit PIN or a signed QR token to a usable token.
 * Returns { ok, token } or { ok: false, code, message }.
 */
function resolveToken(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, code: 'empty', message: 'Enter a PIN or scan a QR code.' };

  let token = null;

  if (/^\d{4}$/.test(raw)) {
    token = store.getTokenByPin(raw);
    if (!token) return { ok: false, code: 'not_found', message: 'Invalid PIN. No such token.' };
  } else {
    const payload = verifyQrToken(raw);
    if (!payload) {
      return { ok: false, code: 'bad_signature', message: 'QR code is forged or corrupted.' };
    }
    token = store.getToken(payload.t);
    if (!token) return { ok: false, code: 'not_found', message: 'Token not recognised.' };
  }

  const delivery = store.getDelivery(token.deliveryId);
  if (!delivery) {
    return { ok: false, code: 'no_delivery', message: 'Token belongs to an unknown delivery.' };
  }
  if (delivery.status === 'completed') {
    return { ok: false, code: 'delivery_done', message: 'That delivery is already finished.' };
  }
  if (token.status === 'used') {
    return { ok: false, code: 'already_used', message: 'Token already used. Quota collected.' };
  }
  if (token.status === 'expired' || new Date(token.expiresAt).getTime() <= Date.now()) {
    token.status = 'expired';
    return { ok: false, code: 'expired', message: 'Token expired. Ask resident to re-request.' };
  }

  return { ok: true, token, delivery };
}

const toQrDataUrl = (qrToken) =>
  QRCode.toDataURL(qrToken, { margin: 1, width: 320, errorCorrectionLevel: 'M' });

const toQrBuffer = (qrToken) => QRCode.toBuffer(qrToken, { margin: 1, width: 400 });

module.exports = { createToken, verifyQrToken, resolveToken, toQrDataUrl, toQrBuffer, generatePin };

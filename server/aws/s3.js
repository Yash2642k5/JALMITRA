'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');

const cfg = config.aws.s3;
let client = null;

const enabled = () => cfg.enabled && Boolean(cfg.bucket);

function getClient() {
  if (!client) {
    client = new S3Client({ region: config.aws.region, credentials: config.aws.credentials });
  }
  return client;
}

const key = (path) => `${cfg.prefix}/${path}`.replace(/^\/+/, '');

/**
 * QR codes need a real URL to ride along as an SMS/WhatsApp media message.
 * Returns a presigned link, or null so the caller falls back to a data URL.
 */
async function putQr(tokenId, buffer) {
  if (!enabled()) return null;
  const objectKey = key(`qr/${tokenId}.png`);
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: objectKey,
        Body: buffer,
        ContentType: 'image/png',
      })
    );
    return await getSignedUrl(
      getClient(),
      new GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey }),
      { expiresIn: cfg.urlTtlMinutes * 60 }
    );
  } catch (err) {
    console.error('[s3] QR upload failed: %s', err.message);
    return null;
  }
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** Exports the fair-share audit log as CSV — the record book, archived. */
async function putLedger(events) {
  if (!enabled()) return null;

  const header = ['timestamp', 'type', 'ward', 'household', 'litres', 'status', 'note'];
  const rows = events.map((e) =>
    [e.timestamp, e.type, e.ward, e.householdName, e.litres, e.status, e.note].map(csvCell).join(',')
  );
  const csv = [header.join(','), ...rows].join('\n');
  const objectKey = key(`ledger/${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);

  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: objectKey,
        Body: csv,
        ContentType: 'text/csv',
      })
    );
    const url = await getSignedUrl(
      getClient(),
      new GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey }),
      { expiresIn: cfg.urlTtlMinutes * 60 }
    );
    return { key: objectKey, url, rows: events.length };
  } catch (err) {
    console.error('[s3] ledger export failed: %s', err.message);
    return null;
  }
}

module.exports = { enabled, putQr, putLedger };

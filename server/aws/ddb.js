'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const config = require('../config');

const cfg = config.aws.ddb;
let doc = null;

const enabled = () => cfg.enabled && Boolean(cfg.prefix);

const table = (name) => `${cfg.prefix}-${name}`;

function getDoc() {
  if (!doc) {
    const base = new DynamoDBClient({ region: config.aws.region, credentials: config.aws.credentials });
    doc = DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });
  }
  return doc;
}

/**
 * Writes are fire-and-forget on purpose: DynamoDB is the durable audit trail,
 * not the hot path. A throttle or a dropped connection must never stall a
 * resident's claim or a tanker mid-dispense.
 */
function put(name, item) {
  if (!enabled()) return;
  getDoc()
    .send(new PutCommand({ TableName: table(name), Item: item }))
    .catch((err) => console.error('[ddb] put %s failed: %s', name, err.message));
}

const putHousehold = (h) => put('households', h);
const putDelivery = (d) => put('deliveries', { ...d, updatedAt: new Date().toISOString() });
const putToken = (t) => put('tokens', { ...t, updatedAt: new Date().toISOString() });
const putEvent = (e) => put('events', e);

/** Ward registers live in DynamoDB; seed.js is the offline fallback. */
async function loadHouseholds() {
  if (!enabled()) return null;
  try {
    const out = await getDoc().send(new ScanCommand({ TableName: table('households') }));
    const items = out.Items || [];
    if (!items.length) return null;
    return items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  } catch (err) {
    console.error('[ddb] household load failed, falling back to seed: %s', err.message);
    return null;
  }
}

async function scanAll(name) {
  if (!enabled()) return [];
  try {
    const out = await getDoc().send(new ScanCommand({ TableName: table(name) }));
    return out.Items || [];
  } catch (err) {
    console.error('[ddb] scan %s failed: %s', name, err.message);
    return [];
  }
}

module.exports = {
  enabled,
  table,
  getDoc,
  putHousehold,
  putDelivery,
  putToken,
  putEvent,
  loadHouseholds,
  scanAll,
};

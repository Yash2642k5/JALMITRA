'use strict';

const config = require('./config');
const { HOUSEHOLDS, WARDS } = require('./seed');
const ddb = require('./aws/ddb');

// Last 10 digits is the household key, so +919810000001 and 9810000001 match.
const normalisePhone = (raw) => String(raw || '').replace(/\D/g, '').slice(-10);

let seq = 0;
const nextId = (prefix) => `${prefix}-${String(++seq).padStart(4, '0')}`;

const state = {
  households: new Map(),
  householdsByPhone: new Map(),
  deliveries: new Map(),
  tokens: new Map(),
  tokensByPin: new Map(),
  events: [],
  sessions: new Map(),
};

function reset(registers) {
  state.households.clear();
  state.householdsByPhone.clear();
  state.deliveries.clear();
  state.tokens.clear();
  state.tokensByPin.clear();
  state.sessions.clear();
  state.events = [];

  for (const h of registers || state.registers || HOUSEHOLDS) {
    const household = { ...h, litresServed: 0 };
    state.households.set(household.id, household);
    state.householdsByPhone.set(normalisePhone(household.phone), household.id);
  }
}

state.registers = HOUSEHOLDS;
reset();

/**
 * Ward registers come from DynamoDB when it is configured, so the roster is
 * not baked into the build. seed.js stays the offline fallback.
 */
async function loadRegisters() {
  const rows = await ddb.loadHouseholds();
  if (rows && rows.length) {
    state.registers = rows;
    reset(rows);
    return { source: 'dynamodb', count: rows.length };
  }
  state.registers = HOUSEHOLDS;
  return { source: 'seed', count: HOUSEHOLDS.length };
}

// --- households ---------------------------------------------------------

const getHousehold = (id) => state.households.get(id) || null;

function getHouseholdByPhone(phone) {
  const id = state.householdsByPhone.get(normalisePhone(phone));
  return id ? state.households.get(id) : null;
}

const listHouseholds = () => [...state.households.values()];

const householdsInWard = (ward) => listHouseholds().filter((h) => h.ward === ward);

// --- deliveries ---------------------------------------------------------

function createDelivery({ ward, capacityLitres, arrivalFrom, arrivalTo, claimDeadline, tankerId }) {
  const delivery = {
    id: nextId('DLV'),
    ward,
    tankerId: tankerId || 'TANKER-01',
    capacityLitres,
    arrivalFrom,
    arrivalTo,
    claimDeadline,
    status: 'claiming',
    reservedLitres: 0,
    dispensedLitres: 0,
    closedReason: null,
    createdAt: new Date().toISOString(),
  };
  state.deliveries.set(delivery.id, delivery);
  ddb.putDelivery(delivery);
  return delivery;
}

const getDelivery = (id) => state.deliveries.get(id) || null;

const listDeliveries = () =>
  [...state.deliveries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** The delivery a resident in this ward can currently claim against. */
function openDeliveryForWard(ward) {
  return listDeliveries().find((d) => d.ward === ward && d.status === 'claiming') || null;
}

/** Any delivery for this ward still being served (claims may be closed). */
function liveDeliveryForWard(ward) {
  return listDeliveries().find((d) => d.ward === ward && d.status !== 'completed') || null;
}

const activeDeliveries = () => listDeliveries().filter((d) => d.status !== 'completed');

function closeDelivery(delivery, reason) {
  if (delivery.status !== 'claiming') return false;
  delivery.status = 'closed';
  delivery.closedReason = reason;
  return true;
}

const unreservedLitres = (d) => Math.max(0, d.capacityLitres - d.reservedLitres);
const remainingLitres = (d) => Math.max(0, d.capacityLitres - d.dispensedLitres);
const fillPercent = (d) => Math.round((remainingLitres(d) / d.capacityLitres) * 1000) / 10;

/** Auto-closes claims once the deadline passes. Returns deliveries just closed. */
function sweepDeliveries() {
  const now = Date.now();
  const closed = [];
  for (const d of state.deliveries.values()) {
    if (d.status === 'claiming' && new Date(d.claimDeadline).getTime() <= now) {
      closeDelivery(d, 'Claim window ended');
      closed.push(d);
    }
  }
  return closed;
}

function deliveryView(d) {
  const claims = listTokens().filter((t) => t.deliveryId === d.id);
  return {
    ...d,
    remainingLitres: remainingLitres(d),
    unreservedLitres: unreservedLitres(d),
    fillPercent: fillPercent(d),
    claimCount: claims.length,
    householdsInWard: householdsInWard(d.ward).length,
    msToDeadline: Math.max(0, new Date(d.claimDeadline).getTime() - Date.now()),
  };
}

// --- tokens -------------------------------------------------------------

function expireStaleTokens() {
  const now = Date.now();
  for (const token of state.tokens.values()) {
    if (token.status === 'reserved' && new Date(token.expiresAt).getTime() <= now) {
      token.status = 'expired';
      state.tokensByPin.delete(token.pin);
      const delivery = getDelivery(token.deliveryId);
      // Expired reservations hand their litres back to the pool.
      if (delivery) delivery.reservedLitres = Math.max(0, delivery.reservedLitres - token.quotaLitres);
    }
  }
}

/** A token that still blocks a new claim on this delivery. */
function activeTokenFor(householdId, deliveryId) {
  expireStaleTokens();
  for (const token of state.tokens.values()) {
    if (
      token.householdId === householdId &&
      token.deliveryId === deliveryId &&
      ['reserved', 'dispensing', 'used'].includes(token.status)
    ) {
      return token;
    }
  }
  return null;
}

function pinIsFree(pin) {
  const existing = state.tokensByPin.get(pin);
  return !existing || !['reserved', 'dispensing'].includes(existing.status);
}

function saveToken(token) {
  state.tokens.set(token.id, token);
  state.tokensByPin.set(token.pin, token);
  ddb.putToken(token);
  return token;
}

const getToken = (id) => state.tokens.get(id) || null;

function getTokenByPin(pin) {
  expireStaleTokens();
  return state.tokensByPin.get(String(pin)) || null;
}

const listTokens = () => [...state.tokens.values()];

// --- events -------------------------------------------------------------

function addEvent(type, payload = {}) {
  const household = payload.householdId ? getHousehold(payload.householdId) : null;
  const event = {
    id: nextId('EV'),
    type,
    timestamp: new Date().toISOString(),
    householdId: payload.householdId || null,
    householdName: household ? household.name : payload.householdName || null,
    ward: household ? household.ward : payload.ward || null,
    deliveryId: payload.deliveryId || null,
    litres: payload.litres ?? null,
    status: payload.status || null,
    note: payload.note || null,
  };
  state.events.unshift(event);
  if (state.events.length > 300) state.events.pop();
  ddb.putEvent(event); // durable audit ledger
  return event;
}

const listEvents = (limit = 100) => state.events.slice(0, limit);

// --- dashboard ----------------------------------------------------------

function wardSummary() {
  return WARDS.map((ward) => {
    const members = householdsInWard(ward);
    const delivery = liveDeliveryForWard(ward);
    const people = members.reduce((sum, h) => sum + h.registeredMembers, 0);
    return {
      ward,
      litresServed: members.reduce((sum, h) => sum + h.litresServed, 0),
      households: members.length,
      people,
      entitledLitres: people * config.litresPerPerson,
      served: members.filter((h) => h.litresServed > 0).length,
      deliveryStatus: delivery ? delivery.status : null,
    };
  });
}

function dashboardState() {
  expireStaleTokens();
  sweepDeliveries();

  const deliveries = listDeliveries().map(deliveryView);
  const active = deliveries.filter((d) => d.status !== 'completed');
  const capacity = active.reduce((sum, d) => sum + d.capacityLitres, 0);
  const dispensed = deliveries.reduce((sum, d) => sum + d.dispensedLitres, 0);
  const reserved = active.reduce((sum, d) => sum + d.reservedLitres, 0);

  return {
    coordinatorLabel: config.coordinatorLabel,
    config: {
      litresPerPerson: config.litresPerPerson,
      maxLitresPerHousehold: config.maxLitresPerHousehold,
      dispenseRateLps: config.dispenseRateLps,
      defaultTankerCapacityLitres: config.defaultTankerCapacityLitres,
      defaultClaimWindowMinutes: config.defaultClaimWindowMinutes,
    },
    wardNames: WARDS,
    deliveries,
    activeDelivery: active[0] || null,
    fleet: {
      capacityLitres: capacity,
      remainingLitres: active.reduce((sum, d) => sum + d.remainingLitres, 0),
      reservedLitres: reserved,
      unreservedLitres: active.reduce((sum, d) => sum + d.unreservedLitres, 0),
      fillPercent: capacity ? Math.round(((capacity - dispensed) / capacity) * 1000) / 10 : 100,
    },
    totals: {
      households: state.households.size,
      litresDispensed: dispensed,
      litresReserved: reserved,
      tokensIssued: listTokens().length,
      duplicateAttempts: state.events.filter((e) => e.type === 'duplicate_attempt').length,
      capacityRejections: state.events.filter((e) => e.type === 'capacity_full').length,
    },
    wards: wardSummary(),
    households: listHouseholds().map((h) => {
      const delivery = liveDeliveryForWard(h.ward);
      const token = delivery ? activeTokenFor(h.id, delivery.id) : null;
      return { ...h, tokenStatus: token ? token.status : null, quotaLitres: token ? token.quotaLitres : null };
    }),
    events: listEvents(60),
  };
}

module.exports = {
  state,
  reset,
  loadRegisters,
  nextId,
  normalisePhone,
  getHousehold,
  getHouseholdByPhone,
  listHouseholds,
  householdsInWard,
  createDelivery,
  getDelivery,
  listDeliveries,
  openDeliveryForWard,
  liveDeliveryForWard,
  activeDeliveries,
  closeDelivery,
  sweepDeliveries,
  deliveryView,
  unreservedLitres,
  remainingLitres,
  fillPercent,
  activeTokenFor,
  pinIsFree,
  saveToken,
  getToken,
  getTokenByPin,
  listTokens,
  expireStaleTokens,
  addEvent,
  listEvents,
  dashboardState,
};

'use strict';

const config = require('./config');
const store = require('./store');
const aws = require('./aws');

const TICK_MS = 200;

let broadcast = () => {};
const setBroadcaster = (fn) => {
  broadcast = fn;
};

function snapshot(session) {
  const delivery = store.getDelivery(session.deliveryId);
  return {
    sessionId: session.id,
    tokenId: session.tokenId,
    deliveryId: session.deliveryId,
    householdId: session.householdId,
    householdName: session.householdName,
    ward: session.ward,
    quotaLitres: session.quotaLitres,
    litresServed: Math.round(session.litresServed * 10) / 10,
    remainingLitres: Math.round((session.quotaLitres - session.litresServed) * 10) / 10,
    tankerRemaining: delivery ? Math.round(store.remainingLitres(delivery)) : 0,
    tankerCapacity: delivery ? delivery.capacityLitres : 0,
    tankerFillPercent: delivery ? store.fillPercent(delivery) : 0,
    status: session.status,
    metered: session.metered,
  };
}

function finish(session, status, note) {
  if (session.timer) clearInterval(session.timer);
  session.timer = null;
  session.status = status;

  const served = Math.round(session.litresServed * 10) / 10;
  const token = store.getToken(session.tokenId);
  const household = store.getHousehold(session.householdId);

  if (token) {
    token.litresServed = served;
    token.status = 'used'; // single use, even on an early stop
  }
  if (household) household.litresServed += served;

  store.addEvent('dispense_done', {
    householdId: session.householdId,
    deliveryId: session.deliveryId,
    litres: served,
    status: status === 'completed' ? 'completed' : 'stopped_early',
    note: [note, session.metered ? 'flow-meter measured' : 'simulated rate'].filter(Boolean).join(' · '),
  });
  aws.metrics.litresDelivered(served, session.ward);

  broadcast('dispense_done', { ...snapshot(session), note });
  return snapshot(session);
}

function start(token) {
  const delivery = store.getDelivery(token.deliveryId);
  if (!delivery) {
    return { ok: false, code: 'no_delivery', message: 'Token has no delivery attached.' };
  }
  if (store.remainingLitres(delivery) <= 0) {
    return { ok: false, code: 'tanker_empty', message: 'Tanker is empty. Cannot dispense.' };
  }
  if (token.status === 'dispensing') {
    return { ok: false, code: 'already_dispensing', message: 'This token is already dispensing.' };
  }

  token.status = 'dispensing';
  const household = store.getHousehold(token.householdId);

  const session = {
    id: store.nextId('DS'),
    tokenId: token.id,
    deliveryId: delivery.id,
    householdId: token.householdId,
    householdName: household ? household.name : 'Unknown',
    ward: household ? household.ward : null,
    quotaLitres: token.quotaLitres,
    litresServed: 0,
    status: 'dispensing',
    metered: false, // flips to true on the first real flow-meter reading
    startedAt: new Date().toISOString(),
    timer: null,
  };
  store.state.sessions.set(session.id, session);

  store.addEvent('dispense_start', {
    householdId: session.householdId,
    deliveryId: delivery.id,
    litres: session.quotaLitres,
    status: 'dispensing',
  });
  broadcast('dispense_start', snapshot(session));

  session.timer = setInterval(() => {
    // Once a real flow meter is reporting, it drives progress, not the clock.
    if (session.metered) return;

    const step = (config.dispenseRateLps * TICK_MS) / 1000;
    const want = Math.min(step, session.quotaLitres - session.litresServed);
    const got = Math.max(0, Math.min(want, store.remainingLitres(delivery)));

    delivery.dispensedLitres += got;
    session.litresServed += got;

    // The hard ceiling: never exceed the approved litres.
    if (session.litresServed >= session.quotaLitres - 0.01) {
      session.litresServed = session.quotaLitres;
      finish(session, 'completed', null);
      return;
    }
    if (got <= 0) {
      finish(session, 'stopped', 'Tanker ran empty mid-dispense');
      return;
    }
    broadcast('dispense_progress', snapshot(session));
  }, TICK_MS);

  return { ok: true, session: snapshot(session) };
}

/**
 * A cumulative litres reading from the tanker's flow meter, delivered via
 * AWS IoT Core. This is what turns "we say 160L" into "the meter says 160L".
 */
function applyMeterReading(sessionId, cumulativeLitres) {
  const session = store.state.sessions.get(sessionId);
  if (!session) return { ok: false, code: 'not_found', message: 'No such dispense session.' };
  if (session.status !== 'dispensing') {
    return { ok: false, code: 'not_active', message: 'Session already finished.' };
  }

  const delivery = store.getDelivery(session.deliveryId);
  if (!delivery) return { ok: false, code: 'no_delivery', message: 'Delivery missing.' };

  session.metered = true;

  // The meter is authoritative but still bounded by the approved quota and
  // by what is physically left in the tanker.
  const target = Math.min(cumulativeLitres, session.quotaLitres);
  const delta = Math.max(0, Math.min(target - session.litresServed, store.remainingLitres(delivery)));

  delivery.dispensedLitres += delta;
  session.litresServed += delta;

  if (session.litresServed >= session.quotaLitres - 0.01) {
    session.litresServed = session.quotaLitres;
    return { ok: true, session: finish(session, 'completed', null) };
  }

  const snap = snapshot(session);
  broadcast('dispense_progress', snap);
  return { ok: true, session: snap };
}

function stop(sessionId) {
  const session = store.state.sessions.get(sessionId);
  if (!session) return { ok: false, code: 'not_found', message: 'No such dispense session.' };
  if (session.status !== 'dispensing') {
    return { ok: false, code: 'not_active', message: 'Session already finished.' };
  }
  return { ok: true, session: finish(session, 'stopped', 'Stopped early by driver') };
}

function stopAll() {
  for (const session of store.state.sessions.values()) {
    if (session.timer) clearInterval(session.timer);
  }
}

module.exports = { setBroadcaster, start, stop, stopAll, applyMeterReading };

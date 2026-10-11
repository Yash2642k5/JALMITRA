'use strict';

const config = require('./config');

/** `WATER 4`, `water  4`, `PAANI 4`, or a bare `WATER` (falls back to record). */
function parseMessage(body) {
  const text = String(body || '').trim().replace(/\s+/g, ' ');
  const match = text.match(/^(water|paani|पानी)\b\s*(\d+)?$/i);
  if (!match) return { ok: false, text };
  return { ok: true, text, requestedMembers: match[2] ? Number(match[2]) : null };
}

/**
 * Quota is computed from the family size on record, never from the number
 * typed into the message — that is what stops a resident inflating it.
 */
function computeQuota(household, requestedMembers) {
  const members = household.registeredMembers;
  const raw = members * config.litresPerPerson;
  const litres = Math.min(raw, config.maxLitresPerHousehold);
  const capped = raw > config.maxLitresPerHousehold;

  let flagged = false;
  let flagNote = null;
  if (requestedMembers !== null && requestedMembers !== undefined) {
    const gap = requestedMembers - members;
    if (gap > config.familyMismatchThreshold) {
      flagged = true;
      flagNote = `Claimed ${requestedMembers} members, ${members} on record`;
    }
  }

  return { litres, members, requestedMembers, capped, flagged, flagNote };
}

module.exports = { parseMessage, computeQuota };

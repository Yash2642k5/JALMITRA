'use strict';

const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const config = require('../config');

const cfg = config.aws.cloudwatch;
let client = null;

const enabled = () => cfg.enabled;

function getClient() {
  if (!client) {
    client = new CloudWatchClient({ region: config.aws.region, credentials: config.aws.credentials });
  }
  return client;
}

/**
 * Operational metrics a water utility would actually page on: litres
 * delivered per ward, and claims refused because a tanker was too small.
 * Fire-and-forget — metrics must never block a dispense.
 */
function put(metricName, value, { ward, unit = 'None' } = {}) {
  if (!enabled()) return;

  const dimensions = ward ? [{ Name: 'Ward', Value: ward }] : [];
  getClient()
    .send(
      new PutMetricDataCommand({
        Namespace: cfg.namespace,
        MetricData: [{ MetricName: metricName, Value: value, Unit: unit, Dimensions: dimensions, Timestamp: new Date() }],
      })
    )
    .catch((err) => console.error('[cloudwatch] %s failed: %s', metricName, err.message));
}

module.exports = {
  enabled,
  litresDelivered: (litres, ward) => put('LitresDelivered', litres, { ward, unit: 'Count' }),
  claimBlocked: (reason, ward) => put('ClaimsBlocked', 1, { ward }),
  tokenIssued: (litres, ward) => put('QuotaReserved', litres, { ward, unit: 'Count' }),
  unclaimedLitres: (litres, ward) => put('UnclaimedLitres', litres, { ward, unit: 'Count' }),
  put,
};

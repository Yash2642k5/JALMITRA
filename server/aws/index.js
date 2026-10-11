'use strict';

const config = require('../config');
const sns = require('./sns');
const ddb = require('./ddb');
const s3 = require('./s3');
const metrics = require('./metrics');

/** What the dashboard shows in its AWS status strip. */
function status() {
  return {
    region: config.aws.region,
    credentials: config.aws.credentials ? 'env keys' : 'instance role / default chain',
    services: [
      { name: 'SNS', role: 'Ward broadcast + quota SMS', on: sns.enabled() },
      { name: 'DynamoDB', role: 'Ward registers + audit ledger', on: ddb.enabled() },
      { name: 'S3', role: 'QR images + ledger export', on: s3.enabled() },
      { name: 'CloudWatch', role: 'Litres and refusals', on: metrics.enabled() },
      { name: 'IoT Core', role: 'Flow-meter metering', on: config.aws.iot.enabled },
    ],
  };
}

module.exports = { sns, ddb, s3, metrics, status };

'use strict';

require('dotenv').config();

const num = (key, fallback) => {
  const raw = process.env[key];
  const parsed = Number(raw);
  return raw === undefined || raw === '' || Number.isNaN(parsed) ? fallback : parsed;
};

const bool = (key, fallback = false) => {
  const raw = (process.env[key] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
};

const str = (key, fallback = '') => (process.env[key] || fallback).trim();

const region = str('AWS_REGION', 'ap-south-1');

module.exports = {
  port: num('PORT', 3000),
  hmacSecret: str('HMAC_SECRET', 'jal-mitra-demo-secret-change-me'),

  // 40 L/person matches the 40-50 L/head/day that tanker delivery is observed
  // to work out to in practice. 20 L covers drinking and cooking only.
  litresPerPerson: num('LITRES_PER_PERSON', 40),
  maxLitresPerHousehold: num('MAX_LITRES_PER_HOUSEHOLD', 400),
  familyMismatchThreshold: num('FAMILY_MISMATCH_THRESHOLD', 1),

  defaultTankerCapacityLitres: num('DEFAULT_TANKER_CAPACITY_LITRES', 5000),
  defaultClaimWindowMinutes: num('DEFAULT_CLAIM_WINDOW_MINUTES', 120),
  tokenTtlMinutes: num('TOKEN_TTL_MINUTES', 30),
  dispenseRateLps: num('DISPENSE_RATE_LPS', 10),

  coordinatorLabel: str('COORDINATOR_LABEL', 'RWA Committee'),
  smsLanguage: str('SMS_LANGUAGE', 'both'),
  publicBaseUrl: str('PUBLIC_BASE_URL').replace(/\/$/, ''),

  aws: {
    region,
    credentials:
      str('AWS_ACCESS_KEY_ID') && str('AWS_SECRET_ACCESS_KEY')
        ? { accessKeyId: str('AWS_ACCESS_KEY_ID'), secretAccessKey: str('AWS_SECRET_ACCESS_KEY') }
        : undefined, // fall through to the EC2 / App Runner instance role

    sns: {
      enabled: bool('SNS_ENABLED'),
      senderId: str('SNS_SENDER_ID', 'JALMITRA'),
      smsType: str('SNS_SMS_TYPE', 'Transactional'),
      broadcastTopicArn: str('SNS_BROADCAST_TOPIC_ARN'),
    },
    ddb: {
      enabled: bool('DDB_ENABLED'),
      prefix: str('DDB_TABLE_PREFIX', 'jalmitra'),
    },
    s3: {
      enabled: bool('S3_ENABLED'),
      bucket: str('S3_BUCKET'),
      prefix: str('S3_PREFIX', 'jal-mitra'),
      urlTtlMinutes: num('S3_URL_TTL_MINUTES', 120),
    },
    cloudwatch: {
      enabled: bool('CLOUDWATCH_ENABLED'),
      namespace: str('CLOUDWATCH_NAMESPACE', 'JalMitra'),
    },
    iot: {
      enabled: bool('IOT_ENABLED'),
      topic: str('IOT_TOPIC', 'jalmitra/tanker/+/flow'),
      ingestKey: str('METER_INGEST_KEY'),
    },
  },

  twilio: {
    accountSid: str('TWILIO_ACCOUNT_SID'),
    authToken: str('TWILIO_AUTH_TOKEN'),
  },
};

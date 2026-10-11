'use strict';

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const config = require('../config');

const cfg = config.aws.sns;
let client = null;

const enabled = () => cfg.enabled;

function getClient() {
  if (!client) {
    client = new SNSClient({ region: config.aws.region, credentials: config.aws.credentials });
  }
  return client;
}

const toE164 = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+91' + digits; // demo registers are Indian numbers
  return '+' + digits.replace(/^0+/, '');
};

/**
 * Sends one SMS. Resolves to a result object either way — a failed send must
 * never break a water claim, it just falls back to the on-screen simulator.
 */
async function sendSms(phone, message) {
  if (!enabled()) return { sent: false, reason: 'sns_disabled' };

  const to = toE164(phone);
  if (!to) return { sent: false, reason: 'bad_number' };

  try {
    const out = await getClient().send(
      new PublishCommand({
        PhoneNumber: to,
        Message: message,
        MessageAttributes: {
          'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: cfg.senderId },
          'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: cfg.smsType },
        },
      })
    );
    return { sent: true, messageId: out.MessageId };
  } catch (err) {
    console.error('[sns] send failed for %s: %s', to, err.message);
    return { sent: false, reason: err.name || 'send_failed' };
  }
}

/** Ward broadcast: one SMS per household, plus an optional ops topic fan-out. */
async function broadcast(households, message) {
  if (!enabled()) return { sent: 0, failed: 0, enabled: false };

  const results = await Promise.all(households.map((h) => sendSms(h.phone, message)));
  const sent = results.filter((r) => r.sent).length;

  if (cfg.broadcastTopicArn) {
    try {
      await getClient().send(
        new PublishCommand({
          TopicArn: cfg.broadcastTopicArn,
          Subject: 'Jal-Mitra ward broadcast',
          Message: message,
        })
      );
    } catch (err) {
      console.error('[sns] topic publish failed: %s', err.message);
    }
  }

  return { sent, failed: results.length - sent, enabled: true };
}

module.exports = { enabled, sendSms, broadcast, toE164 };

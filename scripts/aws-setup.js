'use strict';

/**
 * One-shot provisioning:  npm run aws:setup
 *
 * Creates the DynamoDB tables Jal-Mitra uses and uploads the ward registers
 * from seed.js. Safe to re-run — existing tables are left alone.
 */

const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const config = require('../server/config');
const { HOUSEHOLDS } = require('../server/seed');

const TABLES = ['households', 'deliveries', 'tokens', 'events'];

const base = new DynamoDBClient({ region: config.aws.region, credentials: config.aws.credentials });
const doc = DynamoDBDocumentClient.from(base, { marshallOptions: { removeUndefinedValues: true } });

const name = (t) => `${config.aws.ddb.prefix}-${t}`;

async function exists(table) {
  try {
    await base.send(new DescribeTableCommand({ TableName: table }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function createTable(table) {
  if (await exists(table)) {
    console.log(`  = ${table} already exists`);
    return;
  }
  await base.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST', // stays inside the free tier for a demo
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    })
  );
  await waitUntilTableExists({ client: base, maxWaitTime: 120 }, { TableName: table });
  console.log(`  + ${table} created`);
}

async function main() {
  if (!config.aws.ddb.prefix) {
    console.error('DDB_TABLE_PREFIX is empty. Set it in .env first.');
    process.exit(1);
  }

  console.log(`\nRegion: ${config.aws.region}`);
  console.log(`Credentials: ${config.aws.credentials ? '.env keys' : 'default chain / instance role'}\n`);

  for (const t of TABLES) await createTable(name(t));

  console.log('\nSeeding ward registers...');
  for (const h of HOUSEHOLDS) {
    await doc.send(new PutCommand({ TableName: name('households'), Item: { ...h, litresServed: 0 } }));
  }
  console.log(`  + ${HOUSEHOLDS.length} households written to ${name('households')}`);

  console.log('\nDone. Set DDB_ENABLED=true in .env to use them.\n');
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});

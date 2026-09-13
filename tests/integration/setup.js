/**
 * Integration-test bootstrap.
 *
 * If MONGODB_URI is already set (CI provides a single-node replica set, so
 * real MongoDB transactions get exercised), we use it. Otherwise we spin up
 * mongodb-memory-server, which is standalone — that path exercises the
 * compensating-write fallback in ledgerService instead. Both are valid.
 *
 * Redis is intentionally left unconfigured unless REDIS_URL is set, which
 * exercises the in-memory cache fallback.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret';
process.env.PORT = process.env.PORT || '5000';
process.env.DISABLE_WORKER = 'true'; // no cron ticking during tests

const mongoose = require('mongoose');

// Starting an in-memory Mongo (or connecting to CI's) can take a while
jest.setTimeout(60000);

let mongoServer;

beforeAll(async () => {
  if (!process.env.MONGODB_URI) {
    // Required lazily so CI (which sets MONGODB_URI) never needs the binary
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
  }

  await mongoose.connect(process.env.MONGODB_URI);

  // Build the indexes the app relies on (including the partial unique index
  // that makes recurring payments idempotent)
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));

  const { initTransactionSupport } = require('../../src/utils/dbTransaction');
  await initTransactionSupport();
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  await mongoose.connection.close();
  if (mongoServer) await mongoServer.stop();
});

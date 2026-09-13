/**
 * Three test projects:
 *
 *  - unit:        pure functions, NO infrastructure. Runs anywhere, instantly.
 *  - queue:       the real BullMQ pipeline against a real Redis. Needs
 *                 REDIS_URL; no MongoDB required.
 *  - integration: the real Express app over a real MongoDB (a replica set in
 *                 CI so transactions are exercised; mongodb-memory-server
 *                 locally if MONGODB_URI isn't set).
 */
module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
    },
    {
      displayName: 'queue',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/queue/**/*.test.js'],
      setupFilesAfterEnv: ['<rootDir>/tests/queue/setup.js'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
      setupFilesAfterEnv: ['<rootDir>/tests/integration/setup.js'],
    },
  ],
};

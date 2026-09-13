require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const { reconcileUser } = require('../src/services/ledgerService');
const { formatPaise } = require('../src/utils/money');

/**
 * Verifies that every user's cached balance still equals the sum of their
 * ledger entries. Any drift means a bug (or a compensating write that
 * failed) — exits non-zero so this can run in CI or a cron job.
 */
const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const users = await User.find().select('_id name');
  const drifted = [];

  for (const user of users) {
    const report = await reconcileUser(user._id);
    const status = report.balanced ? '✅' : '❌';
    console.log(
      `${status} ${report.name.padEnd(16)} cached=${formatPaise(report.cachedPaise).padEnd(14)} ledger=${formatPaise(
        report.derivedPaise
      ).padEnd(14)} drift=${formatPaise(report.driftPaise)}`
    );
    if (!report.balanced) drifted.push(report);
  }

  console.log(`\n${users.length - drifted.length}/${users.length} accounts balanced.`);

  await mongoose.connection.close();

  if (drifted.length) {
    console.error(`\n❌ ${drifted.length} account(s) do not match the ledger.`);
    process.exit(1);
  }

  console.log('✅ All accounts reconcile exactly.');
  process.exit(0);
};

run().catch(async (err) => {
  console.error('Reconciliation failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});

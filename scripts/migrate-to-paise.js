require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Transaction = require('../src/models/Transaction');
const LedgerEntry = require('../src/models/LedgerEntry');
const { formatPaise } = require('../src/utils/money');

/**
 * One-time migration for databases created before the integer-paise + ledger
 * change. Safe to run more than once (each step skips already-migrated docs).
 *
 *   1. User.balance (rupees, float)      -> User.balancePaise (integer)
 *   2. Transaction.amount (rupees, float)-> Transaction.amountPaise (integer)
 *   3. Backfill Transaction.participants (powers the new indexed history query)
 *   4. Backfill ledger entries so every existing balance is backed by
 *      balanced double-entry records and reconciliation passes
 *
 * Run with:  node scripts/migrate-to-paise.js
 * Add --dry to preview without writing.
 */
const DRY_RUN = process.argv.includes('--dry');

// Rupee floats coming out of the old schema may be imprecise (0.30000000004),
// so round to the nearest paise rather than truncating.
const rupeeFloatToPaise = (rupees) => Math.round(Number(rupees || 0) * 100);

const migrate = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected. ${DRY_RUN ? 'DRY RUN — no writes will happen.' : 'Migrating...'}\n`);

  const db = mongoose.connection.db;

  // ---- 1. User balances ----
  const usersToFix = await db
    .collection('users')
    .find({ balance: { $exists: true }, balancePaise: { $exists: false } })
    .toArray();

  console.log(`Users needing balance migration: ${usersToFix.length}`);
  for (const user of usersToFix) {
    const paise = rupeeFloatToPaise(user.balance);
    console.log(`  ${user.name}: ${user.balance} -> ${formatPaise(paise)}`);
    if (!DRY_RUN) {
      await db
        .collection('users')
        .updateOne({ _id: user._id }, { $set: { balancePaise: paise }, $unset: { balance: '' } });
    }
  }

  // ---- 2. Transaction amounts ----
  const txnsToFix = await db
    .collection('transactions')
    .find({ amount: { $exists: true }, amountPaise: { $exists: false } })
    .toArray();

  console.log(`\nTransactions needing amount migration: ${txnsToFix.length}`);
  for (const txn of txnsToFix) {
    const paise = rupeeFloatToPaise(txn.amount);
    if (!DRY_RUN) {
      await db.collection('transactions').updateOne(
        { _id: txn._id },
        {
          $set: {
            amountPaise: paise,
            refundedPaise: rupeeFloatToPaise(txn.refunded || 0),
            category: txn.category || (txn.type === 'TRANSFER' ? 'TRANSFER' : 'OTHER'),
          },
          $unset: { amount: '' },
        }
      );
    }
  }

  // ---- 3. participants backfill ----
  const missingParticipants = await db
    .collection('transactions')
    .find({ participants: { $in: [null, []] } })
    .toArray();

  console.log(`\nTransactions needing participants backfill: ${missingParticipants.length}`);
  for (const txn of missingParticipants) {
    const participants = [txn.sender, txn.receiver].filter(Boolean);
    if (!DRY_RUN && participants.length) {
      await db.collection('transactions').updateOne({ _id: txn._id }, { $set: { participants } });
    }
  }

  // ---- 4. Ledger backfill ----
  // Pre-ledger transactions have no entries. Rather than reconstruct history
  // transaction by transaction (which can't be done reliably once balances
  // have drifted), post one opening-balance entry per user equal to their
  // current balance, so the ledger and the cached balance agree from now on.
  const ledgerCount = await LedgerEntry.estimatedDocumentCount();
  console.log(`\nExisting ledger entries: ${ledgerCount}`);

  if (ledgerCount === 0) {
    const users = await User.find().select('_id name balancePaise');
    console.log(`Posting opening ledger entries for ${users.length} users...`);

    for (const user of users) {
      if (!user.balancePaise) continue;
      if (DRY_RUN) {
        console.log(`  would open ${user.name} at ${formatPaise(user.balancePaise)}`);
        continue;
      }

      const [txn] = await Transaction.create([
        {
          receiver: user._id,
          participants: [user._id],
          type: 'ADD_MONEY',
          category: 'OTHER',
          billerName: 'Opening balance (migration)',
          amountPaise: user.balancePaise,
          status: 'SUCCESS',
        },
      ]);

      await LedgerEntry.create([
        {
          transaction: txn._id,
          account: null,
          externalAccount: 'BANK',
          direction: 'DEBIT',
          amountPaise: user.balancePaise,
        },
        {
          transaction: txn._id,
          account: user._id,
          direction: 'CREDIT',
          amountPaise: user.balancePaise,
          balanceAfterPaise: user.balancePaise,
        },
      ]);
    }
  } else {
    console.log('Ledger already has entries — skipping opening-balance backfill.');
  }

  // ---- 5. Ensure new indexes exist ----
  if (!DRY_RUN) {
    console.log('\nBuilding indexes...');
    await Promise.all([Transaction.syncIndexes(), LedgerEntry.syncIndexes(), User.syncIndexes()]);
  }

  console.log(`\n${DRY_RUN ? 'Dry run complete.' : '✅ Migration complete.'}`);
  console.log('Run `npm run reconcile` to verify every balance matches the ledger.');
  await mongoose.connection.close();
  process.exit(0);
};

migrate().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});

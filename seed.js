require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./src/models/User');
const Transaction = require('./src/models/Transaction');
const LedgerEntry = require('./src/models/LedgerEntry');
const PaymentRequest = require('./src/models/PaymentRequest');
const SplitBill = require('./src/models/SplitBill');
const RecurringPayment = require('./src/models/RecurringPayment');
const { postTransaction } = require('./src/services/ledgerService');
const { initTransactionSupport } = require('./src/utils/dbTransaction');
const { rupeesToPaise, formatPaise } = require('./src/utils/money');

const SEED_USERS = [
  { name: 'Amit Sharma', email: 'amit@example.com', phone: '9876543210', upiId: 'amit123@phonepe', openingRupees: 5000 },
  { name: 'Priya Singh', email: 'priya@example.com', phone: '9876543211', upiId: 'priya456@phonepe', openingRupees: 3000 },
  { name: 'Rahul Verma', email: 'rahul@example.com', phone: '9876543212', upiId: 'rahul789@phonepe', openingRupees: 1500 },
  { name: 'Neha Gupta', email: 'neha@example.com', phone: '9876543213', upiId: 'neha012@phonepe', openingRupees: 8000 },
];

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Database Connected for Seeding...');
    await initTransactionSupport();

    await Promise.all([
      User.deleteMany(),
      Transaction.deleteMany(),
      LedgerEntry.deleteMany(),
      PaymentRequest.deleteMany(),
      SplitBill.deleteMany(),
      RecurringPayment.deleteMany(),
    ]);
    console.log('Existing data cleared.');

    const salt = await bcrypt.genSalt(10);
    const password = await bcrypt.hash('password123', salt);
    const mpin = await bcrypt.hash('1234', salt);

    // Accounts start at zero; the opening balance is then posted through the
    // ledger so debits and credits balance from the very first paise.
    const created = await User.insertMany(
      SEED_USERS.map((u) => ({
        name: u.name,
        email: u.email,
        phone: u.phone,
        upiId: u.upiId,
        password,
        mpin,
        balancePaise: 0,
      }))
    );

    for (const [index, user] of created.entries()) {
      await postTransaction({
        type: 'ADD_MONEY',
        amountPaise: rupeesToPaise(String(SEED_USERS[index].openingRupees)),
        toUserId: user._id,
        billerName: 'Opening balance',
      });
    }

    // A couple of sample movements so history/analytics aren't empty
    await postTransaction({
      type: 'TRANSFER',
      amountPaise: rupeesToPaise('250.50'),
      fromUserId: created[0]._id,
      toUserId: created[1]._id,
    });
    await postTransaction({
      type: 'BILL_PAY',
      amountPaise: rupeesToPaise('799'),
      fromUserId: created[3]._id,
      billerName: 'Jio Mobile Recharge',
    });

    const finals = await User.find().select('name upiId balancePaise');
    console.log('\nSeed Users Imported Successfully!');
    finals.forEach((u) => console.log(`  ${u.name.padEnd(14)} ${u.upiId.padEnd(22)} ${formatPaise(u.balancePaise)}`));
    console.log('\nAll users share password: password123 | MPIN: 1234');

    process.exit();
  } catch (error) {
    console.error(`Error with Seeding: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
};

seed();

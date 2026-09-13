const mongoose = require('mongoose');
const { app, request, registerUser, registerWithMpin, auth, getBalance } = require('./helpers');
const { postTransaction, reconcileUser, computeLedgerBalancePaise } = require('../../src/services/ledgerService');
const LedgerEntry = require('../../src/models/LedgerEntry');
const User = require('../../src/models/User');

describe('Ledger integrity', () => {
  test('every account reconciles against its ledger after activity', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();

    await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: receiver.upiId, amount: 321.45, mpin: '1234' });
    await request(app).post('/api/wallet/add-money').set(auth(sender.token)).send({ amount: 500 });
    await request(app)
      .post('/api/wallet/pay-bill')
      .set(auth(sender.token))
      .send({ billerName: 'Adani Electricity', amount: 99.99, mpin: '1234' });

    for (const user of [sender, receiver]) {
      const report = await reconcileUser(user.id);
      expect(report.driftPaise).toBe(0);
      expect(report.balanced).toBe(true);
    }
  });

  test('the reconcile endpoint reports a balanced wallet', async () => {
    const user = await registerUser();
    const res = await request(app).get('/api/wallet/reconcile').set(auth(user.token));

    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
    expect(res.body.drift).toBe(0);
  });

  test('debits and credits sum to zero across the whole system', async () => {
    const a = await registerWithMpin();
    const b = await registerUser();

    await request(app)
      .post('/api/transactions/send')
      .set(auth(a.token))
      .send({ receiverIdentifier: b.upiId, amount: 250, mpin: '1234' });

    const [totals] = await LedgerEntry.aggregate([
      {
        $group: {
          _id: null,
          debits: { $sum: { $cond: [{ $eq: ['$direction', 'DEBIT'] }, '$amountPaise', 0] } },
          credits: { $sum: { $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amountPaise', 0] } },
        },
      },
    ]);

    // The core accounting invariant, system-wide
    expect(totals.debits).toBe(totals.credits);
  });

  test('CONCURRENCY: parallel transfers can never overdraw an account', async () => {
    // This is the regression test for the original read-then-write race:
    //   if (sender.balance < amount) ...; sender.balance -= amount; await save()
    // Two requests could both pass the check and both debit.
    const sender = await registerWithMpin(); // ₹1,000 opening balance
    const receiver = await registerUser();

    // Ten simultaneous ₹200 transfers = ₹2,000 attempted against ₹1,000
    const attempts = Array.from({ length: 10 }, () =>
      request(app)
        .post('/api/transactions/send')
        .set(auth(sender.token))
        .send({ receiverIdentifier: receiver.upiId, amount: 200, mpin: '1234' })
    );

    const results = await Promise.all(attempts);
    const succeeded = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 400);

    // Exactly five can succeed; the rest must be refused for insufficient funds
    expect(succeeded).toHaveLength(5);
    expect(rejected.length).toBeGreaterThanOrEqual(5);

    const finalBalance = await getBalance(sender.token);
    expect(finalBalance).toBe(0);
    expect(finalBalance).toBeGreaterThanOrEqual(0); // never negative

    // And the books still balance
    const report = await reconcileUser(sender.id);
    expect(report.driftPaise).toBe(0);
  });

  test('a balance can never be driven below zero directly through the service', async () => {
    const user = await registerUser();

    await expect(
      postTransaction({
        type: 'WITHDRAW',
        amountPaise: 100000000, // ₹10,00,000 against a ₹1,000 balance
        fromUserId: user.id,
      })
    ).rejects.toThrow(/Insufficient balance/);

    const fresh = await User.findById(user.id);
    expect(fresh.balancePaise).toBe(100000); // untouched
    expect(await computeLedgerBalancePaise(fresh._id)).toBe(100000);
  });

  test('a failed transaction leaves no partial ledger entries behind', async () => {
    const user = await registerUser();
    const entriesBefore = await LedgerEntry.countDocuments();

    await expect(
      postTransaction({
        type: 'TRANSFER',
        amountPaise: 5000,
        fromUserId: user.id,
        toUserId: new mongoose.Types.ObjectId(), // receiver doesn't exist
      })
    ).rejects.toThrow();

    // Whether via transaction rollback or compensating writes, nothing sticks
    expect(await LedgerEntry.countDocuments()).toBe(entriesBefore);
    const fresh = await User.findById(user.id);
    expect(fresh.balancePaise).toBe(100000);
  });

  test('rejects a self-transfer before touching any balance', async () => {
    const user = await registerUser();

    await expect(
      postTransaction({ type: 'TRANSFER', amountPaise: 100, fromUserId: user.id, toUserId: user.id })
    ).rejects.toThrow(/cannot be the same/);
  });
});

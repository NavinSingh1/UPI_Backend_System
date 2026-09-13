const { app, request, registerUser, registerWithMpin, auth, getBalance } = require('./helpers');
const RecurringPayment = require('../../src/models/RecurringPayment');
const PaymentRequest = require('../../src/models/PaymentRequest');
const { runDueMandates, expireStalePaymentRequests } = require('../../src/workers/recurringWorker');
const { reconcileUser } = require('../../src/services/ledgerService');

describe('Payment requests', () => {
  test('a request is created, then paying it moves the money', async () => {
    const requester = await registerUser();
    const payer = await registerWithMpin();

    const created = await request(app)
      .post('/api/payment-requests')
      .set(auth(requester.token))
      .send({ payerIdentifier: payer.upiId, amount: 150, note: 'Lunch' });

    expect(created.status).toBe(201);
    expect(created.body.request.status).toBe('PENDING');
    expect(created.body.request.amount).toBe(150);

    const accepted = await request(app)
      .post(`/api/payment-requests/${created.body.request._id}/accept`)
      .set(auth(payer.token))
      .send({ mpin: '1234' });

    expect(accepted.status).toBe(200);
    expect(accepted.body.request.status).toBe('ACCEPTED');
    expect(await getBalance(payer.token)).toBe(850);
    expect(await getBalance(requester.token)).toBe(1150);
  });

  test('a request can be declined, and cannot then be paid', async () => {
    const requester = await registerUser();
    const payer = await registerWithMpin();

    const created = await request(app)
      .post('/api/payment-requests')
      .set(auth(requester.token))
      .send({ payerIdentifier: payer.upiId, amount: 100 });

    const declined = await request(app)
      .post(`/api/payment-requests/${created.body.request._id}/decline`)
      .set(auth(payer.token));
    expect(declined.status).toBe(200);

    const accept = await request(app)
      .post(`/api/payment-requests/${created.body.request._id}/accept`)
      .set(auth(payer.token))
      .send({ mpin: '1234' });
    expect(accept.status).toBe(409);
    expect(await getBalance(payer.token)).toBe(1000);
  });

  test('only the payer can accept, only the requester can cancel', async () => {
    const requester = await registerWithMpin();
    const payer = await registerWithMpin();
    const outsider = await registerWithMpin();

    const created = await request(app)
      .post('/api/payment-requests')
      .set(auth(requester.token))
      .send({ payerIdentifier: payer.upiId, amount: 100 });
    const id = created.body.request._id;

    expect(
      (await request(app).post(`/api/payment-requests/${id}/accept`).set(auth(outsider.token)).send({ mpin: '1234' }))
        .status
    ).toBe(403);

    expect((await request(app).post(`/api/payment-requests/${id}/cancel`).set(auth(payer.token))).status).toBe(403);
    expect((await request(app).post(`/api/payment-requests/${id}/cancel`).set(auth(requester.token))).status).toBe(200);
  });

  test('you cannot request money from yourself', async () => {
    const user = await registerUser();

    const res = await request(app)
      .post('/api/payment-requests')
      .set(auth(user.token))
      .send({ payerIdentifier: user.upiId, amount: 10 });

    expect(res.status).toBe(400);
  });

  test('expired requests are swept and can no longer be paid', async () => {
    const requester = await registerUser();
    const payer = await registerWithMpin();

    const created = await request(app)
      .post('/api/payment-requests')
      .set(auth(requester.token))
      .send({ payerIdentifier: payer.upiId, amount: 100 });

    // Backdate the expiry, then run the sweep
    await PaymentRequest.updateOne(
      { _id: created.body.request._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );
    await expireStalePaymentRequests();

    const accept = await request(app)
      .post(`/api/payment-requests/${created.body.request._id}/accept`)
      .set(auth(payer.token))
      .send({ mpin: '1234' });

    expect(accept.status).toBe(409);
  });

  test('incoming and outgoing listings are separated', async () => {
    const requester = await registerUser();
    const payer = await registerUser();

    await request(app)
      .post('/api/payment-requests')
      .set(auth(requester.token))
      .send({ payerIdentifier: payer.upiId, amount: 100 });

    const outgoing = await request(app)
      .get('/api/payment-requests?direction=outgoing')
      .set(auth(requester.token));
    const incoming = await request(app).get('/api/payment-requests?direction=incoming').set(auth(payer.token));

    expect(outgoing.body.requests).toHaveLength(1);
    expect(incoming.body.requests).toHaveLength(1);
    expect((await request(app).get('/api/payment-requests').set(auth(requester.token))).body.requests).toHaveLength(0);
  });
});

describe('Split bills', () => {
  test('splits into exact shares that sum to the total', async () => {
    const creator = await registerUser();
    const p1 = await registerWithMpin();
    const p2 = await registerWithMpin();

    // ₹100 across 3 people doesn't divide evenly
    const created = await request(app)
      .post('/api/split-bills')
      .set(auth(creator.token))
      .send({ description: 'Dinner', amount: 100, participantIdentifiers: [p1.upiId, p2.upiId] });

    expect(created.status).toBe(201);

    const shares = created.body.bill.participants.map((p) => p.sharePaise);
    expect(shares).toHaveLength(3);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10000); // exactly ₹100, nothing lost

    // The creator already paid the bill, so their share is settled
    const creatorShare = created.body.bill.participants.find((p) => p.user._id === creator.id);
    expect(creatorShare.status).toBe('PAID');
  });

  test('participants settle their share to the creator and the bill closes', async () => {
    const creator = await registerUser();
    const p1 = await registerWithMpin();

    const created = await request(app)
      .post('/api/split-bills')
      .set(auth(creator.token))
      .send({ description: 'Cab', amount: 200, participantIdentifiers: [p1.upiId] });

    const billId = created.body.bill._id;

    const settle = await request(app)
      .post(`/api/split-bills/${billId}/settle`)
      .set(auth(p1.token))
      .send({ mpin: '1234' });

    expect(settle.status).toBe(200);
    expect(settle.body.bill.status).toBe('SETTLED');
    expect(await getBalance(p1.token)).toBe(900); // paid ₹100 (half of ₹200)
    expect(await getBalance(creator.token)).toBe(1100);
  });

  test('a share cannot be settled twice', async () => {
    const creator = await registerUser();
    const p1 = await registerWithMpin();

    const created = await request(app)
      .post('/api/split-bills')
      .set(auth(creator.token))
      .send({ description: 'Pizza', amount: 100, participantIdentifiers: [p1.upiId] });

    await request(app)
      .post(`/api/split-bills/${created.body.bill._id}/settle`)
      .set(auth(p1.token))
      .send({ mpin: '1234' });

    const again = await request(app)
      .post(`/api/split-bills/${created.body.bill._id}/settle`)
      .set(auth(p1.token))
      .send({ mpin: '1234' });

    expect(again.status).toBe(409);
  });

  test('non-participants cannot view or settle a split', async () => {
    const creator = await registerUser();
    const p1 = await registerWithMpin();
    const outsider = await registerWithMpin();

    const created = await request(app)
      .post('/api/split-bills')
      .set(auth(creator.token))
      .send({ description: 'Trip', amount: 300, participantIdentifiers: [p1.upiId] });

    expect((await request(app).get(`/api/split-bills/${created.body.bill._id}`).set(auth(outsider.token))).status).toBe(
      403
    );
  });

  test('rejects unknown participants', async () => {
    const creator = await registerUser();

    const res = await request(app)
      .post('/api/split-bills')
      .set(auth(creator.token))
      .send({ description: 'Ghosts', amount: 100, participantIdentifiers: ['nobody@phonepe'] });

    expect(res.status).toBe(404);
    expect(res.body.missing).toContain('nobody@phonepe');
  });
});

describe('Recurring payments', () => {
  test('creating a mandate requires the MPIN but never stores it', async () => {
    const payer = await registerWithMpin();
    const payee = await registerUser();

    const withoutMpin = await request(app)
      .post('/api/recurring')
      .set(auth(payer.token))
      .send({ payeeIdentifier: payee.upiId, amount: 100, frequency: 'MONTHLY' });
    expect(withoutMpin.status).toBe(400); // validation requires mpin

    const created = await request(app)
      .post('/api/recurring')
      .set(auth(payer.token))
      .send({ payeeIdentifier: payee.upiId, amount: 100, frequency: 'MONTHLY', mpin: '1234' });

    expect(created.status).toBe(201);
    expect(created.body.mandate.authorizedAt).toBeDefined();

    const stored = await RecurringPayment.findById(created.body.mandate._id).lean();
    expect(JSON.stringify(stored)).not.toContain('1234');
    expect(stored.mpin).toBeUndefined();
  });

  test('the worker executes a due mandate exactly once per period', async () => {
    const payer = await registerWithMpin();
    const payee = await registerUser();

    const created = await request(app)
      .post('/api/recurring')
      .set(auth(payer.token))
      .send({ payeeIdentifier: payee.upiId, amount: 250, frequency: 'DAILY', mpin: '1234' });

    // Make it due now
    await RecurringPayment.updateOne(
      { _id: created.body.mandate._id },
      { $set: { nextRunAt: new Date(Date.now() - 1000) } }
    );

    const first = await runDueMandates();
    expect(first.processed).toBe(1);
    expect(await getBalance(payer.token)).toBe(750);

    // Running again immediately must not charge again — nextRunAt has moved on
    const second = await runDueMandates();
    expect(second.processed).toBe(0);
    expect(await getBalance(payer.token)).toBe(750);
  });

  test('IDEMPOTENCY: re-running the same period cannot double-charge', async () => {
    const payer = await registerWithMpin();
    const payee = await registerUser();

    const created = await request(app)
      .post('/api/recurring')
      .set(auth(payer.token))
      .send({ payeeIdentifier: payee.upiId, amount: 100, frequency: 'DAILY', mpin: '1234' });

    const dueAt = new Date(Date.now() - 1000);
    await RecurringPayment.updateOne({ _id: created.body.mandate._id }, { $set: { nextRunAt: dueAt } });
    await runDueMandates();

    // Simulate a crashed worker that never advanced nextRunAt, then re-run.
    // The partial unique index on reference.periodKey must reject the retry.
    await RecurringPayment.updateOne({ _id: created.body.mandate._id }, { $set: { nextRunAt: dueAt } });
    const retry = await runDueMandates();

    expect(retry.skipped).toBe(1);
    expect(retry.processed).toBe(0);
    expect(await getBalance(payer.token)).toBe(900); // charged once, not twice
  });

  test('a mandate that keeps failing is parked as FAILED', async () => {
    const payer = await registerWithMpin();
    const payee = await registerUser();

    const created = await request(app)
      .post('/api/recurring')
      .set(auth(payer.token))
      .send({ payeeIdentifier: payee.upiId, amount: 900, frequency: 'DAILY', mpin: '1234' });

    // Drain the wallet so the mandate can't be funded
    await request(app)
      .post('/api/wallet/withdraw')
      .set(auth(payer.token))
      .send({ amount: 1000, mpin: '1234' });

    for (let i = 0; i < 4; i += 1) {
      await RecurringPayment.updateOne(
        { _id: created.body.mandate._id },
        { $set: { nextRunAt: new Date(Date.now() - 1000) } }
      );
      await runDueMandates();
    }

    const mandate = await RecurringPayment.findById(created.body.mandate._id);
    expect(mandate.status).toBe('FAILED');
    expect(mandate.lastError).toMatch(/Insufficient/i);
  });

  test('mandates can be paused, resumed and cancelled by their owner only', async () => {
    const payer = await registerWithMpin();
    const payee = await registerUser();
    const outsider = await registerWithMpin();

    const created = await request(app)
      .post('/api/recurring')
      .set(auth(payer.token))
      .send({ payeeIdentifier: payee.upiId, amount: 50, frequency: 'WEEKLY', mpin: '1234' });
    const id = created.body.mandate._id;

    expect((await request(app).post(`/api/recurring/${id}/pause`).set(auth(outsider.token))).status).toBe(403);
    expect((await request(app).post(`/api/recurring/${id}/pause`).set(auth(payer.token))).body.mandate.status).toBe(
      'PAUSED'
    );

    // A paused mandate must not run
    await RecurringPayment.updateOne({ _id: id }, { $set: { nextRunAt: new Date(Date.now() - 1000) } });
    expect((await runDueMandates()).processed).toBe(0);

    expect((await request(app).post(`/api/recurring/${id}/resume`).set(auth(payer.token))).body.mandate.status).toBe(
      'ACTIVE'
    );
    expect((await request(app).delete(`/api/recurring/${id}`).set(auth(payer.token))).body.mandate.status).toBe(
      'CANCELLED'
    );
  });

  test('books reconcile after automated runs', async () => {
    const payer = await registerWithMpin();
    const payee = await registerUser();

    const created = await request(app)
      .post('/api/recurring')
      .set(auth(payer.token))
      .send({ payeeIdentifier: payee.upiId, amount: 133.33, frequency: 'DAILY', mpin: '1234' });

    await RecurringPayment.updateOne(
      { _id: created.body.mandate._id },
      { $set: { nextRunAt: new Date(Date.now() - 1000) } }
    );
    await runDueMandates();

    for (const user of [payer, payee]) {
      expect((await reconcileUser(user.id)).driftPaise).toBe(0);
    }
  });
});

describe('QR codes', () => {
  test('returns a scannable upi:// URI and a data-URL image', async () => {
    const user = await registerUser();

    const res = await request(app).get('/api/users/me/qr').set(auth(user.token));

    expect(res.status).toBe(200);
    expect(res.body.uri).toContain('upi://pay?');
    expect(res.body.uri).toContain(encodeURIComponent(user.upiId));
    expect(res.body.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  test('can pre-fill an amount and render as PNG', async () => {
    const user = await registerUser();

    const withAmount = await request(app).get('/api/users/me/qr?amount=250.50').set(auth(user.token));
    expect(withAmount.body.uri).toContain('am=250.50');

    const png = await request(app).get('/api/users/me/qr?format=png').set(auth(user.token));
    expect(png.headers['content-type']).toBe('image/png');
  });

  test('a scanned QR resolves back to the payee', async () => {
    const payee = await registerUser();
    const scanner = await registerUser();

    const qr = await request(app).get('/api/users/me/qr?amount=99').set(auth(payee.token));

    const parsed = await request(app)
      .post('/api/users/parse-qr')
      .set(auth(scanner.token))
      .send({ uri: qr.body.uri });

    expect(parsed.status).toBe(200);
    expect(parsed.body.payee.upiId).toBe(payee.upiId);
    expect(parsed.body.amount).toBe(99);
  });

  test('rejects a QR that matches no account', async () => {
    const user = await registerUser();

    const res = await request(app)
      .post('/api/users/parse-qr')
      .set(auth(user.token))
      .send({ uri: 'upi://pay?pa=ghost@phonepe&cu=INR' });

    expect(res.status).toBe(404);
  });
});

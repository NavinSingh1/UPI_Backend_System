const { app, request, registerUser, registerWithMpin, auth, getBalance } = require('./helpers');

describe('Transactions', () => {
  test('send money by UPI ID moves the exact amount and records both sides', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();

    const send = await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: receiver.upiId, amount: 200.5, mpin: '1234' });

    expect(send.status).toBe(201);
    expect(send.body.newBalance).toBe(799.5);
    expect(send.body.transaction.amount).toBe(200.5);
    expect(send.body.transaction.amountPaise).toBe(20050); // exact integer paise

    expect(await getBalance(receiver.token)).toBe(1200.5);
  });

  test('send money by phone number also works', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();

    const send = await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: receiver.phone, amount: 50, mpin: '1234' });

    expect(send.status).toBe(201);
  });

  test('history includes the opening balance plus the transfer, newest first', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();

    await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: receiver.upiId, amount: 100, mpin: '1234' });

    const history = await request(app).get('/api/transactions/history').set(auth(sender.token));

    expect(history.status).toBe(200);
    // The opening balance is itself a ledger-backed ADD_MONEY transaction
    expect(history.body.pagination.total).toBe(2);
    expect(history.body.transactions[0].type).toBe('TRANSFER');
    expect(history.body.transactions[1].type).toBe('ADD_MONEY');
  });

  test('history filters by type and caps the page size', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();

    await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: receiver.upiId, amount: 10, mpin: '1234' });

    const filtered = await request(app)
      .get('/api/transactions/history?type=TRANSFER')
      .set(auth(sender.token));

    expect(filtered.body.transactions).toHaveLength(1);

    // ?limit=999999 must not dump the collection
    const capped = await request(app).get('/api/transactions/history?limit=999999').set(auth(sender.token));
    expect(capped.body.pagination.limit).toBeLessThanOrEqual(100);
  });

  test('idempotency key prevents a duplicate transfer on retry', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();

    const payload = { receiverIdentifier: receiver.upiId, amount: 100, mpin: '1234' };

    const first = await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'retry-key-1')
      .send(payload);

    const retry = await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'retry-key-1')
      .send(payload);

    expect(first.status).toBe(201);
    expect(retry.body.idempotent).toBe(true);
    expect(retry.body.transaction._id).toBe(first.body.transaction._id);
    expect(await getBalance(sender.token)).toBe(900); // debited once, not twice
  });

  test('rejects an unknown receiver and self-transfer', async () => {
    const sender = await registerWithMpin();

    const unknown = await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: 'nobody@phonepe', amount: 50, mpin: '1234' });
    expect(unknown.status).toBe(404);

    const self = await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: sender.upiId, amount: 50, mpin: '1234' });
    expect(self.status).toBe(400);
  });

  test('rejects amounts with more than two decimal places', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();

    const res = await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: receiver.upiId, amount: 10.999, mpin: '1234' });

    expect(res.status).toBe(400);
  });

  test('a transaction detail is visible only to its parties, and exposes its ledger', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();
    const outsider = await registerUser();

    const send = await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: receiver.upiId, amount: 50, mpin: '1234' });

    const txnId = send.body.transaction._id;

    const asSender = await request(app).get(`/api/transactions/${txnId}`).set(auth(sender.token));
    expect(asSender.status).toBe(200);
    // Two balanced ledger entries back every transaction
    expect(asSender.body.ledger).toHaveLength(2);
    const debits = asSender.body.ledger.filter((e) => e.direction === 'DEBIT');
    const credits = asSender.body.ledger.filter((e) => e.direction === 'CREDIT');
    expect(debits[0].amountPaise).toBe(credits[0].amountPaise);

    const asOutsider = await request(app).get(`/api/transactions/${txnId}`).set(auth(outsider.token));
    expect(asOutsider.status).toBe(403);
  });

  test('summary and analytics report spending in rupees', async () => {
    const user = await registerWithMpin();
    const receiver = await registerUser();

    await request(app)
      .post('/api/transactions/send')
      .set(auth(user.token))
      .send({ receiverIdentifier: receiver.upiId, amount: 120, mpin: '1234' });
    await request(app)
      .post('/api/wallet/pay-bill')
      .set(auth(user.token))
      .send({ billerName: 'Swiggy Order', amount: 80, mpin: '1234' });

    const summary = await request(app).get('/api/transactions/summary').set(auth(user.token));
    expect(summary.body.totalSent).toBe(120);
    expect(summary.body.totalBillsPaid).toBe(80);

    const analytics = await request(app).get('/api/transactions/analytics').set(auth(user.token));
    expect(analytics.body.totalSpent).toBe(200);
    const food = analytics.body.byCategory.find((c) => c.category === 'FOOD');
    expect(food.total).toBe(80); // "Swiggy" was auto-categorized
  });

  test('a category can be overridden by a party to the transaction', async () => {
    const user = await registerWithMpin();

    const bill = await request(app)
      .post('/api/wallet/pay-bill')
      .set(auth(user.token))
      .send({ billerName: 'Unknown Vendor', amount: 40, mpin: '1234' });

    const res = await request(app)
      .patch(`/api/transactions/${bill.body.transaction._id}/category`)
      .set(auth(user.token))
      .send({ category: 'SHOPPING' });

    expect(res.status).toBe(200);
    expect(res.body.transaction.category).toBe('SHOPPING');
  });

  test('statement downloads as CSV', async () => {
    const user = await registerWithMpin();

    const res = await request(app).get('/api/transactions/statement?format=csv').set(auth(user.token));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Transaction ID');
  });
});

const { app, request, registerUser, registerWithMpin, auth, getBalance } = require('./helpers');
const { reconcileUser } = require('../../src/services/ledgerService');

/** Sends money and returns the created transaction id. */
const sendMoney = async (sender, receiver, amount) => {
  const res = await request(app)
    .post('/api/transactions/send')
    .set(auth(sender.token))
    .send({ receiverIdentifier: receiver.upiId, amount, mpin: '1234' });
  return res.body.transaction._id;
};

describe('Refunds', () => {
  test('the receiver can refund a transfer in full', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerWithMpin();

    const txnId = await sendMoney(sender, receiver, 300);

    const refund = await request(app)
      .post(`/api/transactions/${txnId}/refund`)
      .set(auth(receiver.token))
      .send({ mpin: '1234' });

    expect(refund.status).toBe(201);
    expect(refund.body.transaction.type).toBe('REFUND');
    expect(refund.body.transaction.amount).toBe(300);

    expect(await getBalance(sender.token)).toBe(1000); // made whole
    expect(await getBalance(receiver.token)).toBe(1000);
  });

  test('supports a partial refund and tracks the remainder', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerWithMpin();

    const txnId = await sendMoney(sender, receiver, 500);

    const partial = await request(app)
      .post(`/api/transactions/${txnId}/refund`)
      .set(auth(receiver.token))
      .send({ amount: 200, mpin: '1234' });

    expect(partial.status).toBe(201);
    expect(await getBalance(sender.token)).toBe(700);

    const original = await request(app).get(`/api/transactions/${txnId}`).set(auth(receiver.token));
    expect(original.body.refunded).toBe(200);
    expect(original.body.status).toBe('SUCCESS'); // not fully reversed yet

    // A second partial refund of the remaining ₹300 closes it out
    const rest = await request(app)
      .post(`/api/transactions/${txnId}/refund`)
      .set(auth(receiver.token))
      .send({ amount: 300, mpin: '1234' });
    expect(rest.status).toBe(201);

    const closed = await request(app).get(`/api/transactions/${txnId}`).set(auth(receiver.token));
    expect(closed.body.status).toBe('REVERSED');
  });

  test('cannot refund more than was received', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerWithMpin();

    const txnId = await sendMoney(sender, receiver, 100);

    const tooMuch = await request(app)
      .post(`/api/transactions/${txnId}/refund`)
      .set(auth(receiver.token))
      .send({ amount: 150, mpin: '1234' });
    expect(tooMuch.status).toBe(400);

    await request(app)
      .post(`/api/transactions/${txnId}/refund`)
      .set(auth(receiver.token))
      .send({ mpin: '1234' });

    // Already fully refunded — a second attempt must be refused
    const again = await request(app)
      .post(`/api/transactions/${txnId}/refund`)
      .set(auth(receiver.token))
      .send({ mpin: '1234' });
    expect(again.status).toBe(400);
  });

  test('only the receiver can refund, not the sender', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerWithMpin();

    const txnId = await sendMoney(sender, receiver, 100);

    const bySender = await request(app)
      .post(`/api/transactions/${txnId}/refund`)
      .set(auth(sender.token))
      .send({ mpin: '1234' });

    expect(bySender.status).toBe(403);
  });

  test('a bill payment cannot be refunded peer-to-peer', async () => {
    const user = await registerWithMpin();

    const bill = await request(app)
      .post('/api/wallet/pay-bill')
      .set(auth(user.token))
      .send({ billerName: 'Jio', amount: 50, mpin: '1234' });

    const refund = await request(app)
      .post(`/api/transactions/${bill.body.transaction._id}/refund`)
      .set(auth(user.token))
      .send({ mpin: '1234' });

    expect(refund.status).toBe(400);
  });

  test('books still reconcile after refunds', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerWithMpin();

    const txnId = await sendMoney(sender, receiver, 250.75);
    await request(app)
      .post(`/api/transactions/${txnId}/refund`)
      .set(auth(receiver.token))
      .send({ amount: 100.25, mpin: '1234' });

    for (const user of [sender, receiver]) {
      expect((await reconcileUser(user.id)).driftPaise).toBe(0);
    }
  });
});

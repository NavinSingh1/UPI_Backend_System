const { app, request, registerUser, registerWithMpin, auth, getBalance } = require('./helpers');
const limits = require('../../src/config/limits');

describe('MPIN lockout', () => {
  test('locks the account after repeated wrong MPINs, regardless of IP', async () => {
    const sender = await registerWithMpin({ mpin: '1234' });
    const receiver = await registerUser();

    const attempt = (mpin) =>
      request(app)
        .post('/api/transactions/send')
        .set(auth(sender.token))
        .send({ receiverIdentifier: receiver.upiId, amount: 10, mpin });

    // The per-IP rate limiter wouldn't stop an attacker rotating IPs, so the
    // counter is keyed on the account instead.
    const statuses = [];
    for (let i = 0; i < limits.mpinMaxAttempts; i += 1) {
      const res = await attempt('9999');
      statuses.push(res.status);
    }

    expect(statuses.slice(0, -1).every((s) => s === 401)).toBe(true);
    expect(statuses[statuses.length - 1]).toBe(429); // locked out

    // Even the CORRECT MPIN is refused while the lock holds
    const correct = await attempt('1234');
    expect(correct.status).toBe(429);
    expect(correct.body.retryAfterSeconds).toBeGreaterThan(0);

    expect(await getBalance(sender.token)).toBe(1000); // nothing moved
  });

  test('reports how many attempts remain', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();

    const res = await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: receiver.upiId, amount: 10, mpin: '0000' });

    expect(res.status).toBe(401);
    expect(res.body.attemptsLeft).toBe(limits.mpinMaxAttempts - 1);
  });

  test('a correct MPIN clears the failure counter', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();

    const send = (mpin) =>
      request(app)
        .post('/api/transactions/send')
        .set(auth(sender.token))
        .send({ receiverIdentifier: receiver.upiId, amount: 10, mpin });

    await send('9999');
    await send('9999');
    expect((await send('1234')).status).toBe(201); // succeeds and resets

    const afterReset = await send('9999');
    expect(afterReset.body.attemptsLeft).toBe(limits.mpinMaxAttempts - 1);
  });
});

describe('Transaction limits', () => {
  test('rejects a single transfer above the per-transaction cap', async () => {
    const sender = await registerWithMpin({ topUpRupees: 100 });
    const receiver = await registerUser();

    const res = await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: receiver.upiId, amount: 200000, mpin: '1234' }); // ₹2 lakh

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/per-transaction limit/);
  });

  test('enforces the daily transaction count', async () => {
    const sender = await registerWithMpin({ topUpRupees: 1000 });
    const receiver = await registerUser();

    const send = () =>
      request(app)
        .post('/api/transactions/send')
        .set(auth(sender.token))
        .send({ receiverIdentifier: receiver.upiId, amount: 1, mpin: '1234' });

    const statuses = [];
    for (let i = 0; i < limits.dailyCount + 1; i += 1) {
      statuses.push((await send()).status);
    }

    // One more than the allowance must be refused
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  test('reports remaining headroom', async () => {
    const sender = await registerWithMpin();
    const receiver = await registerUser();

    await request(app)
      .post('/api/transactions/send')
      .set(auth(sender.token))
      .send({ receiverIdentifier: receiver.upiId, amount: 100, mpin: '1234' });

    const res = await request(app).get('/api/wallet/limits').set(auth(sender.token));

    expect(res.status).toBe(200);
    expect(res.body.daily.spent).toBe(100);
    expect(res.body.daily.remaining).toBe(res.body.daily.limit - 100);
    expect(res.body.daily.transactionsUsed).toBe(1);
  });
});

describe('Hardening', () => {
  test('sets security headers and echoes a correlation id', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    // helmet
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('reuses a caller-supplied X-Request-Id for tracing', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'trace-me-123');
    expect(res.headers['x-request-id']).toBe('trace-me-123');
  });

  test('unknown routes return a clean 404, not a stack trace', async () => {
    const res = await request(app).get('/api/nope');

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Route not found/);
    expect(res.text).not.toMatch(/at Object|node_modules/);
  });

  test('an invalid ObjectId is a 400, not a 500', async () => {
    const user = await registerUser();
    const res = await request(app).get('/api/transactions/not-an-id').set(auth(user.token));

    expect(res.status).toBe(400);
  });

  test('validation rejects weak passwords and bad phone numbers', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: 'A',
      email: 'not-an-email',
      phone: '123',
      password: 'short',
    });

    expect(res.status).toBe(400);
    expect(res.body.errors.length).toBeGreaterThanOrEqual(3);
  });
});

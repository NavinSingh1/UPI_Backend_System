const request = require('supertest');
const app = require('../src/app');

const registerAndLogin = async () => {
  const user = {
    name: 'Wallet Tester',
    email: `wallet${Date.now()}@example.com`,
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    password: 'password123',
  };
  const res = await request(app).post('/api/auth/register').send(user);
  return { token: res.body.token, user };
};

const setMpin = async (token, mpin = '1234') =>
  request(app).post('/api/auth/setup-mpin').set('Authorization', `Bearer ${token}`).send({ mpin });

describe('Wallet', () => {
  test('new users start with the default balance via /balance (cached)', async () => {
    const { token } = await registerAndLogin();
    const res = await request(app).get('/api/wallet/balance').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(1000);
  });

  test('add-money increases balance and invalidates the balance cache', async () => {
    const { token } = await registerAndLogin();

    await request(app).get('/api/wallet/balance').set('Authorization', `Bearer ${token}`); // warm the cache
    const add = await request(app).post('/api/wallet/add-money').set('Authorization', `Bearer ${token}`).send({ amount: 500 });
    expect(add.status).toBe(200);
    expect(add.body.balance).toBe(1500);

    const balance = await request(app).get('/api/wallet/balance').set('Authorization', `Bearer ${token}`);
    expect(balance.body.balance).toBe(1500); // must reflect the update, not a stale cached value
  });

  test('withdraw requires a correct MPIN and rejects insufficient balance', async () => {
    const { token } = await registerAndLogin();
    await setMpin(token, '1234');

    const noMpin = await request(app).post('/api/wallet/withdraw').set('Authorization', `Bearer ${token}`).send({ amount: 100, mpin: '9999' });
    expect(noMpin.status).toBe(401); // incorrect MPIN

    const tooMuch = await request(app)
      .post('/api/wallet/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 999999, mpin: '1234' });
    expect(tooMuch.status).toBe(400);

    const ok = await request(app).post('/api/wallet/withdraw').set('Authorization', `Bearer ${token}`).send({ amount: 100, mpin: '1234' });
    expect(ok.status).toBe(200);
    expect(ok.body.balance).toBe(900);
  });

  test('mini-statement returns at most 5 transactions', async () => {
    const { token } = await registerAndLogin();
    for (let i = 0; i < 7; i += 1) {
      await request(app).post('/api/wallet/add-money').set('Authorization', `Bearer ${token}`).send({ amount: 10 });
    }

    const res = await request(app).get('/api/wallet/mini-statement').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(5);
  });
});

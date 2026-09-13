const request = require('supertest');
const app = require('../../src/app');

let counter = 0;

/** Registers a fresh user and returns their token, ids and identifiers. */
const registerUser = async (overrides = {}) => {
  counter += 1;
  const unique = `${Date.now()}${counter}`;

  const payload = {
    name: overrides.name || `User ${counter}`,
    email: overrides.email || `user${unique}@example.com`,
    phone: overrides.phone || `9${String(unique).slice(-9).padStart(9, '0')}`,
    password: overrides.password || 'password123',
  };

  const res = await request(app).post('/api/auth/register').send(payload);
  if (res.status !== 201) {
    throw new Error(`registerUser failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  return {
    token: res.body.token,
    id: res.body._id,
    upiId: res.body.upiId,
    phone: payload.phone,
    email: payload.email,
    password: payload.password,
    balance: res.body.balance,
  };
};

const setMpin = (token, mpin = '1234') =>
  request(app).post('/api/auth/setup-mpin').set('Authorization', `Bearer ${token}`).send({ mpin });

/** Registers a user, sets their MPIN, and optionally tops up their wallet. */
const registerWithMpin = async (options = {}) => {
  const user = await registerUser(options);
  await setMpin(user.token, options.mpin || '1234');

  if (options.topUpRupees) {
    await request(app)
      .post('/api/wallet/add-money')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ amount: options.topUpRupees });
  }

  return user;
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const getBalance = async (token) => {
  const res = await request(app).get('/api/wallet/balance').set(auth(token));
  return res.body.balance;
};

module.exports = { app, request, registerUser, registerWithMpin, setMpin, auth, getBalance };

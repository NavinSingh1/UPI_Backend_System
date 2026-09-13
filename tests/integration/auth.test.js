const request = require('supertest');
const app = require('../src/app');

const newUser = () => ({
  name: 'Test User',
  email: `test${Date.now()}@example.com`,
  phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
  password: 'password123',
});

describe('Auth', () => {
  test('registers a new user and returns a token + UPI ID', async () => {
    const user = newUser();
    const res = await request(app).post('/api/auth/register').send(user);

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.upiId).toMatch(/@phonepe$/);
    expect(res.body.hasMpinSet).toBe(false);
  });

  test('rejects registration with an invalid phone number', async () => {
    const user = { ...newUser(), phone: '123' };
    const res = await request(app).post('/api/auth/register').send(user);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
  });

  test('rejects duplicate email/phone on register', async () => {
    const user = newUser();
    await request(app).post('/api/auth/register').send(user);
    const res = await request(app).post('/api/auth/register').send(user);

    expect(res.status).toBe(400);
  });

  test('logs in with correct credentials and rejects wrong password', async () => {
    const user = newUser();
    await request(app).post('/api/auth/register').send(user);

    const good = await request(app).post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(good.status).toBe(200);
    expect(good.body.token).toBeDefined();

    const bad = await request(app).post('/api/auth/login').send({ email: user.email, password: 'wrongpass' });
    expect(bad.status).toBe(401);
  });

  test('blocks /profile without a token, allows it with one', async () => {
    const user = newUser();
    const registered = await request(app).post('/api/auth/register').send(user);
    const token = registered.body.token;

    const noAuth = await request(app).get('/api/auth/profile');
    expect(noAuth.status).toBe(401);

    const withAuth = await request(app).get('/api/auth/profile').set('Authorization', `Bearer ${token}`);
    expect(withAuth.status).toBe(200);
    expect(withAuth.body.email).toBe(user.email);
  });

  test('logout blacklists the token so it can no longer be used', async () => {
    const user = newUser();
    const registered = await request(app).post('/api/auth/register').send(user);
    const token = registered.body.token;

    const logout = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBe(200);

    const afterLogout = await request(app).get('/api/auth/profile').set('Authorization', `Bearer ${token}`);
    expect(afterLogout.status).toBe(401);
  });

  test('deactivated accounts cannot log in again', async () => {
    const user = newUser();
    const registered = await request(app).post('/api/auth/register').send(user);
    const token = registered.body.token;

    const deactivate = await request(app).delete('/api/auth/account').set('Authorization', `Bearer ${token}`);
    expect(deactivate.status).toBe(200);

    const loginAgain = await request(app).post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(loginAgain.status).toBe(403);
  });
});

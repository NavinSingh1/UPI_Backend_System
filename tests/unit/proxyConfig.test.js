/**
 * Guards the trust-proxy configuration.
 *
 * This is a security setting, not a cosmetic one. Behind nginx, every request
 * arrives from the proxy's address; without `trust proxy` the per-IP rate
 * limiters bucket the entire internet together. And setting it to `true`
 * instead of a hop count would let a client forge X-Forwarded-For and choose
 * its own bucket. So both directions matter and both are asserted here.
 */
const loadApp = (env = {}) => {
  let app;
  jest.isolateModules(() => {
    const previous = { ...process.env };
    Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'test', LOG_LEVEL: 'silent' }, env);
    // eslint-disable-next-line global-require
    app = require('../../src/app');
    process.env = previous;
  });
  return app;
};

describe('trust proxy configuration', () => {
  test('is disabled by default (direct exposure, no proxy in front)', () => {
    const app = loadApp({ TRUST_PROXY_HOPS: '' });
    // Express default is false when never set
    expect(app.get('trust proxy')).toBeFalsy();
  });

  test('is set to the hop COUNT when running behind a proxy', () => {
    const app = loadApp({ TRUST_PROXY_HOPS: '1' });
    expect(app.get('trust proxy')).toBe(1);
  });

  test('is never the string/boolean `true`, which would allow XFF spoofing', () => {
    const app = loadApp({ TRUST_PROXY_HOPS: '2' });
    const setting = app.get('trust proxy');

    expect(setting).toBe(2);
    expect(setting).not.toBe(true);
    expect(setting).not.toBe('true');
  });

  test('exposes an instance id so a load-balanced request is attributable', () => {
    const app = loadApp({ INSTANCE_ID: 'api-7' });
    expect(app.INSTANCE_ID).toBe('api-7');
  });
});

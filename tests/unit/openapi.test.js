/**
 * Keeps the OpenAPI spec honest.
 *
 * The previous docs rotted to covering 8 of 47 routes because nothing
 * checked them. These tests walk the REAL Express router tree and compare it
 * against the spec in both directions, so adding a route without documenting
 * it (or documenting a route that doesn't exist) fails the build.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret';
process.env.LOG_LEVEL = 'silent';

const app = require('../../src/app');
const spec = require('../../src/docs/openapi');

/** Turns a mounted router's regexp back into its path prefix. */
const prefixFromLayer = (layer) => {
  if (layer.regexp?.fast_slash) return '';

  const source = layer.regexp?.source || '';
  const match = source.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/);
  if (match) return `/${match[1].replace(/\\\//g, '/')}`;

  return '';
};

/**
 * Makes an Express path comparable to an OpenAPI one:
 *   - `:param` becomes `{param}`
 *   - a trailing slash is dropped, because a router mounted at
 *     `/api/split-bills` with `router.post('/')` reports the path as
 *     `/api/split-bills/`, which is the same endpoint as `/api/split-bills`
 *     and is conventionally written without the slash in OpenAPI.
 */
const normalize = (routePath) => {
  const withParams = routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return withParams.length > 1 ? withParams.replace(/\/$/, '') : withParams;
};

/** Walks the router tree and returns every mounted route as "METHOD /path". */
const collectRoutes = (stack, prefix = '') => {
  const routes = [];

  for (const layer of stack) {
    if (layer.route) {
      const fullPath = normalize(`${prefix}${layer.route.path}`) || '/';
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled && method !== '_all') routes.push(`${method.toUpperCase()} ${fullPath}`);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      routes.push(...collectRoutes(layer.handle.stack, `${prefix}${prefixFromLayer(layer)}`));
    }
  }

  return routes;
};

const actualRoutes = [...new Set(collectRoutes(app._router.stack))].sort();

const documentedRoutes = Object.entries(spec.paths)
  .flatMap(([routePath, pathItem]) =>
    Object.keys(pathItem)
      .filter((key) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(key))
      .map((method) => `${method.toUpperCase()} ${routePath}`)
  )
  .sort();

describe('OpenAPI spec covers the real API surface', () => {
  test('the router walk actually found the routes (guards the test itself)', () => {
    // If the extraction broke, everything below would pass vacuously
    expect(actualRoutes.length).toBeGreaterThan(40);
    expect(actualRoutes).toContain('POST /api/auth/login');
    expect(actualRoutes).toContain('POST /api/transactions/send');
    expect(actualRoutes).toContain('DELETE /api/recurring/{id}');
  });

  test('every mounted route is documented', () => {
    const undocumented = actualRoutes.filter((route) => !documentedRoutes.includes(route));
    expect(undocumented).toEqual([]);
  });

  test('every documented route actually exists', () => {
    const phantom = documentedRoutes.filter((route) => !actualRoutes.includes(route));
    expect(phantom).toEqual([]);
  });

  test('counts match exactly', () => {
    expect(documentedRoutes.length).toBe(actualRoutes.length);
  });
});

describe('OpenAPI spec is well-formed', () => {
  test('declares the required top-level fields', () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
    expect(spec.servers.length).toBeGreaterThan(0);
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
  });

  test('every operation has a summary, a tag and a 2xx response', () => {
    const problems = [];

    for (const [routePath, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const where = `${method.toUpperCase()} ${routePath}`;
        if (!operation.summary) problems.push(`${where}: missing summary`);
        if (!operation.tags?.length) problems.push(`${where}: missing tag`);
        const has2xx = Object.keys(operation.responses || {}).some((code) => code.startsWith('2'));
        if (!has2xx) problems.push(`${where}: no 2xx response documented`);
      }
    }

    expect(problems).toEqual([]);
  });

  test('every tag used by an operation is declared', () => {
    const declared = new Set(spec.tags.map((t) => t.name));
    const used = new Set(
      Object.values(spec.paths).flatMap((pathItem) => Object.values(pathItem).flatMap((op) => op.tags || []))
    );

    expect([...used].filter((tag) => !declared.has(tag))).toEqual([]);
  });

  test('every $ref resolves — no typo\'d schema or response names', () => {
    const broken = [];

    const walk = (node) => {
      if (!node || typeof node !== 'object') return;

      if (typeof node.$ref === 'string') {
        const match = node.$ref.match(/^#\/components\/(schemas|responses|parameters)\/(.+)$/);
        if (!match) broken.push(node.$ref);
        else if (!spec.components[match[1]]?.[match[2]]) broken.push(node.$ref);
      }

      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else walk(value);
      }
    };

    walk(spec.paths);
    walk(spec.components.schemas);
    walk(spec.components.responses);

    expect(broken).toEqual([]);
  });

  test('protected routes inherit bearer auth, public ones opt out explicitly', () => {
    // Global security applies unless an operation overrides it with []
    expect(spec.security).toEqual([{ bearerAuth: [] }]);

    const publicOps = [];
    for (const [routePath, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (Array.isArray(operation.security) && operation.security.length === 0) {
          publicOps.push(`${method.toUpperCase()} ${routePath}`);
        }
      }
    }

    // Exactly the endpoints that work without a token
    expect(publicOps.sort()).toEqual(
      [
        'GET /',
        'GET /api-docs.json',
        'GET /health',
        'POST /api/auth/forgot-password',
        'POST /api/auth/login',
        'POST /api/auth/register',
        'POST /api/auth/reset-password',
      ].sort()
    );
  });

  test('money endpoints document the Idempotency-Key header', () => {
    const moneyEndpoints = [
      ['/api/transactions/send', 'post'],
      ['/api/transactions/{txnId}/refund', 'post'],
      ['/api/wallet/add-money', 'post'],
      ['/api/wallet/pay-bill', 'post'],
      ['/api/wallet/withdraw', 'post'],
      ['/api/payment-requests/{id}/accept', 'post'],
      ['/api/split-bills/{id}/settle', 'post'],
    ];

    for (const [routePath, method] of moneyEndpoints) {
      const params = spec.paths[routePath][method].parameters || [];
      const hasIdempotency = params.some((p) => p.name === 'Idempotency-Key' && p.in === 'header');
      expect(hasIdempotency).toBe(true);
    }
  });

  test('every endpoint requiring an MPIN documents the 401 and 429 paths', () => {
    for (const [routePath, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const schema = operation.requestBody?.content?.['application/json']?.schema;
        const requiresMpin = schema?.required?.includes('mpin');
        if (!requiresMpin) continue;

        expect(operation.responses['401']).toBeDefined();
      }
    }
  });
});

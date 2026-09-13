/**
 * Generates postman_collection.json from the OpenAPI spec.
 *
 * The spec is the single source of truth: adding an endpoint to
 * src/docs/openapi.js and re-running `npm run postman` keeps Swagger and
 * Postman in step, instead of the two drifting apart (which is how the old
 * collection ended up documenting 8 of 47 routes).
 *
 * On top of a plain conversion this adds the things that make a collection
 * actually usable: bearer auth wired to a variable, token capture on login,
 * ID chaining between requests so the folders can be run top to bottom, and
 * opt-in Idempotency-Key headers on the money endpoints.
 *
 * Run: npm run postman
 */
const fs = require('fs');
const path = require('path');
const spec = require('../src/docs/openapi');

const OUT_COLLECTION = path.join(__dirname, '..', 'postman_collection.json');
const OUT_ENVIRONMENT = path.join(__dirname, '..', 'postman_environment.json');

/** Folder order — also the sensible order to run them in. */
const TAG_ORDER = [
  'System',
  'Auth',
  'Users',
  'Wallet',
  'Transactions',
  'Payment Requests',
  'Split Bills',
  'Recurring',
  'Operations',
];

/**
 * Which response fields each request should stash into collection variables,
 * so later requests can reference {{txnId}}, {{requestId}} and so on.
 */
const CAPTURES = {
  'POST /api/auth/register': [
    ['token', 'token'],
    ['userId', '_id'],
    ['myUpiId', 'upiId'],
  ],
  'POST /api/auth/login': [
    ['token', 'token'],
    ['userId', '_id'],
    ['myUpiId', 'upiId'],
  ],
  'POST /api/transactions/send': [['txnId', 'transaction._id']],
  'POST /api/wallet/add-money': [['txnId', 'transaction._id']],
  'POST /api/wallet/pay-bill': [['txnId', 'transaction._id']],
  'POST /api/payment-requests': [['requestId', 'request._id']],
  'POST /api/split-bills': [['splitId', 'bill._id']],
  'POST /api/recurring': [['mandateId', 'mandate._id']],
};

/** `{id}` means different things per folder — map it to the right variable. */
const PATH_PARAM_VARS = {
  'Payment Requests': { id: 'requestId' },
  'Split Bills': { id: 'splitId' },
  Recurring: { id: 'mandateId' },
};

const varFor = (tag, paramName) => PATH_PARAM_VARS[tag]?.[paramName] || paramName;

/** Turns `/api/transactions/{txnId}` into Postman's `:txnId`-free `{{txnId}}` form. */
const toPostmanPath = (openApiPath, tag) =>
  openApiPath
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const match = segment.match(/^\{(.+)\}$/);
      return match ? `{{${varFor(tag, match[1])}}}` : segment;
    });

/** Pulls the example request body the spec already documents. */
const bodyFor = (operation) => {
  const json = operation.requestBody?.content?.['application/json'];
  if (!json) return undefined;

  const example = json.example || exampleFromSchema(json.schema);
  if (!example) return undefined;

  return {
    mode: 'raw',
    raw: JSON.stringify(example, null, 2),
    options: { raw: { language: 'json' } },
  };
};

/** Fallback: synthesize an example from a schema's own `example` hints. */
const exampleFromSchema = (schema) => {
  if (!schema || schema.type !== 'object' || !schema.properties) return undefined;

  const out = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.example !== undefined) out[key] = prop.example;
    else if (prop.default !== undefined) out[key] = prop.default;
    else if (prop.enum) [out[key]] = prop.enum;
  }
  return Object.keys(out).length ? out : undefined;
};

const queryParamsFor = (operation, tag) =>
  (operation.parameters || [])
    .filter((p) => p.in === 'query')
    .map((p) => ({
      key: p.name,
      value: String(p.example ?? p.schema?.example ?? p.schema?.default ?? ''),
      description: p.description || '',
      // Optional filters start disabled so the request works as-is
      disabled: !p.required,
    }));

const headersFor = (operation) => {
  const headers = [];

  if (operation.requestBody) {
    headers.push({ key: 'Content-Type', value: 'application/json' });
  }

  for (const param of operation.parameters || []) {
    if (param.in !== 'header') continue;

    if (param.name === 'Idempotency-Key') {
      headers.push({
        key: 'Idempotency-Key',
        value: '{{$guid}}',
        description: param.description,
        // Opt-in: enable it to prove that a retry replays instead of re-charging
        disabled: true,
      });
    } else {
      headers.push({
        key: param.name,
        value: String(param.example ?? ''),
        description: param.description,
        disabled: true,
      });
    }
  }

  return headers;
};

/** Test script: assert the expected status, and capture any chained ids. */
const testScriptFor = (key, operation) => {
  const successCode = Object.keys(operation.responses).find((code) => code.startsWith('2')) || '200';
  const lines = [
    `pm.test("status is ${successCode}", function () {`,
    `    pm.response.to.have.status(${successCode});`,
    '});',
  ];

  const captures = CAPTURES[key];
  if (captures) {
    lines.push('', 'const body = pm.response.json();');
    for (const [variable, jsonPath] of captures) {
      const accessor = jsonPath
        .split('.')
        .map((part) => `?.${part}`)
        .join('')
        .slice(1);
      lines.push(
        `if (body${accessor.startsWith('?') ? accessor : `?.${accessor}`}) {`,
        `    pm.collectionVariables.set("${variable}", body${accessor.startsWith('?') ? accessor : `?.${accessor}`});`,
        `    console.log("saved ${variable} =", pm.collectionVariables.get("${variable}"));`,
        '}'
      );
    }
  }

  return lines;
};

// ---------------------------------------------------------------------------

const foldersByTag = new Map();
let requestCount = 0;

for (const [routePath, pathItem] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    const tag = operation.tags?.[0] || 'Other';
    const key = `${method.toUpperCase()} ${routePath}`;

    const item = {
      name: operation.summary || key,
      request: {
        method: method.toUpperCase(),
        header: headersFor(operation),
        ...(bodyFor(operation) ? { body: bodyFor(operation) } : {}),
        url: {
          raw: `{{baseUrl}}${routePath}`,
          host: ['{{baseUrl}}'],
          path: toPostmanPath(routePath, tag),
          ...(queryParamsFor(operation, tag).length ? { query: queryParamsFor(operation, tag) } : {}),
        },
        description: operation.description || operation.summary || '',
        // Public endpoints opt out of the collection's bearer auth
        ...(Array.isArray(operation.security) && operation.security.length === 0 ? { auth: { type: 'noauth' } } : {}),
      },
      event: [
        {
          listen: 'test',
          script: { type: 'text/javascript', exec: testScriptFor(key, operation) },
        },
      ],
      response: [],
    };

    if (!foldersByTag.has(tag)) foldersByTag.set(tag, []);
    foldersByTag.get(tag).push(item);
    requestCount += 1;
  }
}

const orderedTags = [
  ...TAG_ORDER.filter((tag) => foldersByTag.has(tag)),
  ...[...foldersByTag.keys()].filter((tag) => !TAG_ORDER.includes(tag)),
];

const collection = {
  info: {
    _postman_id: 'b7f3c9a2-1d4e-4a8b-9c6f-phonepe000001',
    name: `${spec.info.title} v${spec.info.version}`,
    description: spec.info.description,
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: {
    type: 'bearer',
    bearer: [{ key: 'token', value: '{{token}}', type: 'string' }],
  },
  event: [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: [
          '// Warn early rather than letting every request 401',
          "if (!pm.collectionVariables.get('token') && pm.request.auth && pm.request.auth.type !== 'noauth') {",
          "    console.warn('No {{token}} set — run \"Log in and receive a JWT\" first.');",
          '}',
        ],
      },
    },
  ],
  variable: [
    { key: 'baseUrl', value: 'http://localhost:5000', type: 'string' },
    { key: 'token', value: '', type: 'string' },
    { key: 'userId', value: '', type: 'string' },
    { key: 'myUpiId', value: '', type: 'string' },
    { key: 'txnId', value: '', type: 'string' },
    { key: 'requestId', value: '', type: 'string' },
    { key: 'splitId', value: '', type: 'string' },
    { key: 'mandateId', value: '', type: 'string' },
  ],
  item: orderedTags.map((tag, index) => ({
    name: `${index + 1}. ${tag}`,
    description: spec.tags.find((t) => t.name === tag)?.description || '',
    item: foldersByTag.get(tag),
  })),
};

const environment = {
  id: 'c8e4d0b3-2e5f-4b9c-8d7a-phonepe000002',
  name: 'PhonePe Clone — Local',
  values: [
    { key: 'baseUrl', value: 'http://localhost:5000', enabled: true },
    { key: 'token', value: '', enabled: true },
    { key: 'userId', value: '', enabled: true },
    { key: 'myUpiId', value: '', enabled: true },
    { key: 'txnId', value: '', enabled: true },
    { key: 'requestId', value: '', enabled: true },
    { key: 'splitId', value: '', enabled: true },
    { key: 'mandateId', value: '', enabled: true },
  ],
  _postman_variable_scope: 'environment',
};

fs.writeFileSync(OUT_COLLECTION, `${JSON.stringify(collection, null, 2)}\n`);
fs.writeFileSync(OUT_ENVIRONMENT, `${JSON.stringify(environment, null, 2)}\n`);

console.log(`✅ Postman collection written: ${path.relative(process.cwd(), OUT_COLLECTION)}`);
console.log(`   ${requestCount} requests across ${orderedTags.length} folders`);
orderedTags.forEach((tag, i) => console.log(`     ${i + 1}. ${tag} (${foldersByTag.get(tag).length})`));
console.log(`✅ Postman environment written: ${path.relative(process.cwd(), OUT_ENVIRONMENT)}`);

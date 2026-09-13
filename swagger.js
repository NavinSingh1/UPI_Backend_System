/**
 * Writes swagger-output.json from the OpenAPI spec in src/docs/openapi.js.
 *
 * Previously this used swagger-autogen, which had to boot server.js (and so
 * needed a live MongoDB) and produced Swagger 2.0 with no request or response
 * schemas. The spec is now hand-authored and this script just serializes it,
 * so it runs anywhere in under a second.
 *
 * /api-docs serves the module directly, so you only need this file if you
 * want the JSON on disk (for static hosting, client codegen, or importing
 * into another tool).
 *
 * Run: npm run swagger
 */
const fs = require('fs');
const path = require('path');
const spec = require('./src/docs/openapi');

const outputFile = path.join(__dirname, 'swagger-output.json');
fs.writeFileSync(outputFile, `${JSON.stringify(spec, null, 2)}\n`);

const operations = Object.values(spec.paths).reduce(
  (total, pathItem) => total + Object.keys(pathItem).filter((k) => k !== 'parameters').length,
  0
);

console.log(`✅ OpenAPI ${spec.openapi} written to swagger-output.json`);
console.log(`   ${Object.keys(spec.paths).length} paths, ${operations} operations, ${spec.tags.length} tags`);
console.log('   Swagger UI: http://localhost:5000/api-docs');

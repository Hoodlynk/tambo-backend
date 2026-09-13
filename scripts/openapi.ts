import fs from 'fs';
import path from 'path';
import { buildOpenApiDocument } from '../src/openapi/generate';

/**
 * Emits the OpenAPI document to openapi/openapi.json - the committed artifact
 * client generators consume (`npm run client:ts`). Run after any change to a
 * validation schema or the endpoint registry; CI diffs the output.
 */
const outDir = path.join(__dirname, '..', 'openapi');
const outFile = path.join(outDir, 'openapi.json');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  outFile,
  `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`,
);

console.log(`OpenAPI document written to ${path.relative(process.cwd(), outFile)}`);

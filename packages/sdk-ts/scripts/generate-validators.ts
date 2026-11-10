import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standalone from 'ajv/dist/standalone/index.js';
import { build } from 'esbuild';
import type { OpenAPIV3_1 } from 'openapi-types';

const contract = fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url));
const output = new URL('../src/validation.generated.ts', import.meta.url);
const document = await SwaggerParser.dereference(contract) as OpenAPIV3_1.Document;
const ajv = new Ajv2020({ strict: false, code: { source: true, esm: true } });
addFormats.default(ajv);
const exports: Record<string, string> = {};
for (const name of ['SavePreparation', 'SaveRecord', 'SaveResult', 'SaveList', 'SaveUpload', 'SaveObjects', 'SaveMutation', 'AchievementList', 'PlayerProfile', 'LeaderboardPage', 'MyScore', 'SubmitScoreResult', 'SubmitScoreRequest', 'UpdatePlayerRequest', 'ApiError']) {
  const schema = document.components?.schemas?.[name];
  if (!schema) throw new Error(`Missing contract schema: ${name}`);
  ajv.addSchema(schema, name);
  exports[name] = name;
}
const result = await build({
  stdin: { contents: standalone.default(ajv, exports), resolveDir: fileURLToPath(new URL('../../../', import.meta.url)) },
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false,
  minify: true, legalComments: 'none',
});
const code = '// @ts-nocheck\n// Generated from packages/contracts/openapi.yaml. Run pnpm --filter @supagame/sdk-ts validators:generate.\n// Standalone validation: no runtime schema compilation, eval, Node APIs or dependencies.\n// Bundled MIT-licensed helpers: see ../THIRD_PARTY_NOTICES.md.\n' + result.outputFiles[0]!.text;
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== code) throw new Error('SDK validators are stale. Run pnpm --filter @supagame/sdk-ts validators:generate.');
} else {
  await writeFile(output, code);
}

import assert from 'node:assert/strict';
import { Ajv2020 } from 'npm:ajv@8.20.0/dist/2020.js';
import addFormats from 'npm:ajv-formats@3.0.1';
import { parse } from 'npm:yaml@2.9.1';

const contract = parse(
  await Deno.readTextFile(new URL('../../packages/contracts/openapi.yaml', import.meta.url)),
);
const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
ajv.addSchema(contract, 'contract');
export function assertSchema(name: string, value: unknown): void {
  const validate = ajv.getSchema(`contract#/components/schemas/${name}`);
  assert.ok(validate, `Schema ${name} exists`);
  // Do not dump response data or credentials into failed-test output.
  assert.ok(validate(value), `Response satisfies the ${name} OpenAPI schema`);
}

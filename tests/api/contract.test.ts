import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { OpenAPIV3_1 } from 'openapi-types';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiError, LeaderboardEntry, LeaderboardPage, LeaderboardSummary, MyScore,
  PlayerProfile, SubmitScoreRequest, SubmitScoreResult,
} from '../../packages/contracts/src/types.js';

const contractPath = fileURLToPath(new URL('../../packages/contracts/openapi.yaml', import.meta.url));
const routes = [
  ['/leaderboards', 'get', false],
  ['/leaderboards/{id}/entries', 'get', false],
  ['/leaderboards/{id}/me', 'get', true],
  ['/leaderboards/{id}/scores', 'post', true],
  ['/players/me', 'get', true],
  ['/players/me', 'patch', true],
] as const;

let document: OpenAPIV3_1.Document;
let resolved: OpenAPIV3_1.Document;
const ajv = new Ajv2020({ strict: false });
// ajv-formats exposes its typed plugin through the CommonJS default property.
addFormats.default(ajv);

function operation(path: string, method: 'get' | 'post' | 'patch') {
  const value = document.paths?.[path]?.[method];
  if (!value) throw new Error(`Missing operation: ${method} ${path}`);
  return value;
}

function schema(name: string) {
  const value = resolved.components?.schemas?.[name];
  if (!value) throw new Error(`Missing schema: ${name}`);
  return value;
}

beforeAll(async () => {
  document = parse(await readFile(contractPath, 'utf8')) as OpenAPIV3_1.Document;
  resolved = await SwaggerParser.dereference(contractPath) as OpenAPIV3_1.Document;
});

describe('v1 HTTP contract', () => {
  it('is a valid OpenAPI 3.1 document with the versioned function base path', async () => {
    await expect(SwaggerParser.validate(contractPath)).resolves.toBeDefined();
    expect(document.openapi).toMatch(/^3\.1\./);
    expect(document.servers).toEqual([{ url: '/functions/v1/supagame/v1' }]);
  });

  it.each(routes)('%s %s declares method-specific authentication', (path, method, authenticated) => {
    expect(operation(path, method).security).toEqual([
      authenticated ? { PublishableKey: [], PlayerSession: [] } : { PublishableKey: [] },
    ]);
  });

  it('defines the publishable-key and verified player JWT headers', () => {
    expect(document.components?.securitySchemes).toEqual({
      PublishableKey: expect.objectContaining({ type: 'apiKey', in: 'header', name: 'apikey' }),
      PlayerSession: expect.objectContaining({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }),
    });
  });

  it('bounds page size to 1–100 with a default of 50 and accepts a cursor', () => {
    expect(operation('/leaderboards/{id}/entries', 'get').parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }),
      expect.objectContaining({ name: 'cursor', in: 'query', schema: expect.objectContaining({ type: 'string' }) }),
    ]));
  });

  it('references the named DTOs for every success response', () => {
    const responseSchema = (path: string, method: 'get' | 'post' | 'patch') => {
      const response = operation(path, method).responses?.['200'];
      if (!response || '$ref' in response) throw new Error('Missing concrete success response');
      return response.content?.['application/json']?.schema;
    };
    expect(responseSchema('/leaderboards', 'get')).toEqual({ type: 'array', items: { $ref: '#/components/schemas/LeaderboardSummary' } });
    expect(responseSchema('/leaderboards/{id}/entries', 'get')).toEqual({ $ref: '#/components/schemas/LeaderboardPage' });
    expect(responseSchema('/leaderboards/{id}/me', 'get')).toEqual({ anyOf: [{ $ref: '#/components/schemas/MyScore' }, { type: 'null' }] });
    expect(responseSchema('/leaderboards/{id}/scores', 'post')).toEqual({ $ref: '#/components/schemas/SubmitScoreResult' });
    for (const method of ['get', 'patch'] as const) {
      expect(responseSchema('/players/me', method)).toEqual({ $ref: '#/components/schemas/PlayerProfile' });
    }
    for (const name of ['LeaderboardSummary', 'LeaderboardEntry', 'LeaderboardPage', 'MyScore', 'SubmitScoreRequest', 'SubmitScoreResult', 'PlayerProfile', 'ApiError']) {
      expect(document.components?.schemas).toHaveProperty(name);
    }
  });

  it.each(routes)('%s %s uses one flat ApiError shape for every error', (path, method) => {
    const responses = resolved.paths?.[path]?.[method]?.responses ?? {};
    const errors = Object.entries(responses).filter(([status]) => Number(status) >= 400 || status === 'default');
    expect(errors.length).toBeGreaterThan(0);
    for (const [, response] of errors) {
      if ('$ref' in response) throw new Error('Expected dereferenced response');
      expect(response.content?.['application/json']?.schema).toEqual(schema('ApiError'));
    }
  });

  it.each([0, -42, 42, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])('accepts the safe integer score %s', (score) => {
    const request: SubmitScoreRequest = { score, submissionKey: '2d62da2c-7e2c-462f-88bd-d0d320f41aa1' };
    expect(ajv.compile(schema('SubmitScoreRequest'))(request)).toBe(true);
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, '42', null])('rejects non-safe-integer scores: %s', (score) => {
    expect(ajv.compile(schema('SubmitScoreRequest'))({ score, submissionKey: '2d62da2c-7e2c-462f-88bd-d0d320f41aa1' })).toBe(false);
  });

  it('rejects a forged player ID and missing submission fields', () => {
    const validate = ajv.compile(schema('SubmitScoreRequest'));
    expect(validate({ score: 42, submissionKey: '2d62da2c-7e2c-462f-88bd-d0d320f41aa1', playerId: 'forged' })).toBe(false);
    expect(validate({ score: 42 })).toBe(false);
    expect(validate({ submissionKey: '2d62da2c-7e2c-462f-88bd-d0d320f41aa1' })).toBe(false);
    expect(validate({ score: 42, submissionKey: 'not-a-uuid' })).toBe(false);
  });

  it.each([
    ['/leaderboards/{id}/scores', 'post', 'SubmitScoreRequest'],
    ['/players/me', 'patch', 'UpdatePlayerRequest'],
  ] as const)('%s %s requires its documented JSON request', (path, method, name) => {
    expect(operation(path, method).requestBody).toMatchObject({
      required: true,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
    });
  });

  it('constrains display names and rejects profile identity overrides', () => {
    const validate = ajv.compile(schema('UpdatePlayerRequest'));
    for (const displayName of ['abc', 'a'.repeat(24), 'Player One']) {
      expect(validate({ displayName })).toBe(true);
    }
    for (const displayName of ['', 'ab', 'a'.repeat(25), 'bad\nname', 'bad\u007fname', null]) {
      expect(validate({ displayName })).toBe(false);
    }
    expect(validate({ displayName: 'Player One', playerId: 'forged' })).toBe(false);
  });

  it.each([
    ['LeaderboardEntry', 'score'], ['MyScore', 'score'],
    ['SubmitScoreResult', 'score'], ['SubmitScoreResult', 'bestScore'],
  ])('%s.%s uses JSON-safe integer bounds', (name, property) => {
    const definition = schema(name) as OpenAPIV3_1.SchemaObject;
    expect(definition.properties?.[property]).toMatchObject({
      type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER,
    });
  });

  it('validates representative typed DTOs, including null names and empty pages', () => {
    const board = { id: 'level-1', kind: 'time', sortDirection: 'asc', minValue: 0, maxValue: null } satisfies LeaderboardSummary;
    const entry = { playerId: '2d62da2c-7e2c-462f-88bd-d0d320f41aa1', displayName: null, score: 42, rank: 1, achievedAt: '2026-11-08T12:00:00Z' } satisfies LeaderboardEntry;
    const mine = { ...entry } satisfies MyScore;
    const page = { entries: [entry], nextCursor: null } satisfies LeaderboardPage;
    const result = { outcome: 'not_best', score: 50, bestScore: 42 } satisfies SubmitScoreResult;
    const player = { playerId: entry.playerId, displayName: 'Player One', createdAt: entry.achievedAt } satisfies PlayerProfile;
    const error = { code: 'UNAUTHORIZED', message: 'A valid player session is required.' } satisfies ApiError;
    for (const [name, value] of Object.entries({ LeaderboardSummary: board, LeaderboardEntry: entry, MyScore: mine, LeaderboardPage: page, SubmitScoreResult: result, PlayerProfile: player, ApiError: error })) {
      const validate = ajv.compile(schema(name));
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(ajv.compile(schema('LeaderboardPage'))({ entries: [], nextCursor: null })).toBe(true);
    expect(ajv.compile(schema('SubmitScoreResult'))({ ...result, outcome: 'best' })).toBe(true);
    expect(ajv.compile(schema('SubmitScoreResult'))({ ...result, outcome: 'rejected' })).toBe(false);
    expect(ajv.compile(schema('ApiError'))({ error })).toBe(false);
  });
});

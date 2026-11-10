import { ApiFailure } from './responses.ts';
import type { Json } from './types.ts';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 4096;
// JSON.parse can round a fractional/underflowing literal into an integer. Check
// its original decimal spelling as well, without allocating huge powers of ten.
function exactInteger(value: number, source: string): boolean {
  if (!Number.isSafeInteger(value)) return false;
  const [coefficient = '', exponent = '0'] = source.toLowerCase().split('e');
  const negative = coefficient.startsWith('-');
  const [whole = '', fraction = ''] = coefficient.replace(/^-/, '').split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return value === 0;
  const scale = Number(exponent) - fraction.length;
  if (!Number.isSafeInteger(scale)) return false;
  let integer: bigint;
  if (scale >= 0) {
    if (digits.length + scale > 16) return false;
    integer = BigInt(digits) * 10n ** BigInt(scale);
  } else {
    if (-scale >= digits.length || !/^0+$/.test(digits.slice(scale))) return false;
    integer = BigInt(digits.slice(0, scale));
  }
  return (negative ? -integer : integer) === BigInt(value);
}
function parseJson(
  text: string,
  precisionError: 'INVALID_SCORE' | 'INVALID_CURSOR',
  scores = true,
): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (key.includes('\u0000') || !key.isWellFormed()) {
      throw new ApiFailure(
        precisionError === 'INVALID_CURSOR' ? 'INVALID_CURSOR' : 'INVALID_REQUEST',
      );
    }
    // PostgreSQL text/JSONB cannot represent NUL or unpaired UTF-16 surrogates.
    // Reject them before PostgREST decoding, without duplicating SQL name rules.
    if (typeof value === 'string' && (value.includes('\u0000') || !value.isWellFormed())) {
      throw new ApiFailure(
        precisionError === 'INVALID_CURSOR'
          ? 'INVALID_CURSOR'
          : key === 'displayName'
          ? 'INVALID_DISPLAY_NAME'
          : 'INVALID_REQUEST',
      );
    }
    if (
      scores && key === 'score' && typeof value === 'number' &&
      (!context?.source || !exactInteger(value, context.source))
    ) throw new ApiFailure(precisionError);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new ApiFailure('INVALID_SAVE');
    return value;
  });
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exactFields(value: Record<string, unknown>, fields: string[]) {
  if (
    Object.keys(value).length !== fields.length || !fields.every((key) => Object.hasOwn(value, key))
  ) {
    throw new ApiFailure('INVALID_REQUEST');
  }
}
export async function body(
  request: Request,
  maxBody = MAX_BODY,
  scores = true,
): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type) ||
    (request.headers.has('content-encoding') &&
      request.headers.get('content-encoding') !== 'identity')
  ) {
    throw new ApiFailure('UNSUPPORTED_MEDIA_TYPE');
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw new ApiFailure('INVALID_REQUEST');
  }
  if (length !== null && Number(length) > maxBody) throw new ApiFailure('PAYLOAD_TOO_LARGE');
  if (!request.body) throw new ApiFailure('INVALID_REQUEST');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBody) {
        await reader.cancel();
        throw new ApiFailure('PAYLOAD_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let value: unknown;
  try {
    value = parseJson(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      'INVALID_SCORE',
      scores,
    );
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure('INVALID_REQUEST');
  }
  if (!object(value)) throw new ApiFailure('INVALID_REQUEST');
  return value;
}
export function pagination(url: URL): { p_limit: number; p_cursor: Json } {
  const limit = url.searchParams.get('limit');
  if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) {
    throw new ApiFailure('INVALID_REQUEST');
  }
  const cursor = url.searchParams.get('cursor');
  let decoded: Json = null;
  if (cursor !== null) {
    if (!cursor || new TextEncoder().encode(cursor).length > MAX_BODY) {
      throw new ApiFailure('INVALID_CURSOR');
    }
    try {
      decoded = parseJson(cursor, 'INVALID_CURSOR') as Json;
    } catch {
      throw new ApiFailure('INVALID_CURSOR');
    }
    if (!object(decoded)) throw new ApiFailure('INVALID_CURSOR');
    // SQL validates tuple types, board identity, UUID, score and timestamp.
  }
  return { p_limit: limit === null ? 50 : Number(limit), p_cursor: decoded };
}
export function queryParameters(url: URL, entries: boolean) {
  for (const key of url.searchParams.keys()) {
    if (!entries || !['limit', 'cursor'].includes(key)) throw new ApiFailure('INVALID_REQUEST');
    if (url.searchParams.getAll(key).length !== 1) {
      throw new ApiFailure(key === 'cursor' ? 'INVALID_CURSOR' : 'INVALID_REQUEST');
    }
  }
}

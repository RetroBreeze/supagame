const errors = {
  INVALID_SAVE: [400, 'The save payload is invalid.'],
  SAVE_NOT_FOUND: [404, 'The save slot or upload was not found.'],
  SAVE_QUOTA_EXCEEDED: [413, 'The save size or player quota was exceeded.'],
  STORAGE_UNAVAILABLE: [503, 'The binary object is not available; retry or abort the upload.'],
  INVALID_REQUEST: [400, 'The request is invalid.'],
  INVALID_SCORE: [400, 'The score must be a safe integer within the leaderboard bounds.'],
  INVALID_CURSOR: [400, 'The pagination cursor is invalid.'],
  INVALID_DISPLAY_NAME: [
    400,
    'Display names must contain 3–24 printable characters after trimming.',
  ],
  UNAUTHORIZED: [401, 'A valid project key and any required player session must be provided.'],
  FORBIDDEN: [403, 'This request is not allowed.'],
  NOT_FOUND: [404, 'The route was not found.'],
  LEADERBOARD_NOT_FOUND: [404, 'The leaderboard was not found or is disabled.'],
  METHOD_NOT_ALLOWED: [405, 'This method is not supported for the route.'],
  DUPLICATE_KEY_CONFLICT: [409, 'The submission key was already used with a different score.'],
  PAYLOAD_TOO_LARGE: [413, 'The request exceeds this route’s body limit.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Use uncompressed application/json encoded as UTF-8.'],
  RATE_LIMITED: [429, 'Too many submissions. Try again later.'],
  INTERNAL_ERROR: [500, 'The request could not be completed.'],
} as const;
export type ErrorCode = keyof typeof errors;
export class ApiFailure extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
export function json(body: unknown, status = 200, headers = new Headers()): Response {
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(body), { status, headers });
}
export function failure(code: ErrorCode, headers = new Headers()): Response {
  const [status, message] = errors[code];
  return json({ code, message }, status, headers);
}
export function databaseFailure(error: { code: string; message: string }): ApiFailure {
  // Require both SQLSTATE and the exact known message. Never echo SQL details.
  const pairs: Record<string, ErrorCode> = {
    '22023:INVALID_SAVE': 'INVALID_SAVE',
    'P0002:SAVE_NOT_FOUND': 'SAVE_NOT_FOUND',
    '54000:SAVE_QUOTA_EXCEEDED': 'SAVE_QUOTA_EXCEEDED',
    'P0001:STORAGE_UNAVAILABLE': 'STORAGE_UNAVAILABLE',
    '22023:INVALID_REQUEST': 'INVALID_REQUEST',
    '22023:INVALID_SCORE': 'INVALID_SCORE',
    '22023:INVALID_CURSOR': 'INVALID_CURSOR',
    '22023:INVALID_DISPLAY_NAME': 'INVALID_DISPLAY_NAME',
    'P0002:LEADERBOARD_NOT_FOUND': 'LEADERBOARD_NOT_FOUND',
    '23505:DUPLICATE_KEY_CONFLICT': 'DUPLICATE_KEY_CONFLICT',
    'P0001:RATE_LIMITED': 'RATE_LIMITED',
    '28000:UNAUTHORIZED': 'UNAUTHORIZED',
  };
  const known = pairs[`${error.code}:${error.message}`];
  if (known) return new ApiFailure(known);
  if (['PGRST301', 'PGRST302', 'PGRST303'].includes(error.code)) {
    return new ApiFailure('UNAUTHORIZED');
  }
  if (error.code === '42501') return new ApiFailure('FORBIDDEN');
  return new ApiFailure('INTERNAL_ERROR');
}

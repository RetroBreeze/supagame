export type ErrorKind = 'authentication' | 'api' | 'network' | 'invalid_parameter' | 'unexpected_response';

/** Errors contain public metadata only, never underlying transport/auth causes or tokens. */
export class GameServicesError extends Error {
  readonly kind: ErrorKind;
  /** Reuse this key when manually retrying a failed score submission. */
  submissionKey?: string;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
  }
}
export class AuthenticationError extends GameServicesError {
  readonly code = 'UNAUTHORIZED';
  readonly status = 401;
  constructor(message = 'A usable Supabase user session is required. Sign in or recover the session with your Supabase client.') {
    super('authentication', message);
  }
}
export class ApiError extends GameServicesError {
  constructor(readonly status: number, readonly code: string, message: string) {
    super('api', message);
  }
}
export class NetworkError extends GameServicesError {
  constructor() { super('network', 'The request could not reach Supagame or its response was lost.'); }
}
export class InvalidParameterError extends GameServicesError {
  constructor(readonly parameter: string, message: string) { super('invalid_parameter', message); }
}
export class UnexpectedResponseError extends GameServicesError {
  constructor() { super('unexpected_response', 'Supagame returned a response that does not match the v1 API contract.'); }
}

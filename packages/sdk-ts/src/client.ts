import type { ApiError as ApiErrorBody } from '@supagame/contracts';
import type { Session } from '@supabase/supabase-js';
import type { SupabaseConnection } from './auth.js';
import { ApiError, SaveConflictError, AuthenticationError, InvalidParameterError, NetworkError, UnexpectedResponseError } from './errors.js';
import * as validators from './validation.generated.js';

export interface GameServicesOptions {
  supabase: SupabaseConnection;
  /** Full trusted API base, e.g. https://example.com/functions/v1/supagame/v1. */
  baseUrl?: string;
  /** Required only with baseUrl; use this project's public sb_publishable_ key. */
  publishableKey?: string;
}
export type Schema = keyof typeof validators;
export function matches(schema: Schema, value: unknown): boolean {
  return validators[schema](value) as boolean;
}
interface RequestOptions { session?: Session; body?: object; nullable?: boolean }
export interface Transport {
  request<T>(path: string, method: 'GET' | 'POST' | 'PATCH', schema: Schema, options?: RequestOptions): Promise<T>;
}
function jsonResponse(response: Response): boolean {
  return response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}
async function httpFailure(response: Response): Promise<never> {
  // Gateways need not use our error envelope. Authentication rejection still has a stable type.
  if (response.status === 401) throw new AuthenticationError();
  let body: unknown;
  try { body = jsonResponse(response) ? await response.json() : undefined; }
  catch { throw new UnexpectedResponseError(); }
  if (!matches('ApiError', body)) throw new UnexpectedResponseError();
  const error = body as ApiErrorBody;
  if (error.code === 'SAVE_CONFLICT' && Object.hasOwn(error, 'current')) throw new SaveConflictError(error.current ?? null, error.message);
  throw new ApiError(response.status, error.code, error.message);
}
function customBase(options: GameServicesOptions): string | undefined {
  if (options.baseUrl === undefined) {
    if (options.publishableKey !== undefined) throw new InvalidParameterError('publishableKey', 'publishableKey is only used with an explicit baseUrl.');
    return undefined;
  }
  let url: URL;
  try { url = new URL(options.baseUrl); }
  catch { throw new InvalidParameterError('baseUrl', 'baseUrl must be an absolute trusted API URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new InvalidParameterError('baseUrl', 'Use HTTPS (HTTP is allowed on loopback), without URL credentials, query or fragment.');
  }
  if (typeof options.publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(options.publishableKey)) {
    throw new InvalidParameterError('publishableKey', 'A public sb_publishable_ project key is required with baseUrl.');
  }
  return url.href.replace(/\/+$/, '');
}
export function createTransport(options: GameServicesOptions): Transport {
  const base = customBase(options);
  return {
    async request<T>(path: string, method: 'GET' | 'POST' | 'PATCH', schema: Schema, request: RequestOptions = {}): Promise<T> {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (request.session) headers.Authorization = `Bearer ${request.session.access_token}`;
      let data: unknown;
      if (base !== undefined) {
        headers.apikey = options.publishableKey!;
        if (request.body) headers['Content-Type'] = 'application/json';
        let response: Response;
        try {
          response = await fetch(`${base}${path}`, {
            method, headers, redirect: 'error', credentials: 'omit',
            ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          });
        } catch { throw new NetworkError(); }
        if (!response.ok) return httpFailure(response);
        if (response.status !== 200 || !jsonResponse(response)) throw new UnexpectedResponseError();
        try { data = await response.json(); }
        catch { throw new UnexpectedResponseError(); }
      } else {
        // Public API: preserves the host client's URL, publishable key and custom fetch.
        // Explicit per-request JWTs keep protected requests scoped to the selected player.
        const result = await options.supabase.functions.invoke<unknown>(`supagame/v1${path}`, {
          method, headers, ...(request.body ? { body: request.body } : {}),
        });
        if (result.response && !result.response.ok) return httpFailure(result.response);
        if (result.error) {
          if (result.error instanceof Error && result.error.name === 'FunctionsFetchError') throw new NetworkError();
          throw new UnexpectedResponseError();
        }
        if (!result.response || result.response.status !== 200 || !jsonResponse(result.response)) throw new UnexpectedResponseError();
        data = result.data;
      }
      if (!(request.nullable && data === null) && !matches(schema, data)) throw new UnexpectedResponseError();
      return data as T;
    },
  };
}

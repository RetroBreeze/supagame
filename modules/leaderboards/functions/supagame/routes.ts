import { callerClient } from './auth.ts';
import { ApiFailure, databaseFailure, failure, json } from './responses.ts';
import { body, exactFields, pagination, queryParameters, UUID } from './validation.ts';
import type { ApiConfig, RpcCall } from './types.ts';

type Route = {
  kind: 'boards' | 'entries' | 'standing' | 'scores' | 'profile';
  methods: readonly string[];
  boardId: string;
};
function route(pathname: string): Route | null {
  // Supabase strips /functions/v1 before forwarding; direct Deno calls may use
  // /v1. Match only these exact mount paths, never arbitrary suffixes.
  const path = pathname.replace(/^\/(?:functions\/v1\/)?supagame(?=\/)/, '');
  if (path === '/v1/leaderboards') return { kind: 'boards', methods: ['GET'], boardId: '' };
  if (path === '/v1/players/me') return { kind: 'profile', methods: ['GET', 'PATCH'], boardId: '' };
  const match = /^\/v1\/leaderboards\/([^/]+)\/(entries|me|scores)$/.exec(path);
  if (!match) return null;
  let boardId: string;
  try {
    boardId = decodeURIComponent(match[1]!);
  } catch {
    throw new ApiFailure('INVALID_REQUEST');
  }
  if (
    !boardId || [...boardId].some((character) => {
      const code = character.codePointAt(0)!;
      return character === '/' || code < 32 || code === 127;
    })
  ) throw new ApiFailure('INVALID_REQUEST');
  return {
    kind: match[2] === 'me' ? 'standing' : match[2] as 'entries' | 'scores',
    methods: match[2] === 'scores' ? ['POST'] : ['GET'],
    boardId,
  };
}
async function callFor(request: Request, url: URL, route: Route): Promise<RpcCall> {
  queryParameters(url, route.kind === 'entries');
  switch (route.kind) {
    case 'boards':
      return { name: 'sg_list_leaderboards', args: {} };
    case 'entries':
      return { name: 'sg_get_entries', args: { p_board_id: route.boardId, ...pagination(url) } };
    case 'standing':
      return { name: 'sg_get_my_score', args: { p_board_id: route.boardId } };
    case 'scores': {
      const value = await body(request);
      exactFields(value, ['score', 'submissionKey']);
      if (typeof value.score !== 'number' || !Number.isSafeInteger(value.score)) {
        throw new ApiFailure('INVALID_SCORE');
      }
      if (typeof value.submissionKey !== 'string' || !UUID.test(value.submissionKey)) {
        throw new ApiFailure('INVALID_REQUEST');
      }
      return {
        name: 'sg_submit_score',
        args: {
          p_board_id: route.boardId,
          p_score: value.score,
          p_submission_key: value.submissionKey,
        },
      };
    }
    case 'profile': {
      if (request.method === 'GET') return { name: 'sg_get_my_profile', args: {} };
      const value = await body(request);
      exactFields(value, ['displayName']);
      if (typeof value.displayName !== 'string') throw new ApiFailure('INVALID_REQUEST');
      return { name: 'sg_update_my_profile', args: { p_display_name: value.displayName } };
    }
  }
}

export function createApi(
  config: ApiConfig,
  fetcher: typeof fetch = fetch,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const headers = new Headers({ vary: 'Origin', 'cache-control': 'no-store' });
    try {
      const origin = request.headers.get('origin');
      if (origin !== null) {
        if (origin === 'null' || !config.allowedOrigins.includes(origin)) {
          throw new ApiFailure('FORBIDDEN');
        }
        headers.set('access-control-allow-origin', origin);
      }
      const url = new URL(request.url);
      const matched = route(url.pathname);
      if (!matched) throw new ApiFailure('NOT_FOUND');
      const allowed = [...matched.methods, 'OPTIONS'];
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('access-control-request-method');
        if (!origin || !method || !matched.methods.includes(method)) {
          throw new ApiFailure('FORBIDDEN');
        }
        const requested = (request.headers.get('access-control-request-headers') ?? '').split(',')
          .map((header) => header.trim().toLowerCase()).filter(Boolean);
        if (
          requested.some((header) =>
            !['apikey', 'authorization', 'content-type', 'x-client-info'].includes(header)
          )
        ) throw new ApiFailure('FORBIDDEN');
        headers.set(
          'vary',
          'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        );
        headers.set('access-control-allow-methods', allowed.join(', '));
        headers.set(
          'access-control-allow-headers',
          'apikey, authorization, content-type, x-client-info',
        );
        headers.set('access-control-max-age', '600');
        return new Response(null, { status: 204, headers });
      }
      if (!matched.methods.includes(request.method)) {
        headers.set('allow', allowed.join(', '));
        throw new ApiFailure('METHOD_NOT_ALLOWED');
      }
      const client = await callerClient(
        request,
        !['boards', 'entries'].includes(matched.kind),
        config,
        fetcher,
      );
      const call = await callFor(request, url, matched);
      const { data, error } = await client.rpc(call.name, call.args);
      if (error) throw databaseFailure(error);
      if (data === null && call.name !== 'sg_get_my_score') throw new ApiFailure('INTERNAL_ERROR');
      return json(data, 200, headers);
    } catch (error) {
      return failure(error instanceof ApiFailure ? error.code : 'INTERNAL_ERROR', headers);
    }
  };
}

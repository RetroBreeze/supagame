import { createContextClient, resolveEnv, verifyAuth } from 'npm:@supabase/server@1.9.2/core';
import { ApiFailure } from './responses.ts';
import type { ApiConfig, Database } from './types.ts';
import { UUID } from './validation.ts';

export async function callerClient(
  request: Request,
  userRequired: boolean,
  config: ApiConfig,
  fetcher: typeof fetch,
) {
  const env = { ...config.env, secretKeys: {} };
  // These are AND requirements; an auth-mode array would instead accept either.
  const project = await verifyAuth(request, { auth: 'publishable:*', env });
  if (project.error) {
    throw new ApiFailure(project.error.status >= 500 ? 'INTERNAL_ERROR' : 'UNAUTHORIZED');
  }
  let token: string | null = null;
  if (userRequired) {
    const user = await verifyAuth(request, {
      auth: 'user',
      env,
      audience: 'authenticated',
      issuer: config.issuer,
    });
    if (user.error) {
      throw new ApiFailure(user.error.status >= 500 ? 'INTERNAL_ERROR' : 'UNAUTHORIZED');
    }
    const claims = user.data.jwtClaims;
    // The library verifies signatures/registered claims; require the Supabase
    // end-user role, UUID subject and expiry too. Never accept privileged JWTs.
    if (
      !claims || claims.role !== 'authenticated' || !UUID.test(claims.sub) ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) ||
      claims.exp <= Date.now() / 1000
    ) {
      throw new ApiFailure('UNAUTHORIZED');
    }
    token = user.data.token;
  }
  // Public calls intentionally stay anon-scoped even if an Authorization header
  // is present. No admin client or privileged key participates in RPC execution.
  return createContextClient<Database>({
    env,
    auth: { token, keyName: project.data.keyName ?? null },
    supabaseOptions: { global: { fetch: fetcher } },
  });
}

export function configuration(): ApiConfig {
  const resolved = resolveEnv({ secretKeys: {} });
  if (resolved.error) throw new ApiFailure('INTERNAL_ERROR');
  const allowedOrigins: unknown = JSON.parse(Deno.env.get('SG_ALLOWED_ORIGINS') ?? '[]');
  if (
    !Array.isArray(allowedOrigins) || !allowedOrigins.every((origin: unknown) => {
      if (typeof origin !== 'string' || origin === 'null' || origin === '*') return false;
      try {
        const url = new URL(origin);
        return !!url.host && !url.username && !url.password && !url.search && !url.hash &&
          (url.pathname === '' || url.pathname === '/') && !origin.endsWith('/');
      } catch {
        return false;
      }
    })
  ) throw new ApiFailure('INTERNAL_ERROR');
  const publicUrl = Deno.env.get('SUPABASE_PUBLIC_URL') ?? resolved.data.url;
  return {
    env: resolved.data,
    allowedOrigins,
    issuer: Deno.env.get('SG_AUTH_ISSUER') ?? `${publicUrl.replace(/\/$/, '')}/auth/v1`,
  };
}

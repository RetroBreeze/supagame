import { object, projectRef } from './manifest.ts';
export interface RealtimeInspection {
  status: 'healthy' | 'action required' | 'cannot verify';
  message: string;
  privateOnly?: boolean;
}
/** Optional extra evidence: CLI 3.0.0 does not expose suspension/service health.
 * An explicitly exported Management API token enables these read-only probes;
 * never extract credentials from the CLI's private login store. */
export async function inspectRealtime(
  ref: string,
  token = process.env.SUPABASE_ACCESS_TOKEN,
  fetcher: typeof fetch = fetch,
): Promise<RealtimeInspection> {
  if (!projectRef(ref)) {
    throw new Error('Invalid Realtime inspection project reference.');
  }
  const unavailable = (message: string): RealtimeInspection => ({
    status: 'cannot verify',
    message,
  });
  if (!token) {
    return unavailable(
      'Hosted Realtime service health requires SUPABASE_ACCESS_TOKEN with Realtime config/project health read permissions, or verify Realtime status in the selected project. CLI login still handles ordinary deployment; no global setting is changed.',
    );
  }
  const get = async (path: string): Promise<unknown> => {
    const response = await fetcher(
      `https://api.supabase.com/v1/projects/${ref}/${path}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error('Unavailable');
    return response.json();
  };
  try {
    const config = await get('config/realtime');
    if (
      !object(config) || typeof config.private_only !== 'boolean' ||
      typeof config.suspend !== 'boolean' ||
      !(config.admin_suspended_at === null ||
        typeof config.admin_suspended_at === 'string')
    ) {
      return unavailable(
        'Incomplete hosted Realtime settings. Check Realtime configuration read permissions; health is not assumed.',
      );
    }
    if (config.suspend || config.admin_suspended_at) {
      return {
        status: 'action required',
        privateOnly: config.private_only,
        message:
          'Hosted Realtime is suspended. Resolve the suspension in the selected project’s Realtime settings or with Supabase support, then rerun doctor. Supagame does not change global service settings.',
      };
    }
    const health = await get('health?services=realtime');
    if (!Array.isArray(health)) throw new Error('Incomplete health');
    const matches = health.filter((s) => object(s) && s.name === 'realtime');
    if (matches.length !== 1 || typeof matches[0].healthy !== 'boolean') {
      throw new Error('Incomplete health');
    }
    return {
      status: matches[0].healthy ? 'healthy' : 'action required',
      privateOnly: config.private_only,
      message: matches[0].healthy
        ? `Hosted Realtime reports healthy; global private_only=${config.private_only} is preserved. SDK channels and database broadcasts explicitly use private mode. This does not prove WebSocket delivery.`
        : 'Hosted Realtime reports unhealthy. Check project service status and rerun doctor before deploying Live Leaderboards.',
    };
  } catch {
    return unavailable(
      'Hosted Realtime inspection unavailable. Check token read permissions, network and project status; response bodies and credentials are withheld.',
    );
  }
}

import { expect, it, vi } from 'vitest';
import { inspectRealtime } from '../../packages/cli/src/lib/realtime-inspection.ts';
const ref = 'abcdefghijklmnopqrst';
it('reads supported Management API endpoints with bearer auth and never mutates or logs credentials', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify(
          String(url).includes('/health')
            ? [{ name: 'realtime', healthy: true, status: 'ACTIVE_HEALTHY' }]
            : { private_only: false, suspend: false, admin_suspended_at: null },
        ),
        { status: 200 },
      );
    },
  );
  expect(await inspectRealtime(ref, 'test-token', fetcher)).toMatchObject({
    status: 'healthy',
    privateOnly: false,
  });
  expect(calls.map((c) => c.url)).toEqual([
    `https://api.supabase.com/v1/projects/${ref}/config/realtime`,
    `https://api.supabase.com/v1/projects/${ref}/health?services=realtime`,
  ]);
  expect(
    calls.every((c) => c.init?.method === 'GET' && c.init.redirect === 'error'),
  ).toBe(true);
});
it('reports unavailable credentials without attempting network access', async () => {
  const fetcher = vi.fn();
  expect((await inspectRealtime(ref, undefined, fetcher)).status).toBe(
    'cannot verify',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([401, 403, 429, 500])('redacts HTTP %s responses', async (status) => {
  const result = await inspectRealtime(
    ref,
    'test-token',
    async () => new Response('secret-token', { status }),
  );
  expect(result.status).toBe('cannot verify');
  expect(JSON.stringify(result)).not.toContain('secret-token');
});
it.each([
  { private_only: true, suspend: true, admin_suspended_at: null },
  { private_only: false, suspend: false, admin_suspended_at: '2026-11-10' },
])(
  'reports suspended Realtime as action required without changing it',
  async (config) => {
    const result = await inspectRealtime(
      ref,
      'test-token',
      async () => new Response(JSON.stringify(config)),
    );
    expect(result.status).toBe('action required');
  },
);
it('does not equate incomplete service evidence with health', async () => {
  const result = await inspectRealtime(
    ref,
    'test-token',
    async () => new Response('{}'),
  );
  expect(result.status).toBe('cannot verify');
});

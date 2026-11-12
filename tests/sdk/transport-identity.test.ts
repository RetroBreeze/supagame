import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, createGameServices, SaveConflictError } from '../../packages/sdk-ts/src/index.js';
import { fixture, key, session } from './fixtures.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const current = {
  slot: 'profile', revision: 2, schemaVersion: 1, kind: 'json', metadata: {},
  sizeBytes: 20, deleted: false, objectPath: null,
  createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
  data: { privateProgress: 'original player only' },
};
const conflict = { code: 'SAVE_CONFLICT', message: 'Save changed', current };

describe.each(['functions', 'fetch'] as const)('%s transport identity boundary', (transport) => {
  function setup() {
    const f = fixture();
    if (transport === 'fetch') vi.stubGlobal('fetch', f.fetcher);
    const game = createGameServices({
      supabase: f.supabase,
      ...(transport === 'fetch' ? { baseUrl: 'https://game.example/v1', publishableKey: key } : {}),
    });
    return { ...f, game };
  }

  it.each(['switch', 'signOut'] as const)('withholds conflict data after %s', async (change) => {
    const f = setup();
    let deliver!: (response: Response) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    f.fetcher.mockImplementation(async () => {
      started();
      return new Promise<Response>((resolve) => { deliver = resolve; });
    });
    const result = f.game.saves.save('profile', { coins: 1 }).catch((error: unknown) => error);
    await requestStarted;
    const next = session();
    next.user.id = '00000000-0000-4000-8000-000000000099';
    f.getSession.mockResolvedValue(change === 'switch'
      ? { data: { session: next }, error: null }
      : { data: { session: null }, error: null });
    deliver(Response.json(conflict, { status: 409 }));
    const error = await result;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).not.toHaveProperty('current');
    expect(JSON.stringify(error)).not.toContain('original player only');
  });

  it('rechecks identity after reading a delayed error body', async () => {
    const f = setup();
    let finish!: () => void;
    let reading!: () => void;
    const bodyRead = new Promise<void>((resolve) => { reading = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(conflict)));
          controller.close();
        };
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    const json = response.json.bind(response);
    vi.spyOn(response, 'json').mockImplementation(() => { reading(); return json(); });
    f.fetcher.mockResolvedValue(response);
    const result = f.game.saves.save('profile', { coins: 1 }).catch((error: unknown) => error);
    await bodyRead;
    const next = session(); next.user.id = '00000000-0000-4000-8000-000000000099';
    f.getSession.mockResolvedValue({ data: { session: next }, error: null });
    finish();
    const error = await result;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).not.toHaveProperty('current');
  });

  it('preserves conflict resolution when the same player refreshes their token', async () => {
    const f = setup();
    f.fetcher.mockImplementation(async () => {
      f.getSession.mockResolvedValue({ data: { session: session(true, 'refreshed-token') }, error: null });
      return Response.json(conflict, { status: 409 });
    });
    const result = f.game.saves.save('profile', { coins: 1 });
    await expect(result).rejects.toBeInstanceOf(SaveConflictError);
    await expect(result).rejects.toMatchObject({ current, code: 'SAVE_CONFLICT', status: 409 });
  });
});

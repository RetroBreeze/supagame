import { expect, it, vi } from 'vitest';
import { createOfflineSaves, AuthenticationError, SaveConflictError } from '../../packages/sdk-ts/src/index.js';
import type { Saves } from '../../packages/sdk-ts/src/saves.js';
import type { OfflineEntry } from '../../packages/sdk-ts/src/offline-saves.js';
import { deferred, memoryStore, saveRecord } from './concurrency-fixtures.js';
function setup() {
  const store = memoryStore<OfflineEntry>(); let player: string | null = 'one';
  const saves = { load: vi.fn(async () => saveRecord), save: vi.fn(async () => ({ ...saveRecord, revision: 2 })) } as unknown as Saves;
  const make = () => createOfflineSaves({ saves, store, namespace: 'project', playerId: async () => player });
  return { store, saves, make, switch: () => { player = 'two'; } };
}
it.each(['empty', 'conflict'] as const)('checks identity after a delayed offline read (%s)', async kind => {
  const f = setup(), a = f.make(); await a.load('profile');
  if (kind === 'conflict') {
    await a.stage('profile', {});
    await f.store.update(JSON.stringify(['project', 'one', 'profile']), s => ({ ...s!, conflict: saveRecord }));
  }
  const started = deferred<void>(), finish = deferred<void>(), read = f.store.read.bind(f.store);
  f.store.read = async k => { const result = await read(k); started.resolve(); await finish.promise; return result; };
  const result = a.sync('profile').catch(e => e); await started.promise; f.switch(); finish.resolve();
  expect(await result).toBeInstanceOf(AuthenticationError);
});
it.each(['stage', 'load', 'resolve'] as const)('withholds storage results after account changes during transaction completion (%s)', async method => {
  const f = setup(), a = f.make(); await a.load('profile');
  const started = deferred<void>(), finish = deferred<void>(), update = f.store.update.bind(f.store);
  f.store.update = async (k, fn) => { const result = await update(k, fn); started.resolve(); await finish.promise; return result; };
  const result = (method === 'stage' ? a.stage('profile', {}) : method === 'load' ? a.load('profile') : a.resolve('profile', {}, 1)).catch(e => e);
  await started.promise; f.switch(); finish.resolve(); expect(await result).toBeInstanceOf(AuthenticationError);
  expect(await a.local('profile')).toBeNull();
});
it('ignores a conflict for an operation already resolved by another client', async () => {
  const f = setup(), a = f.make(), b = f.make(), old = deferred<never>(), started = deferred<void>();
  await a.stage('profile', {});
  vi.mocked(f.saves.save).mockImplementationOnce(async () => { started.resolve(); return old.promise; });
  const late = b.sync('profile').catch(e => e); await started.promise;
  await a.resolve('profile', { coins: 10 }, 3);
  vi.mocked(f.saves.save).mockResolvedValue({ ...saveRecord, revision: 4 });
  await a.sync('profile'); old.reject(new SaveConflictError({ ...saveRecord, revision: 3 })); await late;
  const state = await a.local('profile'); expect(state?.cloud?.revision).toBe(4);
  expect(state).not.toHaveProperty('conflict');
  await a.stage('profile', { coins: 11 }); await expect(a.sync('profile')).resolves.toMatchObject({ pending: [] });
});
it('does not overwrite an acknowledged cloud revision with a delayed hydration', async () => {
  const f = setup(), a = f.make(), b = f.make(), started = deferred<void>(), finish = deferred<void>();
  vi.mocked(f.saves.load).mockImplementation(async () => { started.resolve(); await finish.promise; return saveRecord; });
  const pending = a.load('profile'); await started.promise;
  await b.stage('profile', { coins: 2 }); await b.sync('profile'); finish.resolve();
  expect((await pending).cloud?.revision).toBe(2);
});
it('does not let a delayed explicit resolution discard another client\'s new queue entry', async () => {
  const f = setup(), a = f.make(), b = f.make(); await a.stage('profile', { coins: 1 });
  const started = deferred<void>(), finish = deferred<void>(), update = f.store.update.bind(f.store);
  let delay = true;
  f.store.update = async (k, fn) => {
    if (delay) { delay = false; started.resolve(); await finish.promise; }
    return update(k, fn);
  };
  const resolving = a.resolve('profile', { coins: 10 }, 0).catch(e => e);
  await started.promise; await b.stage('profile', { coins: 20 }); finish.resolve();
  expect(await resolving).toBeInstanceOf(SaveConflictError);
  expect((await b.local('profile'))?.pending.at(-1)?.data).toEqual({ coins: 20 });
});

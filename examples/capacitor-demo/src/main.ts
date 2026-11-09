import { createClient } from '@supabase/supabase-js';
import { ApiError, GameServicesError, createGameServices } from '@supagame/sdk-ts';
import { demoConfig } from './config.js';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing demo element: ${id}`);
  return value as T;
}
const status = element('status');
const controls = element<HTMLFieldSetElement>('controls');
async function start() {
  // Read only these two public values, never spread import.meta.env into a bundle.
  const config = demoConfig(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
  const supabase = createClient(config.url, config.key);
  const game = createGameServices({ supabase });
  const board = element<HTMLSelectElement>('board');
  const score = element<HTMLInputElement>('score');
  const name = element<HTMLInputElement>('display-name');
  let pending: { board: string; score: number; key: string } | undefined;

  async function rankings() {
    const [top, mine] = await Promise.all([game.leaderboards.getTop(board.value, { limit: 10 }), game.leaderboards.getMine(board.value)]);
    const rows = top.entries.map((entry) => {
      const row = document.createElement('tr');
      for (const text of [String(entry.rank), entry.displayName ?? 'Unnamed player', String(entry.score)]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      return row;
    });
    element('entries').replaceChildren(...rows);
    element('personal-best').textContent = mine ? `Personal best: ${mine.score} · rank ${mine.rank}` : 'No score yet.';
  }
  async function action(operation: () => Promise<string>) {
    controls.disabled = true;
    try { status.textContent = await operation(); }
    catch (error) {
      status.textContent = error instanceof ApiError ? `${error.code}: ${error.message}`
        : error instanceof GameServicesError ? error.message : 'The operation failed. Check your connection and configuration.';
    } finally { controls.disabled = false; }
  }
  element('profile-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void action(async () => {
      name.value = (await game.players.updateMe({ displayName: name.value })).displayName ?? '';
      await rankings(); return 'Display name saved.';
    });
  });
  element('score-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void action(async () => {
      const value = Number(score.value);
      if (!Number.isSafeInteger(value)) return 'Enter a safe integer score.';
      if (pending && (pending.board !== board.value || pending.score !== value)) {
        return 'Retry the previous board and score first; its result is still uncertain.';
      }
      pending ??= { board: board.value, score: value, key: crypto.randomUUID() };
      let result;
      try { result = await game.leaderboards.submit(pending.board, pending.score, pending.key); }
      catch (error) {
        // A definitive API rejection did not accept this attempt. Network/5xx
        // failures remain uncertain and retain the original key for retry.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) pending = undefined;
        throw error;
      }
      pending = undefined;
      await rankings(); return result.outcome === 'best' ? 'New personal best.' : 'Score accepted; personal best unchanged.';
    });
  });
  const refresh = () => { void action(async () => { await rankings(); return 'Rankings refreshed.'; }); };
  board.addEventListener('change', refresh);
  element('refresh').addEventListener('click', refresh);
  const { userId } = await game.players.ensureAnonymousSession();
  element('identity').textContent = `Player: ${userId}`;
  name.value = (await game.players.getMe()).displayName ?? '';
  await rankings(); controls.disabled = false; status.textContent = 'Ready.';
}
void start().catch((error: unknown) => {
  status.textContent = error instanceof GameServicesError ? error.message
    : error instanceof Error && /^(Set VITE_|The project URL)/.test(error.message) ? error.message
    : 'Unable to start. Check the public configuration, anonymous sign-in and allowed browser origin.';
});

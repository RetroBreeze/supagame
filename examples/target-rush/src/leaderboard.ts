import { createClient } from '@supabase/supabase-js';
import { createGameServices, type GameServices } from '@retrobreeze/supagame-sdk';
import { demoConfig } from './config';

/** All Supagame integration lives here; the game only calls refresh and submit. */
export function setupLeaderboard() {
  const entries = document.getElementById('leaderboard-entries')!;
  const status = document.getElementById('leaderboard-status')!;
  const submission = document.getElementById('submission-status')!;
  let services: GameServices | undefined;
  try {
    const { url, key } = demoConfig(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
    // Supabase owns session persistence and refresh; only a publishable key belongs here.
    services = createGameServices({ supabase: createClient(url, key) });
  } catch {
    status.textContent = 'Leaderboard not configured. See the README to connect Supagame.';
  }

  async function refresh(): Promise<void> {
    if (!services) return;
    status.textContent = 'Loading scores…';
    try {
      // Public read: viewing the title screen does not create an anonymous user.
      const page = await services.leaderboards.getTop('target-rush', { limit: 10 });
      entries.replaceChildren(...page.entries.map(entry => {
        const row = document.createElement('tr');
        for (const value of [entry.rank, entry.displayName ?? 'Player', entry.score]) {
          const cell = document.createElement('td');
          cell.textContent = String(value); // Display names are untrusted text, never HTML.
          row.append(cell);
        }
        return row;
      }));
      status.textContent = page.entries.length ? '' : 'No scores yet. Play the first round!';
    } catch {
      status.textContent = 'Could not load scores. You can still play.';
    }
  }

  async function submit(score: number, displayName: string): Promise<void> {
    if (!services) {
      submission.textContent = 'Score not saved: leaderboard not configured.';
      return;
    }
    submission.textContent = 'Saving score…';
    try {
      // Reuse any existing session, otherwise sign in anonymously. The API stores
      // names on profiles, so save the name before sending the score attempt.
      await services.players.ensureAnonymousSession();
      await services.players.updateMe({ displayName });
      // Submit every finished round; the database keeps only the highest score.
      // The SDK supplies the idempotency key and reuses it for its network retry.
      const result = await services.leaderboards.submit('target-rush', score);
      submission.textContent = `Score saved. Best: ${result.bestScore}`;
      await refresh();
    } catch {
      submission.textContent = 'Could not save score. Check your connection and leaderboard setup.';
    }
  }

  return { refresh, submit };
}

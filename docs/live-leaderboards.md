# Live Leaderboards

Install the optional gaming feature with `supagame add live-leaderboards`.
It automatically stages core and leaderboards when absent. Existing ordinary
leaderboard installations do not receive this migration unless selected.
All three modules currently use version 0.1.0. `add --dry-run`, `upgrade --dry-run`,
`doctor`, immutable migration checks and explicit deploy confirmation use the
existing provisioning system. No changes to existing HTTP routes are required.

```ts
await game.players.ensureAnonymousSession(); // reuses an existing session
const subscription = game.leaderboards.subscribe('vaccoin', {
  topN: 10,
  onUpdate: page => render(page.entries),
  onRankChange: event => showNotice(event),
  onStatus: status => showConnection(status),
  onError: error => showError(error),
});
// On screen/app disposal:
subscription.unsubscribe();
```

The existing full Supabase client supplies Auth and Realtime. Subscription does
not create or replace a session. Call the explicit session helper first.
One active subscription per board per Supabase client is supported; a duplicate
throws an invalid-parameter error. Dispose before replacing a subscription.
Different boards may be subscribed independently. Unsubscribe is idempotent.

Private topic `supagame:leaderboard:<id>` receives `changed` events containing
`{boardId}`. Supabase may add its own message ID. Events contain no player IDs,
names, scores, idempotency keys or audit records. Database triggers emit on
visible best-score changes, visible display-name changes, hiding/unhiding,
player/score removal, and board availability or ordering changes. Equal and
non-best submissions do not emit. No publication changes are made.

Authenticated users, including anonymous Auth users, may receive enabled-board
hints. A restrictive INSERT policy denies client broadcasts in this namespace,
even when another permissive send policy exists. No score-table privileges or
RLS policies are relaxed. Review any existing broad Realtime receive policies:
PostgreSQL permissive SELECT policies combine with OR. Public HTTP reads remain
public. Notifications are hints, never score evidence; HTTP reads remain the
source of truth. Client code never computes competition rankings.

The SDK fetches a first top-N page and the current player's `/me` rank, then
coalesces event bursts over 150ms. Requests are serialized and invalidated reads
cannot replace newer state. Successful subscription/reconnection refreshes the
snapshot. Supabase owns socket retry/backoff; the SDK refreshes tokens and
re-establishes channels on identity changes. There is no polling. Missed messages
while disconnected are reconciled when subscribed again. Reads that fail surface
through `onError`; they do not produce rank events. Dispose/re-subscribe to retry
an HTTP failure when no subsequent change arrives.

Rank events compare successive successful `/me` responses, including players
outside the displayed page. `rank_improved` and `rank_dropped` require two numeric
ranks. `entered_top` means crossing into rank <= topN; `left_top` includes a
previous top player becoming hidden or losing their score. A null-to-visible
transition may emit `entered_top`, but never `rank_improved`. Ties retain the SQL
competition rank. Initial subscription, identity changes, reconnects and reads
after errors establish a fresh baseline without notifications. Numeric movement
and a top-N crossing can emit two events for one refresh. These are transient
in-game events, with no push service or persistent storage.

## Deployment and troubleshooting

Enable Supabase Realtime before applying the optional migration. For local tests,
start the full stack with `[realtime] enabled = true` before `pnpm db:migrate`;
a database-only stack does not initialize `realtime.messages` or `realtime.send`.
Fresh local projects should start Supabase before staging the optional module.
The production project must support database Broadcast and private channels.
Supabase recommends disabling public channel access in Realtime settings; review
other application channels before changing that setting. This installer never
changes hosted settings. Private mode is explicitly requested on both sending
and receiving sides regardless of that global setting.

Run `supagame doctor --remote --project-ref <ref>` for read-only migration,
trigger and policy diagnostics. Doctor cannot prove WebSocket delivery or hosted
Realtime settings; perform a runtime smoke check using real gameplay. Missing
module/policies or an expired JWT can cause channel errors. HTTP API errors,
validation failures and network errors are surfaced separately, not all labeled
offline. A disabled/deleted board produces its existing HTTP not-found error;
consumers should clear stale content if appropriate.

Broadcast delivery is best-effort; it is not a durable event log. Every refresh
uses two HTTP reads, which need not share one database transaction; player rank
notifications compare `/me` reads only. Very active boards increase fan-out and
HTTP reads, subject to project Realtime quotas. Bounds and throttling are not
complete anti-cheat. This feature adds no hosted backend owned by Supagame.

Sources: [Supabase Broadcast](https://supabase.com/docs/guides/realtime/broadcast)
and [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization).

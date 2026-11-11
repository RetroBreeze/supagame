# Changelog

## Unreleased — CLI 0.1.5

- Bundled local Admin Dashboard with single-project resolution and explicit local/remote mode.
- Loopback-only server, per-launch authentication, Host/Origin and CSRF validation, secure previews and exact operation retries.
- Overview, leaderboard management, paginated score moderation, player restrictions and bounded audit history.
- Shared operator service for the existing CLI and dashboard; no new migrations, SDK API or hosted endpoint.

## Unreleased — Admin module, module templates 0.1.4

- Optional `supagame add admin` with forward-only installation, upgrades, deployment inventory and diagnostics.
- CLI leaderboard inspection, generation reset and disable/enable; score inspection and reversible moderation; player submission restrictions and reinstatement; audit listing.
- Private operator authorization, future granular permission assignments, explicit confirmation/reasons, read-only previews, operation deduplication and stale revision checks.
- Retained generation history, generation-bound pagination and live invalidation; typed `PLAYER_RESTRICTED` errors.
- No dashboard, public admin endpoint, permanent deletion or hosted deployment.

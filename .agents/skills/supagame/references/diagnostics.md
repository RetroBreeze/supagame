# Diagnostics and verification

Run checks in a synthetic local consumer first. Do not request production secrets
for automated tests. Existing live resources require the user's authorized scope.

| Layer | Check | What it does not prove |
| --- | --- | --- |
| Local files | `npx supagame doctor` | No live DB, hosted configuration or runtime inspection |
| Local database | `npx supagame doctor --local` | No hosted function health or browser/WebSocket success |
| Hosted inspection | `npx supagame doctor --remote --project-ref YOUR_PROJECT_REF` | Read-only object/config/function inspection; not end-to-end HTTP, CORS or message delivery |
| Runtime HTTP/Auth | Actual public read, existing/anonymous session, protected write/read, missing/invalid/expired JWT rejection | A curl/native success doesn't prove browser CORS |
| Browser CORS | Preflight **and actual application request** from the running game's exact origin | Gateway preflight may be broader than the function allowlist |
| Realtime | Two sessions: subscribe, change a score, observe a Broadcast-triggered HTTP refresh, disconnect/reconnect and dispose | Configuration/private-channel checks alone cannot prove delivery |

Doctor findings distinguish `healthy`, `warning`, `error`, `action required` and
`cannot verify`. Inspect each finding, not just exit status. Exit 1 means an error
or required action; requested live checks with incomplete evidence generally exit
2 (the HTTP `cannot verify` advisory is excepted). Exit 0 still need not prove HTTP.
`--json` provides a versioned result with `result.findings`; it never grants consent.

Relevant runtime checks: descending/ascending personal bests, non-improvements,
ties, opaque page cursors; same-key retries versus conflicting reuse; authenticated
achievement reads/unlocks; save load/replacement/conflict/replay and offline payload
retention; account/session continuity after reload. Include raw HTTP for native
clients, plus engine compilation/device tests when those environments are available.
Report untested platforms and services explicitly.

## Exact-origin troubleshooting

If configured `http://localhost:5173` but the game runs at
`http://127.0.0.1:5173`, these are different origins. Either run at the configured
host or add the actually intended origin:

<!-- local-check -->
```sh
npx supagame config origins add http://127.0.0.1:5173 --dry-run
npx supagame config origins add http://127.0.0.1:5173
```

For hosted use, preview deployment and obtain authorization before applying it.
Local staging alone does not update the hosted function secret. For local use,
restart/reload the function with its generated local origin environment. Verify
the actual browser request again. Keep Auth redirect URLs separate from CORS;
do not change unrelated providers, global settings or disable Auth/RLS.

If the CLI cannot safely merge unknown hosted `SG_ALLOWED_ORIGINS`, recover the
complete intended list first. `--replace-origins` replaces it with **all** manifest
origins and needs deployment approval; it is not a routine CORS fix. Preserve
existing legitimate origins. Wildcards, paths and trailing slashes are not origins.

## Deployment/upgrade trouble

- Wrong project: compare explicit reference, manifest and existing link records;
  stop rather than silently retargeting.
- Missing Realtime service/helpers/grants: inspect supported service provisioning
  and broad receive policies. Don't grant client Broadcast sends or rewrite global
  settings. SQL-only local stacks are insufficient for WebSocket verification.
- Auth failures: verify anonymous signup requirements or refresh the existing
  session. Never replace a failed permanent/guest identity to make tests pass.
- Uncertain deployment: keep journals/lock evidence; inspect remote progress and
  dry-run again. Do not reset databases or delete journals to bypass safeguards.
- Raw logs: credentials can appear in subprocess output; share sanitized summaries,
  never unreviewed diagnostic files, Auth responses or environment dumps.

Canonical guide:
[Troubleshooting](https://github.com/RetroBreeze/supagame/wiki/Troubleshooting).

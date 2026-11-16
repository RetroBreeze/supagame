# @retrobreeze/supagame-contracts

OpenAPI 3.1 schema and shared TypeScript types for the Supagame HTTP API.

```sh
npm install @retrobreeze/supagame-contracts
```

```ts
import type { LeaderboardPage, SubmitScoreRequest } from '@retrobreeze/supagame-contracts';
```

The [TypeScript SDK](https://github.com/RetroBreeze/supagame/blob/main/packages/sdk-ts/README.md)
installs this dependency automatically and re-exports its public types.
For other engines, use `@retrobreeze/supagame-contracts/openapi.yaml` to build an HTTP client.

See the [HTTP API reference](https://github.com/RetroBreeze/supagame/wiki/API)
for authentication, endpoints and examples.

Cloud Saves mutations require the observed generation string. Exact replay is
guaranteed only for the latest 3,072 completed operations also younger than
30 days. Stale context returns `SAVE_CONFLICT` and requires explicit reconciliation.
See the [protocol guide](https://github.com/RetroBreeze/supagame/blob/main/docs/guides/cloud-save-protocol.md).

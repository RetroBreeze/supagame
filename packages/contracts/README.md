# @retrobreeze/supagame-contracts

Versioned OpenAPI 3.1 contract and shared TypeScript DTOs for Supagame's HTTP API.
Proposed first npm release: **0.1.0**. Publication is not yet authorized; the
manifest deliberately remains private.

After publication:

```sh
npm install @retrobreeze/supagame-contracts
```

```ts
import type { LeaderboardPage, SubmitScoreRequest } from '@retrobreeze/supagame-contracts';
```

The SDK installs this dependency automatically and re-exports its public DTOs.
The schema is exported as `@retrobreeze/supagame-contracts/openapi.yaml` for
engine-independent HTTP clients. Requests use `/functions/v1/supagame/v1` in the
developer's own Supabase project. Scores must be JSON-safe integers.

See the [API guide](https://github.com/RetroBreeze/supagame/wiki/API) and
[repository](https://github.com/RetroBreeze/supagame). MIT licensed; see LICENSE.

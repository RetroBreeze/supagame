# Engine-independent HTTP integration

The backend/CLI works independently of language. There is no official Supagame
Unity, Godot, Unreal, C# or GDScript package. Implement the HTTP contract using
the project's HTTP/JSON and session facilities; do not invent engine SDK methods.
The contract is available in `@retrobreeze/supagame-contracts/openapi.yaml` or
[the source OpenAPI](https://github.com/RetroBreeze/supagame/blob/main/packages/contracts/openapi.yaml).
Use the version matching the installed backend; generated clients still need Auth,
error handling and the save/realtime protocols.

## Connection and Auth

Base URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/supagame/v1`
(or the trusted `apiBaseUrl` returned by `supagame connection`). Every application
request sends `apikey: <project publishable key>`. Protected requests also send
`Authorization: Bearer <player access token>`. A publishable key is **not** that
token. Writes send `Content-Type: application/json`, UTF-8, without compression.
Never send player IDs as ownership overrides or follow redirects with credentials.

Reuse the game's existing Supabase session, including refresh/persistence. For a
new raw HTTP Auth adapter, the minimal anonymous flow is:

| Request to the Supabase project URL (not Supagame's base) | Body and handling |
| --- | --- |
| `POST /auth/v1/signup` | `{}` for anonymous signup, only when no session exists and anonymous signup is enabled; send `apikey` and JSON content type. Projects requiring CAPTCHA need their supported challenge flow. |
| `POST /auth/v1/token?grant_type=refresh_token` | `{"refresh_token":"<persisted refresh token>"}` with the same headers; persist the returned rotated session atomically. |

Persist `access_token`, `refresh_token`, expiry and user identity in appropriate
platform storage. Serialize refreshes; bind pending work to the original user.
Fail visibly if refresh is rejected, never fall back to anonymous signup. Do not
log request headers/Auth responses or commit tokens. Losing an unlinked guest
session may make their data unrecoverable. Follow the existing app's sign-in and
account-linking choices. [Supabase anonymous Auth](https://supabase.com/docs/guides/auth/auth-anonymous)
is separate from the Supagame API.

## Wire contract

Paths below are relative to the Supagame base. Only the first two are public;
all other routes require the player's JWT as well as the project key.

| Method/path | Body/result |
| --- | --- |
| `GET /leaderboards` | Board summaries; enabled boards by default, also disabled boards when Admin is installed |
| `GET /leaderboards/arcade/entries?limit=10` | `{entries, nextCursor}`; limit 1–100, default 50; URL-encode opaque cursor on subsequent requests |
| `GET /leaderboards/arcade/me` | Personal entry or JSON `null` |
| `POST /leaderboards/arcade/scores` | `{"score":1250,"submissionKey":"<new UUID>"}` → `{outcome,score,bestScore}` |
| `GET /players/me` | Player profile |
| `PATCH /players/me` | `{"displayName":"Player One"}` → profile |
| `GET /achievements` | Authenticated achievement array with unlock state; no unlock/write endpoint |
| `GET /saves` | `{slots,generation}` (context even for an empty player) |
| `GET /saves/progress` | `{save,generation}`; missing save is `SAVE_NOT_FOUND` |
| `POST /saves/progress` | Discriminated actions, including save/delete/prepare/commit/abort/revisions/loadRevision/restore; use the Cloud Saves reference and OpenAPI |

Use integer JSON scores within ±9,007,199,254,740,991, including in C#/C++.
Equal scores share competition ranks (1,1,3). Never derive rank from array index.
Admin preserves disabled-board reads, but submissions to disabled boards fail.
An Admin board reset invalidates old cursors; start paging again.
A retry preserves UUID/body/board/player; a new UUID means a new submission.
Leaderboard/profile bodies are limited to 4,096 UTF-8 bytes. Unknown fields and
query parameters are rejected. Errors are flat `{code,message}` objects, with
additional save-conflict context where specified. Distinguish HTTP 401, 403, 409,
429 and transport failures; don't classify all failures as offline. Use bounded
backoff and explicit retries, respecting idempotency and the original identity.

## Engine adapters

- **Unity:** use the installed Unity version's `UnityWebRequest`,
  `UploadHandlerRaw` for UTF-8 JSON and `DownloadHandlerBuffer` for responses.
  Set `apikey`, `Authorization` and content type before `SendWebRequest()`.
  Inspect both request result and HTTP status, parse DTOs using the game's JSON
  library, and dispose the request. Schedule UI updates through the game's normal
  lifecycle. These are Unity APIs, not a Supagame C# SDK.
  [Unity request headers](https://docs.unity.com/en-us/engine/6000.3/script-reference/unityengine/networking/unitywebrequest/setrequestheader).
- **Godot 4:** use a scene-owned `HTTPRequest`, `JSON.stringify` and
  `request_completed`; check the start error, transport result and HTTP status.
  Wait until the node is inside the scene tree before requesting, and allow only
  one in-flight request per node. Example transport below; the application
  supplies a current JWT and a UUID persisted before submission.
- **Unreal/custom clients:** map the same methods, headers and JSON onto the
  engine's existing asynchronous HTTP transport. Verify the installed engine API
  before generating code; there is no bundled native adapter.

```gdscript
extends Node

# One request at a time on this node. Do not log auth arguments or raw responses.
func submit_score(http: HTTPRequest, api_base: String, public_key: String,
        access_token: String, score: int, submission_key: String) -> Dictionary:
    if access_token.is_empty() or score < -9007199254740991 or score > 9007199254740991:
        return {"error": "Invalid session or score"}
    http.timeout = 15.0
    http.max_redirects = 0
    var headers := PackedStringArray([
        "apikey: " + public_key,
        "Authorization: Bearer " + access_token,
        "Content-Type: application/json",
    ])
    var payload := JSON.stringify({"score": score, "submissionKey": submission_key})
    var started := http.request(api_base + "/leaderboards/arcade/scores",
        headers, HTTPClient.METHOD_POST, payload)
    if started != OK:
        return {"error": "Request could not start"}
    var response: Array = await http.request_completed
    if response[0] != HTTPRequest.RESULT_SUCCESS:
        return {"error": "Transport failure; retain original submission"}
    var parsed = JSON.parse_string(response[3].get_string_from_utf8())
    if not parsed is Dictionary:
        return {"error": "Unexpected response"}
    return {"status": response[1], "body": parsed}
```

Validate successful fields against the OpenAPI before using them in gameplay;
this transport excerpt is not a full Auth or response-validation client. For
public reads use GET with `apikey`; no anonymous sign-in is necessary.
[Godot HTTPRequest](https://docs.godotengine.org/en/stable/classes/class_httprequest.html).
Native builds normally omit Origin; browser/WebGL exports require exact CORS
origins and must not attempt to bypass browser restrictions.

## Live integration outside TypeScript

REST supports snapshots, not a subscription endpoint. Live delivery uses Supabase
Realtime **private Broadcast**, topic `supagame:leaderboard:<board-id>`, event
`changed`, payload `{boardId}`. Authenticate the Realtime connection with the
player JWT, receive hints, then re-fetch top/personal rank via HTTP. Rehydrate on
reconnect and account change; do not trust hints as score data. Implement against
a verified Supabase Realtime client/protocol for the target environment and test
actual WebSocket delivery. If unavailable, explain that bounded HTTP polling is
snapshot refresh, not verified Live Leaderboards; do not invent a native SDK or
claim an HTTP request proved Realtime.

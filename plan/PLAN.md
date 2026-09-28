# Sentinel implementation plan

## 1. Goal and scope

Build an accountless PWA that lets someone install the app, create named HTTP endpoints, and receive push notifications when authenticated requests hit those endpoints.

This plan supersedes the account/login and secret-URL assumptions in `RESEARCH.md`. Retain that document's platform research, browser limitations, and Rust Web Push compatibility findings.

### MVP experience

1. Open/install the PWA without registering an account.
2. Enable notifications through an explicit user action.
3. Create an endpoint with an automatically generated name such as `wonderful-red-hippo`.
4. Copy its URL and generated trigger token, or a ready-to-run curl example.
5. Send a POST request with the token in the `Authorization` header.
6. Receive a notification; tapping it opens the event in the PWA.
7. Reopen the PWA and see previously created endpoints from IndexedDB.

Endpoints can be created before notifications are enabled, but the UI must clearly show that notification delivery is not configured.

### MVP boundaries

- TypeScript + Vite PWA, with Dexie for IndexedDB.
- Rust Cloudflare Worker for management and ingestion.
- Cloudflare D1, Queues, scheduled outbox recovery, and Static Assets.
- Rust push sender if the compatibility spike succeeds; small TypeScript consumer otherwise.
- POST-only triggers, header authentication required, metadata-only event history.
- One managed browser installation per endpoint initially; one installation can manage many endpoints.
- No passwords, email login, passkeys, user accounts, automatic cross-device synchronization, custom domains, arbitrary code execution, or raw request archive.
- UI framework remains an implementation choice; no framework-specific design is assumed here.

## 2. Access model

Use **endpoint-scoped capability credentials**, not anonymous access to management APIs.

| Value | Purpose | Storage |
| --- | --- | --- |
| Public name | Friendly URL and display name | D1 and Dexie |
| Endpoint ID | Stable opaque record identifier | D1 and Dexie |
| Trigger token | Authorizes incoming notification events only | Hash in D1; plaintext in Dexie |
| Management token | Authorizes configuration, event reads, device linking, token rotation and deletion | Hash in D1; plaintext in Dexie |
| Browser push subscription | Vendor delivery endpoint and encryption material | Browser and D1; optional local metadata |

Rules:

- Generate two independent 256-bit tokens using cryptographically secure randomness; encode as base64url, optionally with distinct type prefixes.
- Never derive credentials from the funny name, installation ID, another token, or timestamps.
- Hash high-entropy tokens with SHA-256 server-side; password hashing is unnecessary for randomly generated 256-bit secrets. Use constant-time digest comparison.
- Trigger tokens never grant management access, even when presented to a management route.
- Tokens go in authorization headers, never URLs or notification payloads.
- A local installation ID may help UI bookkeeping but is not authentication.
- Losing the management credential means losing management access unless a backup exists. There is no email-based recovery in the MVP.

Keeping plaintext credentials in Dexie enables copying trigger tokens later, but exposes them to same-origin JavaScript. Mitigate with a strict CSP, no untrusted HTML, minimal third-party scripts, and no credential logging. Encrypting Dexie with a key stored alongside it does not solve XSS.

## 3. Application architecture

```text
PWA / Dexie ── management token ──► Rust API Worker ──► D1
                                                       │
External caller ── trigger token ──► Rust ingress ──────┤
                                                       │ event + outbox
                                                       ▼
                                           Cloudflare Queue
                                                       │
                                           Push sender consumer
                                                       │
                                           Vendor push service
                                                       │
                                           PWA service worker
                                                       ▼
                                               OS notification
```

Deploy frontend assets and API under the same origin initially. Reserve `/api/*` and `/h/*` for Worker execution; SPA fallback must not handle those routes. Mark API and trigger responses `Cache-Control: no-store`.

Suggested repository layout:

```text
apps/pwa/               TypeScript application, manifest, service worker, Dexie
workers/api/            Rust management, ingress, scheduled recovery
workers/push/           Sender consumer; language selected by spike
migrations/             D1 migrations
contracts/              API schemas and shared test fixtures
tests/                  Integration and end-to-end tests
```

Pin toolchain/dependency versions and separate local, staging, and production bindings/secrets.

## 4. Persistence

### D1: authoritative service state

- `endpoints`: ID, unique public name, trigger/management token hashes, token versions, enabled state, notification preference, created/updated timestamps.
- `push_subscriptions`: ID, unique vendor-endpoint fingerprint, vendor URL, `p256dh`, `auth`, VAPID key version, active state, timestamps.
- `endpoint_devices`: endpoint-to-push-subscription association; enforce at most one active association per endpoint for MVP.
- `events`: ID, endpoint ID, received timestamp, method, content type, bounded byte count, optional caller idempotency key. Do not retain raw bodies, authorization headers or arbitrary query strings.
- `outbox`: event/job ID, state, dispatch lease, created/dispatched timestamps.
- `deliveries`: event ID, subscription ID, state, attempts, next attempt, lease expiration and sanitized provider status. Unique `(event_id, subscription_id)`.
- `creation_requests`: hashes of short-lived creation recovery credentials, request identity and expiry, for retry-safe provisioning.

Use foreign keys and indexes for name lookup, endpoint history cursors, device associations, pending outbox rows and delivery retries. Deletion must invalidate pending work; consumers must recheck endpoint/subscription state before sending. Remove unreferenced subscriptions during cleanup rather than deleting a subscription still used by another endpoint.

### Dexie: this installation's endpoint wallet

- `endpoints`: ID, name, URL, trigger token, management token, token versions, local preferences, created timestamp and last successful synchronization.
- `pendingOperations`: creation/rotation request IDs and recovery material, written before network requests.
- `settings`: schema version, installation label, backup reminder and non-sensitive UI preferences.

Persist endpoint credentials in a single Dexie transaction. Support versioned schema migrations and surface storage failures explicitly. Do not announce creation complete until credentials are durably saved locally.

Render the local list immediately, then refresh each record through its management capability using bounded concurrency. There is no server-wide anonymous “list my endpoints” API: the local wallet defines the user's list.

Offline mode supports viewing local records and copying existing integration details. Creation, rotation and deletion require connectivity; do not silently queue destructive actions.

## 5. Provisioning and naming

### Naming service

Implement a backend module using curated adjective/color/animal word lists. This is an internal service/module, not a dependency on an external naming API.

- Randomly choose a combination and normalize to lowercase hyphenated ASCII.
- Reject reserved or inappropriate combinations through curated lists.
- Insert under a D1 unique constraint; on collision generate another name with bounded retries.
- Return a retryable error if allocation fails; monitor collision frequency and expand the vocabulary if needed.
- Do not treat the name as secret or use a preflight availability check as the uniqueness guarantee.

### Retry-safe creation

Server-generated credentials create an important failure case: the endpoint is created but the response or local write is lost.

Implement a short-lived provisioning protocol:

1. The PWA generates a high-entropy creation recovery secret and request ID, and writes both to Dexie before sending.
2. The backend rate-limits/verifies the creation request and generates the name and both endpoint tokens.
3. Atomically insert the endpoint and a creation-result record bound to the request/recovery credential.
4. Store the token-bearing result encrypted under a server-held key with a short expiry, such as 24 hours. Store only a hash of the recovery credential for authentication.
5. Retrying the same request with that credential returns the same result during the recovery window, not another endpoint.
6. The PWA saves the endpoint wallet record and removes the pending operation after success.
7. Scheduled cleanup removes expired creation results. After expiry, an unrecovered result cannot be reconstructed from token hashes; explain this limitation and allow a new creation attempt.

Recovery credentials never go in URLs/logs. Bind retries to the original request parameters. Apply the same recoverable-result principle to trigger-token rotation so a lost response does not leave Dexie holding only an invalid token.

## 6. API contract

Example trigger:

```sh
curl -X POST 'https://sentinel.example/h/wonderful-red-hippo' \
  -H 'Authorization: Bearer <trigger-token>' \
  -H 'Content-Type: application/json' \
  --data '{"message":"Build completed"}'
```

MVP notifications use generic text, not the supplied message: `wonderful-red-hippo received a request`. This avoids collecting and displaying arbitrary sensitive content on lock screens.

| Route | Authorization | Behavior |
| --- | --- | --- |
| `POST /api/endpoints` | Creation recovery credential + abuse checks | Create/recover provisioning result |
| `GET /api/endpoints/:id` | Management token | Refresh endpoint configuration/status |
| `PATCH /api/endpoints/:id` | Management token | Enable/disable endpoint or notifications |
| `DELETE /api/endpoints/:id` | Management token | Revoke endpoint and remove retained data |
| `POST /api/endpoints/:id/rotate-trigger-token` | Management token | Retry-safe replacement trigger credential |
| `PUT /api/endpoints/:id/device` | Management token | Idempotently link/update this browser subscription |
| `DELETE /api/endpoints/:id/device` | Management token | Unlink this endpoint's device association |
| `POST /api/endpoints/:id/test-notification` | Management token | Rate-limited queued test notification |
| `GET /api/endpoints/:id/events` | Management token | Cursor-paginated event metadata |
| `GET /api/endpoints/:id/events/:eventId` | Management token | Read one endpoint-scoped event |
| `POST /h/:name` | Trigger token | Persist event/outbox and return `202` with event ID |

Use a uniform unauthorized/not-found response for inaccessible endpoint resources where practical. Return `413` for oversized input, `429` with retry guidance for limits, and `503` when durable acceptance fails. Define optional `Idempotency-Key` behavior scoped to the endpoint, with a finite retention period; deduplicate only explicit matching keys, not identical bodies.

Reject trigger methods other than POST; HEAD/OPTIONS must not produce events. Do not allow query-string authentication or browser-session credentials on the trigger route. Same-origin management needs no permissive CORS; cross-origin browser webhook support is out of scope initially.

## 7. Push and reliable delivery

- Store event and outbox row in one atomic D1 operation before returning success.
- Attempt immediate enqueue; scheduled recovery retries undispatched outbox work.
- Queue messages carry opaque IDs, not trigger/management credentials or full request bodies.
- Resolve the currently linked device at dispatch, then recheck enabled/revoked state before sending.
- Use unique delivery records and leases to coordinate attempts; retry only outstanding work.
- Treat Queue processing as at-least-once. Provider acceptance followed by a crash can still produce duplicate notifications; do not promise exactly-once behavior.
- Use a notification tag based on event ID to reduce duplicate UI.
- Disable subscriptions on provider 404/410; retry transient failures with bounded exponential backoff/jitter and `Retry-After` support.
- Alert on authentication/configuration failures rather than deleting all subscriptions.
- Configure explicit retry limits, short interactive batch latency, dead-letter queue and replay tooling.
- Record `provider_accepted`, not “delivered” or “read.”

The service worker displays a small generic notification containing endpoint/event IDs and a same-origin click target, never capability tokens. Event details are fetched by the foreground application using Dexie-held management credentials. If the wallet lacks that endpoint, show a recovery explanation rather than granting access from the notification URL.

On app open, reconcile `pushManager.getSubscription()` and relink locally managed endpoints when the browser subscription changes. On iOS/iPadOS, guide users to install to Home Screen and open the installed app before enabling push. Do not assume browser-tab storage automatically transfers to the installed app; include this in real-device testing.

## 8. Security, limits and recovery

### Launch controls

- Enforce maximum request bytes while streaming, initially 64 KiB; do not trust `Content-Length` alone.
- Authenticate before processing bodies and cap work per request.
- Rate-limit anonymous endpoint creation by available trusted edge signals; use Turnstile when exposing public creation. Do not require an interactive challenge on webhook calls.
- Set per-endpoint trigger limits, notification caps and service-wide budgets. Anonymous clients can reset local identifiers, so these are not an account-level abuse boundary.
- Enforce push URL HTTPS/vendor-host allowlists, standard ports, no userinfo, and no redirects to prevent SSRF. Verify actual supported vendor hosts during the spike.
- Validate browser subscription key encodings and sizes; linking a subscription never grants management access to other endpoints using it.
- Use parameterized SQL, safe text rendering, strict CSP and same-origin notification navigation.
- Redact tokens, provisioning results, request bodies and push URLs from logs/traces.
- Store VAPID and provisioning-encryption keys in Workers secrets; document key versions and rotation.
- Suggested initial retention: seven days of metadata, short-lived provisioning results, and bounded delivery diagnostic history. Make these deployment settings and publish them in the UI.

### User-facing recovery

- Clearly explain: “Your endpoint access is stored on this device. Clearing app data can remove it.”
- Request persistent browser storage where supported; treat it as best-effort, not backup.
- Before public launch, provide a versioned encrypted export/import of the endpoint wallet. Use a maintained browser-compatible implementation of password-based key derivation and authenticated encryption; never invent an encryption format without review.
- A backup passphrase is optional and local to backup creation; it is not an account password or server login.
- Backups contain powerful credentials: warn users, validate imports, never automatically call arbitrary base URLs from imported files, and verify credentials against the configured service before syncing.
- Import restores management access, not the old browser push subscription. Ask before replacing the endpoint's linked device; single-device MVP semantics mean the previous device stops receiving new events.
- Distinguish “Forget on this device” from “Delete endpoint.” Forgetting does not revoke the server endpoint or its linked push subscription; offer explicit unlinking and warn about continued notifications.

## 9. Implementation phases

### Phase 0 — prove deployed compatibility

- [ ] Scaffold minimal Rust Worker and TypeScript PWA builds; pin toolchains.
- [ ] Deploy staging D1, Queue and Rust consumer integration.
- [ ] Time-box Rust encrypted Web Push compatibility investigation to 1–2 days.
- [ ] If native crypto dependencies block it, use a small TypeScript Web Crypto sender.
- [ ] Deliver notifications to desktop Chromium, Firefox and a real installed iPhone PWA.
- [ ] Verify app-closed delivery, click navigation, vendor host allowlists, bundle size and CPU usage.

**Exit:** deployed end-to-end push works and the sender language/dependency decision is recorded. Do not build the product around an unverified Rust crypto stack.

### Phase 1 — database and capability API

- [ ] Add D1 migrations, indexes and constraint tests.
- [ ] Implement funny-name generation and collision retries.
- [ ] Implement token generation, hashing and strict token-role separation.
- [ ] Implement recoverable creation and trigger-token rotation.
- [ ] Implement configuration, deletion, device association and event-read APIs.
- [ ] Add creation limits, request validation and structured redacted logging.

**Exit:** API tests prove credentials cannot cross endpoints or roles, duplicate create requests return one result, and retries recover after dropped responses.

### Phase 2 — PWA wallet and endpoint management

- [ ] Implement Dexie schema/migrations and transactional credential persistence.
- [ ] Build endpoint list, creation flow, detail view, copy URL/token/curl controls and deletion confirmation.
- [ ] Mask tokens until revealed; never put them in page URLs or analytics.
- [ ] Add offline list rendering, sync status and actionable storage/network errors.
- [ ] Implement manifest, app shell caching, installation guidance and update flow.
- [ ] Add permission UI, subscription reconciliation, endpoint linking and test-push controls.

**Exit:** closing/reopening the installed PWA preserves endpoints; creating without push enabled is supported and clearly marked; storage failures do not silently lose credentials.

### Phase 3 — ingestion and durable notifications

- [ ] Implement POST trigger authentication and streaming size limit.
- [ ] Atomically persist metadata/event and outbox; add optional idempotency keys.
- [ ] Implement immediate enqueue plus scheduled outbox recovery.
- [ ] Implement delivery leases, provider response handling, bounded retries and DLQ.
- [ ] Add service-worker push/click handlers and paginated event screen.
- [ ] Add cleanup, revocation checks, latency metrics and budget limits.

**Exit:** an authenticated curl call produces an inbox event and push; unauthorized calls create neither. Queue/provider outages do not silently lose accepted work.

### Phase 4 — recovery and release hardening

- [ ] Implement encrypted export/import and device-replacement confirmation.
- [ ] Test permissions, storage clearing, reinstall, stale backups and subscription replacement on real devices.
- [ ] Run authorization, SSRF, XSS, payload-boundary and abuse tests.
- [ ] Add CI gates, staged deployment, migration procedure and rollback/runbook documentation.
- [ ] Configure alerts for old outbox items, queue lag, DLQ growth, provider auth failures and spend.
- [ ] Publish limitations, retention policy and credential-loss guidance.

**Exit:** all launch acceptance tests pass and recovery/operational procedures have been exercised, not merely documented.

## 10. Required acceptance tests

1. **Accountless onboarding:** a fresh installation creates an endpoint without login/email/password.
2. **Persistence:** endpoint list and usable credentials survive application restart and schema migration.
3. **Names:** concurrent collisions resolve through database constraints without duplicate names.
4. **Header requirement:** no token, wrong token, query token, or management token cannot trigger an event.
5. **Capability isolation:** endpoint A's credentials cannot read/manage/trigger endpoint B; trigger credentials cannot call management APIs.
6. **Provisioning recovery:** lost response and failed Dexie final write can recover the same creation result within the recovery window.
7. **Rotation:** old trigger token stops working; retrying a lost rotation response recovers the replacement token.
8. **Push lifecycle:** permission denial, subscription expiry and relinking produce clear UI and correct backend state.
9. **Failure recovery:** crashes after D1 commit, Queue acceptance and provider acceptance do not corrupt state; unavoidable duplicate-push risk is documented.
10. **Revocation:** disabled/deleted endpoints and unlinked devices are skipped by pending consumers, except already in-flight provider sends that cannot be recalled.
11. **Privacy:** no secrets appear in request URLs, logs, push payloads, service-worker caches or raw-body history.
12. **Recovery:** backup import restores endpoint access, validates service origin, and only replaces the notification device with confirmation.
13. **Real iPhone:** installed app receives push while not open, and notification navigation works with its actual storage context.
14. **Abuse resistance:** oversized requests, spoofed push hosts, redirect targets and excessive anonymous creation fail safely.

## 11. Definition of done

A user can install Sentinel, create `wonderful-red-hippo`, copy a header-authenticated curl command, receive its notification, inspect event metadata, reopen the app with their endpoint list intact, rotate/revoke access, and back up/restore their endpoint wallet—without creating an account. The deployment has durable recovery, enforceable resource limits, observability, and explicit best-effort notification semantics.

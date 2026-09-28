# Sentinel: webhook-to-PWA push research

Research date: 2026-09-18. This is an architecture recommendation, not an implemented or deployment-tested system. Sources were retrieved during this research; platform pricing and dependency compatibility should be rechecked before implementation.

## Executive recommendation

**Yes—this is a good fit for Cloudflare.** Build a TypeScript PWA, a Rust Worker for endpoint management and ingestion, D1 for persistent state, and Queues for asynchronous delivery. Use standards-based Web Push rather than a native app or proprietary notification SDK.

The main uncertainty is **sending encrypted Web Push from Rust compiled to Workers' WebAssembly target**. Validate that first. If the Rust dependencies fight the runtime, retain the Rust backend and use a small TypeScript Queue consumer for notification delivery. That fallback stays entirely on Cloudflare and avoids building a cryptographic protocol implementation from scratch.

Important constraints:

- iPhone/iPad push requires a Home Screen web app on iOS/iPadOS 16.4 or later, plus permission requested through direct user interaction. An ordinary browser tab is not enough. [1]
- Cloudflare hosts the application, but notifications still travel through browser vendors' push services—Apple, Google, Mozilla, etc.
- A successful webhook response means **accepted for processing**, not displayed on a device. Push is best-effort; keep an in-app event inbox.
- “Arbitrary endpoints” should initially mean dynamically created URL records under your own domain, not new Worker deployments, arbitrary code execution, or arbitrary custom domains.

## 1. Proposed product model

Assumptions for planning, not settled requirements:

1. An authenticated user creates an endpoint, names it, and receives a secret trigger URL.
2. The user installs/opens the PWA and selects **Enable notifications on this device**.
3. The browser creates a push subscription. The backend associates that device with the user.
4. The user chooses which endpoints should notify that device.
5. An external service calls a trigger URL. Sentinel records the event and schedules notifications.
6. A notification opens the corresponding event in the authenticated PWA.

Keep these concepts distinct:

| Concept | Meaning |
| --- | --- |
| Trigger endpoint | An application-owned URL receiving external HTTP requests |
| Event | One accepted request, with bounded metadata and optional payload preview |
| Push subscription | A browser-issued delivery URL plus `p256dh` and `auth` key material |
| Endpoint subscription | A user's/device's choice to receive events for a trigger endpoint |
| Delivery | One event's notification attempt for one push subscription |

A browser push subscription belongs to a service-worker registration, not to one trigger endpoint. Reuse it across selected endpoints rather than asking permission repeatedly. [2]

### Endpoint semantics

Suggested shape: `https://hooks.example.com/h/<random-secret>` or same-origin `/h/<random-secret>` for the first deployment.

- Use one dynamic router and database lookup; endpoint creation is a database operation.
- Start with POST. Make other methods explicit configuration if “any hit” is genuinely required.
- GET triggers can fire from link previews, scanners, prefetching, and retries. Treat this as an explicit opt-in warning.
- HEAD and OPTIONS should not notify by default.
- Return `202 Accepted` with an event ID after durable acceptance; allow a fixed `200`/`204` mode later for integrations that require it.
- Return `404` for unknown/revoked endpoints, `405` for disabled methods, `413` for oversized bodies, and `429` for rate limits.
- Do not cache trigger responses. Ensure static/SPA routing never intercepts `/h/*` or `/api/*`.
- Friendly names belong in the UI; do not let a guessable slug be the sole authorization credential.

## 2. Cloudflare architecture

```text
External service
    │ HTTPS request
    ▼
Rust ingress/API Worker ─────────── D1
    │                              endpoints, devices, subscriptions,
    │                              events, deliveries, outbox
    ▼
Cloudflare Queue ◄──── outbox recovery via scheduled Worker
    │
    ▼
Push sender consumer (Rust if validated; TypeScript fallback)
    │ encrypted Web Push + VAPID
    ▼
Browser-vendor push service
    │
    ▼
PWA service worker → OS notification → authenticated event screen

TypeScript PWA assets → Cloudflare Workers Static Assets
```

| Component | Recommendation | Reason |
| --- | --- | --- |
| Frontend | TypeScript + Vite; choose UI framework separately | Conventional static SPA; no SSR needed for the core product |
| Hosting | Workers Static Assets | Deploy static files and Worker together; Pages is also viable [3] |
| API/ingestion | Rust `worker` crate / `workers-rs` | Official Cloudflare Rust bindings; supports fetch, D1, Queues and scheduled work [4] |
| Persistent data | D1 | Relational ownership, endpoint/device subscriptions, inbox and delivery state |
| Async delivery | Queues with explicit retries and DLQ | Keeps webhook latency independent of push-provider latency [5][6] |
| Secrets | Wrangler/Workers secrets | VAPID private keys and session/provider credentials |
| Large bodies | Omit initially; optional R2 later | Avoid turning the MVP into an unlimited request archive |
| Strong coordination | Durable Objects only when needed | Useful for strict per-endpoint counters/coalescing; not required for basic CRUD |
| KV | Not the authoritative subscription/authorization store | Avoid eventual-consistency surprises around revocation and ownership |

### Hosting/build detail

Vite builds the frontend separately; `worker-build` produces the Rust Worker's Wasm and JavaScript glue. Wrangler deploys both artifacts. Do not assume a JavaScript-oriented Vite Worker template automatically wires up a Rust build.

Workers Static Assets supports SPA fallback and selective `run_worker_first` routes. Reserve `/api/*` and `/h/*` for Worker execution and verify unknown API routes return JSON/404, not `index.html`. A dedicated hook hostname is useful isolation later, but not a prerequisite. [3]

Prefer small bounded delivery batches over large fan-out inside one Worker invocation. Benchmark CPU time, Wasm bundle size, memory, subrequests and crypto overhead against Workers limits. [7]

## 3. Rust feasibility: the first technical gate

### What is established

`workers-rs` targets `wasm32-unknown-unknown`. Async Rust is supported, but ordinary native Tokio/async-std runtimes and native networking assumptions do not carry over. D1 and Queue APIs have feature flags in the SDK. Use Workers bindings and fetch rather than assuming a native HTTP client works. [4]

The SDK README contains some old “alpha/beta” wording around products; do not infer current Cloudflare product maturity from those labels. Pin and inspect the actual SDK release used.

### The Web Push dependency trap

A sender must perform both:

- **VAPID authentication:** P-256 signing and appropriate JWT claims/authorization headers. [8]
- **Payload encryption:** ECDH/HKDF/AES-128-GCM according to Web Push content-encryption rules. VAPID signing alone is not enough. [9]

The inspected `web-push` manifest (version 0.11.0 on its repository branch) defaults to `isahc-client`, offers a native Hyper/TLS alternative, and depends on `ece`. The inspected `ece` manifest defaults to an OpenSSL backend. The Web Push README also explicitly requires OpenSSL. **This is not a demonstrated Workers-compatible dependency stack.** Disabling the HTTP client's default features alone does not remove transitive native crypto dependencies. [10][11]

| Option | Assessment |
| --- | --- |
| Rust sender using compatible existing crypto + Workers fetch | Preferred if the compatibility spike succeeds without substantial bespoke crypto |
| Rust calling Web Crypto through JS/Wasm bindings | Possible investigation path; requires interoperability and encoding tests |
| Small TypeScript Queue consumer using Web Crypto | Recommended fallback; clean separation with the Rust application retained |
| Native Rust service/container solely for push | Adds deployment/operational scope without a clear MVP benefit |
| Hand-written Web Push protocol implementation | Avoid unless necessary and independently reviewed/tested |

A concrete fallback candidate is `@block65/webcrypto-web-push`; npm metadata for version 2.0.0 explicitly claims Cloudflare Workers support. That is a **candidate, not a verified dependency**: audit maintenance, API, license, dependencies and deployed behavior before adopting it. A Node `web-push` package should likewise not be assumed compatible merely because the consumer is TypeScript. [12]

### Spike acceptance criteria

1. Pin Rust, `worker`, `worker-build`, Wrangler and candidate dependencies.
2. Build the exact sender for `wasm32-unknown-unknown` and deploy to a test Worker.
3. Deliver a small encrypted notification to desktop Chromium, Firefox, and a real installed iPhone PWA.
4. Verify notification click navigation and revoked subscription handling.
5. Measure bundle size and CPU for 1, 10 and 100 target devices using bounded batches.
6. Verify Queue consumption and D1 writes using the same deployed build.

Time-box this to roughly 1–2 engineering days. If it requires maintaining a native-library fork or a new encryption implementation, use the TypeScript consumer instead. No compatibility build or real-device test was performed as part of this research.

## 4. PWA and browser behavior

### Required frontend pieces

- HTTPS, a stable manifest `id`, name, icons, `start_url`, scope and standalone display mode.
- A service worker controlling the application, with `push` and `notificationclick` handlers.
- Explicit permission UX tied to a user click, not a prompt on first page load.
- `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` using the public VAPID key.
- Authenticated subscription registration with the backend.
- `event.waitUntil(registration.showNotification(...))` in the push handler.
- On click, focus an existing app window or open a same-origin event URL.
- A settings screen showing permission, device subscription, selected endpoints and a test-notification action.

Use feature detection for `serviceWorker`, `PushManager` and `Notification`; do not rely solely on browser names. [1][2]

| Environment | Expected behavior / product implication |
| --- | --- |
| iOS/iPadOS 16.4+ | Install to Home Screen, open installed app, then subscribe through a user gesture [1] |
| Safari on supported macOS versions | Standards-based Web Push is available; test supported OS/browser combinations [1] |
| Chromium desktop/Android and Firefox | Standards-based push available in supported environments; install requirements and permission UX vary |
| Private browsing, embedded browsers, restricted devices | Support may be absent or constrained; retain a useful inbox-only experience |

Apple uses APNs behind standards-based Web Push; Apple Developer Program membership is not required. You do not need native APNs device tokens or an App Store release. [1]

### Practical limitations

- The page need not be open; the platform can wake its service worker. Device power state, OS settings, Focus modes, browser policies and network access still affect delivery.
- Treat pushes as **user-visible notifications**, not a dependable silent background synchronization mechanism.
- Permission denial requires explanatory settings guidance, not repeated prompts.
- Reconcile `getSubscription()` with the backend whenever the app opens. Handle `pushsubscriptionchange` where available, but do not rely exclusively on it.
- An expired login session should not prevent a received push from displaying. Clicking into private event details should require authentication.
- Keep payloads small: target under roughly 3 KB of JSON to leave encryption overhead below common 4 KB limits. Send event ID, endpoint label and a safe short preview—not the whole webhook. [9]
- Cache the application shell; do not automatically cache authenticated event bodies. Clear user-specific state on logout/account switch.
- Use a stable notification `tag` per event to reduce duplicate UI, understanding that OS/browser behavior varies.

VAPID private keys stay on the server; the public key goes to the browser. Track a key version per push subscription and plan rotation: replacing the application-server key is not a transparent operation for existing subscriptions.

## 5. Durable acceptance and delivery semantics

### Avoid the database/queue dual-write hole

“Insert event, then enqueue” can lose dispatch if the process stops between operations. “Enqueue, then insert” can create messages pointing at nonexistent records. D1 and Queues do not share one atomic transaction.

Recommended approach:

1. In one atomic D1 batch/transaction, insert the event and an outbox row.
2. Return success only after that durable commit.
3. Attempt to enqueue the outbox item immediately for low latency.
4. A scheduled recovery job scans indexed pending outbox rows and enqueues anything missed.
5. Mark the outbox row dispatched only after Queue acceptance. A crash before marking can enqueue twice; consumers must tolerate that.

`waitUntil` may accelerate dispatch but must not be the only delivery mechanism. The durable outbox makes a `202` honest even when Queues is temporarily unavailable. Monitor outbox age; recovery cadence affects tail latency.

For MVP, resolve eligible device subscriptions at dispatch time and document that choice. Before each send, recheck ownership/revocation/mute state. If “subscribed at the exact time of the hit” is required, snapshot recipients when recording the event instead.

### Delivery processing

Queues is at-least-once, not exactly-once. Do not depend on event ordering. [5]

- Use unique `(event_id, push_subscription_id)` delivery records.
- Claim attempts with an atomic state transition/lease to avoid concurrent duplicate sends.
- Record provider acceptance separately from failure and retry state.
- Reclaim expired leases after crashes; persist retry timing and attempt counts.
- There remains an unavoidable ambiguity if a provider accepts the push and the consumer crashes before recording success. Do not promise exactly-once notifications.
- Dedupe caller retries only when a stable caller-supplied idempotency key/provider event ID exists. Scope it to the endpoint and define a retention window; identical request bodies may represent legitimate separate events.

Suggested provider-response policy:

| Result | Action |
| --- | --- |
| Successful 2xx | Record `provider_accepted`, not `delivered` or `read` |
| 404/410 | Disable expired/invalid subscription; stop retrying it |
| 429, transient 5xx, network timeout | Bounded exponential backoff with jitter; honor `Retry-After` |
| 400/413 | Inspect payload/format; do not retry unchanged forever |
| 401/403 | Investigate VAPID/key/configuration; alert rather than delete every device |

Use explicit per-message acknowledgments, retry policy, and a dead-letter queue with an operator replay path. Queues defaults to three retries, and without a DLQ exhausted messages are deleted. Set a short batch timeout for interactive notifications—the documented default is five seconds. [6]

For small fan-out, an event job can resume outstanding delivery rows. For larger fan-out, enqueue one job per device or bounded chunk; acknowledge the parent only after child jobs are accepted, and tolerate duplicate children. Do not resend already accepted deliveries when one device fails.

Set push TTL intentionally; stale operational alerts may be undesirable. Expired, muted, rate-limited or coalesced notifications should remain intelligible in the inbox. Web Push does not provide a universal device-display/read receipt; optional client acknowledgments are telemetry, not a delivery guarantee.

## 6. Suggested data and API surface

### D1 entities

- `users`: account identity.
- `endpoints`: owner, label, trigger-token hash, accepted methods, enabled state, notification policy.
- `push_subscriptions`: owner, browser endpoint, endpoint fingerprint, `p256dh`, `auth`, VAPID key version, device label, enabled state, timestamps.
- `endpoint_subscriptions`: endpoint/device association and mute preferences; unique pair.
- `events`: endpoint, timestamp, method, bounded/redacted metadata, preview, optional idempotency key.
- `deliveries`: event/device, state, attempt count, next attempt, lease expiry, last provider status.
- `outbox`: event/job ID, dispatch state, timestamps/lease.

Index owner lookups, trigger-token hashes, endpoint subscription lookups, event history `(endpoint_id, created_at, id)`, pending outbox work and pending deliveries. Use cursor pagination and retention cleanup. Bound stored body size independently of the HTTP request limit. Avoid raw-body storage by default.

### Example application API

```text
POST   /api/endpoints
GET    /api/endpoints
PATCH  /api/endpoints/:id
DELETE /api/endpoints/:id
POST   /api/endpoints/:id/rotate-secret
POST   /api/push-subscriptions
DELETE /api/push-subscriptions/:id
PUT    /api/endpoints/:id/subscriptions/:deviceId
DELETE /api/endpoints/:id/subscriptions/:deviceId
GET    /api/events?endpointId=...&cursor=...
GET    /api/events/:id
POST   /api/push-subscriptions/:id/test
POST   /h/:secret
```

All management APIs require authentication and ownership checks. The trigger URL uses its own capability credential, not the user's interactive session. Never let an unauthenticated caller specify arbitrary recipient devices.

## 7. Security and abuse controls

This is an Internet-facing input collector and notification fan-out service. Abuse prevention belongs in the first usable version.

- **Trigger credentials:** generate at least 128 bits of cryptographic randomness, store a hash for lookup, show the full URL at creation, and support revocation/rotation. If users must redisplay it later, decide on encrypted recoverable storage rather than pretending a hash is reversible.
- **URL leakage:** secret URLs leak through logs, screenshots and monitoring tools. Redact them from application logs; use `Referrer-Policy: no-referrer`. Offer header-token authentication when the caller supports it.
- **Signed integrations:** later support provider HMAC signatures and timestamp/replay validation over raw request bytes. Generic capability URLs do not authenticate a named provider.
- **Tenant isolation:** scope every endpoint, event, subscription and delivery lookup to its owner. Cross-account browser subscription reassignment must be explicit and authenticated.
- **Management authentication:** prefer a maintained OIDC/session approach over writing password auth. Use Secure/HttpOnly/SameSite cookies, CSRF defenses and restricted CORS. For a personal-only first version, Cloudflare Access is an alternative, but do not put interactive Access challenges on incoming webhook URLs.
- **Untrusted push URLs / SSRF:** subscription registration supplies a URL the server will fetch. Enforce HTTPS, reject credentials/nonstandard ports and redirects, and allow only carefully parsed known vendor push hosts. Apple documents `*.push.apple.com`; inventory the actual Google/Mozilla hosts in the spike. Use proper hostname-boundary checks, not substring matching. Unknown providers should fail safely pending allowlist review. [1]
- **Cost amplification:** limit endpoint creation, device registration, request rate, stored bytes and fan-out per account/endpoint. Add burst coalescing and daily caps. Approximate edge rate limiting is not a strict global budget; use atomic coordination if a hard cap is required.
- **Payload handling:** choose an application limit such as 64 KiB initially, enforce it while reading, and bound JSON depth/field lengths. Never execute supplied templates/code or fetch URLs supplied in webhook bodies.
- **Sensitive data:** redact authorization/cookie headers and secret query parameters. Treat push-subscription URLs and `auth` material as sensitive. Default to generic lock-screen text; payload encryption does not hide content displayed on the device.
- **Rendering/navigation:** render payloads as text; use a restrictive CSP; only allow same-origin, application-generated notification click targets.
- **Lifecycle:** deleting an endpoint or account must revoke future sends, invalidate pending work and remove retained private content according to policy. On logout, explicitly offer/perform device unlinking so private notifications do not continue unexpectedly.

## 8. Cost and scaling expectations

Published pricing retrieved during research: [13][14][15]

| Resource | Relevant pricing |
| --- | --- |
| Workers Paid | $5/month account minimum; includes 10M requests and 30M CPU-ms/month; additional requests $0.30/M and CPU $0.02/M ms |
| Static Assets | Asset-only requests are free; requests executing Worker code are billed as Worker requests |
| Queues Paid | 1M operations/month included, then $0.40/M; typically three operations per successfully processed message under 64 KB |
| D1 Paid | 25B rows read/month, 50M rows written/month and 5 GB included; then $0.001/M reads, $1/M writes and $0.75/GB-month |

A small personal deployment can plausibly remain near the $5 Workers baseline, excluding domain registration, identity-provider fees and optional services. That is an estimate, not a quote.

Example: 100,000 events/month × 2 devices = 200,000 delivery jobs, approximately 600,000 Queue operations before retries. If using a separate event fan-out queue, add roughly 300,000 operations: about 900,000 total. Outbox duplicates/retries and DLQ traffic increase that number. D1 indexes, delivery state transitions and retention deletes also count as writes.

The Free plan can support experiments: currently 100,000 Worker requests/day, 10 ms CPU/invocation, 10,000 Queue operations/day, and 24-hour Queue retention. Paid Queues defaults to four-day retention, configurable up to 14 days. Crypto CPU and daily limits make Paid a more comfortable production starting point. [13][14]

No paid notification SaaS is inherently required for standards-based Web Push. The dominant scaling multiplier is **events × target devices × attempts**, not endpoint count. Put budget alerts and resource caps in place before making endpoint creation public.

## 9. Implementation sequence and validation

### Phase 0 — prove the risky path

- Deploy a minimal Rust Worker with D1 and Queue bindings.
- Build a minimal TypeScript PWA with install guidance, subscribe and test-push controls.
- Run the sender compatibility spike above; select Rust or the TS delivery adapter based on evidence.
- Test a real iPhone Home Screen install and at least two desktop browser engines.

### Phase 1 — usable MVP

- Authenticated single-owner endpoints, POST triggers and secret rotation.
- Device registration and endpoint/device subscriptions.
- Durable event/outbox recording, Queues delivery, retries and DLQ.
- Safe notification content, click-through and a paginated event inbox.
- Payload limits, rate limits, device caps and retention cleanup.

### Phase 2 — hardening / optional product features

- Signed provider integrations, additional trigger methods, bounded notification templates.
- Quiet hours, coalescing, filtering and per-device preferences.
- Shared/team endpoints only after explicitly designing the permission model.
- Optional R2 body retention, custom domains, export and operational dashboards.

### Test plan

- Rust unit tests: route parsing, authorization decisions, token handling, payload limits, retry classification and redaction.
- Runtime integration tests against built Wasm via Wrangler/Miniflare: D1 migrations, atomic event/outbox writes, Queue retries, duplicate jobs and ownership isolation.
- Failure injection: crash after event commit, enqueue success, push acceptance and before delivery-state update; confirm recovery without falsely claiming exactly-once behavior.
- Provider simulations: 410, 429 with `Retry-After`, 500, timeout, bad VAPID and oversized payload.
- Abuse tests: fan-out exhaustion, hostile subscription URLs, redirects, spoofed hostnames, deep JSON, secret leakage and cross-account access.
- Real-device tests: app closed, device locked/offline, reconnect before/after TTL, permission denied/revoked, install/update/reinstall, logout and account switching.
- Browser automation can cover UI flows but does not substitute for real OS notification and APNs tests.

Track ingress acceptance/error rates, oldest pending outbox age, queue lag, retry/DLQ counts, expired subscriptions, provider acceptance latency, CPU and storage costs. Correlate with opaque event/delivery IDs, not secret URLs or full payload logs.

## 10. Decisions to settle before implementation

1. Personal/internal tool or public multi-tenant service? This drives authentication, billing and abuse controls.
2. Does “arbitrary endpoint” mean random trigger URLs, friendly paths, selectable HTTP methods, custom domains, or all of these?
3. Is subscribing always limited to the endpoint owner, or can endpoints be shared with other users?
4. Does a new endpoint notify all a user's devices automatically or only explicitly selected devices?
5. Should notifications show payload previews or only “Endpoint X was hit” by default?
6. Is request-body history needed, and what retention period is acceptable?
7. Expected event volume, devices per endpoint and acceptable notification latency?
8. Is a small TypeScript push sender acceptable if Rust Web Push is not economical to maintain?

Recommended starting assumptions: single-owner endpoints, explicit device subscriptions, POST-only secret URLs, generic notification previews, short metadata retention, and Rust-first with a TS delivery fallback.

## Sources

Cloudflare documentation pages returned HTTP 403 to the research HTTP client. Their content was retrieved from Cloudflare's official `cloudflare-docs` repository `production` branch instead, including pricing partials. Repository branches and registry metadata are moving references, not pinned implementation versions.

1. WebKit, **Web Push for Web Apps on iOS and iPadOS**: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
2. MDN, **Push API**: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
3. Cloudflare, **Workers Static Assets**: https://developers.cloudflare.com/workers/static-assets/ — source: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/static-assets/index.mdx
4. Cloudflare, **workers-rs README**, SDK examples and runtime constraints: https://github.com/cloudflare/workers-rs
5. Cloudflare, **Queues delivery guarantees**: https://developers.cloudflare.com/queues/reference/delivery-guarantees/ — source: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/queues/reference/delivery-guarantees.mdx
6. Cloudflare, **Queue batching, retries and delays**: https://developers.cloudflare.com/queues/configuration/batching-retries/ — source: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/queues/configuration/batching-retries.mdx
7. Cloudflare, **Workers limits**: https://developers.cloudflare.com/workers/platform/limits/ — source: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/platform/limits.mdx
8. RFC 8292, **Voluntary Application Server Identification (VAPID)**: https://www.rfc-editor.org/rfc/rfc8292
9. RFC 8291, **Message Encryption for Web Push**: https://www.rfc-editor.org/rfc/rfc8291
10. Rust Web Push README and dependency manifest: https://github.com/pimeys/rust-web-push and https://github.com/pimeys/rust-web-push/blob/master/Cargo.toml
11. Mozilla `ece` dependency manifest: https://github.com/mozilla/rust-ece/blob/main/Cargo.toml
12. Web Crypto sender candidate, npm metadata inspected: https://www.npmjs.com/package/@block65/webcrypto-web-push — registry: https://registry.npmjs.org/@block65/webcrypto-web-push/latest
13. Cloudflare, **Workers pricing**: https://developers.cloudflare.com/workers/platform/pricing/ — source: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers/platform/pricing.mdx
14. Cloudflare, **Queues pricing**: https://developers.cloudflare.com/queues/platform/pricing/ — pricing table: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/partials/workers/queues_pricing.mdx
15. Cloudflare, **D1 pricing**: https://developers.cloudflare.com/d1/platform/pricing/ — pricing table: https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/partials/workers/d1-pricing.mdx

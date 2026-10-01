# Sentinel

An accountless PWA for private HTTP endpoint notifications. This foundation delivers Plan phases 0–2: a Vite + Svelte device wallet, Dexie persistence and recoverable provisioning, plus a TypeScript Cloudflare Worker/D1 management API.

## Local development

Requires Bun. Set up local secrets and D1 once, then start Vite:

```sh
bun install
bun run setup
bun dev
```

Open **http://localhost:5173** in your normal Chrome/Edge browser (not private browsing). `bun dev` runs Vite; the Cloudflare Vite plugin runs both Workers alongside the PWA with hot reload. There is no separate Wrangler server or proxy. The API, trigger URLs, and PWA all use port 5173. Local D1 state stays in `workers/api/.wrangler/state`, shared with `bun run db`. Ctrl-C stops the dev server and its Workers.

`bun dev` does not generate keys, migrate D1, or build assets. No Cloudflare login or deployment is required; actual push delivery needs internet access.

### Test a notification

1. Click **Create endpoint**.
2. Click **Enable** and allow notifications. If permission is already granted, click **Link device**.
3. Click **Send a test notification**. It sends the same example title and body shown in the curl command while retaining the linked-device check. Push jobs dispatch without a batching delay; browser/OS delivery still depends on the push service.
4. You can also copy and run the endpoint's curl command to trigger a notification. Send JSON `title` and `body` fields to customize its lock-screen text; missing, blank, or invalid fields fall back to `Sentinel` and `<endpoint name> received a request`. Keep sensitive content out of these fields: notification previews may be visible to others. The selected endpoint's activity updates immediately over SSE while visible, without polling. Returning to the app or reconnecting catches up on missed events.
5. Use **Install app** to test in the standalone PWA. The same localhost origin retains your wallet and subscription.

Allow your browser's notifications in macOS System Settings → Notifications, and turn off Focus if banners are suppressed. A queued response is not proof of delivery: inspect the running terminal for push-service errors. If a subscription expires, click **Link device** again. Automated browser profiles may reject push registration even when notification permission is granted; use your normal browser for the final delivery check.

Use the same localhost origin consistently: each port/hostname has a separate browser wallet, service worker, and notification permissions. Local trigger URLs use the current Sentinel dev-server origin and only work on this Mac; external webhook senders and phones require an HTTPS deployment/tunnel. If another app owns port 5173, start Sentinel with `bun run --filter @sentinel/pwa dev --port 5174` and use `http://localhost:5174` (including for curl). Sending requests to another app's port may return HTML instead of Sentinel's JSON.

- `bun run setup`: one-time local setup; runs `vapid` and `db` in that order.
- `bun run vapid`: generate/reuse the local VAPID pair and sync its public key into the PWA; run again if keys change.
- `bun run db`: apply local D1 migrations to the same `workers/api/.wrangler/state` used by `bun dev` when new migrations are added.
- `bun run build`: typecheck the PWA and build the client and both Workers for deployment; not needed for `bun dev`.
- `bun run test:local`: exercise provisioning, status updates, push preconditions, triggers, SSE authorization/fan-out/reconnection, events, and revocation against the running server.
- `bun test`: SSE parsing, reconnection, cancellation, endpoint isolation, slow-client cleanup, and encrypted push delivery tests (mocked push service).
- Live activity browser regression (requires `playwright-cli` and a running server): `playwright-cli -s=sentinel-live open http://localhost:5173`, then `playwright-cli -s=sentinel-live run-code --filename scripts/live-activity.playwright.js`. It verifies immediate activity delivery, no idle polling, and offline/reconnect catch-up without a page reload.

Payload accordion browser regression (requires `playwright-cli` and a running server):

```sh
playwright-cli -s=sentinel-payload open http://localhost:5173
playwright-cli -s=sentinel-payload run-code --filename scripts/notification-payload.playwright.js
```

This checks title/body, expansion, keyboard collapse, copying, reload persistence, HTML escaping, and mobile layout. It saves screenshots to `/tmp/sentinel-payload-mobile.png` and `/tmp/sentinel-payload-desktop.png`.

Local secrets live in ignored `workers/push/.dev.vars`; only the matching public key is copied to `apps/pwa/.env.local`. Keep the key pair stable. Setup does not overwrite an existing private key. The local VAPID subject defaults to `https://example.com`; replace it with your contact URL or `mailto:` address before production.

## Deployment

After initial production setup, redeploy the PWA and both Workers with:

```sh
bun run deploy
```

This builds fresh assets, applies pending remote D1 migrations without prompting, deploys the push Worker first, then deploys the API Worker and PWA. A failed build or migration stops deployment. Secrets are unchanged.

Wrangler tracks applied migration filenames in D1, so subsequent deploys skip them. Add future migrations as new numbered `.sql` files in `migrations/`; do not edit already-applied files. Databases previously set up with manual `d1 execute` commands are safe to adopt: the existing three migrations use `CREATE ... IF NOT EXISTS`. Existing metadata-only events remain readable, but their payloads cannot be recovered.

To apply only pending production migrations, run `bun run db:deploy`. For local migrations, use `bun run db`.

For production, generate a separate VAPID key pair. Put its public key in `apps/pwa/.env.local`; never expose the private key through a `VITE_*` variable:

```sh
bunx web-push generate-vapid-keys --json
# apps/pwa/.env.local
VITE_VAPID_PUBLIC_KEY=<publicKey>
```

For initial production setup, update the D1 database ID in both Worker config files and the public origin in `workers/api/wrangler.toml`, then configure the queue and secrets below. Dev overrides the public origin to localhost; builds use the value from the Worker config.

```sh
bunx wrangler queues create sentinel-notifications
bunx wrangler secret put VAPID_PUBLIC_KEY -c workers/push/wrangler.toml
bunx wrangler secret put VAPID_PRIVATE_KEY -c workers/push/wrangler.toml
bunx wrangler secret put VAPID_SUBJECT -c workers/push/wrangler.toml # e.g. mailto:alerts@example.com
bun run deploy                  # build → migrate → push Worker → API/PWA
```

The public key in the PWA and push Worker must be from the same VAPID key pair. Vite builds `apps/pwa/dist/client`, `apps/pwa/dist/sentinel_api`, and `apps/pwa/dist/sentinel_push`. The deploy scripts use the generated Worker configs; rebuild after changing production config or frontend environment variables. Only `dist/client` is public assets; Worker output can contain local `.dev.vars` for preview and must not be published as static files.

The API Worker serves the client assets and always runs first for `/api/*` and `/h/*`. Deploy the push Worker first: it owns the `EventHub` Durable Object class and migration referenced by the API's cross-Worker `EVENTS` binding.

## HTTP response contract

Sentinel's API and webhook routes return JSON, including errors (`error` and `code` fields). Successful activity subscriptions are the sole exception: they return `text/event-stream`. Revocation returns HTTP 200 with `{ "revoked": true }`.

Requests marked `application/json` (including `application/*+json`) must contain valid JSON. Malformed JSON returns HTTP 400 with an example payload, without creating an event or queuing a push:

```json
{
  "error": "Malformed JSON. Send a valid JSON payload.",
  "code": "INVALID_JSON",
  "example": {
    "title": "Build complete",
    "body": "The deployment succeeded",
    "payload": { "bargle": "pop" }
  }
}
```

Additional fields and arbitrary valid JSON values are accepted. Missing/invalid title or body fields use notification defaults. Non-JSON content types remain supported as text. Oversized bodies return HTTP 413; unsupported webhook methods return HTTP 405 with `Allow: POST`; unexpected server failures return a generic JSON HTTP 500 without internal details.

## Delivered behavior

- Generates independent 256-bit trigger and management credentials and stores only SHA-256 digests in D1.
- Writes a local creation recovery secret before provisioning; retrying it recovers the same endpoint for 24 hours.
- Persists the endpoint wallet transactionally in IndexedDB via Dexie.
- Provides endpoint status controls, device linking, credential masking/copying, curl generation, event metadata viewing, deletion, install guidance, and offline wallet rendering.
- Enforces POST-only header-authenticated triggers and a 64 KiB request limit. Full UTF-8 request payloads are stored in D1 and available only through management-authenticated event history. Avoid sending secrets or sensitive personal data.

Ingress records event metadata, notification title/body, and the full request payload, immediately publishes an activity invalidation to the endpoint's Durable Object, then queues a delivery job with bounded notification text (title up to 100 characters, body up to 500). In-app notifications show the same title/body and expand to pretty-printed JSON with a copy button; non-JSON bodies are shown as text. Older events without stored content use fallback text. History returns the latest 50 events; stored payloads currently have no automatic expiry. The queue consumer processes one message at a time without waiting for a batch, retrieves the current linked subscription from D1, sends an encrypted VAPID-authenticated Web Push message, retries transient failures up to three times, and deactivates expired subscriptions.

### Live activity (SSE)

`GET /api/endpoints/:id/stream` requires the endpoint's management bearer token. The PWA uses streaming `fetch`, not native `EventSource`, so credentials stay in an Authorization header rather than URLs/logs. Each endpoint has its own `EventHub`; its subscribe/publish/revoke routes are only accessible through internal Durable Object bindings, never public Worker routes.

A `ready` frame establishes the subscription before fetching the activity snapshot. Each subsequent `activity` frame reloads the latest 50 event records from D1. Reconnection takes a fresh snapshot, so dropped connections do not cause missing or duplicate history rows (this is not an unbounded replay log). Transient failures retry with backoff; lost heartbeats force reconnection. Revocation closes live streams and rejects new subscriptions. Slow clients are disconnected rather than buffered indefinitely.

Streams pause when the page is hidden/offline and resume when visible/online. Connections rotate every 60 seconds to reauthorize and resync after missed invalidations. SSE connections keep Durable Objects active and incur duration charges; they do not use WebSocket hibernation. SSE updates the open app's activity only—OS notifications still use Web Push, avoiding duplicate notifications from two delivery paths.

## Verification

```sh
bun check
bun run build
bun typecheck
bun test
bun run test:local               # with bun dev running
```

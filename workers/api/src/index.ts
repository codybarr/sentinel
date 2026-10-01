import { generateSlug } from "random-word-slugs";

interface Env {
  DB: D1Database;
  NOTIFICATIONS: Queue<{ eventId: string; title: string; body: string }>;
  EVENTS: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
}

interface StoredEndpoint {
  id: string;
  name: string;
  trigger_token_version: number;
  management_token_version: number;
  enabled: number;
  notifications_enabled: number;
  created_at: string;
  updated_at: string;
  management_token_hash: string;
}

interface TriggerEndpoint {
  id: string;
  trigger_token_hash: string;
  enabled: number;
}

interface Event {
  id: string;
  receivedAt: string;
  method: string;
  contentType: string | null;
  byteCount: number;
  title: string | null;
  body: string | null;
  payload: string | null;
}

const encoder = new TextEncoder();
const notFound = () => json({ error: "Not found", code: "NOT_FOUND" }, 404);
const bad = (message: string) =>
  json({ error: message, code: "INVALID_REQUEST" }, 400);

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly example?: unknown,
  ) {
    super(message);
  }
}

const notificationExample = {
  title: "Build complete",
  body: "The deployment succeeded",
  payload: { bargle: "pop" },
};

function isJson(contentType: string | null): boolean {
  return (
    !!contentType &&
    /^application\/(?:json|[\w.-]+\+json)(?:\s*;|\s*$)/i.test(contentType)
  );
}

function parseJson(bytes: Uint8Array, example?: unknown): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new RequestError(
      "Malformed JSON. Send a valid JSON payload.",
      400,
      "INVALID_JSON",
      example,
    );
  }
}

async function requestJson(
  request: Request,
  example: unknown,
): Promise<unknown> {
  const payload = await limitedBody(request);
  if (payload === null)
    throw new RequestError(
      "Payload too large. Maximum size is 64 KiB.",
      413,
      "PAYLOAD_TOO_LARGE",
    );
  return parseJson(payload.bytes, example);
}
const now = () => new Date().toISOString();
const validId = (id: string) => id.length <= 128 && /^[a-zA-Z0-9-]*$/.test(id);

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function bearer(request: Request, scheme: string): string | null {
  const value = request.headers.get("Authorization");
  return value?.startsWith(`${scheme} `)
    ? value.slice(scheme.length + 1)
    : null;
}

async function hash(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function equalHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomId(): string {
  return randomToken().slice(0, 22);
}

function publicOrigin(request: Request, env: Env): string {
  const configured = new URL(env.PUBLIC_ORIGIN);
  const actual = new URL(request.url);
  // A dev server may use a different port when 5173 belongs to another app.
  const local = (hostname: string) =>
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";
  return local(configured.hostname) && local(actual.hostname)
    ? actual.origin
    : configured.origin;
}

function remote(endpoint: StoredEndpoint): Response {
  return json({
    id: endpoint.id,
    name: endpoint.name,
    triggerTokenVersion: endpoint.trigger_token_version,
    managementTokenVersion: endpoint.management_token_version,
    enabled: endpoint.enabled === 1,
    notificationsEnabled: endpoint.notifications_enabled === 1,
    createdAt: endpoint.created_at,
    updatedAt: endpoint.updated_at,
  });
}

async function authorize(
  request: Request,
  env: Env,
  id: string,
): Promise<StoredEndpoint | null> {
  const token = bearer(request, "Bearer");
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT id,name,trigger_token_version,management_token_version,enabled,notifications_enabled,created_at,updated_at,management_token_hash FROM endpoints WHERE id=?1 AND deleted_at IS NULL",
  )
    .bind(id)
    .first<StoredEndpoint>();
  if (!row || !equalHash(row.management_token_hash, await hash(token)))
    return null;
  return row;
}

async function create(request: Request, env: Env): Promise<Response> {
  const requestId = request.headers.get("X-Creation-Request-Id");
  if (!requestId || !validId(requestId))
    return bad("A valid X-Creation-Request-Id is required");
  const recovery = bearer(request, "Provision");
  if (!recovery || recovery.length < 32) return notFound();
  const recoveryHash = await hash(recovery);
  const existing = await env.DB.prepare(
    "SELECT result_json,recovery_hash FROM creation_requests WHERE request_id=?1 AND expires_at > datetime('now')",
  )
    .bind(requestId)
    .first<{ result_json: string; recovery_hash: string }>();
  if (existing)
    return equalHash(existing.recovery_hash, recoveryHash)
      ? json(JSON.parse(existing.result_json))
      : notFound();

  for (let attempt = 0; attempt < 8; attempt++) {
    const timestamp = now();
    const endpointName = generateSlug();
    const endpoint = {
      id: randomId(),
      name: endpointName,
      triggerToken: `tr_${randomToken()}`,
      managementToken: `mg_${randomToken()}`,
      triggerTokenVersion: 1,
      managementTokenVersion: 1,
      enabled: true,
      notificationsEnabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      url: `${publicOrigin(request, env)}/h/${endpointName}`,
    };
    try {
      // D1 batch is transactional: never leave a credential-bearing endpoint without its recovery record.
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO endpoints (id,name,trigger_token_hash,management_token_hash,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
        ).bind(
          endpoint.id,
          endpoint.name,
          await hash(endpoint.triggerToken),
          await hash(endpoint.managementToken),
          timestamp,
        ),
        env.DB.prepare(
          "INSERT INTO creation_requests (request_id,recovery_hash,endpoint_id,result_json,expires_at,created_at) VALUES (?1,?2,?3,?4,datetime('now','+1 day'),?5)",
        ).bind(
          requestId,
          recoveryHash,
          endpoint.id,
          JSON.stringify(endpoint),
          timestamp,
        ),
      ]);
      return json(endpoint);
    } catch (error) {
      // A concurrent retry may have created the endpoint first; return the same credentials only to its owner.
      const winner = await env.DB.prepare(
        "SELECT result_json,recovery_hash FROM creation_requests WHERE request_id=?1 AND expires_at > datetime('now')",
      )
        .bind(requestId)
        .first<{ result_json: string; recovery_hash: string }>();
      if (winner)
        return equalHash(winner.recovery_hash, recoveryHash)
          ? json(JSON.parse(winner.result_json))
          : notFound();
      if (!String(error).includes("UNIQUE constraint failed")) throw error;
    }
  }
  return json(
    {
      error: "Could not allocate endpoint. Retry shortly.",
      code: "ENDPOINT_ALLOCATION_FAILED",
    },
    503,
  );
}

async function patch(
  request: Request,
  env: Env,
  endpoint: StoredEndpoint,
): Promise<Response> {
  const body = await requestJson(request, {
    enabled: true,
    notificationsEnabled: true,
  });
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return bad("Invalid endpoint status");
  const values = body as Record<string, unknown>;
  if (
    (values.enabled !== undefined && typeof values.enabled !== "boolean") ||
    (values.notificationsEnabled !== undefined &&
      typeof values.notificationsEnabled !== "boolean")
  )
    return bad("Invalid endpoint status");
  const enabled =
    values.enabled === undefined ? endpoint.enabled : Number(values.enabled);
  const notifications =
    values.notificationsEnabled === undefined
      ? endpoint.notifications_enabled
      : Number(values.notificationsEnabled);
  const timestamp = now();
  await env.DB.prepare(
    "UPDATE endpoints SET enabled=?1, notifications_enabled=?2, updated_at=?3 WHERE id=?4",
  )
    .bind(enabled, notifications, timestamp, endpoint.id)
    .run();
  return remote({
    ...endpoint,
    enabled,
    notifications_enabled: notifications,
    updated_at: timestamp,
  });
}

async function remove(env: Env, endpoint: StoredEndpoint): Promise<Response> {
  await env.DB.prepare(
    "UPDATE endpoints SET deleted_at=datetime('now'), enabled=0, updated_at=datetime('now') WHERE id=?1",
  )
    .bind(endpoint.id)
    .run();
  await notifyActivity(env, endpoint.id, "revoke");
  return json({ revoked: true });
}

async function events(env: Env, endpoint: StoredEndpoint): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT events.id,received_at AS receivedAt,method,content_type AS contentType,byte_count AS byteCount,title,body,payload FROM events LEFT JOIN event_payloads ON event_payloads.event_id=events.id WHERE endpoint_id=?1 ORDER BY received_at DESC LIMIT 50",
  )
    .bind(endpoint.id)
    .all<Event>();
  const response = json({ events: rows.results });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function device(
  request: Request,
  env: Env,
  endpoint: StoredEndpoint,
): Promise<Response> {
  const body = await requestJson(request, {
    endpoint: "https://push-service.example/subscription",
    keys: { p256dh: "<public key>", auth: "<auth secret>" },
  });
  if (typeof body !== "object" || body === null)
    return bad("Invalid push subscription");
  const sub = body as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  if (
    typeof sub.endpoint !== "string" ||
    !sub.endpoint.startsWith("https://") ||
    typeof sub.keys?.p256dh !== "string" ||
    sub.keys.p256dh.length > 256 ||
    typeof sub.keys?.auth !== "string" ||
    sub.keys.auth.length > 128
  )
    return bad("Invalid push subscription");
  const timestamp = now();
  const fingerprint = await hash(sub.endpoint);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO push_subscriptions (id,endpoint_fingerprint,vendor_url,p256dh,auth,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6) ON CONFLICT(endpoint_fingerprint) DO UPDATE SET active=1,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at",
    ).bind(
      randomId(),
      fingerprint,
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      timestamp,
    ),
    env.DB.prepare(
      "INSERT INTO endpoint_devices (endpoint_id,subscription_id,created_at,updated_at) VALUES (?1,(SELECT id FROM push_subscriptions WHERE endpoint_fingerprint=?2),?3,?3) ON CONFLICT(endpoint_id) DO UPDATE SET subscription_id=excluded.subscription_id,updated_at=excluded.updated_at",
    ).bind(endpoint.id, fingerprint, timestamp),
  ]);
  return remote(endpoint);
}

async function testNotification(
  request: Request,
  env: Env,
  endpoint: StoredEndpoint,
): Promise<Response> {
  if (!endpoint.enabled || !endpoint.notifications_enabled)
    return json(
      {
        error: "Enable this endpoint and notification delivery before testing.",
        code: "NOTIFICATIONS_DISABLED",
      },
      409,
    );
  const linked = await env.DB.prepare(
    "SELECT push_subscriptions.id FROM endpoint_devices JOIN push_subscriptions ON push_subscriptions.id=endpoint_devices.subscription_id WHERE endpoint_devices.endpoint_id=?1 AND push_subscriptions.active=1",
  )
    .bind(endpoint.id)
    .first();
  if (!linked)
    return json(
      {
        error: "Link this browser before sending a test notification.",
        code: "DEVICE_NOT_LINKED",
      },
      409,
    );
  const payload = await limitedBody(request);
  if (payload === null)
    throw new RequestError(
      "Payload too large. Maximum size is 64 KiB.",
      413,
      "PAYLOAD_TOO_LARGE",
    );
  if (isJson(request.headers.get("Content-Type")))
    parseJson(payload.bytes, notificationExample);
  const event: Event = {
    id: randomId(),
    receivedAt: now(),
    method: "TEST",
    contentType: request.headers.get("Content-Type"),
    byteCount: payload.size,
    ...notificationText(
      payload.bytes,
      request.headers.get("Content-Type"),
      endpoint.name,
    ),
    payload: new TextDecoder().decode(payload.bytes),
  };
  await recordEvent(env, endpoint.id, event);
  await notifyActivity(env, endpoint.id, "publish");
  await env.NOTIFICATIONS.send({
    eventId: event.id,
    title: event.title ?? "Sentinel",
    body: event.body ?? `${endpoint.name} received a request`,
  });
  return json({ queued: true, eventId: event.id });
}

function eventHub(
  env: Env,
  endpointId: string,
  action: string,
  method: string,
): Promise<Response> {
  return env.EVENTS.get(env.EVENTS.idFromName(endpointId)).fetch(
    `https://events.internal/${action}`,
    { method },
  );
}

async function notifyActivity(
  env: Env,
  endpointId: string,
  action: string,
): Promise<void> {
  // D1 is authoritative; reconnecting SSE clients resync if publication fails.
  try {
    const response = await eventHub(env, endpointId, action, "POST");
    if (!response.ok) console.error("live activity publication failed");
  } catch {
    console.error("live activity publication failed");
  }
}

async function recordEvent(
  env: Env,
  endpointId: string,
  event: Event,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO events (id,endpoint_id,received_at,method,content_type,byte_count) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(
      event.id,
      endpointId,
      event.receivedAt,
      event.method,
      event.contentType ?? "",
      event.byteCount,
    ),
    env.DB.prepare(
      "INSERT INTO event_payloads (event_id,title,body,payload) VALUES (?1,?2,?3,?4)",
    ).bind(event.id, event.title, event.body, event.payload),
  ]);
}

async function limitedBody(
  request: Request,
): Promise<{ size: number; bytes: Uint8Array } | null> {
  const reader = request.body?.getReader();
  if (!reader) return { size: 0, bytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { size, bytes };
      }
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function notificationText(
  bytes: Uint8Array,
  contentType: string | null,
  endpointName: string,
): { title: string; body: string } {
  const defaults = {
    title: "Sentinel",
    body: `${endpointName} received a request`,
  };
  if (!isJson(contentType)) return defaults;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return defaults;
    const fields = parsed as Record<string, unknown>;
    const text = (value: unknown, fallback: string, max: number) =>
      typeof value === "string" && value.trim()
        ? value.trim().slice(0, max)
        : fallback;
    return {
      title: text(fields.title, defaults.title, 100),
      body: text(fields.body, defaults.body, 500),
    };
  } catch {
    return defaults;
  }
}

async function ingest(
  request: Request,
  env: Env,
  name: string,
): Promise<Response> {
  if (request.method !== "POST") {
    const response = json(
      { error: "Method not allowed. Use POST.", code: "METHOD_NOT_ALLOWED" },
      405,
    );
    response.headers.set("Allow", "POST");
    return response;
  }
  const token = bearer(request, "Bearer");
  if (!name || !token) return notFound();
  const row = await env.DB.prepare(
    "SELECT id,trigger_token_hash,enabled FROM endpoints WHERE name=?1 AND deleted_at IS NULL",
  )
    .bind(name)
    .first<TriggerEndpoint>();
  if (
    row?.enabled !== 1 ||
    !equalHash(row.trigger_token_hash, await hash(token))
  )
    return notFound();
  const payload = await limitedBody(request);
  if (payload === null)
    throw new RequestError(
      "Payload too large. Maximum size is 64 KiB.",
      413,
      "PAYLOAD_TOO_LARGE",
    );
  const contentType = request.headers.get("Content-Type");
  if (isJson(contentType)) parseJson(payload.bytes, notificationExample);
  const event: Event = {
    id: randomId(),
    receivedAt: now(),
    method: "POST",
    contentType,
    byteCount: payload.size,
    ...notificationText(payload.bytes, contentType, name),
    payload: new TextDecoder().decode(payload.bytes),
  };
  await recordEvent(env, row.id, event);
  await notifyActivity(env, row.id, "publish");
  await env.NOTIFICATIONS.send({
    eventId: event.id,
    title: event.title ?? "Sentinel",
    body: event.body ?? `${name} received a request`,
  });
  return json({ eventId: event.id }, 202);
}

async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/endpoints" && request.method === "POST")
    return create(request, env);
  if (path.startsWith("/h/")) return ingest(request, env, path.slice(3));
  const match = /^\/api\/endpoints\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (!match) return notFound();
  const endpoint = await authorize(request, env, match[1]);
  if (!endpoint) return notFound();
  const action = match[2];
  if (!action) {
    if (request.method === "GET") return remote(endpoint);
    if (request.method === "PATCH") return patch(request, env, endpoint);
    if (request.method === "DELETE") return remove(env, endpoint);
  }
  if (request.method === "GET" && action === "events")
    return events(env, endpoint);
  if (request.method === "GET" && action === "stream") {
    const response = await eventHub(env, endpoint.id, "subscribe", "GET");
    // Successful SSE is intentionally a stream; errors still follow the JSON contract.
    return response.ok
      ? response
      : json(
          { error: "Activity stream unavailable", code: "STREAM_UNAVAILABLE" },
          response.status,
        );
  }
  if (request.method === "PUT" && action === "device")
    return device(request, env, endpoint);
  if (request.method === "POST" && action === "test-notification")
    return testNotification(request, env, endpoint);
  return notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (cause) {
      if (cause instanceof RequestError) {
        return json(
          {
            error: cause.message,
            code: cause.code,
            ...(cause.example === undefined ? {} : { example: cause.example }),
          },
          cause.status,
        );
      }
      // Never expose database details, credentials, or request contents.
      console.error("Sentinel API request failed unexpectedly");
      return json(
        { error: "Internal server error", code: "INTERNAL_ERROR" },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;

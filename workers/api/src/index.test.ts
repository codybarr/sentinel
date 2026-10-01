import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import worker from "./index.ts";

const token = "test-secret";
const digest = Array.from(
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");

function fixture() {
  const jobs: Array<{ eventId: string; title: string; body: string }> = [];
  const database = new Database(":memory:");
  for (const migration of [
    "0001_foundation.sql",
    "0002_push_delivery.sql",
    "0003_event_payloads.sql",
  ]) {
    database.exec(
      readFileSync(
        new URL(`../../../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  database.exec("PRAGMA foreign_keys = OFF");
  const env = {
    DB: {
      batch: async (statements: Array<{ run: () => unknown }>) =>
        database.transaction(() =>
          statements.map((statement) => statement.run()),
        )(),
      prepare(sql: string) {
        return {
          bind(...values: Array<string | number | null>) {
            return {
              first: async () =>
                sql.includes("push_subscriptions")
                  ? { id: "device-1" }
                  : {
                      id: "endpoint-1",
                      name: "my-endpoint",
                      trigger_token_hash: digest,
                      management_token_hash: digest,
                      enabled: 1,
                      notifications_enabled: 1,
                    },
              run: () => database.query(sql).run(...values),
              all: async () => ({
                results: database.query(sql).all(...values),
              }),
            };
          },
        };
      },
    },
    EVENTS: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
    },
    NOTIFICATIONS: {
      send: async (job: (typeof jobs)[number]) => {
        jobs.push(job);
      },
    },
  };
  const send = (body: string, contentType = "application/json") =>
    worker.fetch(
      new Request("https://example.com/h/my-endpoint", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType,
        },
        body,
      }),
      env as never,
    );
  const testPush = (body: string) =>
    worker.fetch(
      new Request(
        "https://example.com/api/endpoints/endpoint-1/test-notification",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
        },
      ),
      env as never,
    );
  const readEvents = (credential = token) =>
    worker.fetch(
      new Request("https://example.com/api/endpoints/endpoint-1/events", {
        headers: { Authorization: `Bearer ${credential}` },
      }),
      env as never,
    );
  const request = (path: string, method = "POST", body?: string) =>
    worker.fetch(
      new Request(`https://example.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      }),
      env as never,
    );
  return { jobs, send, testPush, readEvents, database, request, env };
}

test("malformed JSON returns instructional JSON without recording or queueing", async () => {
  const { send, testPush, jobs, readEvents } = fixture();
  for (const call of [send, testPush]) {
    const response = await call('{"title":');
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      error: expect.any(String),
      code: "INVALID_JSON",
      example: {
        title: "Build complete",
        body: "The deployment succeeded",
        payload: { bargle: "pop" },
      },
    });
  }
  expect(jobs).toHaveLength(0);
  expect(await (await readEvents()).json()).toEqual({ events: [] });
});

test("trigger errors are JSON with appropriate HTTP status codes", async () => {
  const { send, request } = fixture();
  for (const [response, status] of [
    [await request("/h/my-endpoint", "GET"), 405],
    [await send("x".repeat(65537)), 413],
    [await request("/unknown", "GET"), 404],
  ] as const) {
    expect(response.status).toBe(status);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
    });
  }
});

test("invalid management JSON is a client error, not an HTML exception", async () => {
  const { request } = fixture();
  for (const [path, method] of [
    ["/api/endpoints/endpoint-1", "PATCH"],
    ["/api/endpoints/endpoint-1/device", "PUT"],
  ]) {
    const response = await request(path, method, "not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_JSON" });
  }
});

test("unexpected dependency failures become safe JSON server errors", async () => {
  const { send, env } = fixture();
  env.DB.batch = async () => {
    throw new Error("private database detail");
  };
  const response = await send('{"title":"Valid"}');
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: "Internal server error",
    code: "INTERNAL_ERROR",
  });
});

test("webhook title and body are passed to the notification job", async () => {
  const { jobs, send } = fixture();
  expect(
    (
      await send(
        JSON.stringify({
          title: "Build complete",
          body: "Deployment succeeded",
        }),
      )
    ).status,
  ).toBe(202);
  expect(jobs[0]).toMatchObject({
    title: "Build complete",
    body: "Deployment succeeded",
  });
  expect(jobs[0].eventId).toBeTruthy();
});

test("test notification uses the same title and body as the webhook", async () => {
  const { jobs, testPush } = fixture();
  expect(
    (
      await testPush(
        JSON.stringify({
          title: "Build complete",
          body: "The deployment succeeded",
        }),
      )
    ).status,
  ).toBe(200);
  expect(jobs[0]).toMatchObject({
    title: "Build complete",
    body: "The deployment succeeded",
  });
});

test("missing, blank and invalid fields use defaults", async () => {
  const { jobs, send } = fixture();
  await send(JSON.stringify({ title: " ", body: 42 }));
  await send(JSON.stringify({ title: "Ignored" }), "text/plain");
  for (const job of jobs)
    expect(job).toMatchObject({
      title: "Sentinel",
      body: "my-endpoint received a request",
    });
  await send(JSON.stringify({ body: "Only a body" }));
  expect(jobs[2]).toMatchObject({ title: "Sentinel", body: "Only a body" });
});

test("notification text is trimmed and bounded", async () => {
  const { jobs, send } = fixture();
  await send(
    JSON.stringify({
      title: `  ${"a".repeat(200)}  `,
      body: `  ${"b".repeat(600)}  `,
    }),
  );
  expect(jobs[0].title).toBe("a".repeat(100));
  expect(jobs[0].body).toBe("b".repeat(500));
});

test("oversized requests do not create notifications or persist payloads", async () => {
  const { jobs, send, readEvents } = fixture();
  expect((await send("x".repeat(65537))).status).toBe(413);
  expect(jobs).toHaveLength(0);
  expect(await (await readEvents()).json()).toEqual({ events: [] });
});

test("event history persists the full arbitrary payload and notification text", async () => {
  const { jobs, send, readEvents } = fixture();
  const payload = JSON.stringify({
    title: "Build complete",
    body: "Deployed",
    nested: { items: [1, null, { html: "<script>alert(1)</script>" }] },
  });
  await send(payload);
  const response = await readEvents();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({
    events: [
      expect.objectContaining({
        id: jobs[0].eventId,
        title: jobs[0].title,
        body: jobs[0].body,
        payload,
        byteCount: new TextEncoder().encode(payload).length,
      }),
    ],
  });
  expect((await readEvents("wrong-token")).status).toBe(404);
});

test("test notifications persist their payload and accurate metadata", async () => {
  const { testPush, readEvents } = fixture();
  const payload = JSON.stringify({
    title: "Test",
    body: "Hello 👋",
    extra: true,
  });
  await testPush(payload);
  expect(await (await readEvents()).json()).toEqual({
    events: [
      expect.objectContaining({
        method: "TEST",
        contentType: "application/json",
        payload,
        title: "Test",
        body: "Hello 👋",
        byteCount: new TextEncoder().encode(payload).length,
      }),
    ],
  });
});

test("legacy metadata-only events remain readable after migration", async () => {
  const { database, readEvents } = fixture();
  database
    .query(
      "INSERT INTO events (id,endpoint_id,received_at,method,byte_count) VALUES (?1,?2,?3,?4,?5)",
    )
    .run("legacy-event", "endpoint-1", "2026-01-01T00:00:00.000Z", "POST", 10);
  expect(await (await readEvents()).json()).toEqual({
    events: [
      expect.objectContaining({
        id: "legacy-event",
        title: null,
        body: null,
        payload: null,
      }),
    ],
  });
});

test("non-JSON payloads are retained as text without breaking history", async () => {
  const { send, readEvents } = fixture();
  await send("not json <b>hello</b>", "text/plain");
  expect(await (await readEvents()).json()).toEqual({
    events: [
      expect.objectContaining({
        payload: "not json <b>hello</b>",
        title: "Sentinel",
        body: "my-endpoint received a request",
      }),
    ],
  });
});

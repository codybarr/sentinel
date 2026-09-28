import { expect, test } from "bun:test";
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
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(..._values: unknown[]) {
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
              run: async () => ({}),
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
  return { jobs, send, testPush };
}

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
  await send("not json");
  await send(JSON.stringify({ title: "Ignored" }), "text/plain");
  for (const job of jobs)
    expect(job).toMatchObject({
      title: "Sentinel",
      body: "my-endpoint received a request",
    });
  await send(JSON.stringify({ body: "Only a body" }));
  expect(jobs[3]).toMatchObject({ title: "Sentinel", body: "Only a body" });
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

test("oversized requests do not create notifications", async () => {
  const { jobs, send } = fixture();
  expect((await send("x".repeat(65537))).status).toBe(413);
  expect(jobs).toHaveLength(0);
});

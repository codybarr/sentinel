import { expect, spyOn, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import worker from "./index.ts";

function fixture(status = 201, responseBody: string | null = null) {
  const vapid = createECDH("prime256v1");
  vapid.generateKeys();
  const device = createECDH("prime256v1");
  device.generateKeys();
  const row = {
    event_id: "event-1",
    endpoint_name: "test-endpoint",
    subscription_id: "device-1",
    vendor_url: "https://push.example.com/message",
    p256dh: device.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
  const writes = [];
  const env = {
    VAPID_PUBLIC_KEY: vapid.getPublicKey().toString("base64url"),
    VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString("base64url"),
    VAPID_SUBJECT: "https://example.com",
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => row,
              run: async () => writes.push({ sql, values }),
            };
          },
        };
      },
      async batch(statements) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    },
  };
  const message = {
    body: { eventId: "event-1" },
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retried = true;
    },
  };
  const fetch = async (url, payload) => {
    expect(url).toBe(row.vendor_url);
    const headers = new Headers(payload.headers);
    expect(headers.get("authorization")).toMatch(/^vapid /);
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(payload.body.byteLength).toBeGreaterThan(0);
    return new Response(responseBody, { status });
  };
  return { env, message, writes, fetch };
}

for (const status of [201, 410, 503]) {
  test(`encrypted VAPID delivery handles push-service status ${status}`, async () => {
    const f = fixture(status);
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(f.fetch);
    const errorMock = spyOn(console, "error").mockImplementation(() => {});
    try {
      await worker.queue({ messages: [f.message] }, f.env);
      expect(f.message.acked).toBe(status !== 503);
      expect(f.message.retried).toBe(status === 503);
      if (status === 201)
        expect(f.writes.some((write) => write.sql.includes("'sent'"))).toBe(
          true,
        );
      if (status === 410) {
        expect(f.writes.some((write) => write.sql.includes("active=0"))).toBe(
          true,
        );
        expect(f.writes.some((write) => write.sql.includes("'expired'"))).toBe(
          true,
        );
      }
      if (status === 503) expect(f.writes).toHaveLength(0);
    } finally {
      fetchMock.mockRestore();
      errorMock.mockRestore();
    }
  });
}

for (const [status, responseBody] of [
  [400, '{"reason":"VapidPkHashMismatch"}'],
  [403, "VAPID public key does not match the subscription. secret-token"],
] as const) {
  test(`key mismatch ${status} reports recovery steps without leaking provider response or deleting subscriptions`, async () => {
    const f = fixture(status, responseBody);
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(f.fetch);
    const errorMock = spyOn(console, "error").mockImplementation(() => {});
    try {
      await worker.queue({ messages: [f.message] }, f.env);
      expect(f.message.retried).toBe(true);
      expect(f.message.acked).toBe(false);
      expect(f.writes).toHaveLength(0);
      const logged = JSON.stringify(errorMock.mock.calls);
      expect(logged).toContain("VAPID key mismatch");
      expect(logged).toContain("enable notifications again");
      expect(logged).not.toContain("secret-token");
      expect(logged).not.toContain(f.env.VAPID_PRIVATE_KEY);
      expect(logged).not.toContain(f.env.VAPID_PUBLIC_KEY);
      expect(logged).not.toContain(f.env.VAPID_SUBJECT);
    } finally {
      fetchMock.mockRestore();
      errorMock.mockRestore();
    }
  });
}

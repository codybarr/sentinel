import { expect, spyOn, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { subscribeActivity } from "./activity-stream.ts";

async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for activity");
    await delay(5);
  }
}
function streamResponse(signal, capture) {
  let abort: () => void = () => {};
  const body = new ReadableStream({
    start(controller) {
      capture(controller);
      abort = () => {
        try {
          controller.error(new Error("Aborted"));
        } catch {}
      };
      signal.addEventListener("abort", abort, { once: true });
    },
    cancel() {
      signal.removeEventListener("abort", abort);
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}
const encode = (text) => new TextEncoder().encode(text);

test("SSE client authenticates via header, parses split frames, ignores heartbeats, and cancels", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  let updates = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    async (url, init) => {
      expect(url).toBe("/api/endpoints/one/stream");
      expect(init.headers.Authorization).toBe("Bearer secret");
      signal = init.signal;
      return streamResponse(signal, (value) => {
        controller = value;
      });
    },
  );
  const stop = subscribeActivity(
    "/api/endpoints/one/stream",
    "secret",
    async () => {
      updates++;
    },
  );
  try {
    await until(() => controller);
    controller.enqueue(encode("event: rea"));
    controller.enqueue(encode("dy\r\ndata: {}\r\n\r"));
    controller.enqueue(
      encode("\n: heartbeat\n\nevent: activity\ndata: {}\n\n"),
    );
    await until(() => updates === 2);
    expect(updates).toBe(2);
    stop();
    expect(signal.aborted).toBe(true);
  } finally {
    stop();
    fetchMock.mockRestore();
  }
});

test("SSE client reconnects after disconnect and resyncs on ready", async () => {
  let connections = 0,
    updates = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    async (_url, init) =>
      streamResponse(init.signal, (controller) => {
        connections++;
        controller.enqueue(encode("event: ready\ndata: {}\n\n"));
        if (connections === 1) controller.close();
      }),
  );
  const stop = subscribeActivity("/stream", "secret", async () => {
    updates++;
  });
  try {
    await until(() => connections === 2 && updates === 2);
    expect(updates).toBe(2);
  } finally {
    stop();
    fetchMock.mockRestore();
  }
});

test("SSE client stops retrying when endpoint access is revoked", async () => {
  let calls = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
    calls++;
    return new Response(null, { status: 404 });
  });
  const stop = subscribeActivity("/stream", "secret", async () => {
    throw new Error("No authorized stream");
  });
  try {
    await delay(1100);
    expect(calls).toBe(1);
  } finally {
    stop();
    fetchMock.mockRestore();
  }
});

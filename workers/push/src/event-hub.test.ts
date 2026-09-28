import { expect, test } from "bun:test";
import { EventHub } from "./event-hub.ts";

const request = (path, method = "GET") =>
  new Request(`https://events.internal/${path}`, { method });
const text = (frame) => new TextDecoder().decode(frame.value);

test("EventHub fans out only within its endpoint and closes revoked streams", async () => {
  const hub = new EventHub();
  const other = new EventHub();
  const readers = [];
  try {
    for (const instance of [hub, hub, other]) {
      const response = await instance.fetch(request("subscribe"));
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body.getReader();
      readers.push(reader);
      expect(text(await reader.read())).toMatch(/event: ready/);
    }
    const pending = readers.map((reader) => reader.read());
    await hub.fetch(request("publish", "POST"));
    for (const frame of await Promise.all(pending.slice(0, 2)))
      expect(text(frame)).toMatch(/event: activity/);
    // The other endpoint's next frame is its own publication, never hub's.
    await other.fetch(request("revoke", "POST"));
    expect((await pending[2]).done).toBe(true);
    const ending = readers.slice(0, 2).map((reader) => reader.read());
    await hub.fetch(request("revoke", "POST"));
    for (const frame of await Promise.all(ending))
      expect(frame.done).toBe(true);
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel()));
  }
});

test("EventHub disconnects a slow subscriber instead of accumulating events", async () => {
  const hub = new EventHub();
  const response = await hub.fetch(request("subscribe"));
  // Leave ready unread; its queue is full, so publication closes the client.
  await hub.fetch(request("publish", "POST"));
  const reader = response.body.getReader();
  expect(text(await reader.read())).toMatch(/event: ready/);
  expect((await reader.read()).done).toBe(true);
  expect((await hub.fetch(request("publish"))).status).toBe(404);
});

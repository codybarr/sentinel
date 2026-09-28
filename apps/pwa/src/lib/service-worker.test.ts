import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface WorkerEvent {
  data?: { json: () => unknown };
  waitUntil: (promise: Promise<unknown>) => void;
}

function serviceWorker() {
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const notifications: Array<{ title: string; options: { body: string } }> = [];
  let skipped = 0;
  let claimed = 0;
  const self = {
    addEventListener: (
      name: string,
      listener: (event: WorkerEvent) => void,
    ) => {
      listeners.set(name, listener);
    },
    skipWaiting: async () => {
      skipped++;
    },
    clients: {
      claim: async () => {
        claimed++;
      },
    },
    registration: {
      showNotification: async (title: string, options: { body: string }) => {
        notifications.push({ title, options });
      },
    },
  };
  runInNewContext(
    readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"),
    { self },
  );
  async function dispatch(name: string, data?: unknown) {
    const pending: Promise<unknown>[] = [];
    const listener = listeners.get(name);
    if (!listener) throw new Error(`Missing ${name} event handler`);
    listener({
      data: data === undefined ? undefined : { json: () => data },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await Promise.all(pending);
  }
  return {
    dispatch,
    notifications,
    get skipped() {
      return skipped;
    },
    get claimed() {
      return claimed;
    },
  };
}

test("updated service worker takes over existing notification clients", async () => {
  const sw = serviceWorker();
  await sw.dispatch("install");
  await sw.dispatch("activate");
  expect(sw.skipped).toBe(1);
  expect(sw.claimed).toBe(1);
});

test("push shows the JSON title and body rather than a generic fallback", async () => {
  const sw = serviceWorker();
  await sw.dispatch("push", {
    eventId: "event-1",
    title: "Build complete",
    body: "The deployment succeeded",
  });
  expect(sw.notifications).toEqual([
    {
      title: "Build complete",
      options: expect.objectContaining({ body: "The deployment succeeded" }),
    },
  ]);
});

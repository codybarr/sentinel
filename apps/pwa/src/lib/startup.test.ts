import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../App.svelte", import.meta.url), "utf8");

function initialState(permission: NotificationPermission, search = "") {
  const start = source.indexOf("let endpoints:");
  const end = source.indexOf("$: unread", start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    source.slice(start, end),
  );
  return runInNewContext(
    `${code}\n({ notificationState, notificationChecking, endpointsLoading, routeEndpoint, view });`,
    {
      window: { Notification: {} },
      Notification: { permission },
      location: { search },
      URLSearchParams,
    },
  );
}

test("granted permission is known before mount, but device readiness is not guessed", () => {
  const state = initialState("granted");
  expect(state.notificationState).toBe("granted");
  expect(state.notificationChecking).toBe(true);
});

test("saved endpoints start unknown rather than empty", () => {
  expect(initialState("default").endpointsLoading).toBe(true);
});

test("a detail refresh infers its layout from the URL before IndexedDB resolves", () => {
  const state = initialState("default", "?endpoint=saved&view=settings");
  expect(state.routeEndpoint).toBe("saved");
  expect(state.view).toBe("settings");
});

test("the local wallet renders without waiting for recovery or activity requests", async () => {
  const start = source.indexOf("onMount(() => {");
  const end = source.indexOf("</script>", start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    source.slice(start, end),
  );
  let localReads = 0;
  let recoveryStarted = false;
  let activityStarted = false;
  let cleanup = () => {};
  const context = {
    onMount: (callback: () => () => void) => {
      cleanup = callback();
    },
    refresh: async () => {
      localReads++;
    },
    db: { settings: { toArray: async () => [] } },
    readRoute: () => {},
    recoverCreates: () => {
      recoveryStarted = true;
      return new Promise(() => {});
    },
    fetchActivity: () => {
      activityStarted = true;
      return new Promise(() => {});
    },
    endpointsLoading: true,
    notificationState: "default",
    endpoints: [],
    seenAt: {},
    activityVisible: false,
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    document: {
      visibilityState: "hidden",
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    navigator: { onLine: true },
    clearInterval: () => {},
    stopActivity: () => {},
  };
  runInNewContext(code, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(localReads).toBe(1);
  expect(recoveryStarted).toBe(true);
  expect(activityStarted).toBe(true);
  expect(context.endpointsLoading).toBe(false);
  cleanup();
});

test("activity failures stay distinct from a confirmed empty inbox and allow retry", async () => {
  const start = source.indexOf("async function fetchActivity()");
  const end = source.indexOf("function updateSubscription", start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    source.slice(start, end),
  );
  const context = {
    endpoints: [{ id: "saved" }],
    api: {
      events: async (): Promise<{ events: unknown[] }> => {
        throw new Error("offline");
      },
    },
    activityErrors: {} as Record<string, boolean>,
    eventCache: {} as Record<string, unknown[]>,
    selected: undefined,
    fetch: async () => {},
  };
  runInNewContext(`${code}\nthis.fetch = fetchActivity;`, context);
  await context.fetch();
  expect(context.activityErrors.saved).toBe(true);
  expect(context.eventCache.saved).toBeUndefined();
  context.api.events = async () => ({ events: [] });
  await context.fetch();
  expect(context.activityErrors.saved).toBe(false);
  expect(context.eventCache.saved).toEqual([]);
});

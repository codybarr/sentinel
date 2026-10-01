import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise the component's real permission flow without needing an iPhone.
function permissionFlow(
  permission: NotificationPermission,
  requestedPermission: NotificationPermission = "default",
) {
  const source = readFileSync(
    new URL("../App.svelte", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function enableNotifications(");
  const end = source.indexOf("async function linkDevice(", start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    source.slice(start, end),
  );
  let requests = 0;
  let links = 0;
  const context = {
    window: { isSecureContext: true, Notification: {}, PushManager: {} },
    navigator: { serviceWorker: {} },
    Notification: {
      permission,
      requestPermission: async () => {
        requests++;
        // Model iOS rejecting a permission request outside a user gesture.
        return requestedPermission;
      },
    },
    notificationState: permission,
    notificationReady: false,
    notificationChecking: false,
    busy: false,
    error: "",
    endpoints: [{ id: "existing-endpoint" }],
    linkDevice: async () => {
      links++;
    },
    show: () => {},
  };
  runInNewContext(`${code}\nthis.enable = enableNotifications;`, context);
  return {
    context,
    enable: (announce: boolean) =>
      (
        context as typeof context & {
          enable: (announce: boolean) => Promise<void>;
        }
      ).enable(announce),
    get requests() {
      return requests;
    },
    get links() {
      return links;
    },
  };
}

test("restart restores granted notifications without requesting permission again", async () => {
  const flow = permissionFlow("granted");
  await flow.enable(false);
  expect(flow.context.notificationReady).toBe(true);
  expect(flow.requests).toBe(0);
  expect(flow.links).toBe(1);
});

test("background validation keeps the known ready state until it finishes", async () => {
  const flow = permissionFlow("granted");
  flow.context.notificationReady = true;
  let finish = () => {};
  flow.context.linkDevice = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const pending = flow.enable(false);
  expect(flow.context.notificationReady).toBe(true);
  expect(flow.context.notificationChecking).toBe(true);
  finish();
  await pending;
  expect(flow.context.notificationChecking).toBe(false);
  expect(flow.context.notificationReady).toBe(true);
});

test("unsupported push clears the initial checking state", async () => {
  const flow = permissionFlow("granted");
  flow.context.notificationChecking = true;
  flow.context.window.isSecureContext = false;
  await flow.enable(false);
  expect(flow.context.notificationChecking).toBe(false);
  expect(flow.context.notificationState).toBe("unsupported");
});

test("a tap requests permission and links the device when granted", async () => {
  const flow = permissionFlow("default", "granted");
  await flow.enable(true);
  expect(flow.requests).toBe(1);
  expect(flow.links).toBe(1);
  expect(flow.context.notificationReady).toBe(true);
});

test("automatic restoration never prompts when permission is not granted", async () => {
  const flow = permissionFlow("default");
  await flow.enable(false);
  expect(flow.requests).toBe(0);
  expect(flow.links).toBe(0);
  expect(flow.context.notificationReady).toBe(false);
});

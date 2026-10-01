<script lang="ts">
import {
  ArrowLeft,
  Bell,
  Check,
  ChevronRight,
  Copy,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "@lucide/svelte";
import { onMount } from "svelte";
import { api } from "./lib/api";
import { randomBase64Url, requestId, vapidKey } from "./lib/crypto";
import { db } from "./lib/db";
import { prettyPayload } from "./lib/payload";
import type { Endpoint, EventRecord } from "./lib/types";

let endpoints: Endpoint[] = [];
let selected: Endpoint | undefined;
let events: EventRecord[] = [];
let eventCache: Record<string, EventRecord[]> = {};
let seenAt: Record<string, string> = {};
let busy = false;
let reveal = false;
let error = "";
let notice = "";
let view: "inbox" | "settings" = "inbox";
let notificationState: NotificationPermission | "unsupported" = "default";
let notificationReady = false;
let activityVisible = false;
let activityKey = "";
let stopActivity = () => {};
let unread: Record<string, number> = {};
let totalUnread = 0;
$: unread = Object.fromEntries(
  endpoints.map((endpoint) => [
    endpoint.id,
    (eventCache[endpoint.id] ?? []).filter(
      (event) => !seenAt[endpoint.id] || event.receivedAt > seenAt[endpoint.id],
    ).length,
  ]),
);
$: totalUnread = Object.values(unread).reduce((sum, count) => sum + count, 0);
const exampleNotification = {
  title: "Build complete",
  body: "The deployment succeeded",
};
$: curl = selected
  ? [
      `curl -X POST '${selected.url}' \\`,
      `  -H 'Authorization: Bearer ${selected.triggerToken}' \\`,
      "  -H 'Content-Type: application/json' \\",
      `  --data '${JSON.stringify(exampleNotification)}'`,
    ].join("\n")
  : "";

function show(message: string) {
  notice = message;
  setTimeout(() => {
    if (notice === message) notice = "";
  }, 3200);
}
async function refresh() {
  endpoints = (await db.endpoints.orderBy("createdAt").reverse().toArray()).map(
    (endpoint) =>
      import.meta.env.DEV
        ? {
            ...endpoint,
            url: new URL(`/h/${endpoint.name}`, location.origin).href,
          }
        : endpoint,
  );
  if (selected) selected = endpoints.find((item) => item.id === selected?.id);
}
async function persist(endpoint: Endpoint) {
  await db.endpoints.put(endpoint);
  await refresh();
}
async function recoverCreates() {
  for (const pending of await db.pendingOperations.toArray()) {
    try {
      const endpoint = await api.create(
        pending.requestId,
        pending.recoverySecret,
      );
      await db.transaction(
        "rw",
        db.endpoints,
        db.pendingOperations,
        async () => {
          await db.endpoints.put(endpoint);
          await db.pendingOperations.delete(pending.requestId);
        },
      );
    } catch {
      /* Still recoverable later. */
    }
  }
}
async function create() {
  busy = true;
  error = "";
  const pending = {
    requestId: requestId(),
    recoverySecret: randomBase64Url(),
    createdAt: new Date().toISOString(),
  };
  try {
    await db.pendingOperations.put(pending);
    const endpoint = await api.create(
      pending.requestId,
      pending.recoverySecret,
    );
    await db.transaction("rw", db.endpoints, db.pendingOperations, async () => {
      await db.endpoints.put(endpoint);
      await db.pendingOperations.delete(pending.requestId);
    });
    await refresh();
    if (notificationReady) {
      await linkDevice(endpoint);
      if (error) notificationReady = false;
    }
    navigate(endpoint.id);
    show("Endpoint created.");
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : "Could not create endpoint. Your recovery attempt is saved locally.";
  } finally {
    busy = false;
  }
}
async function sync(endpoint: Endpoint) {
  try {
    const remote = await api.get(endpoint);
    await persist({
      ...endpoint,
      ...remote,
      lastSyncedAt: new Date().toISOString(),
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Sync failed";
  }
}
async function toggle(field: "enabled" | "notificationsEnabled") {
  if (!selected) return;
  busy = true;
  try {
    const remote = await api.patch(selected, { [field]: !selected[field] });
    selected = { ...selected, ...remote };
    await persist(selected);
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : "Could not update endpoint";
  } finally {
    busy = false;
  }
}
async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    show(`${label} copied.`);
  } catch {
    error = `Could not copy ${label.toLowerCase()}.`;
  }
}
async function enableNotifications(announce = true) {
  error = "";
  if (
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    !("Notification" in window) ||
    !("PushManager" in window)
  ) {
    notificationState = "unsupported";
    error = "Web Push needs a supported browser on localhost or HTTPS.";
    return;
  }
  try {
    // Restoring a PWA is not a user gesture. Reuse granted permission rather
    // than asking again: iOS can reject requests made during startup.
    notificationState = Notification.permission;
    if (announce && notificationState !== "granted") {
      notificationState = await Notification.requestPermission();
    }
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : "Could not request notification permission.";
    return;
  }
  if (notificationState !== "granted") {
    if (announce) {
      show(
        "Notifications remain off. You can change this in browser settings.",
      );
    }
    return;
  }
  busy = true;
  notificationReady = false;
  try {
    for (const endpoint of endpoints) {
      await linkDevice(endpoint);
      if (error) return;
    }
    notificationReady = true;
    if (announce) show("Notifications ready for your endpoints.");
  } finally {
    busy = false;
  }
}
async function linkDevice(endpoint: Endpoint) {
  const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (!key) {
    error = "This deployment is missing its VAPID public key.";
    return;
  }
  error = "";
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });
    await registration.update();
    await navigator.serviceWorker.ready;
    const applicationServerKey = vapidKey(key);
    let subscription = await registration.pushManager.getSubscription();
    const previousKey = subscription?.options.applicationServerKey;
    if (
      subscription &&
      previousKey &&
      !new Uint8Array(previousKey).every(
        (value, index) => value === applicationServerKey[index],
      )
    ) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
    });
    const remote = await api.linkDevice(endpoint, subscription);
    await persist({ ...endpoint, ...remote });
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : "Could not enable notifications on this device";
  }
}
async function testPush() {
  if (!selected) return;
  busy = true;
  error = "";
  try {
    await api.testNotification(selected, exampleNotification);
    show("Test notification queued.");
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not queue test";
  } finally {
    busy = false;
  }
}
async function remove() {
  if (!selected || !confirm(`Delete ${selected.name}? This cannot be undone.`))
    return;
  busy = true;
  try {
    await api.remove(selected);
    await db.endpoints.delete(selected.id);
    delete eventCache[selected.id];
    await refresh();
    navigate("");
    show("Endpoint revoked.");
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : "Could not delete endpoint";
  } finally {
    busy = false;
  }
}
async function markSeen(endpoint: Endpoint, records: EventRecord[]) {
  const latest = records.reduce(
    (date, event) => (event.receivedAt > date ? event.receivedAt : date),
    seenAt[endpoint.id] ?? "",
  );
  if (!latest || latest === seenAt[endpoint.id]) return;
  seenAt = { ...seenAt, [endpoint.id]: latest };
  await db.settings.put({ key: `seen:${endpoint.id}`, value: latest });
}
async function fetchActivity() {
  const results = await Promise.allSettled(
    endpoints.map((endpoint) => api.events(endpoint)),
  );
  for (const [index, result] of results.entries()) {
    if (result.status !== "fulfilled") continue;
    const endpoint = endpoints[index];
    eventCache = { ...eventCache, [endpoint.id]: result.value.events };
    if (selected?.id === endpoint.id && view === "inbox") {
      events = result.value.events;
      void markSeen(endpoint, events);
    }
  }
}
function updateSubscription(endpoint: Endpoint | undefined, visible: boolean) {
  const key =
    endpoint && visible ? `${endpoint.id}:${endpoint.managementToken}` : "";
  if (key === activityKey) return;
  stopActivity();
  activityKey = key;
  stopActivity =
    endpoint && visible
      ? api.subscribeEvents(endpoint, (result) => {
          if (selected?.id !== endpoint.id || activityKey !== key) return;
          events = result;
          eventCache = { ...eventCache, [endpoint.id]: result };
          void markSeen(endpoint, result);
        })
      : () => {};
}
function readRoute() {
  const params = new URLSearchParams(location.search);
  selected = endpoints.find(
    (endpoint) => endpoint.id === params.get("endpoint"),
  );
  view = selected && params.get("view") === "settings" ? "settings" : "inbox";
  reveal = false;
  events = selected ? (eventCache[selected.id] ?? []) : [];
  if (selected && view === "inbox") void markSeen(selected, events);
}
function navigate(id: string, nextView: "inbox" | "settings" = "inbox") {
  const url = new URL(location.href);
  url.searchParams.delete("event");
  if (id) url.searchParams.set("endpoint", id);
  else url.searchParams.delete("endpoint");
  if (id && nextView === "settings") url.searchParams.set("view", "settings");
  else url.searchParams.delete("view");
  history.pushState(null, "", url);
  readRoute();
  window.scrollTo(0, 0);
}
$: updateSubscription(selected, activityVisible && view === "inbox");
onMount(() => {
  let disposed = false;
  let poll: ReturnType<typeof setInterval>;
  notificationState =
    "Notification" in window ? Notification.permission : "unsupported";
  void (async () => {
    await recoverCreates();
    if (disposed) return;
    await refresh();
    const saved = await db.settings.toArray();
    seenAt = Object.fromEntries(
      saved
        .filter((row) => row.key.startsWith("seen:"))
        .map((row) => [row.key.slice(5), row.value]),
    );
    if (disposed) return;
    readRoute();
    await fetchActivity();
    if (disposed) return;
    const eventId = new URLSearchParams(location.search).get("event");
    if (eventId) {
      const owner = endpoints.find((endpoint) =>
        eventCache[endpoint.id]?.some((event) => event.id === eventId),
      );
      if (owner) navigate(owner.id);
    }
    if (notificationState === "granted") void enableNotifications(false);
    for (const endpoint of endpoints.slice(0, 4)) void sync(endpoint);
    poll = setInterval(() => {
      if (activityVisible) void fetchActivity();
    }, 30_000);
  })();
  const updateVisibility = () => {
    activityVisible =
      document.visibilityState === "visible" && navigator.onLine;
    if (activityVisible && endpoints.length) void fetchActivity();
  };
  updateVisibility();
  window.addEventListener("popstate", readRoute);
  document.addEventListener("visibilitychange", updateVisibility);
  window.addEventListener("online", updateVisibility);
  window.addEventListener("offline", updateVisibility);
  return () => {
    disposed = true;
    clearInterval(poll);
    stopActivity();
    window.removeEventListener("popstate", readRoute);
    document.removeEventListener("visibilitychange", updateVisibility);
    window.removeEventListener("online", updateVisibility);
    window.removeEventListener("offline", updateVisibility);
  };
});
</script>

<svelte:head><link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous"/><link href="https://fonts.googleapis.com/css2?family=Wix+Madefor+Text:wght@400;500;600&display=swap" rel="stylesheet"/></svelte:head>
<header class="app-header"><button class="brand" aria-label="Sentinel home" on:click={() => navigate("")}><span class="brand-symbol">◈</span> sentinel</button><div class="header-right">{#if notificationReady}<span class="ready"><Check size={14}/> notifications ready</span>{:else}<button class="enable" disabled={busy} on:click={() => enableNotifications()}><Bell size={15}/> Enable notifications</button>{/if}</div></header>
<main class="app-main">
  {#if !selected}
    <div class="page-heading"><div><p class="kicker">YOUR ENDPOINTS</p><h1>Endpoints{#if totalUnread}<span class="heading-count">{totalUnread}</span>{/if}</h1></div><button class="icon-action create-action" aria-label="Create endpoint" title="Create endpoint" disabled={busy} on:click={create}><Plus size={19}/></button></div>
    {#if endpoints.length}<div class="endpoint-list">{#each endpoints as endpoint}<button class="endpoint-row" on:click={() => navigate(endpoint.id)}><span class="endpoint-symbol" class:paused={!endpoint.enabled}>{endpoint.name.slice(0, 1)}</span><span class="endpoint-text"><strong>{endpoint.name}</strong><small>{endpoint.enabled ? "Active" : "Paused"}</small></span>{#if unread[endpoint.id]}<span class="unread-badge">{unread[endpoint.id]}</span>{/if}<ChevronRight size={18} class="chevron"/></button>{/each}</div>{:else}<div class="empty"><p>No endpoints yet.</p><button class="create-first" disabled={busy} on:click={create}><Plus size={16}/> Create endpoint</button></div>{/if}
  {:else}
    <div class="detail-nav"><button class="back" on:click={() => navigate("")}><ArrowLeft size={17}/> Endpoints</button><button class="icon-action" on:click={() => navigate(selected!.id, view === "settings" ? "inbox" : "settings")} aria-label={view === "settings" ? "View notifications" : "Endpoint settings"} title={view === "settings" ? "View notifications" : "Endpoint settings"}>{#if view === "settings"}<Bell size={19}/>{:else}<Settings2 size={19}/>{/if}</button></div>
    <div class="detail-heading"><p class="kicker">{view === "settings" ? "ENDPOINT SETTINGS" : "NOTIFICATIONS"}</p><h1>{selected.name}</h1>{#if view === "inbox"}<p class="subheading">{selected.enabled ? "Active" : "Paused"}</p>{/if}</div>
    {#if view === "inbox"}
      <section class="notification-stack" aria-label="Recent notifications"><div class="list-caption"><span>Recent</span><span>{events.length} notifications</span></div>{#each events as event (event.id)}<details class="notification-card"><summary class="notification-summary"><span class="notification-icon"><Bell size={18}/></span><span class="notification-body"><span class="notification-top"><strong>{event.title ?? "Sentinel"}</strong><time datetime={event.receivedAt}>{new Date(event.receivedAt).toLocaleString()}</time></span><span class="notification-preview">{event.body ?? `${selected.name} received a request`}</span></span><ChevronRight size={16} class="notification-chevron"/></summary><div class="notification-payload"><div class="payload-toolbar"><small>{event.method} · {event.contentType || "unknown type"} · {event.byteCount.toLocaleString()} B</small>{#if event.payload != null}<button class="icon-action" aria-label="Copy payload" title="Copy payload" on:click={() => copy(prettyPayload(event.payload!), "Payload")}><Copy size={16}/></button>{/if}</div>{#if event.payload != null}<pre class="payload-json">{prettyPayload(event.payload)}</pre>{:else}<p class="payload-unavailable">Payload unavailable for this older notification.</p>{/if}</div></details>{:else}<p class="nothing">No notifications yet.</p>{/each}</section>
    {:else}
      <section class="settings-content"><div class="settings-heading"><h2>Endpoint details</h2><button class="icon-action" aria-label="Refresh endpoint" title="Refresh endpoint" disabled={busy} on:click={() => selected && sync(selected)}><RefreshCw size={16}/></button></div>
        <div class="setting-row"><span>Status</span><button class:active={selected.enabled} class="switch" role="switch" aria-checked={selected.enabled} aria-label="Toggle endpoint" disabled={busy} on:click={() => toggle("enabled")}><span></span></button></div>
        <div class="setting-row"><span>Notification delivery</span><button class:active={selected.notificationsEnabled} class="switch" role="switch" aria-checked={selected.notificationsEnabled} aria-label="Toggle notifications" disabled={busy} on:click={() => toggle("notificationsEnabled")}><span></span></button></div>
        <div class="setting-block"><span>Trigger URL</span><div class="value-line"><code>{selected.url}</code><button class="icon-action" aria-label="Copy trigger URL" title="Copy trigger URL" on:click={() => copy(selected!.url, "URL")}><Copy size={16}/></button></div></div>
        <div class="setting-block"><span>Trigger token</span><div class="value-line"><code>{reveal ? selected.triggerToken : "••••••••••••••••••••••••••••••••"}</code><button class="icon-action" aria-label="Copy trigger token" title="Copy trigger token" on:click={() => copy(selected!.triggerToken, "Token")}><Copy size={16}/></button></div><button class="inline-link" on:click={() => reveal = !reveal}>{reveal ? "Hide token" : "Reveal token"}</button></div>
        <div class="setting-block"><div class="value-line"><span>curl / POST</span><button class="icon-action" aria-label="Copy curl command" title="Copy curl command" on:click={() => copy(curl, "curl command")}><Copy size={16}/></button></div><pre>{curl}</pre></div>
        {#if notificationState === "granted" && selected.notificationsEnabled}<button class="test-action" disabled={busy} on:click={testPush}>Send a test notification ↗</button>{/if}
        <button class="revoke" disabled={busy} on:click={remove}><Trash2 size={16}/> Revoke endpoint</button>
        <p class="wallet-note">Access is held on this device. Clearing app data removes your local keys.</p>
      </section>
    {/if}
  {/if}
</main>
{#if error}<div class="error" role="alert">{error}<button aria-label="Dismiss error" on:click={() => error = ""}>×</button></div>{/if}
{#if notice}<div class="toast" role="status">{notice}</div>{/if}

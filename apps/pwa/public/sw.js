self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = {
      body: event.data?.text() ?? "A Sentinel endpoint received a request.",
    };
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Sentinel", {
      body: data.body ?? "A Sentinel endpoint received a request.",
      tag: data.eventId ?? undefined,
      data: { eventId: data.eventId },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow(
      `/?event=${encodeURIComponent(event.notification.data?.eventId ?? "")}`,
    ),
  );
});

import {
  buildPushPayload,
  type PushSubscription,
  type VapidKeys,
} from "@block65/webcrypto-web-push";

export { EventHub } from "./event-hub.ts";

interface Env {
  DB: D1Database;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

interface NotificationJob {
  eventId: string;
  title?: string;
  body?: string;
}

interface DeliveryRow {
  event_id: string;
  endpoint_name: string;
  subscription_id: string;
  vendor_url: string;
  p256dh: string;
  auth: string;
}

const deliveryQuery = `
  SELECT events.id AS event_id, endpoints.name AS endpoint_name,
         push_subscriptions.id AS subscription_id, push_subscriptions.vendor_url,
         push_subscriptions.p256dh, push_subscriptions.auth
  FROM events
  JOIN endpoints ON endpoints.id = events.endpoint_id
  JOIN endpoint_devices ON endpoint_devices.endpoint_id = endpoints.id
  JOIN push_subscriptions ON push_subscriptions.id = endpoint_devices.subscription_id
  WHERE events.id = ?1
    AND endpoints.deleted_at IS NULL
    AND endpoints.enabled = 1
    AND endpoints.notifications_enabled = 1
    AND push_subscriptions.active = 1
`;

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const vapid: VapidKeys = {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    };

    for (const message of batch.messages) {
      const job = notificationJob(message.body);
      if (!job) {
        console.error("discarding malformed notification job");
        message.ack();
        continue;
      }
      try {
        await deliver(job, env, vapid);
        message.ack();
      } catch (error) {
        console.error("push delivery failed", {
          eventId: job.eventId,
          error: String(error),
        });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;

function notificationJob(value: unknown): NotificationJob | undefined {
  if (typeof value !== "object" || value === null || !("eventId" in value))
    return undefined;
  const fields = value as Record<string, unknown>;
  const eventId = fields.eventId;
  if (typeof eventId !== "string" || eventId.length === 0) return undefined;
  return {
    eventId,
    title: typeof fields.title === "string" ? fields.title : undefined,
    body: typeof fields.body === "string" ? fields.body : undefined,
  };
}

async function deliver(
  job: NotificationJob,
  env: Env,
  vapid: VapidKeys,
): Promise<void> {
  const delivery = await env.DB.prepare(deliveryQuery)
    .bind(job.eventId)
    .first<DeliveryRow>();
  if (!delivery) return;

  const subscription: PushSubscription = {
    endpoint: delivery.vendor_url,
    expirationTime: null,
    keys: { p256dh: delivery.p256dh, auth: delivery.auth },
  };
  const payload = await buildPushPayload(
    {
      data: {
        eventId: delivery.event_id,
        title: job.title || "Sentinel",
        body: job.body || `${delivery.endpoint_name} received a request`,
      },
      options: { ttl: 60, urgency: "high" },
    },
    subscription,
    vapid,
  );
  const response = await fetch(subscription.endpoint, payload);

  if (response.ok) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO push_deliveries (event_id,subscription_id,status,delivered_at) VALUES (?1,?2,'sent',datetime('now'))",
    )
      .bind(delivery.event_id, delivery.subscription_id)
      .run();
    return;
  }
  if (response.status === 404 || response.status === 410) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE push_subscriptions SET active=0,updated_at=datetime('now') WHERE id=?1",
      ).bind(delivery.subscription_id),
      env.DB.prepare(
        "INSERT OR REPLACE INTO push_deliveries (event_id,subscription_id,status,delivered_at) VALUES (?1,?2,'expired',datetime('now'))",
      ).bind(delivery.event_id, delivery.subscription_id),
    ]);
    return;
  }
  const provider = new URL(subscription.endpoint).hostname;
  // Never log the raw response: providers may echo subscription URLs or tokens.
  const detail = await response.text();
  const keyMismatch =
    detail.includes("VapidPkHashMismatch") ||
    (detail.includes("VAPID") && detail.includes("public key"));
  const hint = keyMismatch
    ? "VAPID key mismatch: sync the PWA and Worker public keys, then reload the PWA and enable notifications again"
    : response.status === 401 || response.status === 403
      ? "Check the VAPID key pair, subject, and browser subscription key"
      : "Push provider rejected the notification";
  throw new Error(
    `Push service returned ${response.status} (${provider}). ${hint}`,
  );
}

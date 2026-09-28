import { subscribeActivity } from "./activity-stream";
import type { Endpoint, EventRecord, RemoteEndpoint } from "./types";

const base = import.meta.env.VITE_API_BASE ?? "";
const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const api = {
  create(requestId: string, recoverySecret: string) {
    return request<Endpoint>("/api/endpoints", {
      method: "POST",
      headers: {
        Authorization: `Provision ${recoverySecret}`,
        "X-Creation-Request-Id": requestId,
      },
    });
  },
  get(endpoint: Endpoint) {
    return request<RemoteEndpoint>(`/api/endpoints/${endpoint.id}`, {
      headers: headers(endpoint.managementToken),
    });
  },
  patch(
    endpoint: Endpoint,
    body: { enabled?: boolean; notificationsEnabled?: boolean },
  ) {
    return request<RemoteEndpoint>(`/api/endpoints/${endpoint.id}`, {
      method: "PATCH",
      headers: headers(endpoint.managementToken),
      body: JSON.stringify(body),
    });
  },
  remove(endpoint: Endpoint) {
    return request<void>(`/api/endpoints/${endpoint.id}`, {
      method: "DELETE",
      headers: headers(endpoint.managementToken),
    });
  },
  events(endpoint: Endpoint) {
    return request<{ events: EventRecord[] }>(
      `/api/endpoints/${endpoint.id}/events`,
      { headers: headers(endpoint.managementToken) },
    );
  },
  subscribeEvents(
    endpoint: Endpoint,
    onEvents: (events: EventRecord[]) => void,
  ) {
    return subscribeActivity(
      `${base}/api/endpoints/${endpoint.id}/stream`,
      endpoint.managementToken,
      async (signal) => {
        const result = await request<{ events: EventRecord[] }>(
          `/api/endpoints/${endpoint.id}/events`,
          {
            headers: headers(endpoint.managementToken),
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          },
        );
        if (!signal.aborted) onEvents(result.events);
      },
    );
  },
  async linkDevice(endpoint: Endpoint, subscription: PushSubscription) {
    const json = subscription.toJSON();
    return request<RemoteEndpoint>(`/api/endpoints/${endpoint.id}/device`, {
      method: "PUT",
      headers: headers(endpoint.managementToken),
      body: JSON.stringify(json),
    });
  },
  testNotification(endpoint: Endpoint, text: { title: string; body: string }) {
    return request<void>(`/api/endpoints/${endpoint.id}/test-notification`, {
      method: "POST",
      headers: headers(endpoint.managementToken),
      body: JSON.stringify(text),
    });
  },
};

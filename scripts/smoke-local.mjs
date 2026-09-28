import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

const origin = process.env.SENTINEL_ORIGIN ?? "http://localhost:5173";
async function request(path, options = {}, status = 200) {
  const response = await fetch(new URL(path, origin), options);
  assert.equal(response.status, status, `${options.method ?? "GET"} ${path}`);
  if (status === 204 || status === 413) return;
  return response.json();
}
const provisionHeaders = {
  Authorization: `Provision ${randomBytes(32).toString("base64url")}`,
  "X-Creation-Request-Id": randomUUID(),
};
const endpoint = await request("/api/endpoints", {
  method: "POST",
  headers: provisionHeaders,
});
const path = `/api/endpoints/${endpoint.id}`;
const headers = {
  Authorization: `Bearer ${endpoint.managementToken}`,
  "Content-Type": "application/json",
};
try {
  assert.deepEqual(
    await request("/api/endpoints", {
      method: "POST",
      headers: provisionHeaders,
    }),
    endpoint,
    "retries must recover the same credentials",
  );
  await request(
    "/api/endpoints",
    {
      method: "POST",
      headers: {
        ...provisionHeaders,
        Authorization: `Provision ${randomBytes(32).toString("base64url")}`,
      },
    },
    404,
  );
  assert.equal(new URL(endpoint.url).origin, origin);
  const remote = await request(path, { headers });
  assert.equal(remote.enabled, true, "API must return boolean endpoint status");
  assert.equal(
    remote.notificationsEnabled,
    true,
    "API must return camelCase notification status",
  );
  const paused = await request(path, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ notificationsEnabled: false }),
  });
  assert.equal(paused.notificationsEnabled, false);
  await request(`${path}/test-notification`, { method: "POST", headers }, 409);
  await request(path, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ notificationsEnabled: true }),
  });
  await request(`${path}/test-notification`, { method: "POST", headers }, 409);
  await request(
    `/h/${endpoint.name}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.managementToken}` },
      body: "wrong token",
    },
    404,
  );
  await request(
    `/h/${endpoint.name}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.triggerToken}` },
      body: "x".repeat(65537),
    },
    413,
  );
  await request(
    `/h/${endpoint.name}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.triggerToken}` },
      body: "smoke test",
    },
    202,
  );
  const { events } = await request(`${path}/events`, { headers });
  assert.equal(events.length, 1);
  assert.equal(events[0].method, "POST");
  console.log(
    "PASS: provisioning, API contract, delivery preconditions, trigger, and event history",
  );
} finally {
  const response = await fetch(new URL(path, origin), {
    method: "DELETE",
    headers,
  });
  if (response.status !== 204)
    console.error(
      `FAIL: endpoint revocation returned ${response.status}, expected 204`,
    );
  else console.log("PASS: endpoint revocation");
  assert.equal(response.status, 204);
}

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

const origin = process.env.SENTINEL_ORIGIN ?? "http://localhost:5173";
const response = await fetch(`${origin}/api/endpoints`, {
  method: "POST",
  signal: AbortSignal.timeout(5000),
  headers: {
    Authorization: `Provision ${randomBytes(32).toString("base64url")}`,
    "X-Creation-Request-Id": randomUUID(),
  },
});
assert.equal(response.status, 200);
const endpoint = await response.json();
const path = `${origin}/api/endpoints/${endpoint.id}`;
const headers = { Authorization: `Bearer ${endpoint.managementToken}` };
const streams = [];
let deleted = false;
async function connect() {
  const response = await fetch(`${path}/stream`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  streams.push(reader);
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /event: ready/,
  );
  return reader;
}
try {
  for (const authorization of ["", `Bearer ${endpoint.triggerToken}`]) {
    const denied = await fetch(`${path}/stream`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(
      denied.status,
      404,
      "Only the management credential may subscribe",
    );
  }
  const a = await connect();
  const b = await connect();
  const pending = [a.read(), b.read()];
  const start = performance.now();
  const triggered = await fetch(endpoint.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${endpoint.triggerToken}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(triggered.status, 202);
  for (const frame of await Promise.all(pending))
    assert.match(new TextDecoder().decode(frame.value), /event: activity/);
  const elapsed = Math.round(performance.now() - start);
  assert.ok(elapsed < 2000, `SSE fan-out took ${elapsed}ms`);
  const history = await (await fetch(`${path}/events`, { headers })).json();
  assert.equal(
    history.events.length,
    1,
    "Published activity must already be persisted",
  );
  await a.cancel();
  const c = await connect();
  const ending = [b.read(), c.read()];
  const revoked = await fetch(path, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(revoked.status, 204);
  deleted = true;
  for (const frame of await Promise.all(ending))
    assert.equal(frame.done, true, "Revocation closes active streams");
  const denied = await fetch(`${path}/stream`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(denied.status, 404);
  console.log(
    `PASS: SSE authorization, fan-out (${elapsed}ms), persisted history, reconnect, and revocation`,
  );
} finally {
  await Promise.all(streams.map((reader) => reader.cancel().catch(() => {})));
  if (!deleted)
    await fetch(path, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(5000),
    });
}

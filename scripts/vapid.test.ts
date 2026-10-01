import { expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncLocalVapid } from "./vapid";

test("dev key synchronization repairs a stale PWA key without rotating Worker secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "sentinel-vapid-"));
  try {
    mkdirSync(join(root, "workers/push"), { recursive: true });
    mkdirSync(join(root, "apps/pwa"), { recursive: true });
    const pair = createECDH("prime256v1");
    pair.generateKeys();
    const publicKey = pair.getPublicKey().toString("base64url");
    const secrets = `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${pair.getPrivateKey().toString("base64url")}\nVAPID_SUBJECT=https://example.com\n`;
    const secretsPath = join(root, "workers/push/.dev.vars");
    const publicPath = join(root, "apps/pwa/.env.local");
    writeFileSync(secretsPath, secrets);
    writeFileSync(
      publicPath,
      "VITE_VAPID_PUBLIC_KEY=stale-key\nVITE_OTHER=keep\n",
    );
    syncLocalVapid(root);
    expect(readFileSync(secretsPath, "utf8")).toBe(secrets);
    expect(readFileSync(publicPath, "utf8")).toBe(
      `VITE_VAPID_PUBLIC_KEY=${publicKey}\nVITE_OTHER=keep\n`,
    );
    syncLocalVapid(root);
    expect(readFileSync(secretsPath, "utf8")).toBe(secrets);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { createECDH } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const secretsPath = resolve(root, "workers/push/.dev.vars");
const publicPath = resolve(root, "apps/pwa/.env.local");
const parse = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((line) => /^\w+=/.test(line))
      .map((line) => {
        const index = line.indexOf("=");
        return [
          line.slice(0, index),
          line
            .slice(index + 1)
            .trim()
            .replace(/^(['"])(.*)\1$/, "$2"),
        ];
      }),
  );

let secrets = existsSync(secretsPath) ? readFileSync(secretsPath, "utf8") : "";
let keys = parse(secrets);
const ecdh = createECDH("prime256v1");
if (keys.VAPID_PRIVATE_KEY || keys.VAPID_PUBLIC_KEY) {
  if (!keys.VAPID_PRIVATE_KEY || !keys.VAPID_PUBLIC_KEY)
    throw new Error(
      "Incomplete VAPID pair in workers/push/.dev.vars; restore both keys before continuing.",
    );
  ecdh.setPrivateKey(Buffer.from(keys.VAPID_PRIVATE_KEY, "base64url"));
  if (ecdh.getPublicKey().toString("base64url") !== keys.VAPID_PUBLIC_KEY)
    throw new Error("VAPID keys do not match; restore a matching pair.");
} else {
  ecdh.generateKeys();
  secrets += `\nVAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString("base64url")}\nVAPID_PRIVATE_KEY=${ecdh.getPrivateKey().toString("base64url")}\n`;
}
keys = parse(secrets);
if (!keys.VAPID_SUBJECT) secrets += "VAPID_SUBJECT=https://example.com\n";
writeFileSync(secretsPath, secrets, { mode: 0o600 });
chmodSync(secretsPath, 0o600);
const current = existsSync(publicPath) ? readFileSync(publicPath, "utf8") : "";
const publicLine = `VITE_VAPID_PUBLIC_KEY=${keys.VAPID_PUBLIC_KEY}`;
if (
  parse(current).VITE_VAPID_PUBLIC_KEY &&
  parse(current).VITE_VAPID_PUBLIC_KEY !== keys.VAPID_PUBLIC_KEY
) {
  console.log(
    "Updated the PWA public key. Previously linked browsers must click Link device again.",
  );
}
writeFileSync(
  publicPath,
  /^VITE_VAPID_PUBLIC_KEY=.*$/m.test(current)
    ? current.replace(/^VITE_VAPID_PUBLIC_KEY=.*$/m, publicLine)
    : `${current}\n${publicLine}\n`,
);
console.log(
  "Local VAPID keys ready (private key stays in ignored workers/push/.dev.vars).",
);

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

for (const migration of readdirSync(resolve(root, "migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  const result = spawnSync(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "d1",
      "execute",
      "sentinel",
      "--local",
      "--config",
      "workers/api/wrangler.toml",
      "--persist-to",
      "workers/api/.wrangler/state",
      "--file",
      `migrations/${migration}`,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

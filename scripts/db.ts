import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(
  resolve(root, "node_modules/.bin/wrangler"),
  [
    "d1",
    "migrations",
    "apply",
    "sentinel",
    "--local",
    "--config",
    "workers/api/wrangler.toml",
    "--persist-to",
    "workers/api/.wrangler/state",
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { syncLocalVapid } from "../../scripts/vapid";

export default defineConfig(({ command }) => {
  // Vite loads .env.local after evaluating this config. Reuse the Worker's
  // stable key pair before the browser gets its applicationServerKey.
  if (command === "serve") syncLocalVapid();
  return {
    plugins: [
      svelte(),
      cloudflare({
        configPath: "../../workers/api/wrangler.toml",
        auxiliaryWorkers: [{ configPath: "../../workers/push/wrangler.toml" }],
        // Keep the existing database, shared with `bun run db`.
        persistState: {
          path: fileURLToPath(
            new URL("../../workers/api/.wrangler/state", import.meta.url),
          ),
        },
        remoteBindings: false,
        ...(command === "serve"
          ? { config: { vars: { PUBLIC_ORIGIN: "http://localhost:5173" } } }
          : {}),
      }),
    ],
    build: { target: "es2022" },
    server: { port: 5173, strictPort: true },
  };
});

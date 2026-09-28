# Agent instructions

- After code changes, run `bun check`. Fix **all** diagnostics, including warnings and suggested unsafe fixes; do not stop just because the command exits successfully. Rerun until it reports no diagnostics.
- Review unsafe fixes before applying them: preserve behavior rather than blindly running `--unsafe`. If a diagnostic is a false positive or removing the flagged code would break required behavior, add a narrowly scoped, explained suppression instead.
- Svelte template bindings are not recognized by Biome's script-only unused-symbol checks; the `.svelte` override in `biome.json` disables only those two checks. Use `bun typecheck` to validate Svelte bindings.

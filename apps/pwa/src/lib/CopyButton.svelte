<script lang="ts">
import { IconCheck, IconCopy } from "@tabler/icons-svelte";
import { onDestroy } from "svelte";

export let label: string;
export let onCopy: () => Promise<boolean>;

let copied = false;
let pending = false;
let disposed = false;
let reset: ReturnType<typeof setTimeout> | undefined;

async function handleCopy() {
  if (pending) return;
  pending = true;
  try {
    const success = await onCopy();
    if (disposed || !success) return;
    copied = true;
    clearTimeout(reset);
    reset = setTimeout(() => {
      copied = false;
    }, 1500);
  } finally {
    pending = false;
  }
}

onDestroy(() => {
  disposed = true;
  clearTimeout(reset);
});
</script>

<button
  class="icon-action copy-button"
  class:copied
  aria-label={copied ? `${label}: copied` : label}
  title={copied ? "Copied!" : label}
  aria-busy={pending}
  on:click={handleCopy}
>
  <span class="copy-icon" aria-hidden="true"><IconCopy size={16}/></span>
  <span class="check-icon" aria-hidden="true"><IconCheck size={16}/></span>
</button>

<style>
.copy-button {
  position: relative;
  transition: color 160ms ease;
}
.copy-button.copied {
  color: var(--highlight);
}
.copy-icon,
.check-icon {
  position: absolute;
  display: flex;
  transition: opacity 160ms ease, transform 160ms ease;
}
.copy-icon {
  opacity: 1;
  transform: scale(1);
}
.check-icon {
  opacity: 0;
  transform: scale(0.65);
}
.copied .copy-icon {
  opacity: 0;
  transform: scale(0.65);
}
.copied .check-icon {
  opacity: 1;
  transform: scale(1);
}
@media (prefers-reduced-motion: reduce) {
  .copy-button,
  .copy-icon,
  .check-icon {
    transition: none;
  }
}
</style>

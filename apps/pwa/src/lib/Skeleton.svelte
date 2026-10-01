<script lang="ts">
export let kind: "endpoints" | "notifications" | "settings";
</script>

<div class="loading-content" role="status" aria-label={kind === "endpoints" ? "Loading endpoints" : kind === "settings" ? "Loading endpoint settings" : "Loading notifications"}>
  <div aria-hidden="true">
    {#if kind === "endpoints"}
      <div class="endpoint-list">
        {#each [0, 1, 2] as row}
          <div class="endpoint-row skeleton-row">
            <span class="skeleton endpoint-symbol"></span>
            <span class="endpoint-text"><span class="skeleton skeleton-line" style:width={row === 1 ? "42%" : "32%"}></span><span class="skeleton skeleton-line skeleton-short"></span></span>
          </div>
        {/each}
      </div>
    {:else if kind === "notifications"}
      <div class="notification-stack">
        <div class="list-caption"><span>Recent</span><span class="skeleton skeleton-line skeleton-count"></span></div>
        {#each [0, 1, 2] as row}
          <div class="notification-card notification-summary">
            <span class="skeleton notification-icon"></span>
            <span class="notification-body"><span class="skeleton skeleton-line" style:width={row === 1 ? "45%" : "34%"}></span><span class="skeleton skeleton-line skeleton-preview"></span></span>
          </div>
        {/each}
      </div>
    {:else}
      <div class="settings-content">
        <div class="settings-heading"><span class="skeleton skeleton-line skeleton-settings-title"></span><span class="skeleton skeleton-icon"></span></div>
        {#each [0, 1] as row}
          <div class="setting-row"><span class="skeleton skeleton-line" style:width={row ? "160px" : "60px"}></span><span class="skeleton skeleton-switch"></span></div>
        {/each}
        {#each [0, 1, 2] as row}
          <div class="setting-block"><span class="skeleton skeleton-line skeleton-settings-title"></span><span class="skeleton skeleton-line skeleton-value" style:width={row === 2 ? "90%" : "75%"}></span></div>
        {/each}
      </div>
    {/if}
  </div>
</div>

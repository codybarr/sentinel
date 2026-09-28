// Fetch-based SSE keeps the management credential in an Authorization header,
// never in a URL (native EventSource cannot set that header).
export function subscribeActivity(
  url: string,
  managementToken: string,
  onActivity: (signal: AbortSignal) => Promise<void>,
): () => void {
  const lifetime = new AbortController();

  void (async () => {
    let retry = 1000;
    while (!lifetime.signal.aborted) {
      const connection = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, connection.signal]);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const keepAlive = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => connection.abort(), 45_000);
      };
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        keepAlive();
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${managementToken}`,
            Accept: "text/event-stream",
          },
          cache: "no-store",
          signal,
        });
        if ([401, 403, 404].includes(response.status)) return;
        if (
          !response.ok ||
          !response.headers
            .get("content-type")
            ?.includes("text/event-stream") ||
          !response.body
        ) {
          throw new Error("Activity stream unavailable");
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          keepAlive();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 65_536)
            throw new Error("Activity frame too large");
          while (true) {
            const boundary = /\r?\n\r?\n/.exec(buffer);
            if (!boundary) break;
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            if (/^event: *(ready|activity)\r?$/m.test(frame)) {
              // The subscription exists before the first snapshot. Reading D1
              // again on invalidation/reconnect avoids gaps and duplicate rows.
              await onActivity(signal);
              retry = 1000;
            }
          }
        }
      } catch {
        /* Reconnect and resync after network/stream/snapshot failures. */
      } finally {
        clearTimeout(watchdog);
        connection.abort();
        await reader?.cancel().catch(() => {});
      }
      if (lifetime.signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          lifetime.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, retry);
        lifetime.signal.addEventListener("abort", finish, { once: true });
      });
      retry = Math.min(retry * 2, 30_000);
    }
  })();

  return () => lifetime.abort();
}

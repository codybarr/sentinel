// One object per endpoint. Only the authenticated API can reach this binding;
// there is deliberately no public Worker fetch route to publish or subscribe.
export class EventHub {
  private clients = new Set<{
    controller: ReadableStreamDefaultController<Uint8Array>;
    close: () => void;
  }>();
  private encoder = new TextEncoder();

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/publish") {
      this.broadcast("event: activity\ndata: {}\n\n");
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && path === "/revoke") {
      for (const client of this.clients) client.close();
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET" || path !== "/subscribe")
      return new Response("Not found", { status: 404 });
    if (this.clients.size >= 64)
      return new Response("Too many subscribers", { status: 429 });

    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const client = {
          controller,
          close: () => {
            cleanup();
            try {
              controller.close();
            } catch {
              /* Already cancelled. */
            }
          },
        };
        const heartbeat = setInterval(
          () => this.send(client, ": heartbeat\n\n"),
          15_000,
        );
        // Bound connection lifetime: re-authenticate and resync even if an
        // invalidation was lost during a Worker restart or publication failure.
        const expiry = setTimeout(() => client.close(), 60_000);
        cleanup = () => {
          clearInterval(heartbeat);
          clearTimeout(expiry);
          this.clients.delete(client);
        };
        this.clients.add(client);
        this.send(client, "event: ready\ndata: {}\n\n");
      },
      cancel: () => cleanup(),
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  private send(
    client: {
      controller: ReadableStreamDefaultController<Uint8Array>;
      close: () => void;
    },
    frame: string,
  ) {
    // Never accumulate an unbounded buffer for a suspended or slow browser.
    if ((client.controller.desiredSize ?? 0) <= 0) {
      client.close();
      return;
    }
    try {
      client.controller.enqueue(this.encoder.encode(frame));
    } catch {
      client.close();
    }
  }

  private broadcast(frame: string) {
    for (const client of this.clients) this.send(client, frame);
  }
}

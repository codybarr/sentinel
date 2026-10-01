export function prettyPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    // Non-JSON webhooks remain readable and copyable as their original text.
    return payload;
  }
}

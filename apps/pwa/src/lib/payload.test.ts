import { expect, test } from "bun:test";
import { prettyPayload } from "./payload";

test("formats arbitrary JSON values without dropping nested fields", () => {
  for (const value of [
    { nested: [1, null, { text: "hello" }] },
    [1, true],
    null,
    "text",
    42,
  ]) {
    expect(prettyPayload(JSON.stringify(value))).toBe(
      JSON.stringify(value, null, 2),
    );
  }
});

test("retains invalid JSON, HTML, and empty request bodies as text", () => {
  for (const value of ["not json", "<script>alert(1)</script>", ""]) {
    expect(prettyPayload(value)).toBe(value);
  }
});

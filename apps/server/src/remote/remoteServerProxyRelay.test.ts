import { describe, expect, it } from "vitest";
import { nodeHeaders } from "./remoteServerProxyRelay";

describe("headers the relay writes to a dev server", () => {
  it("sends headers named like object internals as plain headers", () => {
    const headers = nodeHeaders([
      ["constructor", "a"],
      ["tostring", "b"],
      ["__proto__", "c"],
      ["accept", "text/html"],
      ["accept", "text/plain"],
    ]);
    expect(Object.entries(headers)).toEqual([
      ["constructor", "a"],
      ["tostring", "b"],
      ["__proto__", "c"],
      ["accept", ["text/html", "text/plain"]],
    ]);
  });
});

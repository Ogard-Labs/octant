import { describe, expect, it } from "vitest";
import { MAX_PROVIDER_TOOL_RESULT_BYTES } from "@octant/contracts";
import { boundedToolResultJson } from "./toolResultJson";

describe("bounded tool results", () => {
  it("passes a result that fits through unchanged and previews one that does not", () => {
    expect(boundedToolResultJson({ ok: true })).toBe('{"ok":true}');
    const huge = boundedToolResultJson({ text: "x".repeat(MAX_PROVIDER_TOOL_RESULT_BYTES) });
    expect(huge.length).toBeLessThanOrEqual(MAX_PROVIDER_TOOL_RESULT_BYTES);
    expect(JSON.parse(huge)).toMatchObject({ error: "tool-result-too-large", truncated: true });
  });

  it("names an unserializable result instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(JSON.parse(boundedToolResultJson(cyclic))).toEqual({
      error: "tool-result-unserializable",
    });
  });
});

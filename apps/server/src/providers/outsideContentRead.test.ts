import {
  CorrelationId,
  UtcTimestamp,
  decodeProviderInstanceId,
  decodeProviderRuntimeEvent,
  decodeProviderSessionId,
} from "@octant/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { outsideContentTarget, outsideContentToolName } from "./outsideContentRead";

describe("outside-content read fields", () => {
  it("bounds a query of wide characters to the length the contract counts", () => {
    const target = outsideContentTarget("🙂".repeat(1_024));
    const toolName = outsideContentToolName(`Fetch ${"🙂".repeat(300)}`);
    expect(target?.length).toBeLessThanOrEqual(1_024);
    expect(toolName.length).toBeLessThanOrEqual(256);
    expect(() =>
      decodeProviderRuntimeEvent({
        kind: "outside-content-read",
        instanceId: decodeProviderInstanceId("80000000-0000-4000-8000-000000000401"),
        sessionId: decodeProviderSessionId("80000000-0000-4000-8000-000000000402"),
        sequence: 1,
        correlationId: Schema.decodeUnknownSync(CorrelationId)(
          "80000000-0000-4000-8000-000000000403",
        ),
        occurredAt: Schema.decodeUnknownSync(UtcTimestamp)("2026-10-14T10:00:00.000Z"),
        toolCallId: "tool-1",
        toolName,
        source: "web-search",
        ...(target === undefined ? {} : { target }),
      }),
    ).not.toThrow();
  });

  it("redacts a credential an address carries, and names an unnamed tool plainly", () => {
    expect(outsideContentTarget("https://user:hunter2@example.invalid/a?token=abc")).not.toContain(
      "hunter2",
    );
    expect(outsideContentTarget(undefined)).toBeUndefined();
    expect(outsideContentToolName("   ")).toBe("Tool");
  });
});

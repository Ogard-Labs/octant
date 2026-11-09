import { describe, expect, it } from "vitest";
import { decodeBrowserActionKind } from "./browserAutomation";
import {
  decodeBrowserPageScriptNativeCommand,
  decodeBrowserPageScriptReceipt,
} from "./browserPageScript";

const id = "10000000-0000-4000-8000-000000000001";
const scoped = { contextId: id, owner: { windowId: id, threadId: id } };

describe("private bounded script messages", () => {
  it("accepts source only in scoped preparation and never in a public renderer action", () => {
    expect(
      decodeBrowserPageScriptNativeCommand({
        ...scoped,
        operation: "prepare",
        source: "42",
        expectedUrl: "https://example.com/",
        requiresClearPage: true,
      }).operation,
    ).toBe("prepare");
    expect(() => decodeBrowserActionKind("run-script")).toThrow();
    expect(() =>
      decodeBrowserPageScriptNativeCommand({
        ...scoped,
        operation: "execute",
        planId: id,
        source: "changed source",
      }),
    ).toThrow();
    expect(() =>
      decodeBrowserPageScriptNativeCommand({
        ...scoped,
        operation: "prepare",
        source: "42",
        expectedUrl: "https://example.com/",
        owner: { windowId: "foreign-window", threadId: id },
      }),
    ).toThrow();
  });

  it("does not permit page data in refused, cancelled or uncertain receipts or claim completed effects", () => {
    for (const status of [
      "refused",
      "cancelled",
      "execution-uncertain",
      "script-failed",
      "timed-out",
    ]) {
      expect(decodeBrowserPageScriptReceipt({ status, effect: "possible" }).effect).toBe(
        "possible",
      );
      expect(() =>
        decodeBrowserPageScriptReceipt({ status, effect: "possible", valueJson: '"page data"' }),
      ).toThrow();
    }
    expect(() =>
      decodeBrowserPageScriptReceipt({ status: "completed", effect: "completed", valueJson: "42" }),
    ).toThrow();
  });
});

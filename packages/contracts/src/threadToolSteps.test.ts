import { describe, expect, it } from "vitest";
import { decodeThreadToolStep, decodeThreadToolStepList } from "./threadToolSteps";
import { MAX_THREAD_TOOL_STEPS_PER_TURN } from "./threadToolSteps";

const step = { toolCallId: "call-1", toolName: "Read", state: "completed" } as const;

describe("the thread tool step contract", () => {
  it("accepts a tool call with only its id, name, and state", () => {
    expect(decodeThreadToolStep(step)).toEqual(step);
  });

  it("refuses a field that would carry the tool's input or output", () => {
    expect(() => decodeThreadToolStep({ ...step, input: "cat ~/.ssh/id_rsa" })).toThrow();
  });

  it("refuses a summary longer than a Code turn's tool step holds", () => {
    expect(() => decodeThreadToolStep({ ...step, summary: "x".repeat(2_049) })).toThrow();
  });

  it("carries the page a call published only as a plain https address with an optional title", () => {
    const page = { url: "https://claude.ai/artifact/abc-123", title: "Quarterly report" };
    expect(decodeThreadToolStep({ ...step, publishedPage: page })).toEqual({
      ...step,
      publishedPage: page,
    });
    expect(decodeThreadToolStep({ ...step, publishedPage: { url: page.url } })).toEqual({
      ...step,
      publishedPage: { url: page.url },
    });
    for (const url of [
      "http://claude.ai/artifact/abc-123",
      "https://user:token@claude.ai/artifact/abc-123",
      "javascript:alert(1)",
      "claude.ai/artifact/abc-123",
    ]) {
      expect(() => decodeThreadToolStep({ ...step, publishedPage: { url } })).toThrow();
    }
    expect(() =>
      decodeThreadToolStep({ ...step, publishedPage: { url: page.url, title: "t".repeat(257) } }),
    ).toThrow();
    expect(() =>
      decodeThreadToolStep({ ...step, publishedPage: { url: page.url, html: "<p>page</p>" } }),
    ).toThrow();
  });

  it("refuses more tool calls than one turn may keep", () => {
    expect(() =>
      decodeThreadToolStepList(
        Array.from({ length: MAX_THREAD_TOOL_STEPS_PER_TURN + 1 }, (_unused, index) => ({
          ...step,
          toolCallId: `call-${String(index)}`,
        })),
      ),
    ).toThrow();
  });
});

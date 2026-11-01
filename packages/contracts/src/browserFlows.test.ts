import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  BrowserFlow,
  BrowserFlowsCommand,
  MAX_BROWSER_FLOW_STEPS,
  decodeBrowserFlowsCommand,
} from "./browserFlows";

const step = { operation: "scroll", input: { operation: "scroll" }, expect: { path: "/" } };
const flow = (overrides: object) =>
  ({ name: "Check", steps: [step], savedAt: "2026-11-01T09:00:00.000Z", ...overrides }) as unknown;

describe("a saved Browser flow", () => {
  const decode = Schema.decodeUnknownSync(BrowserFlow);

  it("holds 1 to 50 steps and a name of 1 to 80 characters", () => {
    expect(decode(flow({}))).toMatchObject({ name: "Check" });
    expect(() => decode(flow({ steps: [] }))).toThrow();
    expect(() =>
      decode(flow({ steps: Array.from({ length: MAX_BROWSER_FLOW_STEPS + 1 }, () => step) })),
    ).toThrow();
    expect(() => decode(flow({ name: "" }))).toThrow();
    expect(() => decode(flow({ name: "x".repeat(81) }))).toThrow();
  });

  it("refuses a field the record does not define, such as page text or a ref id", () => {
    expect(() =>
      decode(flow({ steps: [{ ...step, expect: { path: "/", text: "Hello" } }] })),
    ).toThrow();
    expect(() => decode(flow({ steps: [{ ...step, ref: "e4" }] }))).toThrow();
  });

  it("lets the person list and delete and nothing else", () => {
    expect(decodeBrowserFlowsCommand({ kind: "list" })).toEqual({ kind: "list" });
    expect(() =>
      Schema.decodeUnknownSync(BrowserFlowsCommand)({ kind: "run", name: "x" }),
    ).toThrow();
  });
});

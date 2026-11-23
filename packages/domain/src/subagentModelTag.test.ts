import { describe, expect, it } from "vitest";
import {
  findSubagentModelTags,
  formatSubagentModelTag,
  subagentReasoningValues,
} from "./subagentModelTag";

const instance = "6f1e0c52-2b7d-4c1a-9f3e-0a1b2c3d4e5f";

describe("subagent model tags", () => {
  it("reads back the tag it writes, with and without reasoning", () => {
    for (const tag of [
      { providerInstanceId: instance, modelId: "gpt-5" },
      { providerInstanceId: instance, modelId: "gpt-5", reasoning: "high" },
    ]) {
      const text = `Review this ${formatSubagentModelTag(tag)} please`;
      const [match] = findSubagentModelTags(text);
      expect(match?.tag).toEqual(tag);
      expect(text.slice(match?.start, match?.end)).toBe(formatSubagentModelTag(tag));
    }
  });

  it("keeps a router's vendor-qualified model id whole", () => {
    const [match] = findSubagentModelTags(`@model(${instance}/anthropic/claude-x:beta)`);
    expect(match?.tag).toEqual({ providerInstanceId: instance, modelId: "anthropic/claude-x:beta" });
  });

  it("finds several tags and ignores malformed ones", () => {
    const text = [
      `@model(${instance}/a)`,
      "@model(no-slash)",
      `@model(${instance}/b, reasoning=)`,
      `email@model(${instance}/c)`,
      `@model(${instance}/d,reasoning=low)`,
    ].join(" ");
    expect(findSubagentModelTags(text).map((match) => match.tag.modelId)).toEqual(["a", "d"]);
  });

  it("offers only the reasoning values a model advertises", () => {
    expect(
      subagentReasoningValues({
        options: [
          { id: "effort", displayName: "Effort", kind: "selection", values: ["low", "high"] },
          { id: "service-tier", displayName: "Tier", kind: "selection", values: ["flex"] },
          { id: "fast", displayName: "Fast", kind: "boolean" },
        ],
      }),
    ).toEqual(["low", "high"]);
  });
});

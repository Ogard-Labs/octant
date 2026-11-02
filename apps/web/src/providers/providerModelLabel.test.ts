import { describe, expect, it } from "vitest";
import { readableModelId } from "./providerModelLabel";

describe("naming a model no catalogue has described", () => {
  it("reads a raw id as words and a version", () => {
    expect(readableModelId("zai-glm-5-2")).toBe("Zai GLM 5.2");
    expect(readableModelId("gpt-5.6-luna")).toBe("GPT 5.6 Luna");
    expect(readableModelId("anthropic/claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
  });

  it("leaves a name somebody already chose alone", () => {
    expect(readableModelId("GPT-5.6-Sol")).toBe("GPT-5.6-Sol");
    expect(readableModelId("My local model")).toBe("My local model");
  });
});

import { describe, expect, it } from "vitest";
import { nativeHarnessInstructions, nativeHarnessToolGuide } from "./nativeHarnessInstructions";

const chatText = () =>
  nativeHarnessInstructions("chat")
    .map((block) => block.text)
    .join("\n");

describe("native harness instructions", () => {
  it("tells a Chat lead what the thread lacks and sends it to the tool list for what it has", () => {
    const text = chatText();
    expect(text).toContain("no filesystem and no shell");
    expect(text).toContain("exactly what you can call");
  });

  it("does not promise helper agents in a Chat thread that was not offered the tool", () => {
    expect(nativeHarnessInstructions("chat")[1]?.text).not.toMatch(/child|helper agent/i);
    expect(nativeHarnessToolGuide(["octant_canvas"])).not.toContain("octant_agents");
    expect(nativeHarnessToolGuide([])).toBeUndefined();
  });

  it("names the helper-agent tool when the thread is offered it", () => {
    expect(nativeHarnessToolGuide(["octant_agents", "octant_canvas"])).toContain(
      "octant_agents: start, watch, and stop helper agents",
    );
  });
});

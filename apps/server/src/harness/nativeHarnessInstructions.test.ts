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

  it("tells a lead to run helpers with the octant_agents operations, not a tool it is never offered", () => {
    const text = chatText();
    expect(text).toContain("octant_agents");
    for (const operation of ["delegate", "wait"]) expect(text).toContain(`operation ${operation}`);
    // `start` and `collect` were the retired harness tool's words for these.
    expect(text).not.toMatch(/\bcollect\b|\bstart a child\b/);
  });

  it("names the helper-agent tool when the thread is offered it", () => {
    expect(nativeHarnessToolGuide(["octant_agents", "octant_canvas"])).toContain(
      "octant_agents: start, watch, and stop helper agents",
    );
  });

  it.each([
    "octant_past_threads",
    "octant_side_chat_list_files",
    "octant_side_chat_read_file",
    "octant_side_chat_search_files",
    "octant_zen",
    "skill",
  ])("says what %s is for only in a turn that offers it", (name) => {
    expect(nativeHarnessToolGuide([name])).toMatch(new RegExp(`^- ${name}: \\S`, "m"));
    expect(nativeHarnessToolGuide(["octant_canvas"])).not.toContain(name);
  });

  it("has no line for a tool name that is no longer offered", () => {
    expect(
      nativeHarnessToolGuide([
        "octant_web_research",
        "octant_zen_search_threads",
        "octant_zen_list_widgets",
        "octant_zen_create_widget",
      ]),
    ).toBeUndefined();
  });
});

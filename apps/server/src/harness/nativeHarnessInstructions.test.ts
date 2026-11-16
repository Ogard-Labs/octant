import { describe, expect, it } from "vitest";
import {
  nativeHarnessInstructions,
  nativeHarnessToolGuide,
  windowsShellInstruction,
} from "./nativeHarnessInstructions";

const chatText = () =>
  nativeHarnessInstructions("chat")
    .map((block) => block.text)
    .join("\n");

describe("native harness instructions", () => {
  it.each([
    [undefined, /Windows PowerShell 5\.1/],
    ["powershell", /Windows PowerShell 5\.1/],
    ["pwsh", /PowerShell 7/],
    ["cmd", /Command Prompt batch script under cmd\.exe/],
  ] as const)(
    "tells a Work or Code lead on a Windows host which shell runs its commands (%s)",
    (windowsShell, named) => {
      for (const mode of ["work", "code"] as const) {
        const texts = nativeHarnessInstructions(mode, { platform: "win32", windowsShell }).map(
          (block) => block.text,
        );
        expect(texts).toContain(windowsShellInstruction(windowsShell));
        expect(texts.at(-1)).toMatch(named);
      }
    },
  );

  it("says nothing of a Windows shell to a Chat lead or on another host", () => {
    const shellTexts = (["powershell", "pwsh", "cmd"] as const).map((shell) =>
      windowsShellInstruction(shell),
    );
    for (const blocks of [
      nativeHarnessInstructions("chat", { platform: "win32", windowsShell: "cmd" }),
      nativeHarnessInstructions("code", { platform: "darwin", windowsShell: "cmd" }),
    ])
      for (const block of blocks) expect(shellTexts).not.toContain(block.text);
  });

  it("tells a Chat lead what the thread lacks and sends it to the tool list for what it has", () => {
    const text = chatText();
    expect(text).toContain("no filesystem and no shell");
    expect(text).toContain("exactly what you can call");
  });

  it("does not promise helper agents in a Chat thread that was not offered the tool", () => {
    expect(nativeHarnessInstructions("chat").at(-1)?.text).not.toMatch(/child|helper agent/i);
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

  it("tells every lead what Octant is in the same words in every mode, ahead of the mode's rules", () => {
    const about = (mode: "chat" | "work" | "code") =>
      nativeHarnessInstructions(mode).find((block) => block.text.startsWith("About Octant:"));
    const text = about("chat")?.text ?? "";
    expect(about("work")).toEqual(about("chat"));
    expect(about("code")).toEqual(about("chat"));
    expect(nativeHarnessInstructions("code").at(-1)?.text).toContain("This is a Code thread");
    expect(text).toContain("You can never mark a thread Done");
    expect(text).toContain("Plan mode is read-only");
    // Nothing that changes between turns, or the provider's cached prefix breaks.
    expect(text).not.toMatch(/\d/);
  });

  it("points to memory and skill tools only as offered, so the text holds without them", () => {
    const text = chatText();
    expect(text).toContain("When a memory tool is offered");
    expect(text).toContain("When a skill tool is offered");
    expect(text).toContain("below Full access the person approves each change");
  });

  it("names the helper-agent tool when the thread is offered it", () => {
    expect(nativeHarnessToolGuide(["octant_agents", "octant_canvas"])).toContain(
      "octant_agents: start, watch, and stop helper agents",
    );
  });

  it.each([
    "diagnostics",
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

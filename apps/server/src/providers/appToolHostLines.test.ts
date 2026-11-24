import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACP_CLIENT_TOOL_NAMES } from "@octant/provider-sdk";
import { BROWSER_TOOL_HOST_LINE } from "@octant/plugin-host/browser-use";
import { describe, expect, it } from "vitest";
import { CANVAS_DELIVERY_INSTRUCTIONS } from "../canvas/canvasDeliveryInstructions";
import { appToolHostLines } from "./appToolHostLines";

const offered = (...names: ReadonlyArray<string>) => names.map((name) => ({ name }));

const threadsTool = (operations: ReadonlyArray<string>) => ({
  name: "octant_threads",
  inputSchema: {
    type: "object",
    properties: { operation: { type: "string", enum: [...operations] } },
  },
});

/** Every first-party tool a turn can be offered, the widest guide a model can meet. */
const BROADEST = [
  "octant_agents",
  "octant_android",
  "octant_apple",
  "octant_ask_thread",
  "octant_browser",
  "octant_canvas",
  "octant_code",
  "octant_computer",
  "octant_create_image",
  "octant_credential",
  "octant_debug",
  "octant_github",
  "octant_linear",
  "octant_look",
  "octant_memory",
  "octant_narrate",
  "octant_offer_side_task",
  "octant_past_threads",
  "octant_propose_routine",
  "octant_pull_request",
  "octant_report_finished",
  "octant_routines",
  "octant_side_chat_list_files",
  "octant_side_chat_read_file",
  "octant_side_chat_search_files",
  "octant_terminal",
  "octant_threads",
  "octant_transcribe",
  "octant_zen",
];

/**
 * First-party `octant_*` names that no model is told about, each with why. A
 * name found in the source that is neither guided nor listed here fails the
 * coverage test, so a new tool cannot ship without its line.
 */
const NOT_GUIDED: Readonly<Record<string, string>> = {
  octant_capability_echo: "the probe tool a capability check offers, never a turn",
  octant_probe_tool: "the probe tool Pi's capability check offers, never a turn",
  octant_instructions: "a Codex context key, not a tool",
  octant_context: "a Codex context key, not a tool",
  ...Object.fromEntries(
    Object.values(ACP_CLIENT_TOOL_NAMES).map((name) => [
      name,
      "an ACP client service the bridge filters out, never model-visible",
    ]),
  ),
};

const REPOSITORY = join(import.meta.dirname, "../../../..");
const SOURCE_ROOTS = [
  "apps/server/src",
  "packages/contracts/src",
  "packages/plugin-host/src",
  "packages/provider-sdk/src",
];

function sourceFiles(directory: string): ReadonlyArray<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every complete `octant_*` string literal in shipped first-party source. */
function firstPartyToolNames(): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const root of SOURCE_ROOTS)
    for (const file of sourceFiles(join(REPOSITORY, root)))
      for (const match of readFileSync(file, "utf8").matchAll(
        /["'`](octant_[a-z]+(?:_[a-z]+)*)["'`]/g,
      ))
        if (match[1] !== undefined) names.add(match[1]);
  return [...names].sort();
}

const unguided = (names: ReadonlyArray<string>) =>
  names.filter((name) => appToolHostLines(offered(name)).length === 0 && !(name in NOT_GUIDED));

describe("appToolHostLines", () => {
  it("gives every offered first-party tool exactly one line, a tool it lacks none, and no tools no guide", () => {
    const lines = appToolHostLines(offered(...BROADEST));
    expect(lines.map((line) => line.tool)).toEqual(BROADEST);
    for (const line of lines) expect(line.text).toContain(line.tool);
    expect(appToolHostLines(offered("octant_browser"))).toEqual([
      { tool: "octant_browser", text: BROWSER_TOOL_HOST_LINE },
    ]);
    expect(appToolHostLines(offered("someone_elses_tool"))).toEqual([]);
    expect(appToolHostLines([])).toEqual([]);
    expect(appToolHostLines(undefined)).toEqual([]);
  });

  it("writes the same bytes for the same tools in any order", () => {
    const forward = appToolHostLines(offered(...BROADEST));
    const backward = appToolHostLines(offered(...[...BROADEST].reverse(), "octant_canvas"));
    expect(backward).toEqual(forward);
  });

  it("keeps a tool's line when its operations change, except the coordinator's octant_threads", () => {
    const line = (operations: ReadonlyArray<string>) =>
      appToolHostLines([threadsTool(operations)])[0]?.text;
    const reading = line(["list", "read", "wait", "help"]);
    expect(line(["list", "read", "wait", "send", "acknowledge", "receipts", "help"])).toBe(reading);
    expect(line(["list", "read", "wait", "board", "help"])).toBe(reading);
    const coordinating = line(["list", "read", "wait", "send", "start", "help"]);
    expect(coordinating).not.toBe(reading);
    expect(coordinating).toMatch(/start worker threads/);
    expect(reading).not.toMatch(/start/);
    expect(appToolHostLines(offered("octant_threads"))[0]?.text).toBe(reading);
  });

  it("offers inline visuals on the Canvas line and leaves document delivery to its own rule", () => {
    const [canvas] = appToolHostLines(offered("octant_canvas"));
    expect(canvas?.text).toMatch(/inline/);
    expect(canvas?.text).toMatch(/chart/);
    expect(canvas?.text).not.toContain(CANVAS_DELIVERY_INSTRUCTIONS);
    expect(canvas?.text).not.toMatch(/report|deck|document/i);
  });

  it("tells every runtime that findings with numbers become an inline Canvas above the reply", () => {
    const [canvas] = appToolHostLines(offered("octant_canvas"));
    expect(canvas?.text).toContain("findings carry numbers, a trend, or a comparison");
    expect(canvas?.text).toContain("above your reply");
    expect(canvas?.text).not.toMatch(/below/);
    expect(CANVAS_DELIVERY_INSTRUCTIONS).toContain("inline Canvas summary drawn above your reply");
    expect(CANVAS_DELIVERY_INSTRUCTIONS).toContain("reply with only what it does not already say");
  });

  it("keeps Project memory to this Project's facts and says nothing of the person's preferences", () => {
    const [memory] = appToolHostLines(offered("octant_memory"));
    expect(memory?.text).toContain("this Project");
    expect(memory?.text).toContain("transient task details");
    expect(memory?.text).not.toMatch(/prefer|personal|about the person|the person likes/i);
  });

  it("promises no approval that does not happen at every access level", () => {
    const text = appToolHostLines(offered(...BROADEST))
      .map((line) => line.text)
      .join("\n");
    // Below Full access the browser asks per site; a Private page never does.
    expect(text).not.toMatch(/each new site asks/);
    // Outside Strict at Full access, or under a remembered Project grant, Computer use does not ask.
    expect(text).not.toMatch(/first action on each app asks/);
    // A Project's "Don't ask again" choice skips the image tool's question.
    expect(text).not.toMatch(/confirm first|confirms first/);
    const [image] = appToolHostLines(offered("octant_create_image"));
    expect(image?.text).toMatch(/instead of drawing it as SVG/);
    expect(image?.text).toMatch(/restyle photos or screenshots, use references/);
    expect(image?.text).toMatch(/logos, icons, and diagrams/);
  });

  it("names the right tool for a model that cannot read images, for desktops beyond macOS, and for earlier work", () => {
    expect(appToolHostLines(offered("octant_look"))[0]?.text).toMatch(/cannot read .*image/);
    expect(appToolHostLines(offered("octant_computer"))[0]?.text).not.toMatch(/macOS/);
    expect(appToolHostLines(offered("octant_past_threads"))[0]?.text).toMatch(/earlier/);
    expect(appToolHostLines(offered("octant_agents"))[0]?.text).toMatch(
      /another provider or model/,
    );
  });

  it("keeps every line short and the widest guide near a thousand tokens", () => {
    const lines = appToolHostLines([
      ...offered(...BROADEST.filter((name) => name !== "octant_threads")),
      threadsTool(["list", "read", "wait", "send", "start", "help"]),
    ]);
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(240);
    const characters = lines.reduce((total, line) => total + line.text.length + 1, 0);
    expect(Math.ceil(characters / 4)).toBeLessThanOrEqual(1_050);
  });

  it("fails for a first-party tool name with no line and passes for the names deliberately left out", () => {
    expect(unguided(["octant_new_tool"])).toEqual(["octant_new_tool"]);
    expect(unguided(Object.keys(NOT_GUIDED))).toEqual([]);
    const found = firstPartyToolNames();
    expect(found).toEqual(expect.arrayContaining(BROADEST));
    expect(unguided(found)).toEqual([]);
  });

  it("lists every guided tool in the agent tools specification", () => {
    const specification = readFileSync(join(REPOSITORY, "docs/design/agent-tools.md"), "utf8");
    for (const name of BROADEST) expect(specification).toContain(`\`${name}\``);
  });
});

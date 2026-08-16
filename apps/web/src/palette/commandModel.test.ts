import { describe, expect, it, vi } from "vitest";
import {
  applySlashCommandToken,
  filterOctantCommands,
  groupOctantCommands,
  parseSlashCommandToken,
  type OctantCommand,
} from "./commandModel";

function command(overrides: Partial<OctantCommand> & Pick<OctantCommand, "id">): OctantCommand {
  return {
    title: overrides.id,
    group: "Threads",
    action: { kind: "run", run: vi.fn() },
    ...overrides,
  };
}

describe("parseSlashCommandToken", () => {
  it("opens on a bare slash at the start of the draft", () => {
    expect(parseSlashCommandToken("/", 1)).toEqual({ query: "", start: 0, end: 1 });
  });

  it("reads the query the caret is inside", () => {
    expect(parseSlashCommandToken("/chat", 5)).toEqual({ query: "chat", start: 0, end: 5 });
  });

  it("stays closed for a slash that is not at the start of the draft", () => {
    expect(parseSlashCommandToken("read /chat", 10)).toBeUndefined();
    expect(parseSlashCommandToken("and/or", 6)).toBeUndefined();
  });

  it("closes once whitespace separates the caret from the slash", () => {
    expect(parseSlashCommandToken("/new chat", 9)).toBeUndefined();
  });

  it("stays closed while the caret sits before the slash", () => {
    expect(parseSlashCommandToken("/chat", 0)).toBeUndefined();
    expect(parseSlashCommandToken("/chat", null)).toBeUndefined();
  });
});

describe("applySlashCommandToken", () => {
  it("removes the token and keeps the prose that followed it", () => {
    const draft = "/cha rest of the message";
    // The caret sits at the end of the token, which is where the affordance is
    // still open; everything the user already typed after it survives.
    const token = parseSlashCommandToken(draft, 4)!;
    expect(applySlashCommandToken(draft, token)).toEqual({
      draft: " rest of the message",
      caretIndex: 0,
    });
  });
});

describe("filterOctantCommands", () => {
  it("ranks a title prefix above a word start above a keyword-only match", () => {
    const results = filterOctantCommands(
      [
        command({ id: "keyword", title: "Open Settings", keywords: ["chat"] }),
        command({ id: "word-start", title: "New chat" }),
        command({ id: "prefix", title: "Chat threads" }),
      ],
      "chat",
    );

    expect(results.map((entry) => entry.id)).toEqual(["prefix", "word-start", "keyword"]);
  });

  it("drops commands that match nothing and keeps caller order for an empty query", () => {
    const commands = [command({ id: "a" }), command({ id: "b" })];
    expect(filterOctantCommands(commands, "zzz")).toEqual([]);
    expect(filterOctantCommands(commands, "  ")).toEqual(commands);
  });
});

describe("groupOctantCommands", () => {
  it("keeps the ranked order both between and inside groups", () => {
    const grouped = groupOctantCommands([
      command({ id: "m1", group: "Modes" }),
      command({ id: "t1", group: "Threads" }),
      command({ id: "m2", group: "Modes" }),
    ]);

    expect(grouped.map((group) => group.group)).toEqual(["Modes", "Threads"]);
    expect(grouped[0]!.commands.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });
});

import { describe, expect, it } from "vitest";
import { matchingSlashCommands, slashCommandQuery } from "./slashCommands";

const command = (name: string) => ({ name });

describe("slash command suggestions", () => {
  it("asks for commands only while the whole message is a slash and a name being typed", () => {
    expect(slashCommandQuery("/")).toBe("");
    expect(slashCommandQuery("/rev")).toBe("rev");
    expect(slashCommandQuery("/review ")).toBeUndefined();
    expect(slashCommandQuery("/review the change")).toBeUndefined();
    expect(slashCommandQuery("run /review")).toBeUndefined();
    expect(slashCommandQuery(" /review")).toBeUndefined();
    expect(slashCommandQuery("")).toBeUndefined();
  });

  it("lists names that start with what was typed before names that only contain it", () => {
    const commands = ["compact", "init", "review", "pr-review"].map(command);
    expect(matchingSlashCommands(commands, "REV").map((entry) => entry.name)).toEqual([
      "review",
      "pr-review",
    ]);
    expect(matchingSlashCommands(commands, "").map((entry) => entry.name)).toEqual([
      "compact",
      "init",
      "review",
      "pr-review",
    ]);
    expect(matchingSlashCommands(commands, "zzz")).toEqual([]);
  });

  it("shows at most eight commands", () => {
    const commands = Array.from({ length: 20 }, (_, index) => command(`c${index}`));
    expect(matchingSlashCommands(commands, "c")).toHaveLength(8);
  });
});

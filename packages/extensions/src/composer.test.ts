import { describe, expect, it } from "vitest";
import { parseComposerReference } from "./composer";

describe("structured extension composer syntax", () => {
  it.each([
    ["@build-tools", { kind: "plugin", pluginSlug: "build-tools" }],
    ["@build-tools/server", { kind: "plugin", pluginSlug: "build-tools", componentId: "server" }],
    ["$review", { kind: "skill", skillName: "review" }],
    [
      "$agents-skills-directory:project:review",
      { kind: "skill", skillName: "agents-skills-directory:project:review" },
    ],
  ])("parses %s as data only", (input, expected) => {
    expect(parseComposerReference(input)).toEqual(expected);
  });

  it.each([
    "person@example.com",
    "hello @build-tools",
    "\\@build-tools",
    "@unknown component",
    "@build-tools/../../escape",
    "@",
    "$",
  ])("leaves non-exact or unsafe input as ordinary text: %s", (input) => {
    expect(parseComposerReference(input)).toEqual({ kind: "plain-text", text: input });
  });
});

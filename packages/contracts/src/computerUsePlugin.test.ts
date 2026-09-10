import { describe, expect, it } from "vitest";
import { decodeComputerControlCommand, decodeComputerUseSettings } from "./computerUsePlugin";

describe("Computer use plugin commands", () => {
  it("requires an observed element for control and refuses arbitrary driver commands", () => {
    expect(decodeComputerControlCommand({ operation: "apps" })).toEqual({ operation: "apps" });
    expect(() => decodeComputerControlCommand({ operation: "click", elementIndex: 2 })).toThrow();
    expect(() =>
      decodeComputerControlCommand({ operation: "execute_command", command: "pwd" }),
    ).toThrow();
    expect(() =>
      decodeComputerControlCommand({ operation: "apps", socket: "/tmp/other" }),
    ).toThrow();
  });

  it("enables automatic driver updates without granting application control", () => {
    expect(decodeComputerUseSettings({})).toEqual({ enabled: true, automaticUpdates: true });
    expect(() => decodeComputerUseSettings({ approvedApps: ["*"] })).toThrow();
  });

  it("preserves whitespace when typing or clearing an observed field", () => {
    const base = {
      operation: "type",
      observationId: "11111111-1111-4111-8111-111111111111",
      elementIndex: 2,
    };
    expect(decodeComputerControlCommand({ ...base, text: "  indented\n" })).toMatchObject({
      text: "  indented\n",
    });
    expect(decodeComputerControlCommand({ ...base, text: "" })).toMatchObject({ text: "" });
  });
});

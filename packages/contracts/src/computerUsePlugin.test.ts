import { describe, expect, it } from "vitest";
import {
  decodeComputerControlCommand,
  decodeComputerUseSettings,
  decodeSimulatorInputCommand,
} from "./computerUsePlugin";

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

describe("Simulator input through the desktop broker", () => {
  it("names the device window and refuses a coordinate tap without its frame", () => {
    const destination = { udid: "348B3796-90BE-4B03-ADC1-46D7468C9D43", name: "iPhone 17 Pro" };
    expect(
      decodeSimulatorInputCommand({
        kind: "type-text",
        ...destination,
        text: " spaced ",
        budgetMs: 30_000,
      }),
    ).toMatchObject({ text: " spaced " });
    expect(() =>
      decodeSimulatorInputCommand({ kind: "type-text", ...destination, text: "x" }),
    ).toThrow();
    expect(
      decodeSimulatorInputCommand({
        kind: "tap",
        ...destination,
        point: { x: 562, y: 1221 },
        frame: { width: 1206, height: 2622 },
      }),
    ).toMatchObject({ point: { x: 562, y: 1221 } });
    expect(() =>
      decodeSimulatorInputCommand({ kind: "tap", ...destination, point: { x: 1, y: 1 } }),
    ).toThrow();
    expect(() =>
      decodeSimulatorInputCommand({
        kind: "key-press",
        udid: "../x",
        name: "iPhone",
        key: "return",
      }),
    ).toThrow();
    expect(() =>
      decodeSimulatorInputCommand({
        kind: "type-text",
        ...destination,
        text: "x",
        budgetMs: 30_000,
        appId: "*",
      }),
    ).toThrow();
  });
});

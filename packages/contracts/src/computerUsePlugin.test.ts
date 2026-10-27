import { describe, expect, it } from "vitest";
import {
  decodeComputerControlCommand,
  decodeComputerSendFileCommand,
  decodeComputerUseOwner,
  decodeComputerUseSettings,
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

  it("leaves automatic driver updates off without granting application control", () => {
    expect(decodeComputerUseSettings({})).toEqual({ enabled: true, automaticUpdates: false });
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

  it("types into keyboard focus only from an observation, with nothing but text or one known key", () => {
    const observationId = "11111111-1111-4111-8111-111111111111";
    expect(decodeComputerControlCommand({ operation: "type", observationId, text: "hi" })).toEqual({
      operation: "type",
      observationId,
      text: "hi",
    });
    expect(
      "elementIndex" in
        decodeComputerControlCommand({ operation: "press", observationId, key: "Tab" }),
    ).toBe(false);
    expect(() => decodeComputerControlCommand({ operation: "type", text: "hi" })).toThrow();
    expect(() =>
      decodeComputerControlCommand({ operation: "press", observationId, key: "F13" }),
    ).toThrow();
    expect(() =>
      decodeComputerControlCommand({ operation: "type", observationId, text: "hi", x: 1, y: 1 }),
    ).toThrow();
  });

  it("names a desktop destination only as a lease id, and a file to send only as a path", () => {
    const owner = {
      windowId: "11111111-1111-4111-8111-111111111111",
      threadId: "22222222-2222-4222-8222-222222222222",
      mode: "code",
      providerInstanceId: "33333333-3333-4333-8333-333333333333",
      modelId: "fixture",
      executionPolicy: "approval-gated",
    };
    expect(decodeComputerUseOwner(owner)).not.toHaveProperty("leaseId");
    expect(
      decodeComputerUseOwner({ ...owner, leaseId: "44444444-4444-4444-8444-444444444444" }),
    ).toMatchObject({ leaseId: "44444444-4444-4444-8444-444444444444" });
    expect(() => decodeComputerUseOwner({ ...owner, leaseId: "this-mac" })).toThrow();
    expect(decodeComputerSendFileCommand({ operation: "send-file", path: "dist/app" })).toEqual({
      operation: "send-file",
      path: "dist/app",
    });
    expect(() =>
      decodeComputerSendFileCommand({ operation: "send-file", path: "dist/app", leaseId: "x" }),
    ).toThrow();
    expect(() => decodeComputerControlCommand({ operation: "send-file", path: "a" })).toThrow();
  });
});

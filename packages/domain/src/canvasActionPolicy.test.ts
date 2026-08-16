import { describe, expect, it } from "vitest";
import { CANVAS_COMMAND_IDS, decodeCanvasActionCommand } from "@octant/contracts";
import {
  CANVAS_COMMAND_ALLOWLIST,
  admitCanvasActionBlock,
  classifyCanvasActionCommand,
  isAllowlistedCanvasCommand,
} from "./canvasActionPolicy";

const ids = {
  source: "11111111-1111-4111-8111-111111111111",
} as const;

const block = (command: unknown, overrides: Record<string, unknown> = {}) => ({
  blockId: "action-1",
  schemaVersion: 1,
  kind: "action",
  label: "Do a thing",
  command,
  ...overrides,
});

describe("Canvas command allowlist", () => {
  it("mirrors the contract allowlist exactly", () => {
    expect([...CANVAS_COMMAND_ALLOWLIST].sort()).toEqual([...CANVAS_COMMAND_IDS].sort());
    for (const commandId of CANVAS_COMMAND_IDS) {
      expect(isAllowlistedCanvasCommand(commandId)).toBe(true);
    }
  });

  it("fails closed on identifiers outside the allowlist", () => {
    expect(isAllowlistedCanvasCommand("canvas.delete-everything")).toBe(false);
    expect(isAllowlistedCanvasCommand("shell.exec")).toBe(false);
    expect(isAllowlistedCanvasCommand("")).toBe(false);
    expect(isAllowlistedCanvasCommand("canvas.open-source ")).toBe(false);
  });
});

describe("admitCanvasActionBlock", () => {
  it("admits a well-formed, allowlisted action block with a capability report", () => {
    const admission = admitCanvasActionBlock(
      block({ command: "canvas.open-source", sourceId: ids.source }),
    );
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") throw new Error("expected admitted");
    expect(admission.block.command.command).toBe("canvas.open-source");
    expect(admission.capability).toEqual({
      command: "canvas.open-source",
      effect: "read",
      requiresApproval: false,
    });
  });

  it("denies an unknown command by identifier (fail closed)", () => {
    const admission = admitCanvasActionBlock(
      block({ command: "canvas.run-script", script: "rm -rf /" }),
    );
    expect(admission).toMatchObject({ kind: "denied", denialCode: "unknown-command" });
  });

  it("denies excess fields as malformed (no executable Canvas code)", () => {
    expect(
      admitCanvasActionBlock(block({ command: "canvas.request-refresh" }, { onClick: "alert(1)" })),
    ).toMatchObject({ kind: "denied", denialCode: "malformed" });
    expect(
      admitCanvasActionBlock({
        command: "canvas.open-source",
        sourceId: ids.source,
        handler: "() => {}",
      }),
    ).toMatchObject({ kind: "denied" });
  });

  it("denies an unsupported block schema version", () => {
    expect(
      admitCanvasActionBlock(block({ command: "canvas.request-refresh" }, { schemaVersion: 2 })),
    ).toMatchObject({ kind: "denied", denialCode: "unsupported-schema" });
  });

  it("denies non-object and shapeless input", () => {
    expect(admitCanvasActionBlock(null)).toMatchObject({ kind: "denied", denialCode: "malformed" });
    expect(admitCanvasActionBlock("open-source")).toMatchObject({
      kind: "denied",
      denialCode: "malformed",
    });
    expect(admitCanvasActionBlock({})).toMatchObject({ kind: "denied" });
  });
});

describe("classifyCanvasActionCommand", () => {
  it("reports read-only commands with no approval requirement", () => {
    for (const command of [
      { command: "canvas.open-source", sourceId: ids.source },
      {
        command: "canvas.filter-data",
        target: "t",
        filters: [{ column: "c", operator: "eq", value: 1 }],
      },
      { command: "canvas.attach-selection", selection: [{ kind: "canvas" }] },
      { command: "canvas.open-thread", threadRef: "opaque:t" },
      { command: "canvas.open-pull-request", pullRequestRef: "ref:pr" },
    ]) {
      const capability = classifyCanvasActionCommand(decodeCanvasActionCommand(command));
      expect(capability.effect).toBe("read");
      expect(capability.requiresApproval).toBe(false);
    }
  });

  it("classifies refresh as a non-approval mutation", () => {
    expect(
      classifyCanvasActionCommand(decodeCanvasActionCommand({ command: "canvas.request-refresh" })),
    ).toEqual({
      command: "canvas.request-refresh",
      effect: "mutate",
      requiresApproval: false,
    });
  });

  it("classifies proposing a new thread as an approval-gated mutation", () => {
    expect(
      classifyCanvasActionCommand(decodeCanvasActionCommand({ command: "canvas.propose-thread" })),
    ).toEqual({
      command: "canvas.propose-thread",
      effect: "mutate",
      requiresApproval: true,
    });
  });

  it("covers every allowlisted command", () => {
    for (const commandId of CANVAS_COMMAND_IDS) {
      expect(isAllowlistedCanvasCommand(commandId)).toBe(true);
    }
  });
});

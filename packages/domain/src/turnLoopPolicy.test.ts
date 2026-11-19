import { decodeTurnLoopNotice, decodeTurnStallNotice } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  INITIAL_TURN_LOOP_STATE,
  OCTANT_TOOL_EARLY_WARNING_THRESHOLD,
  OCTANT_TOOL_REPEAT_WARNING,
  TURN_LOOP_THRESHOLD,
  appendRepeatToolWarning,
  canonicalToolInputFromJson,
  decideTurnStallAction,
  observeTurnRuntimeEvent,
  observeTurnToolCall,
  turnLoopNoticeSentence,
  turnStallNoticeSentence,
} from "./turnLoopPolicy";

describe("turn loop and stall policy", () => {
  it("normalizes object keys recursively so reordered JSON inputs compare as identical", () => {
    const a = canonicalToolInputFromJson('{"b": 2, "a": {"z": [1, {"y": 2, "x": 1}], "m": true}}');
    const b = canonicalToolInputFromJson('{"a":{"m":true,"z":[1,{"x":1,"y":2}]},"b":2}');
    expect(a).toBeDefined();
    expect(a).toBe(b);

    // Array order matters.
    expect(canonicalToolInputFromJson('{"items":[1,2]}')).not.toBe(
      canonicalToolInputFromJson('{"items":[2,1]}'),
    );
    // Invalid JSON cannot be compared.
    expect(canonicalToolInputFromJson("{not json")).toBeUndefined();
  });

  it("raises an early warning at the 3rd consecutive identical Octant call and a loop notice at the 6th outside Strict", () => {
    expect(OCTANT_TOOL_EARLY_WARNING_THRESHOLD).toBe(3);
    expect(TURN_LOOP_THRESHOLD).toBe(6);

    const inputs = [
      '{"a":1,"b":2}',
      '{"b":2,"a":1}',
      '{ "a": 1, "b": 2 }',
      '{"b": 2, "a": 1}',
      '{"a":1,"b":2}',
      '{"b":2,"a":1}',
      '{"a":1,"b":2}',
    ];

    let state = INITIAL_TURN_LOOP_STATE;
    const earlyWarnings: number[] = [];
    const loops: Array<{ readonly call: number; readonly kind: string; readonly count: number }> =
      [];

    for (const [index, inputJson] of inputs.entries()) {
      const result = observeTurnToolCall(state, {
        toolName: "octant_read",
        inputJson,
        owner: "octant",
        strict: false,
      });
      state = result.next;
      if (result.earlyWarning) earlyWarnings.push(index + 1);
      if (result.loop !== undefined) {
        loops.push({ call: index + 1, kind: result.loop.kind, count: result.loop.count });
      }
    }

    expect(earlyWarnings).toEqual([3]);
    expect(loops).toEqual([{ call: 6, kind: "notice", count: 6 }]);
  });

  it("stops the turn at the 6th consecutive identical call under Strict", () => {
    let state = INITIAL_TURN_LOOP_STATE;
    let lastLoop: ReturnType<typeof observeTurnToolCall>["loop"];
    for (let i = 0; i < 6; i += 1) {
      const result = observeTurnToolCall(state, {
        toolName: "Read",
        inputJson:
          i % 2 === 0 ? '{"file_path":"a.ts","offset":0}' : '{"offset":0,"file_path":"a.ts"}',
        owner: "provider",
        strict: true,
      });
      state = result.next;
      expect(result.earlyWarning).toBe(false);
      lastLoop = result.loop;
    }
    expect(lastLoop).toEqual({ kind: "stop", toolName: "Read", count: 6 });
  });

  it("resets the consecutive count when a different tool or different input runs in between", () => {
    let state = INITIAL_TURN_LOOP_STATE;
    for (let i = 0; i < 5; i += 1) {
      state = observeTurnToolCall(state, {
        toolName: "octant_read",
        inputJson: '{"path":"a.ts"}',
        owner: "octant",
        strict: true,
      }).next;
    }
    // Different input breaks the streak.
    state = observeTurnToolCall(state, {
      toolName: "octant_read",
      inputJson: '{"path":"b.ts"}',
      owner: "octant",
      strict: true,
    }).next;
    const afterInputChange = observeTurnToolCall(state, {
      toolName: "octant_read",
      inputJson: '{"path":"a.ts"}',
      owner: "octant",
      strict: true,
    });
    expect(afterInputChange.loop).toBeUndefined();
    expect(afterInputChange.count).toBe(1);

    // Different tool name also resets.
    state = afterInputChange.next;
    for (let i = 0; i < 4; i += 1) {
      state = observeTurnToolCall(state, {
        toolName: "octant_read",
        inputJson: '{"path":"a.ts"}',
        owner: "octant",
        strict: true,
      }).next;
    }
    state = observeTurnToolCall(state, {
      toolName: "octant_list",
      inputJson: '{"path":"a.ts"}',
      owner: "octant",
      strict: true,
    }).next;
    const afterToolChange = observeTurnToolCall(state, {
      toolName: "octant_read",
      inputJson: '{"path":"a.ts"}',
      owner: "octant",
      strict: true,
    });
    expect(afterToolChange.loop).toBeUndefined();
    expect(afterToolChange.count).toBe(1);
  });

  it("tracks provider runtime events while ignoring partial or un-inputted tool calls", () => {
    let state = INITIAL_TURN_LOOP_STATE;

    // Six Claude Edit calls whose tool-call-content omits contents (partial: true) never trigger a loop.
    for (let i = 1; i <= 6; i += 1) {
      state = observeTurnRuntimeEvent(
        state,
        { kind: "tool-start", toolCallId: `e-${i}`, toolName: "Edit" },
        { strict: true },
      ).next;
      const content = observeTurnRuntimeEvent(
        state,
        {
          kind: "tool-call-content",
          toolCallId: `e-${i}`,
          part: "input",
          text: '{"file_path":"src/app.ts"}',
          partial: true,
        },
        { strict: true },
      );
      expect(content.loop).toBeUndefined();
      state = content.next;
      state = observeTurnRuntimeEvent(
        state,
        { kind: "tool-success", toolCallId: `e-${i}` },
        { strict: true },
      ).next;
    }

    // Three identical Octant calls bridged through an MCP prefix, interrupted by an opaque provider tool, do not trigger a loop.
    for (let i = 1; i <= 3; i += 1) {
      state = observeTurnRuntimeEvent(
        state,
        { kind: "tool-start", toolCallId: `m-${i}`, toolName: "mcp__octant__octant_read" },
        { strict: false },
      ).next;
      const req = observeTurnRuntimeEvent(
        state,
        {
          kind: "tool-request",
          requestId: `r-${i}`,
          toolName: "octant_read",
          inputJson: '{"p":"x"}',
        },
        { strict: false },
      );
      expect(req.earlyWarning).toBe(i === 3);
      state = req.next;
      state = observeTurnRuntimeEvent(
        state,
        { kind: "tool-success", toolCallId: `m-${i}` },
        { strict: false },
      ).next;
    }

    // An opaque provider tool (no tool-call-content, no tool-request) resets the streak when it finishes.
    state = observeTurnRuntimeEvent(
      state,
      { kind: "tool-start", toolCallId: "bash-1", toolName: "Bash" },
      { strict: false },
    ).next;
    state = observeTurnRuntimeEvent(
      state,
      { kind: "tool-success", toolCallId: "bash-1" },
      { strict: false },
    ).next;

    // Three more identical Octant calls start fresh at 1..3 (not 4..6).
    for (let i = 4; i <= 6; i += 1) {
      const req = observeTurnRuntimeEvent(
        state,
        {
          kind: "tool-request",
          requestId: `r-${i}`,
          toolName: "octant_read",
          inputJson: '{"p":"x"}',
        },
        { strict: false },
      );
      expect(req.loop).toBeUndefined();
      expect(req.earlyWarning).toBe(i === 6);
      state = req.next;
    }
  });

  it("appends one informational sentence to an Octant tool result without discarding the result", () => {
    expect(appendRepeatToolWarning({ ok: true, value: 42 })).toEqual({
      ok: true,
      value: 42,
      notice: OCTANT_TOOL_REPEAT_WARNING,
    });
    expect(appendRepeatToolWarning({ ok: true, notice: "Existing note." })).toEqual({
      ok: true,
      notice: `Existing note. ${OCTANT_TOOL_REPEAT_WARNING}`,
    });
    expect(appendRepeatToolWarning("plain text")).toBe(
      `plain text\n\n${OCTANT_TOOL_REPEAT_WARNING}`,
    );
    expect(appendRepeatToolWarning([1, 2])).toEqual({
      result: [1, 2],
      notice: OCTANT_TOOL_REPEAT_WARNING,
    });
  });

  it("notices stalls outside Strict and stops stalls under Strict", () => {
    expect(decideTurnStallAction({ strict: false })).toBe("notice");
    expect(decideTurnStallAction({ strict: true })).toBe("stop");
  });

  it("formats clear loop and stall notice sentences", () => {
    const occurredAt = "2026-11-19T12:00:00.000Z";
    expect(
      turnLoopNoticeSentence(
        decodeTurnLoopNotice({
          kind: "turn-loop-noticed",
          toolName: "octant_read",
          count: 6,
          occurredAt,
        }),
      ),
    ).toBe("Repeated octant_read 6 times in a row with the same input.");
    expect(
      turnLoopNoticeSentence(
        decodeTurnLoopNotice({
          kind: "turn-loop-stopped",
          toolName: "Read",
          count: 6,
          occurredAt,
        }),
      ),
    ).toBe("Stopped under Strict after Read ran 6 times in a row with the same input.");
    expect(
      turnStallNoticeSentence(
        decodeTurnStallNotice({
          kind: "turn-stall-noticed",
          idleMs: 30 * 60_000,
          occurredAt,
        }),
      ),
    ).toBe("No activity from the provider for 30 minutes.");
    expect(
      turnStallNoticeSentence(
        decodeTurnStallNotice({
          kind: "turn-stall-noticed",
          idleMs: 60 * 60_000,
          occurredAt,
        }),
      ),
    ).toBe("No activity from the provider for 1 hour.");
  });
});

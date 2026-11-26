import type { AgentRunConversationEntry } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { subagentTranscript } from "./subagentTranscript";

const at = "2026-11-26T10:00:00.000Z" as AgentRunConversationEntry["occurredAt"];
let sequence = 0;
function entry(
  fields: Omit<AgentRunConversationEntry, "sequence" | "occurredAt">,
): AgentRunConversationEntry {
  sequence += 1;
  return { ...fields, sequence, occurredAt: at };
}

describe("subagentTranscript", () => {
  it("joins a reply's deltas into one message and groups tool steps between replies", () => {
    const items = subagentTranscript([
      entry({ kind: "status", text: "task: Find the flaky test" }),
      entry({ kind: "assistant", text: "Looking" }),
      entry({ kind: "assistant", text: " now." }),
      entry({
        kind: "tool",
        text: "bun run test",
        tool: { toolCallId: "a", toolName: "Bash", state: "started", summary: "bun run test" },
      }),
      entry({
        kind: "tool",
        text: "src/app.ts",
        tool: { toolCallId: "b", toolName: "Read", state: "completed", summary: "src/app.ts" },
      }),
      entry({
        kind: "tool",
        text: "2 failed",
        tool: { toolCallId: "a", toolName: "Bash", state: "failed", summary: "2 failed" },
      }),
      entry({ kind: "assistant", text: "Two tests fail." }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["reply", "activity", "reply"]);
    expect(items[0]).toMatchObject({ text: "Looking now." });
    expect(items[1]).toMatchObject({
      rows: [
        { id: "a", toolName: "Bash", state: "failed", summary: "2 failed" },
        { id: "b", toolName: "Read", state: "completed" },
      ],
    });
  });

  it("shows what the person sent as their own messages, and a plain resume as a status line", () => {
    const items = subagentTranscript([
      entry({ kind: "status", text: "steering: Skip the docs" }),
      entry({ kind: "status", text: "resume: Continue the work you were doing." }),
      entry({ kind: "status", text: "follow-up: Now fix it" }),
      entry({ kind: "status", text: "Working-time limit: 30 minutes for this attempt." }),
    ]);
    expect(items).toMatchObject([
      { kind: "message", label: "Your steering note", text: "Skip the docs" },
      { kind: "status", text: "Resumed." },
      { kind: "message", label: "Your follow-up", text: "Now fix it" },
      { kind: "status", text: "Working-time limit: 30 minutes for this attempt." },
    ]);
  });

  it("keeps a completed step's command, and shows a failed step's reason", () => {
    const items = subagentTranscript([
      entry({
        kind: "tool",
        text: "bun run lint",
        tool: { toolCallId: "c", toolName: "Bash", state: "started", summary: "bun run lint" },
      }),
      entry({
        kind: "tool",
        text: "exit 0",
        tool: { toolCallId: "c", toolName: "Bash", state: "completed", summary: "exit 0" },
      }),
    ]);
    expect(items[0]).toMatchObject({
      rows: [{ id: "c", state: "completed", summary: "bun run lint" }],
    });
  });
});

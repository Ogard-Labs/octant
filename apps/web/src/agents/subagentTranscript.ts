import type { AgentRunConversationEntry } from "@octant/contracts";
import type { TurnActivityRow } from "../transcript/turnActivity";

/**
 * What a subagent's tab draws, in order: what the person (or the host on
 * their behalf) said to it, what it replied, the tool steps it took, and the
 * quiet status lines between.
 */
export type SubagentTranscriptItem =
  | {
      readonly kind: "message";
      readonly key: string;
      readonly label: string;
      readonly text: string;
    }
  | { readonly kind: "reply"; readonly key: string; readonly text: string }
  | {
      readonly kind: "activity";
      readonly key: string;
      readonly rows: ReadonlyArray<TurnActivityRow>;
    }
  | { readonly kind: "status"; readonly key: string; readonly text: string };

/**
 * The host writes what reached the subagent as a status line, "<kind>: <text>",
 * one per message (see the agent-run wiring's `onUserMessage`). These are the
 * kinds a person sends; the brief ("task") is the tab's first message already,
 * and a plain Resume carries only the host's own prompt.
 */
const SENT_KINDS: ReadonlyArray<{ readonly prefix: string; readonly label: string }> = [
  { prefix: "steering: ", label: "Your steering note" },
  { prefix: "follow-up: ", label: "Your follow-up" },
  { prefix: "answer: ", label: "Your answer" },
];

/**
 * Folds a subagent's conversation into thread items. The host records a reply
 * one entry per text delta, so consecutive replies are one message; tool steps
 * in a row are one activity group, and a step's finish takes the place of its
 * start by call id, as a thread's activity row does.
 */
export function subagentTranscript(
  entries: ReadonlyArray<AgentRunConversationEntry>,
): ReadonlyArray<SubagentTranscriptItem> {
  const items: SubagentTranscriptItem[] = [];
  for (const entry of entries) {
    const key = `${String(entry.generation ?? 1)}:${String(entry.sequence)}`;
    const last = items.at(-1);
    if (entry.kind === "tool" && entry.tool !== undefined) {
      const tool = entry.tool;
      const row: TurnActivityRow = {
        kind: "tool",
        id: tool.toolCallId,
        toolName: tool.toolName,
        state: tool.state,
        ...(tool.summary === undefined ? {} : { summary: tool.summary }),
      };
      const group = items.findLast(
        (item): item is Extract<SubagentTranscriptItem, { kind: "activity" }> =>
          item.kind === "activity" && item.rows.some((candidate) => candidate.id === row.id),
      );
      if (group !== undefined) {
        replaceItem(items, group, {
          ...group,
          rows: group.rows.map((candidate) =>
            candidate.id === row.id ? finishedRow(candidate, row) : candidate,
          ),
        });
        continue;
      }
      if (last?.kind === "activity") {
        replaceItem(items, last, { ...last, rows: [...last.rows, row] });
        continue;
      }
      items.push({ kind: "activity", key, rows: [row] });
      continue;
    }
    if (entry.kind === "assistant") {
      if (last?.kind === "reply") {
        replaceItem(items, last, { ...last, text: last.text + entry.text });
        continue;
      }
      items.push({ kind: "reply", key, text: entry.text });
      continue;
    }
    if (entry.childActivity === undefined) {
      if (entry.text.startsWith("task: ")) continue;
      if (entry.text.startsWith("resume: ")) {
        items.push({ kind: "status", key, text: "Resumed." });
        continue;
      }
      const sent = SENT_KINDS.find((candidate) => entry.text.startsWith(candidate.prefix));
      if (sent !== undefined) {
        items.push({
          kind: "message",
          key,
          label: sent.label,
          text: entry.text.slice(sent.prefix.length),
        });
        continue;
      }
    }
    if (entry.text.trim().length === 0) continue;
    items.push({ kind: "status", key, text: entry.text });
  }
  return items;
}

/**
 * A finished step keeps the line its start gave (the command it ran, the file
 * it read) unless it failed, when what went wrong is the line worth reading.
 */
function finishedRow(start: TurnActivityRow, finish: TurnActivityRow): TurnActivityRow {
  if (start.kind !== "tool" || finish.kind !== "tool") return finish;
  if (finish.state === "failed" || start.summary === undefined) return finish;
  return { ...finish, summary: start.summary };
}

function replaceItem(
  items: SubagentTranscriptItem[],
  previous: SubagentTranscriptItem,
  next: SubagentTranscriptItem,
): void {
  const index = items.lastIndexOf(previous);
  if (index !== -1) items[index] = next;
}

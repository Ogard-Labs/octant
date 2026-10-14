import { summarizeStepArgument } from "@octant/domain/live-turn-policy";

// The contract bounds these fields with `Schema.maxLength`, which counts UTF-16
// code units, while a step argument is bounded in code points: an emoji-heavy
// query could pass one and fail the other.
const TARGET_MAX_LENGTH = 1_024;
const TOOL_NAME_MAX_LENGTH = 256;

/** The query or address an `outside-content-read` event may carry. */
export function outsideContentTarget(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : boundedLine(raw, TARGET_MAX_LENGTH);
}

/** An agent-written tool name, which may name the address it fetches. */
export function outsideContentToolName(raw: string | undefined): string {
  return (raw === undefined ? undefined : boundedLine(raw, TOOL_NAME_MAX_LENGTH)) ?? "Tool";
}

function boundedLine(raw: string, maximum: number): string | undefined {
  const line = summarizeStepArgument(raw, maximum);
  if (line === undefined || line.length <= maximum) return line;
  let end = maximum - 1;
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${line.slice(0, end)}…`;
}

/**
 * What the host wrote into a parent thread when a delegated subagent ended.
 *
 * The host composes that turn's input as plain text (see the delivery prompt in
 * `apps/server/src/agentRun/agentResultDeliveryPrompt.ts`) so the parent agent
 * can read it. A person reads the same turn in the transcript, and the card
 * built from this parse shows what the text says in the words the interface
 * uses elsewhere for a subagent: a role, a model, a result, and ids behind a
 * disclosure.
 *
 * A block this parser cannot read stays a `raw` block, so a change to the
 * delivery wording degrades to showing the text rather than hiding it.
 */
export type ChildResultBlock =
  | {
      readonly kind: "result";
      /** `finished` carries a reply; `ended` stopped without one. */
      readonly outcome: "finished" | "ended";
      readonly role: string;
      readonly providerInstanceId: string;
      readonly modelId: string;
      readonly runId: string;
      readonly generation: string;
      readonly task: string;
      /** How an ended subagent stopped (`failed`, `cancelled`); absent when it finished. */
      readonly status: string | undefined;
      /** The reply, or why the subagent stopped. Absent when none was kept. */
      readonly text: string | undefined;
      readonly truncated: boolean;
    }
  | { readonly kind: "raw"; readonly text: string };

const FINISHED_HEADING = "A subagent you delegated has finished.";
const ENDED_HEADING = "A subagent you delegated ended without completing.";
const BATCH_HEADING = /^\d+ delegated subagents have finished\./;
const BATCH_SEPARATOR = "\n\n--- Child result ---\n";
const TRUNCATED_REPLY = "\n(the reply was truncated)";
const UNAVAILABLE_REPLY = "(the reply is unavailable)";

/** Whether this turn text is a delivery the host composed for a subagent result. */
export function isChildResultDelivery(text: string): boolean {
  return (
    text.startsWith(FINISHED_HEADING) ||
    text.startsWith(ENDED_HEADING) ||
    (BATCH_HEADING.test(text) && text.includes(BATCH_SEPARATOR))
  );
}

/** The result blocks in a delivery's text, or none when it is not a delivery. */
export function parseChildResultDelivery(text: string): ReadonlyArray<ChildResultBlock> {
  if (!isChildResultDelivery(text)) return [];
  if (BATCH_HEADING.test(text)) {
    return text
      .split(BATCH_SEPARATOR)
      .slice(1)
      .map((part) => parseBlock(part));
  }
  return [parseBlock(text)];
}

function parseBlock(text: string): ChildResultBlock {
  const heading: "finished" | "ended" | undefined = text.startsWith(FINISHED_HEADING)
    ? "finished"
    : text.startsWith(ENDED_HEADING)
      ? "ended"
      : undefined;
  const subagent = /^Subagent: (.+?) \((.*)\/([^/\n]*)\)$/m.exec(text);
  const run = /^Run: (\S+) \(generation (\d+)\)$/m.exec(text);
  const taskStart = text.indexOf("\nTask: ");
  if (heading === undefined || subagent === null || run === null || taskStart < 0) {
    return { kind: "raw", text };
  }
  const afterTask = text.slice(taskStart + "\nTask: ".length);
  const outcomeAt = afterTask.search(/\n\n(?:Result:\n|Outcome: )/);
  if (outcomeAt < 0) return { kind: "raw", text };
  const task = afterTask.slice(0, outcomeAt);
  const outcome = afterTask.slice(outcomeAt + 2);
  const [, role = "", providerInstanceId = "", modelId = ""] = subagent;
  const [, runId = "", generation = ""] = run;
  const base = { kind: "result" as const, outcome: heading, role, task, runId, generation };
  if (outcome.startsWith("Result:\n")) {
    let reply = outcome.slice("Result:\n".length);
    const truncated = reply.endsWith(TRUNCATED_REPLY);
    if (truncated) reply = reply.slice(0, -TRUNCATED_REPLY.length);
    return {
      ...base,
      providerInstanceId,
      modelId,
      status: undefined,
      text: reply === UNAVAILABLE_REPLY || reply.length === 0 ? undefined : reply,
      truncated,
    };
  }
  // "Outcome: failed — <reason>": the status word is the card's own state, so
  // only what follows it is the reason a person reads.
  const stopped = /^Outcome: ([^—\n]+?)(?: — (.*))?$/s.exec(outcome);
  const reason = stopped?.[2];
  return {
    ...base,
    providerInstanceId,
    modelId,
    status: stopped?.[1],
    text: reason === undefined || reason === "no detail was recorded" ? undefined : reason,
    truncated: false,
  };
}

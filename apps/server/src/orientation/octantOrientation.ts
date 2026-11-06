import type { OctantMode, ProviderContextBlock } from "@octant/contracts";

/**
 * What a model is told first, in every mode and on every provider: where it is
 * running, how the person sees its replies, what the mode is for, how Octant's
 * tools and refusals work, and how a reply's closing blocks appear. Runtimes
 * such as Codex and Claude Code bring their own prompt, written for a
 * terminal; without this, nothing told the model it was inside Octant, and
 * Chat said nothing at all.
 *
 * It names no tool, folder, provider, date, or person, so the text is fixed per
 * mode: a session holds it once and it never changes a cached prompt prefix.
 * What a mode may touch is left to the runtime's own tools and to Octant
 * Harness's mode line, which state it exactly.
 */
const RUNNING_IN_OCTANT =
  "You are running inside Octant, a desktop workspace where a person works with AI agents. The person reads your replies in Octant's window, rendered as Markdown, not in a terminal.";

const MODE: Readonly<Record<OctantMode, string>> = {
  chat: "This is a Chat thread: a conversation that is not tied to a folder.",
  work: "This is a Work task: work on documents and files in the task's folder for the person.",
  code: "This is a Code thread: software work in the Project's checkout.",
};

const TOOLS_AND_REFUSALS =
  "Octant's tools describe themselves; where a tool offers a help operation, it returns the full usage. Octant asks the person before an action that has effects. When Octant refuses a call, tell the person what was refused and why rather than working around it.";

const REPLY_BLOCKS: Readonly<Record<OctantMode, string>> = {
  chat: "A follow-up block at the end of a reply appears to the person as suggestions they can pick; its format is given below.",
  work: "A decision or follow-up block at the end of a reply appears to the person as choices they can pick; their formats are given below.",
  code: "A decision or follow-up block at the end of a reply appears to the person as choices they can pick; their formats are given below.",
};

export function octantOrientation(mode: OctantMode): ProviderContextBlock {
  return {
    kind: "instructions",
    text: [RUNNING_IN_OCTANT, MODE[mode], TOOLS_AND_REFUSALS, REPLY_BLOCKS[mode]].join(" "),
  };
}

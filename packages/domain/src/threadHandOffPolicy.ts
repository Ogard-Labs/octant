/**
 * Pure shaping for one thread hand-off.
 *
 * The server cuts the thread the way export does; this module decides whether
 * that cut can be handed off, what the thread's provider is asked, and how
 * the Markdown it answers with becomes Canvas blocks. Nothing here reads
 * state, runs a provider, or decides who may ask — the export policy already
 * settled who may read the thread.
 */

import type { CanvasBlock } from "@octant/contracts/canvas";
import type { ThreadExportBundle } from "@octant/contracts/thread-export";
import type { ThreadHandOffRefusalReason } from "@octant/contracts/thread-hand-off";

/** Transcript text the prompt carries at most; older entries are named, not sent. */
const MAX_TRANSCRIPT_CHARS = 48_000;
const MAX_ENTRY_CHARS = 8_000;
const MAX_TITLE_CHARS = 120;
/** Blocks one hand-off document may hold; the tail is folded into the last block. */
const MAX_DOCUMENT_BLOCKS = 96;
const MAX_BLOCK_CHARS = 32_000;

export const HAND_OFF_SECTIONS = [
  "Objective",
  "Workspace and context",
  "What was done",
  "What is left",
  "Decisions and risks",
  "How to continue",
] as const;

/**
 * What the cut itself rules out. A running turn would hand off a moving
 * target; a thread outside a Project has nowhere to keep the document; an
 * empty thread has nothing to hand off.
 */
export function decideThreadHandOff(
  bundle: ThreadExportBundle,
):
  | { readonly kind: "allow" }
  | { readonly kind: "refuse"; readonly reason: ThreadHandOffRefusalReason } {
  if (bundle.omissions.some((omission) => omission.kind === "in-progress")) {
    return { kind: "refuse", reason: "turn-running" };
  }
  if (bundle.octant.projectId === undefined) return { kind: "refuse", reason: "project-required" };
  if (bundle.transcript.entries.length === 0) return { kind: "refuse", reason: "empty-thread" };
  return { kind: "allow" };
}

export function threadHandOffTitle(bundle: ThreadExportBundle): string {
  return `Hand-off: ${bundle.octant.title}`.slice(0, MAX_TITLE_CHARS).trim();
}

/**
 * The instruction the thread's provider receives: the export cut, most recent
 * turns first when the transcript had to be shortened, and the six sections a
 * person continuing the work needs. The answer is asked for as plain Markdown
 * so it maps onto Canvas headings and paragraphs without a second parser.
 */
export function buildThreadHandOffPrompt(bundle: ThreadExportBundle): string {
  const lines: string[] = [
    "You are writing a hand-off document for a colleague who will continue this thread without you.",
    "Use only what the transcript below says; do not invent detail, and say plainly when something is unknown.",
    "Answer in plain Markdown with exactly these `##` section headings, in this order:",
    ...HAND_OFF_SECTIONS.map((section) => `## ${section}`),
    "Write short paragraphs and `-` bullet lists. No tables, no code fences, no preamble, no closing remarks.",
    "",
    `Thread: ${bundle.octant.title} (${bundle.octant.mode} mode)`,
    `Cut taken at ${bundle.octant.generatedAt}; provider ${String(bundle.provenance.providerInstanceId)}, model ${String(bundle.provenance.modelId)}.`,
  ];
  if (bundle.evidence.artifacts.length > 0) {
    lines.push(
      `Canvas artifacts on this thread: ${bundle.evidence.artifacts.map((artifact) => artifact.title).join("; ")}.`,
    );
  }
  if (bundle.evidence.completion !== undefined) {
    lines.push(
      `Delivery: ${bundle.evidence.completion.deliveryTarget} — ${bundle.evidence.completion.satisfactionEvidence}`,
    );
  }
  const omissions = bundle.omissions.filter((omission) => omission.kind !== "in-progress");
  if (omissions.length > 0) {
    lines.push(
      `The cut left out: ${omissions.map((omission) => `${omission.kind} (${String(omission.count)})`).join(", ")}.`,
    );
  }
  lines.push("", "--- transcript ---");
  const { entries, dropped } = boundedTranscript(bundle);
  if (dropped > 0) {
    lines.push(
      `[${String(dropped)} earlier entries omitted for length; the most recent are below]`,
    );
  }
  for (const entry of entries) {
    const status = entry.status === "completed" ? "" : ` (${entry.status})`;
    lines.push("", `${entry.role}${status}:`, entry.text);
  }
  return lines.join("\n");
}

function boundedTranscript(bundle: ThreadExportBundle): {
  readonly entries: ReadonlyArray<{ role: string; status: string; text: string }>;
  readonly dropped: number;
} {
  const kept: Array<{ role: string; status: string; text: string }> = [];
  let budget = MAX_TRANSCRIPT_CHARS;
  const entries = bundle.transcript.entries;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const text =
      entry.text.length > MAX_ENTRY_CHARS ? `${entry.text.slice(0, MAX_ENTRY_CHARS)}…` : entry.text;
    if (text.length > budget) break;
    budget -= text.length;
    kept.unshift({ role: entry.role, status: entry.status, text });
  }
  return { entries: kept, dropped: entries.length - kept.length };
}

/**
 * Markdown from the provider becomes the closed Canvas catalog: `#` lines are
 * headings, blank lines separate paragraphs, list items keep their bullet as
 * text. Inline emphasis marks are dropped rather than rendered, because a
 * rich-text block shows its text as written. Nothing else — no HTML, no
 * links, no code — reaches the document.
 */
export function threadHandOffDocumentBlocks(markdown: string): ReadonlyArray<CanvasBlock> {
  const blocks: CanvasBlock[] = [];
  let paragraph: string[] = [];
  let counter = 0;
  const push = (block: CanvasBlock) => {
    blocks.push(block);
  };
  const nextId = () => {
    counter += 1;
    return `hand-off-${String(counter)}`;
  };
  const flush = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (text.length === 0) return;
    push({
      blockId: nextId(),
      schemaVersion: 1,
      kind: "rich-text",
      text: text.slice(0, MAX_BLOCK_CHARS),
    } as CanvasBlock);
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/```.*$/, "").trimEnd();
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      flush();
      const text = inlineText(heading[2] ?? "");
      if (text.length > 0) {
        push({
          blockId: nextId(),
          schemaVersion: 1,
          kind: "heading",
          level: Math.min(6, Math.max(1, heading[1]?.length ?? 2)),
          text: text.slice(0, MAX_BLOCK_CHARS),
        } as CanvasBlock);
      }
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (item !== null) {
      // A list item is its own line of the paragraph, bullet kept as text.
      paragraph.push(`• ${inlineText(item[1] ?? "")}`);
      continue;
    }
    paragraph.push(inlineText(line.trim()));
  }
  flush();
  if (blocks.length <= MAX_DOCUMENT_BLOCKS) return blocks;
  const head = blocks.slice(0, MAX_DOCUMENT_BLOCKS - 1);
  const tail = blocks
    .slice(MAX_DOCUMENT_BLOCKS - 1)
    .map((block) => ("text" in block ? block.text : ""))
    .join("\n")
    .slice(0, MAX_BLOCK_CHARS);
  return [
    ...head,
    { blockId: "hand-off-tail", schemaVersion: 1, kind: "rich-text", text: tail } as CanvasBlock,
  ];
}

function inlineText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();
}

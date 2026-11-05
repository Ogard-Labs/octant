import type { ReplyDetailLevel } from "@octant/contracts/shell";
import { createContext, useContext, useState } from "react";

/**
 * The person's Reply detail level (Settings › Appearance › Reading). A surface
 * with no provider, such as a paired browser that cannot read the host's shell
 * settings, reads the quiet default.
 */
export const ReplyDetailContext = createContext<ReplyDetailLevel>("low");

/** Which of a turn's disclosures a level shows open before anyone touches one. */
export interface ReplyDetailOpening {
  readonly thinking: boolean;
  /** Whether a closed thinking disclosure shows its first line beside its name. */
  readonly thinkingPreview: boolean;
  /** Whether a settled turn's "N tool calls" fold stays open. */
  readonly toolCalls: boolean;
  /** Whether each tool row shows the summary the transcript already holds. */
  readonly toolDetail: boolean;
}

const OPENING: Readonly<Record<ReplyDetailLevel, ReplyDetailOpening>> = {
  low: { thinking: false, thinkingPreview: false, toolCalls: false, toolDetail: false },
  medium: { thinking: false, thinkingPreview: true, toolCalls: true, toolDetail: false },
  high: { thinking: true, thinkingPreview: false, toolCalls: true, toolDetail: true },
};

export function replyDetailOpening(level: ReplyDetailLevel): ReplyDetailOpening {
  return OPENING[level];
}

export const REPLY_DETAIL_LEVELS: ReadonlyArray<ReplyDetailLevel> = ["low", "medium", "high"];

/** The words Settings and the command palette use for each level. */
export const REPLY_DETAIL_LABELS: Readonly<Record<ReplyDetailLevel, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export const REPLY_DETAIL_DESCRIPTIONS: Readonly<Record<ReplyDetailLevel, string>> = {
  low: "Thinking stays folded, and a finished turn's tool calls fold behind one line.",
  medium: "Thinking stays folded with its first line showing, and tool calls stay listed.",
  high: "Thinking, tool calls, and each call's recorded result stay open.",
};

const NO_CHOICES: ReadonlyMap<string, boolean> = new Map();

interface DisclosureChoices {
  readonly level: ReplyDetailLevel;
  readonly open: ReadonlyMap<string, boolean>;
}

export interface ReplyDisclosures {
  readonly level: ReplyDetailLevel;
  readonly opening: ReplyDetailOpening;
  /** Whether a disclosure is open: the person's own choice, else the level's. */
  readonly isOpen: (id: string, openByLevel: boolean) => boolean;
  readonly choose: (id: string, open: boolean) => void;
}

/**
 * Open and closed state for one turn's disclosures.
 *
 * Opening or closing a disclosure by hand wins for that disclosure until the
 * level changes, which puts every disclosure back where the new level puts it:
 * someone who just asked for more or less detail expects to see that level.
 * The choices live in this component, so a remount forgets them too, as it
 * always has. Keeping them across a level change would leave a reader unable
 * to tell what the level they chose looks like.
 */
export function useReplyDisclosures(): ReplyDisclosures {
  const level = useContext(ReplyDetailContext);
  const [choices, setChoices] = useState<DisclosureChoices>(() => ({ level, open: NO_CHOICES }));
  // Forget the choices as the level changes, not merely while it differs:
  // going from high to medium and back must not revive what was closed at high.
  if (choices.level !== level) setChoices({ level, open: NO_CHOICES });
  const current = choices.level === level ? choices.open : NO_CHOICES;
  return {
    level,
    opening: replyDetailOpening(level),
    isOpen: (id, openByLevel) => current.get(id) ?? openByLevel,
    choose: (id, open) =>
      setChoices((previous) => {
        const base = previous.level === level ? previous.open : NO_CHOICES;
        if (base.get(id) === open && previous.level === level) return previous;
        const next = new Map(base);
        next.set(id, open);
        return { level, open: next };
      }),
  };
}

/** Longest preview kept in the document; the row's own ellipsis clips it on screen. */
const THINKING_PREVIEW_LIMIT = 160;

/**
 * The first line of a turn's thinking, as plain words: block markers and
 * emphasis marks are dropped because the preview is not rendered as Markdown.
 */
export function thinkingPreviewLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0) ?? "";
  const plain = line
    .replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
  return plain.length <= THINKING_PREVIEW_LIMIT
    ? plain
    : `${plain.slice(0, THINKING_PREVIEW_LIMIT - 1)}…`;
}

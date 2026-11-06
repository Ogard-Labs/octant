import type { ReplyDetailLevel, ReplyDetailReading } from "@octant/contracts/shell";
import {
  effectiveReplyDetail,
  replyDetailOpening,
  threadReplyDetailOverride,
  type ReplyDetailOpening,
  type ReplyDetailThread,
} from "@octant/domain/reply-detail-policy";
import { createContext, useContext, useState } from "react";

export {
  REPLY_DETAIL_LEVELS,
  replyDetailOpening,
  thinkingPreviewLine,
  type ReplyDetailOpening,
  type ReplyDetailThread,
} from "@octant/domain/reply-detail-policy";

/**
 * The Reply detail level a transcript draws at: inside a thread, that
 * thread's own level or else the default; elsewhere (the Review page) the
 * default. A surface with no provider reads the quiet default.
 */
export const ReplyDetailContext = createContext<ReplyDetailLevel>("low");

/**
 * Where Reply detail comes from and how it changes. A local window reads and
 * writes the host's shell settings; a paired browser reads the host's answer
 * and cannot change it, so it carries no setters.
 */
export interface ReplyDetailSource {
  readonly reading: ReplyDetailReading;
  /** Sets a thread's own level, or clears it so the thread follows the default. */
  readonly setThreadLevel?: (
    thread: ReplyDetailThread,
    level: ReplyDetailLevel | undefined,
  ) => void;
}

const QUIET_SOURCE: ReplyDetailSource = { reading: { defaultLevel: "low", threads: [] } };

export const ReplyDetailSourceContext = createContext<ReplyDetailSource>(QUIET_SOURCE);

/** One thread's Reply detail: what it is drawn at, and whether it chose that itself. */
export interface ThreadReplyDetailState {
  readonly thread: ReplyDetailThread;
  readonly level: ReplyDetailLevel;
  readonly override: ReplyDetailLevel | undefined;
  readonly defaultLevel: ReplyDetailLevel;
  readonly setLevel?: (level: ReplyDetailLevel | undefined) => void;
}

export function useThreadReplyDetail(thread: ReplyDetailThread): ThreadReplyDetailState {
  const source = useContext(ReplyDetailSourceContext);
  const setThreadLevel = source.setThreadLevel;
  return {
    thread,
    level: effectiveReplyDetail(source.reading, thread),
    override: threadReplyDetailOverride(source.reading.threads, thread),
    defaultLevel: source.reading.defaultLevel,
    ...(setThreadLevel === undefined
      ? {}
      : { setLevel: (level: ReplyDetailLevel | undefined) => setThreadLevel(thread, level) }),
  };
}

/** The words Settings, the thread menu, and the command palette use for each level. */
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

/** The same levels said short enough for a menu row at phone width. */
export const REPLY_DETAIL_MENU_DESCRIPTIONS: Readonly<Record<ReplyDetailLevel, string>> = {
  low: "Thinking and finished tool calls folded",
  medium: "Thinking's first line, tool calls listed",
  high: "Thinking, tool calls, and results open",
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
 * level this transcript draws at changes (the thread's own level, or the
 * default it follows), which puts every disclosure back where the new level
 * puts it: someone who just asked for more or less detail expects to see that
 * level. The choices live in this component, so a remount forgets them too,
 * as it always has.
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

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface ComposerNoticeSlot {
  readonly content: ReactNode;
  readonly register: () => () => void;
}
const NoticeContext = createContext<ComposerNoticeSlot | undefined>(undefined);

/** Keep a notice in its owning pane even while that pane's composer is loading. */
export function ComposerNoticeProvider(props: {
  readonly value: ReactNode;
  readonly children: ReactNode;
}) {
  const [composers, setComposers] = useState(0);
  const register = useCallback(() => {
    setComposers((count) => count + 1);
    return () => setComposers((count) => Math.max(0, count - 1));
  }, []);
  const value = useMemo(() => ({ content: props.value, register }), [props.value, register]);
  return (
    <NoticeContext.Provider value={value}>
      {props.children}
      {composers === 0 && props.value != null ? (
        <div className="composer-notice-fallback">{props.value}</div>
      ) : null}
    </NoticeContext.Provider>
  );
}

/** This slot carries notices only; it cannot confirm authority challenges. */
export function useComposerNotice(): ReactNode {
  const slot = useContext(NoticeContext);
  const register = slot?.register;
  useLayoutEffect(() => register?.(), [register]);
  return slot?.content;
}

/**
 * One thing a composer has to say about its thread or about sending. The
 * notice card above the box draws it with the system's callout, so a surface
 * hands over words, a tone and an action, never markup of its own.
 */
export interface ComposerNoticeItem {
  readonly key: string;
  /** `neutral` is a fact or a hint, `warning` needs a look, `danger` is a refusal or failure. */
  readonly tone: "neutral" | "warning" | "danger";
  /** A refusal is announced as an alert; the default follows the tone. */
  readonly role?: "alert" | "status";
  /** The element id, for a control that names this notice as its description. */
  readonly id?: string;
  readonly text: ReactNode;
  /** Names the card, or the status line, for assistive technology. */
  readonly label?: string;
  /**
   * Set only for a state that is passing by itself and has no action (a first
   * turn being prepared). It is then the quiet line, which takes no layout
   * room, and only while its text is a string. Everything else stays a card
   * until the person resolves it, however plain: a note that stays must be
   * readable whole, never cut to one line.
   */
  readonly transient?: true;
  readonly action?: ReactNode;
}

/**
 * What the card is announced as: the tone's own default, as the callout draws
 * it. A refusal or failure is an alert, a plain fact a status.
 */
export function noticeRole(notice: ComposerNoticeItem): "alert" | "status" {
  // An offer the person must act on is announced when it appears, like a refusal.
  return (
    notice.role ?? (notice.tone === "neutral" && notice.action === undefined ? "status" : "alert")
  );
}

/**
 * The one passing message a composer is saying now (sending, a response
 * streaming, a provider check). It is progress, not a card: it comes and goes
 * by itself, so it is a quiet line that takes no layout room, and `quiet`
 * keeps it to assistive technology where a control already says it.
 */
export interface ComposerProgress {
  readonly text: string;
  /** Names the status region while this is said. */
  readonly label?: string;
  readonly quiet?: boolean;
}

const SEVERITY: Record<ComposerNoticeItem["tone"], number> = { danger: 0, warning: 1, neutral: 2 };

/** Most severe first; notices of one tone keep the order the surface gave. */
export function bySeverity(
  notices: ReadonlyArray<ComposerNoticeItem>,
): ReadonlyArray<ComposerNoticeItem> {
  return notices
    .map((notice, index) => ({ notice, index }))
    .sort((a, b) => SEVERITY[a.notice.tone] - SEVERITY[b.notice.tone] || a.index - b.index)
    .map(({ notice }) => notice);
}

interface ComposerNoticeSink {
  readonly set: (item: ComposerNoticeItem | undefined, key: string) => void;
}
const SinkContext = createContext<ComposerNoticeSink | undefined>(undefined);

/**
 * Lets a control inside the box (the microphone) say a failure in the notice
 * card instead of beside itself, where a long message was cut to fit. Absent
 * outside a thread composer, so the control keeps saying it where it stands.
 */
export function ComposerNoticeSinkProvider(props: {
  readonly set: ComposerNoticeSink["set"];
  readonly children: ReactNode;
}) {
  const value = useMemo(() => ({ set: props.set }), [props.set]);
  return <SinkContext.Provider value={value}>{props.children}</SinkContext.Provider>;
}

/**
 * Publishes `item` to the composer's notice card while it is defined and
 * reports whether a card took it (false: the caller draws it itself).
 */
export function useComposerNoticeSink(key: string, item: ComposerNoticeItem | undefined): boolean {
  const sink = useContext(SinkContext);
  const set = sink?.set;
  // The item is rebuilt on every render; its words are what identify it.
  const signature =
    item === undefined ? undefined : `${item.tone}:${item.role ?? ""}:${String(item.text)}`;
  useLayoutEffect(() => {
    if (set === undefined) return undefined;
    set(item, key);
    return () => set(undefined, key);
  }, [set, key, signature]);
  return sink !== undefined;
}

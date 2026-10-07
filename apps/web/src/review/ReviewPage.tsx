import {
  describeChord,
  matchPageKeybinding,
  resolveSnoozePresets,
  type OctantKeybindingActionId,
  type OctantKeybindings,
} from "@octant/domain";
import { Check, Clock, CornerUpLeft, Minus, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ParsedDiffFile } from "../code/unifiedDiff";
import { UnifiedDiffList } from "../code/UnifiedDiffList";
import { useKeybindings } from "../keybindings/useKeybindings";
import { relativeTimeLabel } from "../lib/relativeTime";
import { isApplePlatform } from "../platform";
import { Surface, SurfaceEmpty, SurfaceHeader } from "../surface/SurfaceHeader";
import { AssistantMessageBody } from "../transcript/AssistantMessageBody";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";
import {
  REVIEW_CHECK_WORDS,
  orderReviewEntries,
  reviewEntryKey,
  type ReviewCheckKind,
  type ReviewEntry,
} from "./reviewModel";
import type {
  ReviewDiff,
  ReviewFacts,
  ReviewOctantCheck,
  ReviewReply,
  ReviewSource,
} from "./reviewSource";

/** What a host command answered: done, or refused in the host's own words. */
export type ReviewActionOutcome =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly message: string };

export interface ReviewPageProps {
  readonly entries: ReadonlyArray<ReviewEntry>;
  readonly source: ReviewSource;
  /** Bumps when the host reports that a thread list changed; facts are read again. */
  readonly changeRevision: number;
  readonly now: number;
  readonly onClose: () => void;
  readonly onOpen: (entry: ReviewEntry) => void;
  readonly onComplete: (entry: ReviewEntry) => Promise<ReviewActionOutcome>;
  readonly onSnooze: (entry: ReviewEntry, until: string) => Promise<ReviewActionOutcome>;
  readonly onSendBack: (entry: ReviewEntry, prompt: string) => Promise<ReviewActionOutcome>;
  readonly onMarkSeen: (entry: ReviewEntry) => void;
  /**
   * The host lets a window read a Code thread only in the one Code Project the
   * window is bound to, and the list spans every Project. Without this the page
   * read threads elsewhere and showed the host's refusal ("Code thread is
   * unauthorized") as their reply and changes.
   */
  readonly codeProjectAccess?: {
    readonly boundProjectId: string | undefined;
    readonly onOpenProject: (entry: ReviewEntry) => void;
  };
  /** Injected in tests; otherwise the window's own keybindings. */
  readonly keybindings?: OctantKeybindings;
}

type Loaded<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "failed" };

/** Reads one thing for the selected thread; a result for a thread no longer selected is dropped. */
function useLoaded<T>(
  key: string | undefined,
  load: (signal: AbortSignal) => Promise<T>,
): Loaded<T> {
  const [state, setState] = useState<{
    readonly key: string | undefined;
    readonly loaded: Loaded<T>;
  }>({ key, loaded: { status: "loading" } });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (key === undefined) return;
    const controller = new AbortController();
    setState({ key, loaded: { status: "loading" } });
    loadRef.current(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setState({ key, loaded: { status: "ready", value } });
      },
      () => {
        if (!controller.signal.aborted) setState({ key, loaded: { status: "failed" } });
      },
    );
    return () => controller.abort();
  }, [key]);
  return state.key === key ? state.loaded : { status: "loading" };
}

const CHECK_ICONS: Readonly<Record<ReviewCheckKind, LucideIcon>> = {
  passed: Check,
  failing: X,
  pending: Clock,
  none: Minus,
};

/** The glyph carries the state beside its words, so no colour has to. */
function CheckMark(props: { readonly kind: ReviewCheckKind }) {
  const Icon = CHECK_ICONS[props.kind];
  return <Icon aria-hidden="true" className="review-check__glyph" size={12} strokeWidth={2} />;
}

const OCTANT_CHECK_WORDS: Readonly<Record<ReviewOctantCheck["verdict"], string>> = {
  passed: "passed",
  failed: "failed",
  running: "running",
  inconclusive: "inconclusive",
};

const OCTANT_CHECK_KIND: Readonly<Record<ReviewOctantCheck["verdict"], ReviewCheckKind>> = {
  passed: "passed",
  failed: "failing",
  running: "pending",
  inconclusive: "none",
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}

/**
 * One page for every finished thread the person has not looked at: what the
 * agent did, whether it worked, and single keys to act. The list is the
 * sidebar tile's own predicate, so the count and the rows agree, and every
 * action goes through the thread's ordinary host command; a refusal is shown
 * in the host's words and nothing here widens what a thread may do.
 */
export function ReviewPage(props: ReviewPageProps) {
  const fallbackKeybindings = useKeybindings();
  const keybindings = props.keybindings ?? fallbackKeybindings.keybindings;
  const apple = isApplePlatform();
  const [facts, setFacts] = useState<{
    readonly status: "loading" | "ready";
    readonly byKey: ReadonlyMap<string, ReviewFacts>;
  }>({ status: "loading", byKey: new Map() });
  const entriesKey = props.entries.map(reviewEntryKey).join(",");
  const entriesRef = useRef(props.entries);
  entriesRef.current = props.entries;

  useEffect(() => {
    const controller = new AbortController();
    const entries = entriesRef.current;
    if (entries.length === 0) {
      setFacts({ status: "ready", byKey: new Map() });
      return;
    }
    props.source.loadFacts(entries, controller.signal).then(
      (byKey) => {
        if (!controller.signal.aborted) setFacts({ status: "ready", byKey });
      },
      () => {
        // A board that cannot be read leaves the rows as they are: each still
        // lists with its title and Project, and says nothing it was not told.
        if (!controller.signal.aborted) setFacts({ status: "ready", byKey: new Map() });
      },
    );
    return () => controller.abort();
  }, [props.source, props.changeRevision, entriesKey]);

  const ordered = useMemo(() => {
    const finishedAt = new Map<string, string>();
    for (const [key, fact] of facts.byKey) {
      if (fact.finishedAt !== undefined) finishedAt.set(key, fact.finishedAt);
    }
    return orderReviewEntries(props.entries, finishedAt);
  }, [facts.byKey, props.entries]);

  // Selection follows the thread, not the position, so a re-sort when facts
  // arrive does not move it. When the selected thread leaves the list the next
  // one takes its place, which is what lets a person triage by pressing C.
  const [selectedKey, setSelectedKey] = useState<string>();
  const lastIndex = useRef(0);
  const selectedIndex = ordered.findIndex((entry) => reviewEntryKey(entry) === selectedKey);
  const effectiveIndex =
    selectedIndex >= 0 ? selectedIndex : Math.min(lastIndex.current, ordered.length - 1);
  const selected = ordered[effectiveIndex];
  if (selected !== undefined) lastIndex.current = effectiveIndex;
  const selectedEntryKey = selected === undefined ? undefined : reviewEntryKey(selected);
  // Pin whatever is selected by position. Without this the first row is
  // "whichever sorts first", and the board facts that arrive after the first
  // paint re-sort the list: the selection then jumped to the other thread, whose
  // load re-read the board, which re-sorted the list again.
  useEffect(() => {
    if (selectedEntryKey !== undefined && selectedKey !== selectedEntryKey) {
      setSelectedKey(selectedEntryKey);
    }
  }, [selectedEntryKey, selectedKey]);
  const selectedFacts =
    selectedEntryKey === undefined ? undefined : facts.byKey.get(selectedEntryKey);

  const [notice, setNotice] = useState<{ readonly key: string; readonly message: string }>();
  const [pending, setPending] = useState(false);
  const [composing, setComposing] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const followUpRef = useRef<HTMLInputElement>(null);

  // A different thread starts clean: its own refusal line, and no half-typed
  // follow-up carried over from the one before.
  useEffect(() => {
    setComposing(false);
    setFollowUp("");
    setSnoozeOpen(false);
  }, [selectedEntryKey]);

  useEffect(() => {
    if (composing) followUpRef.current?.focus();
  }, [composing]);

  // Land on the page so its keys work at once, unless focus already moved inside it.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const access = props.codeProjectAccess;
  const projectClosed =
    access !== undefined &&
    selected?.mode === "code" &&
    (selected.projectId === undefined ||
      access.boundProjectId === undefined ||
      String(selected.projectId) !== String(access.boundProjectId));
  const readKey = projectClosed ? undefined : selectedEntryKey;
  const reply = useLoaded<ReviewReply | undefined>(readKey, (signal) =>
    selected === undefined ? Promise.resolve(undefined) : props.source.loadReply(selected, signal),
  );
  // The checks and the diff need the checkout the board named, so they wait for
  // the facts read to settle, and read again when a thread whose facts had not
  // arrived yet (one that just finished) gets them.
  const detailKey =
    readKey === undefined || facts.status !== "ready"
      ? undefined
      : `${readKey}:${String(selectedFacts?.checkoutId ?? "")}`;
  const octantCheck = useLoaded<ReviewOctantCheck | undefined>(detailKey, async (signal) =>
    selected === undefined || props.source.loadOctantCheck === undefined
      ? undefined
      : await props.source.loadOctantCheck(selected, selectedFacts, signal),
  );
  const diff = useLoaded<ReviewDiff | undefined>(detailKey, async (signal) =>
    selected === undefined || props.source.loadDiff === undefined
      ? undefined
      : await props.source.loadDiff(selected, selectedFacts, signal),
  );

  const [fileId, setFileId] = useState<{ readonly key: string; readonly id: string }>();

  async function run(
    entry: ReviewEntry,
    act: () => Promise<ReviewActionOutcome>,
  ): Promise<boolean> {
    if (pending) return false;
    const key = reviewEntryKey(entry);
    setPending(true);
    setNotice(undefined);
    try {
      const outcome = await act();
      if (outcome.status === "refused") {
        setNotice({ key, message: outcome.message });
        return false;
      }
      return true;
    } finally {
      setPending(false);
    }
  }

  function move(delta: number) {
    if (ordered.length === 0) return;
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, effectiveIndex + delta))];
    if (next !== undefined) setSelectedKey(reviewEntryKey(next));
  }

  const actionsRef = useRef<(action: OctantKeybindingActionId) => void>(() => undefined);
  actionsRef.current = (action) => {
    if (selected === undefined) {
      return;
    }
    switch (action) {
      case "review-next":
        move(1);
        return;
      case "review-previous":
        move(-1);
        return;
      case "review-open":
        props.onOpen(selected);
        return;
      case "review-complete":
        void run(selected, () => props.onComplete(selected));
        return;
      case "review-send-back":
        setSnoozeOpen(false);
        setComposing(true);
        return;
      case "review-snooze":
        setComposing(false);
        setSnoozeOpen((open) => !open);
        return;
      case "review-mark-seen":
        props.onMarkSeen(selected);
        return;
      default:
        return;
    }
  };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      // Control is Cocoa text editing on Apple hardware, never a page command.
      if (apple && event.ctrlKey) return;
      const target = event.target;
      if (isTypingTarget(target)) return;
      // Bare keys are safe only because the page owns them while it has focus:
      // a C pressed on a sidebar row must not complete the thread selected
      // here. Focus that fell to the body, because the control holding it left
      // with the thread it belonged to, still counts as the page.
      const page = rootRef.current?.closest(".review-page");
      if (
        target !== document.body &&
        !(target instanceof Node && page?.contains(target) === true)
      ) {
        return;
      }
      // A menu, popover, or dialog owns its own keys while it is open.
      if (
        target instanceof HTMLElement &&
        target.closest("[role='dialog'], [role='menu']") !== null
      ) {
        return;
      }
      const action = matchPageKeybinding(keybindings, "review", event, apple);
      if (action === undefined) return;
      // Enter on a focused control activates that control; only on the page
      // itself, or on a list row, does it open the thread.
      if (
        action === "review-open" &&
        target instanceof HTMLElement &&
        target.closest("button, a") !== null &&
        target.closest("[data-review-row]") === null
      ) {
        return;
      }
      event.preventDefault();
      actionsRef.current(action);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [apple, keybindings]);

  useEffect(() => {
    if (selectedEntryKey === undefined) return;
    const row = [...(rootRef.current?.querySelectorAll("[data-review-row]") ?? [])].find(
      (candidate) => candidate.getAttribute("data-review-row") === selectedEntryKey,
    );
    if (!(row instanceof HTMLElement)) return;
    // A focused row is the one the keys act on, so focus moves with J and K
    // rather than staying on a row that is no longer selected.
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== row &&
      focused.hasAttribute("data-review-row") &&
      rootRef.current?.contains(focused) === true
    ) {
      row.focus({ preventScroll: true });
    }
    if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [selectedEntryKey]);

  const count = props.entries.length;
  const chord = (id: OctantKeybindingActionId): string => {
    const bound = keybindings.bindings.get(id);
    return bound === undefined ? "" : describeChord(bound, apple);
  };
  const legend: ReadonlyArray<{ readonly keys: ReadonlyArray<string>; readonly label: string }> = [
    { keys: [chord("review-next"), chord("review-previous")], label: "move" },
    { keys: [chord("review-open")], label: "open" },
    { keys: [chord("review-complete")], label: "complete" },
    { keys: [chord("review-send-back")], label: "send back" },
    { keys: [chord("review-snooze")], label: "snooze" },
    { keys: [chord("review-mark-seen")], label: "seen" },
  ];

  return (
    <Surface ariaLabel="To review" className="review-page" measure="wide">
      <SurfaceHeader
        actions={
          <p aria-label="Keyboard shortcuts" className="review-legend">
            {legend.map((item) => (
              <span className="review-legend__item" key={item.label}>
                {item.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}{" "}
                {item.label}
              </span>
            ))}
          </p>
        }
        onBack={props.onClose}
        title={`To review · ${String(count)} finished ${count === 1 ? "thread" : "threads"}`}
      />
      <section
        aria-label="Review finished threads"
        className="review-page__body"
        ref={rootRef}
        tabIndex={-1}
      >
        {selected === undefined ? (
          <SurfaceEmpty
            detail="Finished threads you have not opened will appear here."
            title="Nothing waiting for review"
          />
        ) : (
          <>
            <nav aria-label="Finished threads" className="review-list">
              <ul>
                {ordered.map((entry) => {
                  const key = reviewEntryKey(entry);
                  const entryFacts = facts.byKey.get(key);
                  return (
                    <li key={key}>
                      <OctantButton
                        aria-current={key === selectedEntryKey ? "true" : undefined}
                        className="review-row"
                        data-review-row={key}
                        onClick={() => setSelectedKey(key)}
                        onFocus={() => setSelectedKey(key)}
                        type="button"
                        variant="bare"
                      >
                        <span className="review-row__face">
                          <span className="oct-row-label review-row__title">{entry.title}</span>
                          <span className="oct-meta review-row__meta">
                            {rowMeta(entry, entryFacts)}
                          </span>
                          <span className="oct-meta review-row__state">
                            {entryFacts !== undefined && entry.mode !== "chat" ? (
                              <>
                                <span className="review-check">
                                  <CheckMark kind={entryFacts.check} />
                                  {REVIEW_CHECK_WORDS[entryFacts.check]}
                                </span>
                                {" · "}
                              </>
                            ) : null}
                            {age(entry, entryFacts, props.now)}
                          </span>
                        </span>
                      </OctantButton>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <section
              aria-label={`Review ${selected.title}`}
              className="review-detail"
              key={selectedEntryKey}
            >
              <header className="review-detail__head">
                <h2 className="oct-title review-detail__title">{selected.title}</h2>
                <p className="oct-meta review-detail__where">
                  {detailWhere(selected, selectedFacts)}
                </p>
                <div className="review-detail__actions">
                  <OctantButton
                    disabled={pending}
                    onClick={() => void run(selected, () => props.onComplete(selected))}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Check aria-hidden="true" size={14} strokeWidth={1.8} />
                    Complete <kbd>{chord("review-complete")}</kbd>
                  </OctantButton>
                  <OctantButton
                    aria-expanded={composing}
                    disabled={pending}
                    onClick={() => {
                      setSnoozeOpen(false);
                      setComposing((open) => !open);
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <CornerUpLeft aria-hidden="true" size={14} strokeWidth={1.8} />
                    Send back <kbd>{chord("review-send-back")}</kbd>
                  </OctantButton>
                  <OctantPopover
                    onOpenChange={setSnoozeOpen}
                    open={snoozeOpen}
                    title={`Snooze ${selected.title}`}
                    trigger={
                      <>
                        <Clock aria-hidden="true" size={14} strokeWidth={1.8} />
                        Snooze <kbd>{chord("review-snooze")}</kbd>
                      </>
                    }
                    triggerDisabled={pending}
                    triggerLabel="Snooze"
                    triggerVariant="outline"
                    className="review-snooze"
                  >
                    <ul aria-label="Snooze until" className="review-snooze__list">
                      {resolveSnoozePresets(new Date(props.now)).map((preset) => (
                        <li key={preset.id}>
                          <OctantButton
                            className="review-snooze__choice"
                            onClick={() => {
                              setSnoozeOpen(false);
                              void run(selected, () => props.onSnooze(selected, preset.until));
                            }}
                            type="button"
                            variant="ghost"
                          >
                            <span>{preset.label}</span>
                            <span className="oct-meta">{preset.whenLabel}</span>
                          </OctantButton>
                        </li>
                      ))}
                    </ul>
                  </OctantPopover>
                  <OctantButton
                    onClick={() => props.onOpen(selected)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Open <kbd>{chord("review-open")}</kbd>
                  </OctantButton>
                  <OctantButton
                    onClick={() => props.onMarkSeen(selected)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Mark seen <kbd>{chord("review-mark-seen")}</kbd>
                  </OctantButton>
                </div>
                {composing ? (
                  <OctantInput
                    aria-label={`Follow-up for ${selected.title}`}
                    className="review-detail__follow-up"
                    disabled={pending}
                    onChange={(event) => setFollowUp(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setComposing(false);
                        setFollowUp("");
                        rootRef.current?.focus({ preventScroll: true });
                        return;
                      }
                      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      const text = followUp.trim();
                      if (text === "") return;
                      void run(selected, () => props.onSendBack(selected, text)).then((sent) => {
                        if (!sent) return;
                        setComposing(false);
                        setFollowUp("");
                        rootRef.current?.focus({ preventScroll: true });
                      });
                    }}
                    placeholder="What should it change? Enter sends, Esc cancels"
                    ref={followUpRef}
                    value={followUp}
                  />
                ) : null}
                {notice === undefined || notice.key !== selectedEntryKey ? null : (
                  <OctantAlert className="review-detail__notice" role="alert">
                    {notice.message}
                  </OctantAlert>
                )}
              </header>
              {projectClosed && access !== undefined ? (
                <section
                  aria-label="Project not open"
                  className="review-section review-section--closed"
                >
                  <p className="oct-meta">
                    This thread is in {selected.projectName}. Open that Project to see its reply,
                    checks and changes.
                  </p>
                  <OctantButton
                    onClick={() => access.onOpenProject(selected)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Open {selected.projectName}
                  </OctantButton>
                </section>
              ) : (
                <>
                  <LastReply reply={reply} />
                  {selected.mode === "chat" ? null : (
                    <Checks facts={selectedFacts} octant={octantCheck} />
                  )}
                  <ChangedFiles
                    diff={diff}
                    fileId={
                      fileId !== undefined && fileId.key === selectedEntryKey
                        ? fileId.id
                        : undefined
                    }
                    onSelectFile={(id) =>
                      selectedEntryKey === undefined
                        ? undefined
                        : setFileId({ key: selectedEntryKey, id })
                    }
                    reply={reply}
                    workPaths={selected.mode === "work"}
                  />
                </>
              )}
            </section>
          </>
        )}
      </section>
    </Surface>
  );
}

function rowMeta(entry: ReviewEntry, facts: ReviewFacts | undefined): string {
  const parts = [entry.projectName];
  if (facts?.changes !== undefined) {
    parts.push(
      `${String(facts.changes.files)} ${facts.changes.files === 1 ? "file" : "files"}`,
      `+${String(facts.changes.insertions)} −${String(facts.changes.deletions)}`,
    );
  }
  return parts.join(" · ");
}

function age(entry: ReviewEntry, facts: ReviewFacts | undefined, now: number): string {
  const at = facts?.finishedAt ?? entry.updatedAt;
  return at === undefined ? "" : relativeTimeLabel(at, now);
}

function detailWhere(entry: ReviewEntry, facts: ReviewFacts | undefined): string {
  const parts = [entry.projectName];
  if (facts?.branch !== undefined) {
    parts.push(facts.base === undefined ? facts.branch : `${facts.branch} → ${facts.base}`);
  }
  if (facts?.commits !== undefined && facts.commits > 0) {
    parts.push(`${String(facts.commits)} ${facts.commits === 1 ? "commit" : "commits"}`);
  }
  return parts.join(" · ");
}

function LastReply(props: { readonly reply: Loaded<ReviewReply | undefined> }) {
  const [expanded, setExpanded] = useState(false);
  const { reply } = props;
  const text = reply.status === "ready" ? (reply.value?.text ?? "") : "";
  const long = text.length > 360 || text.split("\n").length > 7;
  return (
    <section aria-label="Last reply" className="review-section">
      <h3 className="oct-section-label">Last reply</h3>
      {reply.status === "loading" ? (
        <p className="oct-meta" role="status">
          Loading the reply…
        </p>
      ) : reply.status === "failed" ? (
        <p className="oct-meta">The reply could not be read from the host.</p>
      ) : reply.value === undefined || text === "" ? (
        <p className="oct-meta">The thread has no reply to show.</p>
      ) : (
        <>
          {reply.value.outcome === "completed" ? null : (
            <p className="oct-meta">
              {reply.value.outcome === "failed"
                ? "The last turn failed."
                : "The last turn stopped before it finished."}
            </p>
          )}
          <div className="review-reply" data-expanded={expanded || !long ? "true" : "false"}>
            <AssistantMessageBody body={text} />
          </div>
          {long ? (
            <OctantButton
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
              size="sm"
              type="button"
              variant="link"
            >
              {expanded ? "Show less" : "Show more"}
            </OctantButton>
          ) : null}
        </>
      )}
    </section>
  );
}

function Checks(props: {
  readonly facts: ReviewFacts | undefined;
  readonly octant: Loaded<ReviewOctantCheck | undefined>;
}) {
  const octant = props.octant.status === "ready" ? props.octant.value : undefined;
  const ci = props.facts?.check ?? "none";
  if (octant === undefined && props.facts === undefined) return null;
  return (
    <section aria-label="Checks" className="review-section">
      <h3 className="oct-section-label">Checks</h3>
      <p className="review-checks">
        {octant === undefined ? null : (
          <span className="review-check">
            <CheckMark kind={OCTANT_CHECK_KIND[octant.verdict]} />
            Octant check {OCTANT_CHECK_WORDS[octant.verdict]}
          </span>
        )}
        <span className="review-check">
          <CheckMark kind={ci} />
          {ci === "none" ? "No CI checks reported" : `CI ${REVIEW_CHECK_WORDS[ci]}`}
        </span>
      </p>
    </section>
  );
}

function ChangedFiles(props: {
  readonly diff: Loaded<ReviewDiff | undefined>;
  readonly reply: Loaded<ReviewReply | undefined>;
  readonly workPaths: boolean;
  readonly fileId: string | undefined;
  readonly onSelectFile: (id: string) => void;
}) {
  if (props.workPaths) {
    const paths = props.reply.status === "ready" ? (props.reply.value?.wrotePaths ?? []) : [];
    if (paths.length === 0) return null;
    return (
      <section aria-label="Changed files" className="review-section">
        <h3 className="oct-section-label">Changed files</h3>
        <ul className="review-files">
          {paths.map((path) => (
            <li key={path}>
              <span className="review-file__face">
                <span className="review-file__path">{path}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  const { diff } = props;
  if (diff.status === "ready" && diff.value === undefined) return null;
  return (
    <section aria-label="Changed files" className="review-section">
      <h3 className="oct-section-label">Changed files</h3>
      {diff.status === "loading" ? (
        <p className="oct-meta" role="status">
          Reading the changes…
        </p>
      ) : diff.status === "failed" || diff.value?.status === "unavailable" ? (
        <p className="oct-meta">
          {diff.status === "ready" && diff.value?.status === "unavailable"
            ? diff.value.message
            : "The changes could not be read from the host."}
        </p>
      ) : diff.value?.status === "clean" ? (
        <p className="oct-meta">This checkout has no local changes to review.</p>
      ) : diff.value?.status === "ready" ? (
        <DiffFiles
          fileId={props.fileId}
          files={diff.value.files}
          onSelectFile={props.onSelectFile}
          truncated={diff.value.truncated}
        />
      ) : null}
    </section>
  );
}

function DiffFiles(props: {
  readonly files: ReadonlyArray<ParsedDiffFile>;
  readonly truncated: boolean;
  readonly fileId: string | undefined;
  readonly onSelectFile: (id: string) => void;
}) {
  const selected = props.files.find((file) => file.id === props.fileId) ?? props.files[0];
  if (selected === undefined)
    return <p className="oct-meta">This checkout has no textual changes.</p>;
  return (
    <>
      {props.truncated ? (
        <p className="oct-meta" role="status">
          This diff is truncated and is not complete.
        </p>
      ) : null}
      <ul aria-label="Files" className="review-files">
        {props.files.map((file) => (
          <li key={file.id}>
            <OctantButton
              aria-current={file.id === selected.id ? "true" : undefined}
              className="review-file"
              onClick={() => props.onSelectFile(file.id)}
              type="button"
              variant="bare"
            >
              <span className="review-file__face">
                <span className="review-file__path">{file.path}</span>
                <span className="review-file__counts">
                  {file.binary
                    ? "binary"
                    : `+${file.additions.toLocaleString()} −${file.deletions.toLocaleString()}`}
                </span>
              </span>
            </OctantButton>
          </li>
        ))}
      </ul>
      <UnifiedDiffList files={[selected]} />
    </>
  );
}

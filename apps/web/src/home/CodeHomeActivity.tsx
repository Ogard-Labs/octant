import type { CodeClient } from "@octant/client-runtime/code-client";
import { decodeUtcTimestamp } from "@octant/contracts";
import type {
  ActivityCardSource,
  ActivityKind,
  ActivityQuery,
  ActivityRecord,
  ActivityView,
  HomeActivityCustomization,
  ActivityRangeChoice,
} from "@octant/contracts/code-home-activity";
import type { OctantMode } from "@octant/contracts/modes";
import type { HomeCardCustomization } from "@octant/contracts/shell";
import {
  activityRangeForCard,
  DEFAULT_HOME_ACTIVITY,
  resolveActivityRange,
  type ActivityRangeResult,
  type ActivityWindow as ResolvedWindow,
} from "@octant/domain/activity-range-policy";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Ellipsis,
  GitMerge,
  Pin,
  PinOff,
  RefreshCw,
  Rocket,
  type IconComponent,
} from "../ui/icons";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { IconButton } from "../shell/IconButton";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton, octantButtonClassName } from "../ui/base/OctantButton";
import { OctantCard, OctantCardContent, OctantCardHeader } from "../ui/base/OctantCard";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { ActivityRangeField, activityRangeLabel } from "./ActivityRangeField";
import "./home.css";
import {
  arrangeHomeCards,
  moveHomeCard,
  setHomeCardVisible,
  type HomeCardIdentity,
  type HomeCardPlacement,
} from "./homeCards";

export interface CodeHomeActivityProps {
  readonly customization: HomeCardCustomization;
  readonly onCustomizationChange: (next: HomeCardCustomization) => void;
  readonly read: NonNullable<CodeClient["readHomeActivity"]>;
  readonly onOpenThread: (mode: OctantMode, threadId: string) => void;
  readonly onOpenExternal?: ((url: string) => void) | undefined;
  /** Overrides the locale's week start; absent reads the client's own. */
  readonly weekStartsOn?: number;
}

interface ActivityCardMeta {
  readonly id: string;
  readonly card: ActivityKind;
  readonly title: string;
  readonly icon: IconComponent;
  /** The one line Customize gives about what the card counts. */
  readonly explanation: string;
  readonly emptyLabel: string;
}

const ACTIVITY_CARDS: ReadonlyArray<ActivityCardMeta> = [
  {
    id: "activity-prs-merged",
    card: "prs-merged",
    title: "Pull requests merged",
    icon: GitMerge,
    explanation: "Pull requests you merged.",
    emptyLabel: "No merged pull requests.",
  },
  {
    id: "activity-issues-closed",
    card: "issues-closed",
    title: "Issues closed",
    icon: CircleDot,
    explanation: "Issues you closed.",
    emptyLabel: "No closed issues.",
  },
  {
    id: "activity-releases-published",
    card: "releases-published",
    title: "Releases published",
    icon: Rocket,
    explanation: "Releases your GitHub account created and published.",
    emptyLabel: "No published releases.",
  },
  {
    id: "activity-runs",
    card: "runs",
    title: "Successful runs",
    icon: Activity,
    explanation: "Completed turns and agent runs, always recorded by Octant.",
    emptyLabel: "No successful runs.",
  },
];

interface ActivityCardInput {
  readonly meta: ActivityCardMeta;
  readonly range: ActivityRangeChoice;
  readonly pinned: boolean;
  readonly source: ActivityCardSource;
  readonly read: CodeHomeActivityProps["read"];
  /** Absent when the range could not resolve; the card says so and reads nothing. */
  readonly query: ActivityQuery | undefined;
  /** "Mar 9, 9:30 AM – Mar 16, 9:30 AM", or "Everything recorded" for Total. */
  readonly windowText: string;
}

/**
 * Activity cards carry no `useContent`: they are not drawn by the shared
 * `HomeCard` frame but by `ActivityCard`, so the definition only needs the
 * registry identity plus the input its own component reads.
 */
interface ActivityCardDefinition extends HomeCardIdentity {
  readonly input: ActivityCardInput;
}

function clientTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function localeWeekStartsOn(): number {
  // A calendar week starts where the locale says; a runtime that can read it
  // only through the older `weekInfo` field still answers, and one with
  // neither falls back to Monday rather than an arbitrary day.
  try {
    const language = typeof navigator === "undefined" ? "en-US" : navigator.language;
    const locale = new Intl.Locale(language) as Intl.Locale & {
      getWeekInfo?: () => { readonly firstDay: number };
      weekInfo?: { readonly firstDay: number };
    };
    const first = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    if (typeof first === "number" && Number.isFinite(first)) return first % 7;
  } catch {
    // fall through to the default
  }
  return 1;
}

function contractWindow(window: ResolvedWindow) {
  return {
    from:
      window.startMs === null ? null : decodeUtcTimestamp(new Date(window.startMs).toISOString()),
    until: decodeUtcTimestamp(new Date(window.endMs).toISOString()),
  };
}

function windowLabel(window: ResolvedWindow): string {
  if (window.startMs === null) return "Everything recorded";
  return `${absoluteTimeFormatter.format(new Date(window.startMs))} – ${absoluteTimeFormatter.format(new Date(window.endMs))}`;
}

/** "yesterday", "last week": what the comparison delta is measured against. */
function previousPeriodLabel(range: ActivityRangeChoice): string {
  switch (range.kind) {
    case "today":
      return "yesterday";
    case "last-24-hours":
      return "the previous 24 hours";
    case "yesterday":
      return "the day before";
    case "this-week":
      return "last week";
    case "this-month":
      return "last month";
    case "last-month":
      return "the month before";
    case "this-year":
      return "last year";
    case "total":
      return "before";
    case "custom":
      return "the days before";
  }
}

function sourceName(source: ActivityCardSource): string {
  return source === "github" ? "Your GitHub account" : "Recorded by Octant";
}

function sourceLabel(view: ActivityView): string {
  return sourceName(view.source);
}

function fallbackLabel(view: ActivityView): string | undefined {
  switch (view.fallback) {
    case "no-github-connection":
      return "GitHub is not connected — showing what Octant recorded.";
    case "insecure-github-storage":
      return "GitHub sign-in is not stored safely — showing what Octant recorded.";
    default:
      return undefined;
  }
}

/** The quiet line a card or a page shows when the read could not finish. */
function reasonLabel(view: ActivityView): string {
  switch (view.reason) {
    case "not-recorded":
      return "Not recorded yet.";
    case "not-connected":
      return "Not connected.";
    case "not-checked":
      return "Not checked yet.";
    case "incomplete":
      return "Only part of this history could be read.";
    case "rate-limited":
      return "The source's rate limit was reached.";
    case "read-failed":
      return "Could not be read.";
    case "expired":
      return "This read expired — open it again to retry.";
    case "authorization-changed":
      return "Access changed — open it again to retry.";
    default:
      return view.status === "unavailable"
        ? view.source === "github"
          ? "Octant could not read GitHub."
          : "Octant could not read this activity."
        : "Only part of this history could be read.";
  }
}

interface CardRead {
  readonly phase: "loading" | "refreshing" | "settled";
  readonly view?: ActivityView;
  /** A refresh failed but a previous view is still shown. */
  readonly stale?: boolean;
}

/**
 * The activity section under the Code start screen's list: a shared
 * timeframe, which account or journal the cards read, and up to four cards
 * pinned to a timeframe of their own. Reads happen once per mount, choice
 * change or Refresh — the panel never polls.
 */
export function CodeHomeActivity(props: CodeHomeActivityProps) {
  const activity = props.customization.activity ?? DEFAULT_HOME_ACTIVITY;
  const timeZone = useMemo(() => clientTimeZone(), []);
  const localeWeekStart = useMemo(() => localeWeekStartsOn(), []);
  const weekStartsOn = props.weekStartsOn ?? localeWeekStart;
  const [epoch, setEpoch] = useState(0);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  // One clock snapshot per mount, choices change and explicit refresh: every
  // card resolves against the same "now" so their windows cannot disagree.
  const nowMs = useMemo(() => Date.now(), [activity, epoch]);
  const resolve = useMemo(
    () =>
      (range: ActivityRangeChoice): ActivityRangeResult =>
        resolveActivityRange({ range, nowMs, timeZone, weekStartsOn }),
    [nowMs, timeZone, weekStartsOn],
  );
  // One input per card, memoized so a card's read effect keys on real change
  // — new timeframe, source or account — and not on every render's rebuild.
  const cardInputs = useMemo<ReadonlyArray<ActivityCardInput>>(
    () =>
      ACTIVITY_CARDS.map((meta) => {
        const range = activityRangeForCard(activity, meta.card);
        const resolved = resolve(range);
        const source: ActivityCardSource = meta.card === "runs" ? "octant" : activity.source;
        const query =
          resolved.status === "ready"
            ? ({
                kind: "read",
                card: meta.card,
                source,
                current: contractWindow(resolved.current),
                ...(resolved.comparison === null
                  ? {}
                  : { comparison: contractWindow(resolved.comparison) }),
              } satisfies ActivityQuery)
            : undefined;
        return {
          meta,
          range,
          pinned: activity.pins.some((pin) => pin.card === meta.card),
          source,
          read: props.read,
          query,
          windowText: resolved.status === "ready" ? windowLabel(resolved.current) : "No window",
        };
      }),
    [activity, resolve, props.read],
  );
  const definitions: ReadonlyArray<ActivityCardDefinition> = cardInputs.map((input) => ({
    id: input.meta.id,
    title: input.meta.title,
    icon: input.meta.icon,
    defaultOn: true,
    available: true,
    input,
  }));
  const placements = arrangeHomeCards(definitions, props.customization);
  const writeActivity = (next: HomeActivityCustomization) =>
    props.onCustomizationChange({ ...props.customization, activity: next });
  const grid = placements.filter((placement) => placement.visible);
  const titleId = useId();
  return (
    <section aria-label="Activity" className="code-home-activity">
      <div className="code-home-activity__bar">
        <h2 className="oct-section-label code-home-activity__title" id={titleId}>
          Activity
        </h2>
        <ActivityRangeField
          label="Activity timeframe"
          onChange={(range) => writeActivity({ ...activity, sharedRange: range })}
          resolve={resolve}
          value={activity.sharedRange}
        />
        <IconButton
          icon={RefreshCw}
          label="Refresh activity"
          onClick={() => setEpoch((current) => current + 1)}
        />
        <IconButton
          icon={Ellipsis}
          label="Customize activity"
          onClick={() => setCustomizeOpen(true)}
        />
      </div>
      {grid.length === 0 ? (
        <p className="oct-row-detail code-home-activity__quiet">
          Every activity card is hidden — Customize activity brings one back.
        </p>
      ) : (
        <div className="home-dashboard__grid code-home-activity__grid">
          {grid.map((placement) => (
            <ActivityCard
              definition={placement.definition}
              epoch={epoch}
              key={placement.definition.id}
              onOpenExternal={props.onOpenExternal}
              onOpenThread={props.onOpenThread}
            />
          ))}
        </div>
      )}
      <OctantDialogPresence>
        {customizeOpen ? (
          <ActivityCustomizeDialog
            customization={props.customization}
            definitions={definitions}
            onChange={props.onCustomizationChange}
            onClose={() => setCustomizeOpen(false)}
            onActivityChange={writeActivity}
            placements={placements}
            resolve={resolve}
            settings={activity}
          />
        ) : null}
      </OctantDialogPresence>
    </section>
  );
}

/**
 * The parts of a card read an explicit refresh may hold on to: same card,
 * source and range choice. Any of them moving means the last answer belongs
 * to a different question and must not stay on screen or keep its snapshot
 * pageable.
 */
function activityScopeKey(input: ActivityCardInput): string {
  return JSON.stringify({
    card: input.meta.card,
    range: input.range,
    source: input.source,
  });
}

/** What `ActivityCard` needs from one card's read: the answer plus the drill-down it opened. */
interface ActivityCardView {
  readonly read: CardRead;
  readonly drill: { readonly view: ActivityView } | undefined;
  readonly openRecords: (view: ActivityView) => void;
  readonly closeRecords: () => void;
}

/**
 * One card's read. The read is keyed on the query alone: a reorder, a
 * sibling card's change or a repaint never re-reads, an explicit Refresh
 * does (keeping the last answer on screen), and a changed timeframe or
 * source clears the drill-down with it.
 */
function useActivityCardContent(input: ActivityCardInput, epoch: number): ActivityCardView {
  const [read, setRead] = useState<CardRead>({ phase: "loading" });
  const [drill, setDrill] = useState<{ view: ActivityView } | undefined>(undefined);
  const consumedEpoch = useRef(0);
  const consumedScope = useRef<string | undefined>(undefined);
  const consumedReader = useRef(input.read);
  useEffect(() => {
    const scope = activityScopeKey(input);
    // A rebuilt read client is a new authority: the last answer and its
    // snapshot belong to the old one and must not be retained on refresh.
    const scopeChanged =
      consumedReader.current !== input.read ||
      (consumedScope.current !== undefined && consumedScope.current !== scope);
    consumedScope.current = scope;
    consumedReader.current = input.read;
    const refresh = epoch > consumedEpoch.current;
    consumedEpoch.current = Math.max(consumedEpoch.current, epoch);
    // A scope change — new timeframe, source or host — retires the view and
    // any drill-down it opened; an explicit refresh keeps the last answer up
    // only while it still answers the same scope.
    if (scopeChanged || !refresh) setDrill(undefined);
    if (input.query === undefined) {
      setRead({ phase: "settled" });
      return undefined;
    }
    setRead((previous) =>
      refresh && !scopeChanged && previous.view !== undefined
        ? { phase: "refreshing", view: previous.view }
        : { phase: "loading" },
    );
    const query = refresh ? { ...input.query, refresh: true } : input.query;
    let active = true;
    input.read(query).then(
      (view) => {
        if (!active) return;
        // A fresh answer with no navigable basis — unavailable or a labeled
        // fallback — retires the last snapshot's open records dialog too.
        if (view.status === "unavailable" || view.fallback !== undefined) setDrill(undefined);
        setRead({ phase: "settled", view });
      },
      () => {
        if (!active) return;
        setRead((previous) =>
          previous.view !== undefined
            ? { phase: "settled", view: previous.view, stale: true }
            : { phase: "settled" },
        );
      },
    );
    return () => {
      active = false;
    };
  }, [input, epoch]);
  return {
    read,
    drill,
    openRecords: (view) => setDrill({ view }),
    closeRecords: () => setDrill(undefined),
  };
}

/**
 * One activity card: the icon and title, then its count as the control that
 * opens the records, one context line, and its source — every row always
 * rendered, so a card reads the same shape loading, empty, unavailable or
 * ready.
 */
function ActivityCard(props: {
  readonly definition: ActivityCardDefinition;
  readonly epoch: number;
  readonly onOpenThread: CodeHomeActivityProps["onOpenThread"];
  readonly onOpenExternal: CodeHomeActivityProps["onOpenExternal"];
}) {
  const { definition } = props;
  const input = definition.input;
  const { read, drill, openRecords, closeRecords } = useActivityCardContent(input, props.epoch);
  const titleId = useId();
  const Icon = definition.icon;
  const view = read.view;
  const loading = view === undefined && read.phase === "loading";
  const failed = view === undefined && !loading;
  const unavailable = view !== undefined && view.status === "unavailable";
  const count = view === undefined || unavailable ? 0 : (view.count ?? view.records.length);
  const state = loading
    ? "loading"
    : failed || unavailable
      ? "unavailable"
      : count === 0
        ? "empty"
        : "ready";

  const figure =
    loading || failed || unavailable ? (
      <p className="code-home-activity-card__figure code-home-activity-card__figure--muted">—</p>
    ) : count === 0 ? (
      <p className="code-home-activity-card__figure">0</p>
    ) : view !== undefined && view.snapshotId !== undefined ? (
      <OctantButton
        aria-label={`${definition.title}: ${count}. Show records`}
        className="code-home-activity-card__figure"
        onClick={() => openRecords(view)}
        type="button"
        variant="bare"
      >
        {count}
        <ChevronRight
          aria-hidden="true"
          className="code-home-activity-card__figure-chevron"
          size={16}
        />
      </OctantButton>
    ) : (
      <p className="code-home-activity-card__figure">{count}</p>
    );

  let context: string;
  if (loading) {
    context = "Looking…";
  } else if (view === undefined) {
    context =
      input.query === undefined
        ? "This timeframe could not be resolved."
        : "Octant could not read this activity.";
  } else if (view.status === "unavailable") {
    context = reasonLabel(view);
  } else if (count === 0) {
    context = emptyLabelFor(view, input.range);
  } else if (view.status === "ready" && view.comparisonCount !== undefined) {
    context = comparisonText(count - view.comparisonCount, input.range);
  } else {
    context = activityRangeLabel(input.range);
  }

  const finished = view?.finished;
  const runsLine =
    finished !== undefined && finished.failed + finished.canceled > 0 ? (
      <p className="oct-row-detail code-home-activity-card__context">
        {finished.failed} failed · {finished.canceled} canceled
      </p>
    ) : null;

  let caveat: string | undefined;
  let caveatNeutral = false;
  if (view !== undefined) {
    const fallback = fallbackLabel(view);
    if (fallback !== undefined) {
      caveat = fallback;
      caveatNeutral = true;
    } else if (read.stale === true) {
      caveat =
        view.checkedAt === undefined
          ? "The last refresh failed."
          : `Checked ${relativeTimeLabel(view.checkedAt)} — the last refresh failed.`;
    } else if (view.status === "partial") {
      caveat =
        view.checkedAt === undefined
          ? reasonLabel(view)
          : `${reasonLabel(view)} Checked ${relativeTimeLabel(view.checkedAt)}.`;
    }
  }

  return (
    <OctantCard
      aria-busy={loading}
      aria-labelledby={titleId}
      className="home-card code-home-activity-card outline-0"
      data-card={definition.id}
      data-state={state}
      variant="glass"
    >
      <OctantCardHeader className="home-card__header">
        <Icon aria-hidden="true" className="home-card__icon" size={16} />
        <h2 className="oct-section-label home-card__title" id={titleId}>
          {definition.title}
        </h2>
        {input.pinned ? (
          <span className="oct-meta code-home-activity-card__range">
            {activityRangeLabel(input.range)}
          </span>
        ) : null}
      </OctantCardHeader>
      <OctantCardContent className="home-card__body code-home-activity-card__body">
        {figure}
        <p className="oct-row-detail code-home-activity-card__context">{context}</p>
        {runsLine}
        <p className="oct-meta code-home-activity-card__source">
          {view === undefined ? sourceName(input.source) : sourceName(view.source)}
        </p>
        {caveat === undefined ? null : (
          <p
            className={
              caveatNeutral
                ? "oct-meta code-home-activity-card__note"
                : "oct-row-detail code-home-activity-card__caveat"
            }
          >
            {caveat}
          </p>
        )}
      </OctantCardContent>
      <OctantDialogPresence>
        {drill === undefined ? null : (
          <ActivityRecordsDialog
            input={input}
            onClose={closeRecords}
            onOpenExternal={props.onOpenExternal}
            onOpenThread={props.onOpenThread}
            view={drill.view}
          />
        )}
      </OctantDialogPresence>
    </OctantCard>
  );
}

/** "+7 vs last week", "−2 vs last week" or "Same as last week". */
function comparisonText(delta: number, range: ActivityRangeChoice): string {
  if (delta === 0) return `Same as ${previousPeriodLabel(range)}`;
  return `${delta > 0 ? `+${delta}` : `−${-delta}`} vs ${previousPeriodLabel(range)}`;
}

function emptyLabelFor(view: ActivityView, range: ActivityRangeChoice): string {
  if (view.status === "partial") return "None could be read in this range.";
  switch (view.reason) {
    case "not-recorded":
      return "Nothing is recorded yet.";
    case "not-checked":
      return "Not checked yet.";
    default:
      return `None ${range.kind === "total" ? "yet" : activityRangeLabel(range).toLowerCase()}.`;
  }
}

/** What the drill-down pages: the snapshot the first read froze. */
function ActivityRecordsDialog(props: {
  readonly view: ActivityView;
  readonly input: ActivityCardInput;
  readonly onClose: () => void;
  readonly onOpenThread: CodeHomeActivityProps["onOpenThread"];
  readonly onOpenExternal: CodeHomeActivityProps["onOpenExternal"];
}) {
  const titleId = useId();
  const [records, setRecords] = useState<ReadonlyArray<ActivityRecord>>(props.view.records);
  const [nextOffset, setNextOffset] = useState(props.view.nextOffset);
  const [allFinished, setAllFinished] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | undefined>(undefined);
  const requestId = useRef(0);
  const finished = props.view.finished;

  const load = (offset: number, mode: "filtered" | "all", append: boolean) => {
    const snapshotId = props.view.snapshotId;
    if (snapshotId === undefined) {
      setPageError("This view cannot be paged.");
      return;
    }
    // A slower earlier answer must never publish after a newer request (a
    // mode switch or another page) has started.
    const generation = ++requestId.current;
    setLoading(true);
    setPageError(undefined);
    props.input
      .read({
        kind: "page",
        snapshotId,
        offset,
        ...(mode === "all" ? { allFinished: true } : {}),
      })
      .then(
        (page) => {
          if (generation !== requestId.current) return;
          setLoading(false);
          if (page.status === "unavailable") {
            if (page.reason === "expired" || page.reason === "authorization-changed") {
              // A dead snapshot's rows must not stay navigable.
              setRecords([]);
              setNextOffset(undefined);
            }
            setPageError(reasonLabel(page));
            return;
          }
          setRecords((previous) => (append ? [...previous, ...page.records] : page.records));
          setNextOffset(page.nextOffset);
        },
        () => {
          if (generation !== requestId.current) return;
          setLoading(false);
          setPageError("The page could not be read.");
        },
      );
  };

  return (
    <OctantDialog
      className="code-home-activity-records"
      label={`${props.input.meta.title} records`}
      labelledBy={titleId}
      onClose={props.onClose}
      open
    >
      <div className="octant-dialog__head code-home-activity-records__head">
        <div>
          <h2 className="octant-dialog__title" id={titleId}>
            {props.input.meta.title}
          </h2>
          <p className="oct-meta code-home-activity-records__scope">
            {activityRangeLabel(props.input.range)} · {props.input.windowText} ·{" "}
            {sourceLabel(props.view)}
          </p>
        </div>
        <OctantButton
          aria-label="Close records"
          onClick={props.onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          ×
        </OctantButton>
      </div>
      {props.input.meta.card === "runs" && finished !== undefined ? (
        <div className="code-home-activity-records__finished">
          <p className="oct-meta">
            {finished.successful} successful · {finished.failed} failed · {finished.canceled}{" "}
            canceled
          </p>
          <label className="code-home-activity-records__all-finished">
            {/* The label wraps the switch so its text toggles it; the switch
                already speaks "All finished", so the visible copy stays out of
                the accessible tree to keep the name from doubling. */}
            <span aria-hidden="true" className="oct-row-detail">
              All finished
            </span>
            <OctantSwitch
              checked={allFinished}
              label="All finished"
              onCheckedChange={(next) => {
                setAllFinished(next);
                // The list must never show one mode's rows under the other
                // mode's switch: it clears and refills from the same snapshot.
                setRecords([]);
                setNextOffset(undefined);
                load(0, next ? "all" : "filtered", false);
              }}
            />
          </label>
        </div>
      ) : null}
      {pageError !== undefined ? (
        <OctantAlert className="code-home-activity-records__error" layout="row" tone="warning">
          {pageError}
        </OctantAlert>
      ) : null}
      {records.length === 0 ? (
        pageError === undefined ? (
          <p className="oct-row-detail code-home-activity-records__empty">
            {loading ? "Loading…" : "Nothing in this range."}
          </p>
        ) : null
      ) : (
        <ul aria-label="Records" className="code-home-activity-records__list">
          {records.map((record) => (
            <ActivityRecordRow
              key={`${record.id}:${record.occurredAt}`}
              onOpenExternal={props.onOpenExternal}
              onOpenThread={props.onOpenThread}
              record={record}
            />
          ))}
        </ul>
      )}
      {nextOffset === undefined ? null : (
        <div className="code-home-activity-records__foot">
          <OctantButton
            disabled={loading}
            onClick={() => load(nextOffset, allFinished ? "all" : "filtered", true)}
            size="sm"
            type="button"
            variant="secondary"
          >
            {loading ? "Loading…" : "Load more"}
          </OctantButton>
        </div>
      )}
    </OctantDialog>
  );
}

function ActivityRecordRow(props: {
  readonly record: ActivityRecord;
  readonly onOpenThread: CodeHomeActivityProps["onOpenThread"];
  readonly onOpenExternal: CodeHomeActivityProps["onOpenExternal"];
}) {
  const record = props.record;
  return (
    <li className="code-home-activity-record">
      <span className="code-home-activity-record__head">
        <span className="oct-row-label code-home-activity-record__title">{record.label}</span>
        <span className="code-home-activity-record__nav">{recordActions(record, props)}</span>
      </span>
      <span className="oct-meta code-home-activity-record__meta">
        {absoluteTimeFormatter.format(new Date(record.occurredAt))}
        {recordMeta(record)}
      </span>
    </li>
  );
}

function ExternalLink(props: {
  readonly href: string;
  readonly onOpenExternal: CodeHomeActivityProps["onOpenExternal"];
  readonly children: ReactNode;
}) {
  if (props.onOpenExternal === undefined) {
    return (
      <a
        className={`${octantButtonClassName({ size: "sm", variant: "link" })} code-home-activity-record__link`}
        href={props.href}
        rel="noreferrer"
        target="_blank"
      >
        {props.children}
      </a>
    );
  }
  return (
    <OctantButton
      className="code-home-activity-record__link"
      onClick={() => props.onOpenExternal?.(props.href)}
      size="sm"
      type="button"
      variant="link"
    >
      {props.children}
    </OctantButton>
  );
}

function ThreadLink(props: {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly onOpenThread: CodeHomeActivityProps["onOpenThread"];
}) {
  return (
    <OctantButton
      className="code-home-activity-record__link window-no-drag"
      onClick={() => props.onOpenThread(props.mode, props.threadId)}
      size="sm"
      type="button"
      variant="link"
    >
      Open thread
    </OctantButton>
  );
}

function recordActions(
  record: ActivityRecord,
  props: {
    readonly onOpenThread: CodeHomeActivityProps["onOpenThread"];
    readonly onOpenExternal: CodeHomeActivityProps["onOpenExternal"];
  },
): ReactNode {
  switch (record.kind) {
    case "prs-merged":
      return (
        <>
          <ExternalLink
            href={`https://github.com/${record.repositoryOwner}/${record.repositoryName}/pull/${record.number}`}
            onOpenExternal={props.onOpenExternal}
          >
            {record.repositoryOwner}/{record.repositoryName}#{record.number}
          </ExternalLink>
          {record.threadId === undefined ? null : (
            <ThreadLink
              mode="code"
              onOpenThread={props.onOpenThread}
              threadId={String(record.threadId)}
            />
          )}
        </>
      );
    case "issues-closed":
      return (
        <>
          <ExternalLink
            href={`https://github.com/${record.repositoryOwner}/${record.repositoryName}/issues/${record.number}`}
            onOpenExternal={props.onOpenExternal}
          >
            {record.repositoryOwner}/{record.repositoryName}#{record.number}
          </ExternalLink>
          {record.closingPullRequest === undefined ? null : (
            <ExternalLink
              href={`https://github.com/${record.closingPullRequest.repositoryOwner}/${record.closingPullRequest.repositoryName}/pull/${record.closingPullRequest.number}`}
              onOpenExternal={props.onOpenExternal}
            >
              closed by {record.closingPullRequest.repositoryName}#
              {record.closingPullRequest.number}
            </ExternalLink>
          )}
          {record.threadId === undefined ? null : (
            <ThreadLink
              mode="code"
              onOpenThread={props.onOpenThread}
              threadId={String(record.threadId)}
            />
          )}
        </>
      );
    case "releases-published":
      return (
        <ExternalLink href={record.url} onOpenExternal={props.onOpenExternal}>
          {record.tag}
        </ExternalLink>
      );
    case "runs":
      return (
        <ThreadLink
          mode={record.mode}
          onOpenThread={props.onOpenThread}
          threadId={record.threadId}
        />
      );
  }
}

function recordMeta(record: ActivityRecord): ReactNode {
  if (record.kind !== "runs") return null;
  return (
    <>
      {" · "}
      {record.finish} · run {record.runId}
    </>
  );
}

function ActivityCustomizeDialog(props: {
  readonly settings: HomeActivityCustomization;
  readonly customization: HomeCardCustomization;
  readonly definitions: ReadonlyArray<ActivityCardDefinition>;
  readonly placements: ReadonlyArray<HomeCardPlacement<ActivityCardDefinition>>;
  readonly resolve: (range: ActivityRangeChoice) => ActivityRangeResult;
  readonly onChange: (next: HomeCardCustomization) => void;
  readonly onActivityChange: (next: HomeActivityCustomization) => void;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const settings = props.settings;
  const setPin = (card: ActivityKind, range: ActivityRangeChoice | undefined) => {
    const pins = settings.pins.filter((pin) => pin.card !== card);
    props.onActivityChange({
      ...settings,
      pins: range === undefined ? pins : [...pins, { card, range }],
    });
  };
  return (
    <OctantDialog
      className="code-home-activity-customize"
      label="Customize activity"
      labelledBy={titleId}
      onClose={props.onClose}
      open
    >
      <div className="octant-dialog__head code-home-activity-customize__head">
        <h2 className="octant-dialog__title" id={titleId}>
          Customize activity
        </h2>
        <OctantButton
          aria-label="Close activity customization"
          onClick={props.onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          ×
        </OctantButton>
      </div>
      <div className="code-home-activity-customize__source">
        <span className="oct-row-label code-home-activity-customize__source-label">
          History from
        </span>
        <OctantSelectField
          aria-label="History source"
          className="code-home-activity-customize__source-field"
          onValueChange={(id) => {
            if (id === "github" || id === "octant") {
              props.onActivityChange({ ...settings, source: id });
            }
          }}
          options={[
            { id: "github", label: "Your GitHub account" },
            { id: "octant", label: "Recorded by Octant" },
          ]}
          value={settings.source}
        />
      </div>
      <ul aria-label="Activity cards" className="code-home-activity-customize__list">
        {props.placements.map((placement, index) => {
          const meta = ACTIVITY_CARDS.find((candidate) => candidate.id === placement.definition.id);
          if (meta === undefined) return null;
          const pin = settings.pins.find((candidate) => candidate.card === meta.card);
          const Icon = placement.definition.icon;
          return (
            <li className="code-home-activity-customize__row" key={placement.definition.id}>
              <div className="code-home-activity-customize__rowhead">
                <Icon aria-hidden="true" className="code-home-activity-customize__icon" size={16} />
                <span className="oct-row-label code-home-activity-customize__name">
                  {placement.definition.title}
                </span>
                <span className="code-home-activity-customize__move">
                  <IconButton
                    disabled={index === 0}
                    icon={ChevronUp}
                    label={`Move ${placement.definition.title} up`}
                    onClick={() =>
                      props.onChange(
                        moveHomeCard(
                          props.definitions,
                          props.customization,
                          placement.definition.id,
                          index - 1,
                        ),
                      )
                    }
                  />
                  <IconButton
                    disabled={index === props.placements.length - 1}
                    icon={ChevronDown}
                    label={`Move ${placement.definition.title} down`}
                    onClick={() =>
                      props.onChange(
                        moveHomeCard(
                          props.definitions,
                          props.customization,
                          placement.definition.id,
                          index + 1,
                        ),
                      )
                    }
                  />
                </span>
                <OctantSwitch
                  checked={placement.visible}
                  label={`Show ${placement.definition.title}`}
                  onCheckedChange={(visible) =>
                    props.onChange(
                      setHomeCardVisible(
                        props.definitions,
                        props.customization,
                        placement.definition.id,
                        visible,
                      ),
                    )
                  }
                />
              </div>
              <p className="oct-meta code-home-activity-customize__explanation">
                {meta.explanation}
              </p>
              <div className="code-home-activity-customize__pin">
                {pin === undefined ? (
                  <>
                    <span className="oct-meta">Shared timeframe</span>
                    <IconButton
                      icon={Pin}
                      label={`Pin a timeframe for ${placement.definition.title}`}
                      onClick={() => setPin(meta.card, settings.sharedRange)}
                    />
                  </>
                ) : (
                  <>
                    <ActivityRangeField
                      label={`Timeframe for ${placement.definition.title}`}
                      onChange={(range) => setPin(meta.card, range)}
                      resolve={props.resolve}
                      value={pin.range}
                    />
                    <IconButton
                      icon={PinOff}
                      label={`Use the shared timeframe for ${placement.definition.title}`}
                      onClick={() => setPin(meta.card, undefined)}
                    />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </OctantDialog>
  );
}

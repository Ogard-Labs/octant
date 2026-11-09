import {
  SHUTDOWN_BATCH_MAX,
  type HubMemberId,
  type MovedThreadReference,
  type ProjectId,
  type ShutdownChoice,
  type ShutdownListedMember,
  type ShutdownListing,
  type ShutdownPlacement,
  type ShutdownThreadRow,
  type ThreadMoveThreadStatus,
  type ThreadMoveTiming,
  type ThreadMoveUnlockChallenge,
} from "@octant/contracts";
import type { DesktopOwnerUnlockPort } from "@octant/client-runtime";
import {
  defaultShutdownDestination,
  startingShutdownChoice,
  type MoveEligibility,
} from "@octant/domain";
import { Briefcase, CircleCheck, MessageSquare, SquareCode } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { OctantBadge } from "../../ui/base/OctantBadge";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantDialog } from "../../ui/base/OctantDialog";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import type { ThreadMoveClient } from "./threadMoveClient";

/** How far a running batch has come, for the menu bar while the dialog is hidden. */
export interface ShutdownBatchProgress {
  readonly ended: number;
  readonly total: number;
}

export interface PrepareToShutDownDialogProps {
  readonly open: boolean;
  readonly client: ThreadMoveClient;
  /** This Mac's unlock key; absent outside the desktop app. */
  readonly unlock?: Pick<DesktopOwnerUnlockPort, "ownerUnlockSign">;
  /** Opened from the quit confirmation: the dialog ends with Quit Octant. */
  readonly onQuit?: () => void;
  readonly onOpenHubSettings?: () => void;
  /** Told how far a running batch has come, and `undefined` once none runs. */
  readonly onProgress?: (progress: ShutdownBatchProgress | undefined) => void;
  readonly onClose: () => void;
}

/**
 * What the person set for one row: a choice, and for a move the member it
 * goes to when that is not the head's destination.
 */
interface RowPick {
  readonly choice: ShutdownChoice;
  readonly memberId?: string;
}

const CHOICE_WORDS: Readonly<Record<ShutdownChoice, string>> = {
  move: "Move",
  "move-after-turn": "After this turn",
  "stop-and-move": "Stop and move",
  "hand-over": "Hand over",
  "leave-here": "Leave here",
};

const REASON_WORDS: Readonly<Record<string, string>> = {
  busy: "Busy",
  delegated: "Delegated here",
  "unlock-required": "Not an owner there",
  refused: "Not accepting moves",
  "no-eligible-project": "No matching Project",
  "destination-unreachable": "Offline",
  "transfer-failed": "Didn't arrive",
  "no-matching-provider": "No matching provider",
};

/** A row's menu names another member through an option id of this shape. */
const ELSEWHERE = "elsewhere:";

const POLL_MS = 1_000;

/** How a handover the batch started ended, as its own request answered. */
type HandoverEnd = "handing-over" | "pushed" | "not-pushed" | "refused";

/**
 * Prepare to shut down: every thread here that matters, each on the choice it
 * starts with, one destination for all of them unless a row names another,
 * and one press with one unlock per destination, asked in turn.
 * Canonical: DESIGN.md "Prepare to shut down" and
 * docs/design/hub-and-spokes.md "Prepare to shut down".
 */
export function PrepareToShutDownDialog(props: PrepareToShutDownDialogProps) {
  const titleId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const [listing, setListing] = useState<ShutdownListing | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [destination, setDestination] = useState<string | undefined>(undefined);
  const [picks, setPicks] = useState<ReadonlyMap<string, RowPick>>(new Map());
  // Rows whose choice the person set: a destination change leaves them alone.
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set());
  const [olderOpen, setOlderOpen] = useState(false);
  const [phase, setPhase] = useState<"choosing" | "running">("choosing");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // The threads this batch started moving, each with the member it went to.
  const [chosen, setChosen] = useState<ReadonlyArray<{ thread: MovedThreadReference; to: string }>>(
    [],
  );
  const [handovers, setHandovers] = useState<ReadonlyMap<string, HandoverEnd>>(new Map());
  // Rows set to move that this batch did not start, each with why: shown on
  // the row, and counted as staying here so the screen never says Safe to
  // shut down while one of them is still on this computer.
  const [notStarted, setNotStarted] = useState<ReadonlyMap<string, string>>(new Map());
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ThreadMoveThreadStatus>>(new Map());
  const [working, setWorking] = useState(false);
  // A notice or record older than this batch belongs to an earlier move.
  const [startedAt, setStartedAt] = useState(0);
  // Rows set to move that this batch left out: past one unlock's SHUTDOWN_BATCH_MAX,
  // or bound for a destination whose unlock was declined or refused.
  const [leftOver, setLeftOver] = useState(0);
  // A batch keeps moving on the server while the dialog is hidden, so opening
  // the dialog again shows that batch rather than starting over.
  const batchUnsettled = useRef(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    props.client
      .shutdownListing()
      .then((next) => {
        setListing(next);
        const start = startingDestination(next);
        setDestination(start);
        setPicks(startingPicks(next, start));
        setEdited(new Set());
      })
      .catch(() => setLoadFailed(true));
  }, [props.client]);

  // Focus opens on the primary button so Return accepts the defaults; the
  // list arrives after the dialog opens, so it moves there once rows load.
  useEffect(() => {
    if (listing !== undefined) primary.current?.focus();
  }, [listing]);

  const chooseAgain = useCallback(() => {
    setPhase("choosing");
    setProblem(undefined);
    setStatuses(new Map());
    setChosen([]);
    setHandovers(new Map());
    setNotStarted(new Map());
    setLeftOver(0);
    load();
  }, [load]);

  useEffect(() => {
    if (!props.open || batchUnsettled.current) return;
    chooseAgain();
  }, [props.open, chooseAgain]);

  // Changing the destination re-reads every row the person has not set
  // themselves. Whether a row was set is tracked, never inferred from its
  // value: a Leave here they chose can equal another destination's default.
  const changeDestination = (memberId: string) => {
    if (listing === undefined) return;
    const next = startingPicks(listing, memberId);
    setPicks((current) => {
      const updated = new Map(current);
      for (const row of listing.rows) {
        const id = rowKey(row.thread);
        if (!edited.has(id)) updated.set(id, next.get(id) ?? { choice: "leave-here" });
      }
      return updated;
    });
    setDestination(memberId);
  };
  const choose = (thread: MovedThreadReference, pick: RowPick) => {
    const id = rowKey(thread);
    setPicks((current) => new Map(current).set(id, pick));
    setEdited((current) => new Set(current).add(id));
  };

  const members = listing?.members ?? [];
  const rows = listing?.rows ?? [];
  const listed = rows.filter((row) => !row.older);
  const older = rows.filter((row) => row.older);
  const pickOf = (row: ShutdownThreadRow): RowPick =>
    picks.get(rowKey(row.thread)) ?? { choice: "leave-here" };
  const targetOf = (row: ShutdownThreadRow): string | undefined =>
    pickOf(row).memberId ?? destination;

  // Each destination's rows set to move, the head's first, then the others in roster order.
  const moving = rows.filter((row) => movesAway(pickOf(row).choice));
  const groups = [...members]
    .sort((left, right) =>
      String(left.memberId) === destination ? -1 : String(right.memberId) === destination ? 1 : 0,
    )
    .map((entry) => ({
      member: entry,
      rows: moving.filter((row) => targetOf(row) === String(entry.memberId)),
    }))
    .filter((group) => group.rows.length > 0);
  const batches = groups.map((group) => ({
    member: group.member,
    rows: group.rows.slice(0, SHUTDOWN_BATCH_MAX),
  }));
  const batchCount = batches.reduce((total, batch) => total + batch.rows.length, 0);
  const handingOver = rows.filter((row) => pickOf(row).choice === "hand-over");
  const pressCount = batchCount + handingOver.length;
  const staying = rows.length - moving.length - handingOver.length;
  const overflow = moving.length - batchCount;

  const handOverAll = async (
    handRows: ReadonlyArray<ShutdownThreadRow>,
    notify: string | undefined,
  ) => {
    // One after another: each commits and pushes on this computer's own disk
    // and network. One that is refused or whose request fails stays here, says
    // so on its row and in the alert, and the rest still go.
    for (const row of handRows) {
      let end: HandoverEnd = "refused";
      try {
        // The host-wide shutdown route, as the batch's moves are: this window
        // need not show the thread, and the host hands over only a Code
        // thread the head's destination cannot take.
        if (notify !== undefined) {
          const outcome = await props.client.shutdownHandOver(row.thread, notify);
          if (outcome.status === "handed-over") end = outcome.pushed ? "pushed" : "not-pushed";
        }
      } catch {
        end = "refused";
      }
      setHandovers((current) => new Map(current).set(rowKey(row.thread), end));
      if (end === "refused") {
        const sentence = `${row.title} couldn't be handed over.`;
        setProblem((current) => (current === undefined ? sentence : `${current} ${sentence}`));
      }
    }
  };

  const start = async () => {
    if (pressCount === 0) return;
    if (batches.length > 0 && props.unlock === undefined) return;
    setWorking(true);
    setProblem(undefined);
    const problems: string[] = [];
    const started: Array<{ thread: MovedThreadReference; to: string }> = [];
    const unstarted = new Map<string, string>();
    for (const group of groups) {
      for (const row of group.rows.slice(SHUTDOWN_BATCH_MAX)) {
        unstarted.set(rowKey(row.thread), "Moves next");
      }
    }
    // The server starts the first moves before it answers, so the cutoff
    // that tells this batch's results from an earlier move's is taken now.
    const cutoff = Date.now() - 1_000;
    try {
      // One owner challenge and one Touch ID per destination, asked in turn.
      // A destination whose unlock is declined or refused, or whose request
      // fails outright, moves nothing; the others still move, and its rows
      // count as staying here with the reason on each.
      for (const batch of batches) {
        const name = batch.member.name;
        const threads = batch.rows.map((row) => row.thread);
        let outcome: Awaited<ReturnType<typeof startBatch>>;
        try {
          outcome = await startBatch(batch.member.memberId, batch.rows);
        } catch {
          // The desktop request or the signing failed; this destination is
          // not known to have started anything, so its rows stay here.
          outcome = "not-started";
        }
        if (outcome === "started") {
          const to = String(batch.member.memberId);
          started.push(...threads.map((thread) => ({ thread, to })));
          continue;
        }
        for (const thread of threads) unstarted.set(rowKey(thread), NOT_STARTED_WORDS[outcome]);
        problems.push(
          outcome === "unlock-required"
            ? `This Mac isn't an owner on ${name}. Mark it as an owner there in Settings › Remote access › Hub.`
            : outcome === "destination-unreachable"
              ? `${name} couldn't be reached.`
              : outcome === "declined"
                ? `The move to ${name} wasn't unlocked.`
                : outcome === "refused"
                  ? `${name} doesn't accept moved threads from this computer.`
                  : `The moves to ${name} couldn't start.`,
        );
      }
    } finally {
      setWorking(false);
    }
    const handed = handingOver.map((row) => row.thread);
    if (started.length === 0 && handed.length === 0) {
      setProblem(`${problems.join(" ")} Nothing moved.`);
      return;
    }
    setProblem(problems.length === 0 ? undefined : problems.join(" "));
    setChosen(started);
    setHandovers(new Map(handed.map((thread) => [rowKey(thread), "handing-over" as const])));
    setNotStarted(unstarted);
    setStartedAt(cutoff);
    setLeftOver(unstarted.size);
    batchUnsettled.current = true;
    setPhase("running");
    // A handover tells the head's destination, so it shows under Handovers there.
    if (handingOver.length > 0) void handOverAll(handingOver, destination);
  };

  const startBatch = async (
    memberId: HubMemberId,
    batchRows: ReadonlyArray<ShutdownThreadRow>,
  ): Promise<
    | "started"
    | "declined"
    | "unlock-required"
    | "destination-unreachable"
    | "refused"
    | "not-started"
  > => {
    if (props.unlock === undefined) return "declined";
    const threads = batchRows.map((row) => row.thread);
    const asked = await props.client.shutdownChallenge(String(memberId), threads);
    if (asked.status !== "challenge") return asked.kind;
    const challenge: ThreadMoveUnlockChallenge = asked.challenge;
    const signed = await props.unlock.ownerUnlockSign(challenge);
    if (signed.status !== "done" || signed.signature === undefined) return "declined";
    const started = await props.client.shutdownStart({
      destinationMemberId: memberId,
      rows: batchRows.map((row) => {
        const placement = placementFor(row, String(memberId));
        const project = placement === undefined ? undefined : projectFor(row, placement);
        return {
          thread: row.thread,
          ...(project === undefined ? {} : { destinationProjectId: project }),
          timing: timingOf(pickOf(row).choice),
        };
      }),
      unlock: { challengeId: asked.challenge.challengeId, signature: signed.signature },
    });
    return started.status === "refused" ? "not-started" : "started";
  };

  const moveStates = chosen.map(({ thread, to }) => ({
    to,
    state: settledState(statuses.get(rowKey(thread)), startedAt),
  }));
  const handoverStates = [...handovers.values()];
  const moved = moveStates.filter((entry) => entry.state === "moved");
  const failed =
    moveStates.filter((entry) => entry.state === "failed").length +
    handoverStates.filter((end) => end === "refused").length;
  // A row that ended without moving or a notice to show stays here, and so
  // does a handover whose work reached no other computer.
  const stayed =
    moveStates.filter((entry) => entry.state === "stayed").length +
    handoverStates.filter((end) => end === "not-pushed").length;
  const handedOver = handoverStates.filter((end) => end === "pushed").length;
  const total = chosen.length + handovers.size;
  const ended = moved.length + failed + stayed + handedOver;
  const done = phase === "running" && total > 0 && ended === total;
  const progress = total === 0 ? 0 : Math.round((ended / total) * 100);
  useEffect(() => {
    if (done) batchUnsettled.current = false;
  }, [done]);

  // While the batch runs, each moving thread's state is read until it settles,
  // even while the dialog is hidden, so the menu bar can show the progress.
  useEffect(() => {
    if (phase !== "running" || chosen.length === 0 || done) return;
    let stopped = false;
    const read = async () => {
      const entries = await Promise.all(
        chosen.map(async ({ thread }) => {
          try {
            return [rowKey(thread), await props.client.status(thread)] as const;
          } catch {
            return undefined;
          }
        }),
      );
      if (stopped) return;
      setStatuses(
        new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)),
      );
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [phase, chosen, done, props.client]);
  // A thread set to move that failed, or that waits for the next batch, still stays here.
  const staysHere = failed + stayed + leftOver;

  const reportProgress = props.onProgress;
  useEffect(() => {
    if (reportProgress === undefined) return;
    reportProgress(phase === "running" && !done && total > 0 ? { ended, total } : undefined);
  }, [reportProgress, phase, done, ended, total]);
  // A dialog that goes away mid-batch stops reporting a progress it can no longer read.
  useEffect(() => () => reportProgress?.(undefined), [reportProgress]);

  const movedSentence = (() => {
    const perDestination = members
      .map((entry) => ({
        name: entry.name,
        count: moved.filter((move) => move.to === String(entry.memberId)).length,
      }))
      .filter((entry) => entry.count > 0)
      .map((entry, index) =>
        index === 0
          ? `${String(entry.count)} moved to ${entry.name}`
          : `${String(entry.count)} to ${entry.name}`,
      );
    const parts = perDestination.length === 0 ? ["Nothing moved"] : perDestination;
    if (handedOver > 0) parts.push(`${String(handedOver)} handed over`);
    return `${parts.join(", ")}.`;
  })();

  const summary = (() => {
    if (pressCount === 0) return "Nothing is set to move.";
    if (overflow > 0 && groups.length === 1 && groups[0] !== undefined) {
      return `The first ${String(batchCount)} move to ${groups[0].member.name} now; the other ${String(overflow)} can move next, with one more Touch ID.`;
    }
    const parts = groups.map(
      (group) => `${String(group.rows.length)} move to ${group.member.name}`,
    );
    if (handingOver.length > 0) {
      parts.push(
        handingOver.length === 1 ? "1 hands over" : `${String(handingOver.length)} hand over`,
      );
    }
    // Past one unlock's limit, the rest wait for a further press.
    if (overflow > 0) parts.push(`${String(overflow)} can move next`);
    parts.push(`${String(staying)} stay here`);
    return parts.join(" · ");
  })();

  const primaryLabel =
    batches.length === 0
      ? pressCount === 1
        ? "Hand over 1 thread"
        : `Hand over ${String(pressCount)} threads`
      : batches.length > 1
        ? `Move ${String(pressCount)} threads`
        : pressCount === 1
          ? "Move 1 thread with Touch ID"
          : `Move ${String(pressCount)} threads with Touch ID`;

  const rowView = (row: ShutdownThreadRow) => {
    const id = rowKey(row.thread);
    const moveState = statuses.get(id);
    return (
      <ShutdownRow
        destination={destination}
        handover={handovers.get(id)}
        inBatch={chosen.some((entry) => rowKey(entry.thread) === id)}
        notStarted={notStarted.get(id)}
        key={id}
        members={members}
        onChoose={(pick) => choose(row.thread, pick)}
        phase={phase}
        pick={pickOf(row)}
        row={row}
        startedAt={startedAt}
        status={moveState}
      />
    );
  };

  return (
    <OctantDialog
      className="shutdown-dialog"
      initialFocus={primary}
      label="Prepare to shut down"
      labelledBy={titleId}
      onClose={props.onClose}
      open={props.open}
    >
      <header className="shutdown-dialog__head">
        {done && staysHere === 0 ? (
          <h2 className="shutdown-dialog__title" id={titleId}>
            <CircleCheck aria-hidden="true" size={20} /> Safe to shut down
          </h2>
        ) : done ? (
          <h2 className="shutdown-dialog__title shutdown-dialog__title--warning" id={titleId}>
            {staysHere === 1 ? "1 thread stays" : `${String(staysHere)} threads stay`} on this
            computer
          </h2>
        ) : (
          <h2 className="shutdown-dialog__title" id={titleId}>
            Prepare to shut down
          </h2>
        )}
        <p className="shutdown-dialog__meta">
          {done ? movedSentence : "Move your threads to another computer before this one goes off."}
        </p>
        {phase === "choosing" && members.length > 0 ? (
          <div className="shutdown-dialog__destination">
            <span className="shutdown-dialog__label">Move to</span>
            <OctantSelectField
              aria-label="Move to"
              onValueChange={changeDestination}
              options={members.map((entry) => ({
                id: String(entry.memberId),
                label: `${entry.name} · ${memberWord(entry)}`,
                disabled: !takesAny(listing, entry),
              }))}
              {...(destination === undefined ? {} : { value: destination })}
            />
          </div>
        ) : null}
        {phase === "running" ? (
          <div
            aria-label="Moving threads"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress}
            className="environment-move__bar"
            role="progressbar"
          >
            <span style={{ width: `${String(progress)}%` }} />
          </div>
        ) : null}
      </header>

      <div className="shutdown-dialog__list">
        {listing === undefined && !loadFailed ? (
          <p className="shutdown-dialog__sentence">Looking at this computer's threads…</p>
        ) : loadFailed ? (
          <p className="shutdown-dialog__sentence">
            This computer's threads couldn't be listed.{" "}
            <OctantButton onClick={load} size="sm" variant="link">
              Try again
            </OctantButton>
          </p>
        ) : members.length === 0 ? (
          <div className="shutdown-dialog__sentence">
            <p>Join a hub to move threads between your computers.</p>
            {props.onOpenHubSettings === undefined ? null : (
              <OctantButton onClick={props.onOpenHubSettings} size="sm" variant="outline">
                Set up
              </OctantButton>
            )}
          </div>
        ) : rows.length === 0 ? (
          <p className="shutdown-dialog__sentence">Nothing to move. Safe to shut down.</p>
        ) : (
          <>
            {listed.map(rowView)}
            {older.length === 0 ? null : (
              <details
                className="shutdown-dialog__older"
                onToggle={(event) => setOlderOpen(event.currentTarget.open)}
                open={olderOpen}
              >
                <summary>
                  Older threads <span className="shutdown-dialog__count">{older.length}</span>
                </summary>
                {older.map(rowView)}
              </details>
            )}
          </>
        )}
      </div>

      <footer className="shutdown-dialog__foot">
        {phase === "choosing" && listing !== undefined && rows.length > 0 ? (
          <p aria-live="polite" className="shutdown-dialog__summary">
            {summary}
          </p>
        ) : null}
        {problem === undefined ? null : (
          <p className="shutdown-dialog__problem" role="alert">
            {problem}
          </p>
        )}
        <p aria-live="polite" className="visually-hidden">
          {phase === "running"
            ? done
              ? staysHere === 0
                ? "Safe to shut down."
                : `${String(staysHere)} threads stay on this computer.`
              : `${String(ended)} of ${String(total)} done.`
            : ""}
        </p>
        <div className="shutdown-dialog__buttons">
          {done && leftOver > 0 ? (
            <>
              <OctantButton onClick={props.onClose} variant="ghost">
                Done
              </OctantButton>
              <OctantButton onClick={chooseAgain} ref={primary}>
                {leftOver === 1 ? "Move the last thread" : `Move the other ${String(leftOver)}`}
              </OctantButton>
            </>
          ) : done && props.onQuit !== undefined ? (
            <>
              <OctantButton onClick={props.onClose} variant="ghost">
                Done
              </OctantButton>
              <OctantButton onClick={props.onQuit} ref={primary}>
                {staysHere === 0 ? "Quit Octant" : "Quit anyway"}
              </OctantButton>
            </>
          ) : done || rows.length === 0 || members.length === 0 ? (
            <OctantButton onClick={props.onClose} ref={primary}>
              {done || rows.length === 0 ? "Done" : "Close"}
            </OctantButton>
          ) : phase === "running" ? (
            <OctantButton onClick={props.onClose} variant="ghost">
              Hide
            </OctantButton>
          ) : (
            <>
              <OctantButton onClick={props.onClose} variant="ghost">
                Cancel
              </OctantButton>
              <OctantButton
                disabled={
                  pressCount === 0 || working || (batches.length > 0 && props.unlock === undefined)
                }
                onClick={() => void start()}
                ref={primary}
              >
                {primaryLabel}
              </OctantButton>
            </>
          )}
        </div>
      </footer>
    </OctantDialog>
  );
}

function ShutdownRow(props: {
  readonly row: ShutdownThreadRow;
  readonly members: ReadonlyArray<ShutdownListedMember>;
  readonly destination: string | undefined;
  readonly pick: RowPick;
  readonly phase: "choosing" | "running";
  readonly status: ThreadMoveThreadStatus | undefined;
  readonly handover: HandoverEnd | undefined;
  /** The running batch moves this row; one it left out stays here. */
  readonly inBatch: boolean;
  /** Why this row, set to move, did not start: it stays here. */
  readonly notStarted: string | undefined;
  readonly startedAt: number;
  readonly onChoose: (pick: RowPick) => void;
}) {
  const { row } = props;
  const placement =
    props.destination === undefined ? undefined : placementFor(row, props.destination);
  const start = startFor(row, placement);
  // Another member that can take this row, named in its own menu.
  const elsewhere = props.members.filter(
    (entry) =>
      String(entry.memberId) !== props.destination &&
      placementFor(row, String(entry.memberId))?.reason === undefined,
  );
  const elsewhereLabel = (name: string) =>
    row.busy ? `Move to ${name} after this turn` : `Move to ${name}`;
  const options = [
    ...start.offers.map((offer) => ({ id: offer, label: CHOICE_WORDS[offer] })),
    ...elsewhere.map((entry) => ({
      id: `${ELSEWHERE}${String(entry.memberId)}`,
      label: elsewhereLabel(entry.name),
    })),
  ];
  const named =
    props.pick.memberId !== undefined && props.pick.memberId !== props.destination
      ? props.pick.memberId
      : undefined;
  const value = named === undefined ? props.pick.choice : `${ELSEWHERE}${named}`;
  const Glyph =
    row.thread.mode === "code"
      ? SquareCode
      : row.thread.mode === "work"
        ? Briefcase
        : MessageSquare;
  return (
    <div className="shutdown-row">
      <Glyph aria-hidden="true" className="shutdown-row__glyph" size={14} strokeWidth={1.7} />
      <span className="shutdown-row__title">{row.title}</span>
      {row.projectName === undefined ? null : (
        <span className="shutdown-row__project">{row.projectName}</span>
      )}
      {props.phase === "running" && props.notStarted !== undefined ? (
        <span className="shutdown-row__reason">
          <OctantBadge variant="secondary">{props.notStarted}</OctantBadge>
        </span>
      ) : null}
      {props.phase === "running" ? (
        <span className="shutdown-row__state">
          {props.handover !== undefined
            ? HANDOVER_WORDS[props.handover]
            : props.inBatch
              ? runningWord(props.pick.choice, props.status, props.startedAt)
              : "Stays here"}
        </span>
      ) : (
        <>
          {start.reason === undefined || named !== undefined ? null : (
            <span className="shutdown-row__reason">
              <OctantBadge variant="secondary">
                {REASON_WORDS[start.reason] ?? "Can't move"}
              </OctantBadge>
            </span>
          )}
          <OctantSelectField
            aria-label={`Choice for ${row.title}`}
            className="shutdown-row__choice"
            onValueChange={(picked) => {
              if (picked.startsWith(ELSEWHERE)) {
                const memberId = picked.slice(ELSEWHERE.length);
                if (elsewhere.some((entry) => String(entry.memberId) === memberId)) {
                  props.onChoose({ choice: row.busy ? "move-after-turn" : "move", memberId });
                }
                return;
              }
              const offer = start.offers.find((candidate) => candidate === picked);
              if (offer !== undefined) props.onChoose({ choice: offer });
            }}
            options={options}
            value={value}
          />
        </>
      )}
    </div>
  );
}

/** Why a destination's rows did not start, as each of its rows says it. */
const NOT_STARTED_WORDS: Readonly<
  Record<
    "declined" | "unlock-required" | "destination-unreachable" | "refused" | "not-started",
    string
  >
> = {
  declined: "Not unlocked",
  "unlock-required": "Not an owner there",
  "destination-unreachable": "Offline",
  refused: "Not accepting moves",
  "not-started": "Couldn't start",
};

const HANDOVER_WORDS: Readonly<Record<HandoverEnd, string>> = {
  "handing-over": "Handing over",
  pushed: "Handed over",
  "not-pushed": "Handed over, not pushed",
  refused: "Can't hand over",
};

function movesAway(choice: ShutdownChoice): boolean {
  return choice === "move" || choice === "move-after-turn" || choice === "stop-and-move";
}

function timingOf(choice: ShutdownChoice): ThreadMoveTiming {
  if (choice === "move-after-turn") return "after-turn";
  if (choice === "stop-and-move") return "stop-and-move";
  return "now";
}

function rowKey(thread: MovedThreadReference): string {
  return `${thread.mode}:${thread.threadId}`;
}

function placementFor(row: ShutdownThreadRow, memberId: string): ShutdownPlacement | undefined {
  return row.placements.find((placement) => String(placement.memberId) === memberId);
}

/** The Project a row moves into: the one named like its own, else the first that fits. */
function projectFor(row: ShutdownThreadRow, placement: ShutdownPlacement): ProjectId | undefined {
  const same = placement.projects.find((project) => project.title === row.projectName);
  return (same ?? placement.projects[0])?.projectId;
}

function eligibilityOf(
  row: ShutdownThreadRow,
  placement: ShutdownPlacement | undefined,
): MoveEligibility {
  if (placement === undefined) return { status: "cannot-move", reason: "destination-unreachable" };
  if (placement.reason !== undefined) return { status: "cannot-move", reason: placement.reason };
  return { status: "eligible", projects: [], waitsForTurn: row.busy };
}

function startFor(
  row: ShutdownThreadRow,
  placement: ShutdownPlacement | undefined,
): {
  readonly choice: ShutdownChoice;
  readonly offers: ReadonlyArray<ShutdownChoice>;
  readonly reason?: string;
} {
  const start = startingShutdownChoice({
    mode: row.thread.mode,
    eligibility: eligibilityOf(row, placement),
  });
  // An older thread stays unless the person opens it and chooses otherwise.
  return {
    choice: row.older && start.choice === "move" ? "leave-here" : start.choice,
    offers: start.offers.length === 0 ? ["leave-here"] : start.offers,
    ...(start.reason === undefined ? {} : { reason: start.reason }),
  };
}

function startingPicks(
  listing: ShutdownListing,
  destination: string | undefined,
): ReadonlyMap<string, RowPick> {
  return new Map(
    listing.rows.map((row) => [
      rowKey(row.thread),
      {
        choice: startFor(
          row,
          destination === undefined ? undefined : placementFor(row, destination),
        ).choice,
      },
    ]),
  );
}

function takesAny(listing: ShutdownListing | undefined, member: ShutdownListedMember): boolean {
  return (
    listing?.rows.some((row) => placementFor(row, String(member.memberId))?.reason === undefined) ??
    false
  );
}

function startingDestination(listing: ShutdownListing): string | undefined {
  const chosen = defaultShutdownDestination({
    lastMovedTo: listing.lastMovedTo,
    members: listing.members.map((member) => ({
      memberId: member.memberId,
      role: member.role,
      online: member.reachable,
      takesThreads: takesAny(listing, member),
    })),
  });
  return chosen === undefined
    ? listing.members[0] === undefined
      ? undefined
      : String(listing.members[0].memberId)
    : String(chosen);
}

function memberWord(member: ShutdownListedMember): string {
  if (!member.reachable) return "Offline";
  if (member.refusal === "refused") return "Not accepting moves";
  return "Online";
}

function settledState(
  status: ThreadMoveThreadStatus | undefined,
  startedAt: number,
): "moved" | "failed" | "stayed" | "running" {
  if (status === undefined || status.sending !== undefined || status.waiting !== undefined) {
    return "running";
  }

  if (status.departed !== undefined && Date.parse(status.departed.movedAt) >= startedAt) {
    return "moved";
  }
  if (status.failure !== undefined && Date.parse(status.failure.failedAt) >= startedAt) {
    return "failed";
  }
  // Ended with no departure: Don't move was pressed, or its failure notice was put away.
  if (status.settled !== undefined && Date.parse(status.settled.settledAt) >= startedAt) {
    return "stayed";
  }
  return "running";
}

function runningWord(
  choice: ShutdownChoice,
  status: ThreadMoveThreadStatus | undefined,
  startedAt: number,
): string {
  if (choice === "leave-here") return "Stays here";
  const state = settledState(status, startedAt);
  if (state === "moved") return "Moved";
  if (state === "failed") return "Can't move";
  if (state === "stayed") return "Stays here";
  if (status?.waiting !== undefined) {
    return status.waiting.stopping === true ? "Stopping" : "After this turn";
  }
  if (status?.sending !== undefined) {
    const { bytesSent, bytesTotal } = status.sending;
    const percent = bytesTotal === 0 ? 0 : Math.min(99, Math.floor((bytesSent / bytesTotal) * 100));
    return `Moving ${String(percent)}%`;
  }
  return "Waiting";
}

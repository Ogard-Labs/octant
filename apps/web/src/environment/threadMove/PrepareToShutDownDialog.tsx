import {
  SHUTDOWN_BATCH_MAX,
  type MovedThreadReference,
  type ProjectId,
  type ShutdownChoice,
  type ShutdownListedMember,
  type ShutdownListing,
  type ShutdownPlacement,
  type ShutdownThreadRow,
  type ThreadMoveThreadStatus,
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

export interface PrepareToShutDownDialogProps {
  readonly open: boolean;
  readonly client: ThreadMoveClient;
  /** This Mac's unlock key; absent outside the desktop app. */
  readonly unlock?: Pick<DesktopOwnerUnlockPort, "ownerUnlockSign">;
  /** Opened from the quit confirmation: the dialog ends with Quit Octant. */
  readonly onQuit?: () => void;
  readonly onOpenHubSettings?: () => void;
  readonly onClose: () => void;
}

/** The row choices this release offers; a handover and Stop and move are not built yet. */
type RowChoice = Extract<ShutdownChoice, "move" | "move-after-turn" | "leave-here">;

const CHOICE_WORDS: Readonly<Record<RowChoice, string>> = {
  move: "Move",
  "move-after-turn": "After this turn",
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

const POLL_MS = 1_000;

/**
 * Prepare to shut down: every thread here that matters, each on the choice it
 * starts with, one destination for all of them, and one press with one unlock.
 * Canonical: DESIGN.md "Prepare to shut down" and
 * docs/design/hub-and-spokes.md "Prepare to shut down".
 */
export function PrepareToShutDownDialog(props: PrepareToShutDownDialogProps) {
  const titleId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const [listing, setListing] = useState<ShutdownListing | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [destination, setDestination] = useState<string | undefined>(undefined);
  const [choices, setChoices] = useState<ReadonlyMap<string, RowChoice>>(new Map());
  // Rows whose choice the person set: a destination change leaves them alone.
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set());
  const [olderOpen, setOlderOpen] = useState(false);
  const [phase, setPhase] = useState<"choosing" | "running">("choosing");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<ReadonlyArray<MovedThreadReference>>([]);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ThreadMoveThreadStatus>>(new Map());
  const [working, setWorking] = useState(false);
  // A notice or record older than this batch belongs to an earlier move.
  const [startedAt, setStartedAt] = useState(0);
  // Rows set to move that this batch left out because one unlock moves at most SHUTDOWN_BATCH_MAX.
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
        setChoices(startingChoices(next, start));
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
    const next = startingChoices(listing, memberId);
    setChoices((current) => {
      const updated = new Map(current);
      for (const row of listing.rows) {
        const id = rowKey(row.thread);
        if (!edited.has(id)) updated.set(id, next.get(id) ?? "leave-here");
      }
      return updated;
    });
    setDestination(memberId);
  };
  const choose = (thread: MovedThreadReference, choice: RowChoice) => {
    const id = rowKey(thread);
    setChoices((current) => new Map(current).set(id, choice));
    setEdited((current) => new Set(current).add(id));
  };

  // While the batch runs and the dialog shows, each chosen thread's state is read until it settles.
  useEffect(() => {
    if (!props.open || phase !== "running" || chosen.length === 0) return;
    let stopped = false;
    const read = async () => {
      const entries = await Promise.all(
        chosen.map(async (thread) => {
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
  }, [props.open, phase, chosen, props.client]);

  const members = listing?.members ?? [];
  const member = members.find((entry) => String(entry.memberId) === destination);
  const rows = listing?.rows ?? [];
  const listed = rows.filter((row) => !row.older);
  const older = rows.filter((row) => row.older);
  const moving = rows.filter((row) => {
    const choice = choices.get(rowKey(row.thread));
    return choice === "move" || choice === "move-after-turn";
  });
  const staying = rows.length - moving.length;
  const batch = moving.slice(0, SHUTDOWN_BATCH_MAX);

  const start = async () => {
    if (props.unlock === undefined || member === undefined || batch.length === 0) return;
    setWorking(true);
    setProblem(undefined);
    try {
      const threads = batch.map((row) => row.thread);
      const asked = await props.client.shutdownChallenge(String(member.memberId), threads);
      if (asked.status !== "challenge") {
        setProblem(
          asked.kind === "unlock-required"
            ? `This Mac isn't an owner on ${member.name}. Mark it as an owner there in Settings › Remote access › Hub.`
            : asked.kind === "destination-unreachable"
              ? `${member.name} couldn't be reached.`
              : `${member.name} doesn't accept moved threads from this computer.`,
        );
        return;
      }
      const challenge: ThreadMoveUnlockChallenge = asked.challenge;
      const signed = await props.unlock.ownerUnlockSign(challenge);
      if (signed.status !== "done" || signed.signature === undefined) {
        setProblem("The move wasn't unlocked. Nothing moved.");
        return;
      }
      // The server starts the first moves before it answers, so the cutoff
      // that tells this batch's results from an earlier move's is taken now.
      const cutoff = Date.now() - 1_000;
      const started = await props.client.shutdownStart({
        destinationMemberId: member.memberId,
        rows: batch.map((row) => {
          const placement = placementFor(row, String(member.memberId));
          const project = placement === undefined ? undefined : projectFor(row, placement);
          return {
            thread: row.thread,
            ...(project === undefined ? {} : { destinationProjectId: project }),
            timing: choices.get(rowKey(row.thread)) === "move-after-turn" ? "after-turn" : "now",
          };
        }),
        unlock: { challengeId: asked.challenge.challengeId, signature: signed.signature },
      });
      if (started.status === "refused") {
        setProblem("The batch couldn't start. Nothing moved.");
        return;
      }
      setChosen(threads);
      setStartedAt(cutoff);
      setLeftOver(moving.length - batch.length);
      batchUnsettled.current = true;
      setPhase("running");
    } catch {
      setProblem("This computer could not start the moves.");
    } finally {
      setWorking(false);
    }
  };

  const settled = chosen.map((thread) => settledState(statuses.get(rowKey(thread)), startedAt));
  const moved = settled.filter((state) => state === "moved").length;
  const failed = settled.filter((state) => state === "failed").length;
  // A row that ended without moving or a notice to show stays here.
  const stayed = settled.filter((state) => state === "stayed").length;
  const ended = moved + failed + stayed;
  const done = phase === "running" && chosen.length > 0 && ended === chosen.length;
  const progress = chosen.length === 0 ? 0 : Math.round((ended / chosen.length) * 100);
  useEffect(() => {
    if (done) batchUnsettled.current = false;
  }, [done]);
  // A thread set to move that failed, or that waits for the next batch, still stays here.
  const staysHere = failed + stayed + leftOver;

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
          {done
            ? `${String(moved)} moved to ${member?.name ?? "another computer"}.`
            : "Move your threads to another computer before this one goes off."}
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
            {listed.map((row) => (
              <ShutdownRow
                choice={choices.get(rowKey(row.thread)) ?? "leave-here"}
                destination={destination}
                key={rowKey(row.thread)}
                onChoose={(choice) => choose(row.thread, choice)}
                phase={phase}
                row={row}
                startedAt={startedAt}
                status={statuses.get(rowKey(row.thread))}
              />
            ))}
            {older.length === 0 ? null : (
              <details
                className="shutdown-dialog__older"
                onToggle={(event) => setOlderOpen(event.currentTarget.open)}
                open={olderOpen}
              >
                <summary>
                  Older threads <span className="shutdown-dialog__count">{older.length}</span>
                </summary>
                {older.map((row) => (
                  <ShutdownRow
                    choice={choices.get(rowKey(row.thread)) ?? "leave-here"}
                    destination={destination}
                    key={rowKey(row.thread)}
                    onChoose={(choice) => choose(row.thread, choice)}
                    phase={phase}
                    row={row}
                    startedAt={startedAt}
                    status={statuses.get(rowKey(row.thread))}
                  />
                ))}
              </details>
            )}
          </>
        )}
      </div>

      <footer className="shutdown-dialog__foot">
        {phase === "choosing" && listing !== undefined && rows.length > 0 ? (
          <p aria-live="polite" className="shutdown-dialog__summary">
            {moving.length === 0
              ? "Nothing is set to move."
              : moving.length > batch.length
                ? `The first ${String(batch.length)} move to ${member?.name ?? "another computer"} now; the other ${String(moving.length - batch.length)} can move next, with one more Touch ID.`
                : `${String(moving.length)} move to ${member?.name ?? "another computer"} · ${String(staying)} stay here`}
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
              : `${String(moved)} of ${String(chosen.length)} moved.`
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
                disabled={props.unlock === undefined || batch.length === 0 || working}
                onClick={() => void start()}
                ref={primary}
              >
                {batch.length === 1
                  ? "Move 1 thread with Touch ID"
                  : `Move ${String(batch.length)} threads with Touch ID`}
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
  readonly destination: string | undefined;
  readonly choice: RowChoice;
  readonly phase: "choosing" | "running";
  readonly status: ThreadMoveThreadStatus | undefined;
  readonly startedAt: number;
  readonly onChoose: (choice: RowChoice) => void;
}) {
  const { row } = props;
  const placement =
    props.destination === undefined ? undefined : placementFor(row, props.destination);
  const start = startFor(row, placement);
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
      {props.phase === "running" ? (
        <span className="shutdown-row__state">
          {runningWord(props.choice, props.status, props.startedAt)}
        </span>
      ) : (
        <>
          {start.reason === undefined ? null : (
            <span className="shutdown-row__reason">
              <OctantBadge variant="secondary">
                {REASON_WORDS[start.reason] ?? "Can't move"}
              </OctantBadge>
            </span>
          )}
          <OctantSelectField
            aria-label={`Choice for ${row.title}`}
            className="shutdown-row__choice"
            onValueChange={(value) => {
              const picked = start.offers.find((offer) => offer === value);
              if (picked !== undefined) props.onChoose(picked);
            }}
            options={start.offers.map((offer) => ({ id: offer, label: CHOICE_WORDS[offer] }))}
            value={props.choice}
          />
        </>
      )}
    </div>
  );
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
  readonly choice: RowChoice;
  readonly offers: ReadonlyArray<RowChoice>;
  readonly reason?: string;
} {
  const start = startingShutdownChoice({
    mode: row.thread.mode,
    eligibility: eligibilityOf(row, placement),
  });
  const offers = start.offers.filter(
    (offer): offer is RowChoice =>
      offer === "move" || offer === "move-after-turn" || offer === "leave-here",
  );
  const choice: RowChoice =
    start.choice === "move" || start.choice === "move-after-turn" ? start.choice : "leave-here";
  // An older thread stays unless the person opens it and chooses otherwise.
  return {
    choice: row.older && choice === "move" ? "leave-here" : choice,
    offers: offers.length === 0 ? ["leave-here"] : offers,
    ...(start.reason === undefined ? {} : { reason: start.reason }),
  };
}

function startingChoices(
  listing: ShutdownListing,
  destination: string | undefined,
): ReadonlyMap<string, RowChoice> {
  return new Map(
    listing.rows.map((row) => [
      rowKey(row.thread),
      startFor(row, destination === undefined ? undefined : placementFor(row, destination)).choice,
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
  choice: RowChoice,
  status: ThreadMoveThreadStatus | undefined,
  startedAt: number,
): string {
  if (choice === "leave-here") return "Stays here";
  const state = settledState(status, startedAt);
  if (state === "moved") return "Moved";
  if (state === "failed") return "Can't move";
  if (state === "stayed") return "Stays here";
  if (status?.waiting !== undefined) return "After this turn";
  if (status?.sending !== undefined) {
    const { bytesSent, bytesTotal } = status.sending;
    const percent = bytesTotal === 0 ? 0 : Math.min(99, Math.floor((bytesSent / bytesTotal) * 100));
    return `Moving ${String(percent)}%`;
  }
  return "Waiting";
}

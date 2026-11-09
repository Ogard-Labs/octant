import {
  ProjectId,
  type MovedThreadReference,
  type ThreadMoveDestination,
  type ThreadMoveDestinations,
  type ThreadMoveFailureReason,
  type ThreadMoveThreadStatus,
  type ThreadMoveUnlockChallenge,
  type HandoverOutcome,
} from "@octant/contracts";
import { Schema } from "effect";
import type { DesktopOwnerUnlockPort } from "@octant/client-runtime";
import { ArrowRight, ChevronRight, Laptop, Server } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantBadge } from "../../ui/base/OctantBadge";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantDialog } from "../../ui/base/OctantDialog";
import { OctantSelectField } from "../../ui/base/OctantSelect";
import { OctantSwitch } from "../../ui/base/OctantSwitch";
import { EnvironmentCard, EnvironmentTile } from "../EnvironmentGroup";
import type { ThreadMoveClient } from "./threadMoveClient";
import { useThreadMove } from "./useThreadMove";

export interface ThreadMoveComputerCardProps {
  readonly thread: MovedThreadReference;
  readonly threadTitle: string;
  /** The name of the host the thread runs on, as the window lists it. */
  readonly hostName: string;
  /** Whether that host is the computer this window runs on. */
  readonly isThisComputer: boolean;
  /**
   * The move routes; absent when the window shows another host's thread or
   * is not a local desktop window, which shows where the thread runs and no
   * move.
   */
  readonly client?: ThreadMoveClient;
  /** This Mac's unlock key; absent outside the desktop app. */
  readonly unlock?: Pick<DesktopOwnerUnlockPort, "ownerUnlockSign">;
  /** Opens Settings › Remote access › Hub, for a host that is in no hub. */
  readonly onOpenHubSettings?: () => void;
}

/** What a thread's Environment needs to show its Computer card, beyond the thread itself. */
export type ThreadMoveEnvironment = Omit<ThreadMoveComputerCardProps, "thread" | "threadTitle">;

/**
 * The Computer card at the top of a thread's Environment: where the thread
 * runs, and the one place a person moves it to another of their computers.
 * Canonical: DESIGN.md "Moving a thread starts in Environment and nowhere
 * else in the thread" and docs/design/hub-and-spokes.md.
 */
export function ThreadMoveComputerCard(props: ThreadMoveComputerCardProps) {
  if (props.client === undefined) {
    return (
      <EnvironmentCard caption="Computer">
        <div className="environment-move__row environment-move__row--static">
          <EnvironmentTile icon={Laptop} />
          <span className="environment-move__name">{props.hostName}</span>
          <OctantBadge variant="secondary">
            {props.isThisComputer ? "This computer" : props.hostName}
          </OctantBadge>
        </div>
      </EnvironmentCard>
    );
  }
  return <MovableComputerCard {...props} client={props.client} />;
}

function MovableComputerCard(props: ThreadMoveComputerCardProps & { client: ThreadMoveClient }) {
  const move = useThreadMove(props.client, props.thread);
  const [open, setOpen] = useState(false);
  const [chosenMember, setChosenMember] = useState<string | undefined>(undefined);
  const [chosenProject, setChosenProject] = useState<string | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const canHandOver = props.thread.mode === "code";
  const [takeBackOffered, setTakeBackOffered] = useState(false);
  const contentId = useId();
  const status = move.status;
  const live = useLiveAnnouncement(status);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && move.destinations === undefined && !move.destinationsLoading) {
      move.loadDestinations();
    }
  };

  const destinations = useMemo(
    () =>
      [...(move.destinations?.destinations ?? [])].sort(
        (left, right) => Number(eligible(right)) - Number(eligible(left)),
      ),
    [move.destinations],
  );
  const member = destinations.find((entry) => String(entry.memberId) === chosenMember);
  const projectChoices = member === undefined ? [] : projectOptions(member);
  // One fitting Project is chosen for the person.
  const project =
    chosenProject ?? (projectChoices.length === 1 ? projectChoices[0]?.id : undefined);
  const ready = member !== undefined && eligible(member) && project !== undefined;

  const pill = computerPill(status);

  return (
    <>
      <EnvironmentCard caption="Computer">
        <div className="environment-move">
          <OctantButton
            aria-controls={contentId}
            aria-expanded={open}
            className="environment-move__row window-no-drag"
            onClick={toggle}
            type="button"
            variant="bare"
          >
            <EnvironmentTile icon={Laptop} />
            <span className="environment-move__name">{props.hostName}</span>
            <OctantBadge variant={pill.tone}>{pill.label}</OctantBadge>
            <ChevronRight
              aria-hidden="true"
              className="environment-group__chevron"
              size={14}
              strokeWidth={1.8}
            />
          </OctantButton>
          {open ? (
            <div className="environment-move__content" id={contentId}>
              <MoveProgress
                client={props.client}
                onChanged={move.refresh}
                onTakeBackOffered={setTakeBackOffered}
                status={status}
                takeBackOffered={takeBackOffered}
                thread={props.thread}
              />
              {/* A thread that is moving, waiting for its turn, still
                  arriving here, or handed over is held, so it offers no
                  other move. */}
              {status?.sending !== undefined ||
              status?.waiting !== undefined ||
              status?.arriving !== undefined ||
              status?.handedOver !== undefined ? null : (
                <DestinationPicker
                  mode={props.thread.mode}
                  chosenMember={chosenMember}
                  destinations={destinations}
                  loading={move.destinationsLoading}
                  failed={move.destinationsFailed}
                  listing={move.destinations}
                  onChooseMember={(memberId) => {
                    setChosenMember(memberId);
                    setChosenProject(undefined);
                  }}
                  onChooseProject={setChosenProject}
                  onOpenHubSettings={props.onOpenHubSettings}
                  onRetry={move.loadDestinations}
                  onReview={() => setSheetOpen(true)}
                  project={project}
                  projectChoices={projectChoices}
                  ready={ready}
                />
              )}
            </div>
          ) : null}
        </div>
      </EnvironmentCard>
      {status?.failure === undefined ? null : (
        <OctantAlert
          action={
            <span className="environment-move__actions">
              <OctantButton
                onClick={() => {
                  setOpen(true);
                  if (move.destinations === undefined) move.loadDestinations();
                }}
                size="sm"
                variant="outline"
              >
                Choose another computer
              </OctantButton>
              {canHandOver ? (
                <OctantButton onClick={() => setHandoverOpen(true)} size="sm" variant="outline">
                  Hand over instead
                </OctantButton>
              ) : null}
              <OctantButton
                onClick={() => {
                  void props.client.dismiss(props.thread).finally(move.refresh);
                }}
                size="sm"
                variant="ghost"
              >
                Dismiss
              </OctantButton>
            </span>
          }
          title="This thread can't move"
          tone="warning"
        >
          {FAILURE_SENTENCES[status.failure.reason]}
        </OctantAlert>
      )}
      {status?.arriving === undefined ? null : (
        <ArrivingNotice arriving={status.arriving} client={props.client} onChanged={move.refresh} />
      )}
      {status?.departed === undefined ? null : <MovedNotice departed={status.departed} />}
      {status?.handedOver === undefined ? null : (
        <HandedOverNotice
          handedOver={status.handedOver}
          onTakeBack={() =>
            void props.client
              .handoverTakeBack(String(status.handedOver?.handoverId))
              .finally(move.refresh)
          }
        />
      )}
      {handoverOpen ? (
        <HandoverSheet
          {...(member === undefined || !eligible(member)
            ? {}
            : { destination: { memberId: String(member.memberId), name: member.name } })}
          client={props.client}
          onClose={() => setHandoverOpen(false)}
          onHandedOver={() => {
            setHandoverOpen(false);
            move.refresh();
          }}
          thread={props.thread}
          threadTitle={props.threadTitle}
        />
      ) : null}
      <p aria-live="polite" className="visually-hidden">
        {live}
      </p>
      {member === undefined || !sheetOpen ? null : (
        <ThreadMoveSheet
          busy={move.destinations?.busy === true}
          client={props.client}
          hostName={props.hostName}
          member={member}
          onClose={() => setSheetOpen(false)}
          onStarted={() => {
            setSheetOpen(false);
            move.refresh();
          }}
          {...(canHandOver
            ? {
                onHandOver: () => {
                  setSheetOpen(false);
                  setHandoverOpen(true);
                },
              }
            : {})}
          projectTitle={projectChoices.find((choice) => choice.id === project)?.label}
          projectId={project === NO_PROJECT ? undefined : project}
          thread={props.thread}
          threadTitle={props.threadTitle}
          unlock={props.unlock}
        />
      )}
    </>
  );
}

const NO_PROJECT = "octant-move:no-project";
const decodeProjectId = Schema.decodeUnknownSync(ProjectId);

function eligible(entry: ThreadMoveDestination): boolean {
  return entry.reachable && entry.refusal === undefined;
}

function projectOptions(
  member: ThreadMoveDestination,
): ReadonlyArray<{ readonly id: string; readonly label: string }> {
  return [
    ...member.projects.map((project) => ({ id: String(project.projectId), label: project.title })),
    ...(member.noProjectAllowed ? [{ id: NO_PROJECT, label: "No Project" }] : []),
  ];
}

/**
 * One word for a member's state. A member that refuses answers every reason
 * (Move in off, Owners off, this computer no longer in its roster) in the same
 * words, so the pill cannot say which; whether this Mac is an owner there is
 * learned at the unlock, and said then.
 */
function memberPill(entry: ThreadMoveDestination, mode: MovedThreadReference["mode"]): string {
  if (!entry.reachable) return "Offline";
  if (entry.refusal === "refused") return "Not accepting moves";
  if (entry.refusal === "no-eligible-project") {
    return mode === "code" ? "No matching repository" : "No matching Project";
  }
  return "Online";
}

function computerPill(status: ThreadMoveThreadStatus | undefined): {
  readonly label: string;
  readonly tone: "secondary" | "warning" | "outline";
} {
  if (status?.sending !== undefined) {
    return { label: `Moving ${String(percent(status.sending))}%`, tone: "outline" };
  }
  if (status?.waiting !== undefined) return { label: "Moves after this turn", tone: "outline" };
  if (status?.arriving !== undefined) return { label: "Arriving", tone: "outline" };
  if (status?.handedOver !== undefined) return { label: "Handed over", tone: "outline" };
  if (status?.failure !== undefined) return { label: "Can't move", tone: "warning" };
  return { label: "This computer", tone: "secondary" };
}

function percent(sending: NonNullable<ThreadMoveThreadStatus["sending"]>): number {
  if (sending.state === "arrived" || sending.state === "committed") return 100;
  if (sending.bytesTotal === 0) return 0;
  return Math.min(99, Math.floor((sending.bytesSent / sending.bytesTotal) * 100));
}

/** One sentence per reason, in the words the design gives each. */
const FAILURE_SENTENCES: Readonly<Record<ThreadMoveFailureReason, string>> = {
  busy: "A turn is running or the thread is waiting on you. Try again when it finishes.",
  delegated: "Another computer delegated this thread here, so it stays with that delegation.",
  "unlock-required":
    "The move wasn't unlocked, or this Mac isn't an owner on that computer. Mark it as an owner there in Settings › Remote access › Hub.",
  refused: "That computer doesn't accept moved threads from this one.",
  "no-eligible-project": "That computer has no Project this thread can move into.",
  "destination-unreachable": "That computer couldn't be reached.",
  "transfer-failed": "Part of the thread didn't arrive intact.",
  "no-matching-provider":
    "That computer has no provider of the kind this thread runs on, so it can't continue it.",
};

function DestinationPicker(props: {
  readonly mode: MovedThreadReference["mode"];
  readonly listing: ThreadMoveDestinations | undefined;
  readonly destinations: ReadonlyArray<ThreadMoveDestination>;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly chosenMember: string | undefined;
  readonly projectChoices: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly project: string | undefined;
  readonly ready: boolean;
  readonly onChooseMember: (memberId: string) => void;
  readonly onChooseProject: (projectId: string) => void;
  readonly onReview: () => void;
  readonly onRetry: () => void;
  readonly onOpenHubSettings: (() => void) | undefined;
}) {
  const labelId = useId();
  if (props.loading && props.listing === undefined) {
    return <p className="environment-move__sentence">Looking for your other computers…</p>;
  }
  if (props.failed) {
    return (
      <p className="environment-move__sentence">
        Your other computers couldn't be listed.{" "}
        <OctantButton onClick={props.onRetry} size="sm" variant="link">
          Try again
        </OctantButton>
      </p>
    );
  }
  if (props.listing?.blocked === "delegated") {
    return (
      <p className="environment-move__sentence">
        Another computer delegated this thread here, so it stays with that delegation.
      </p>
    );
  }
  if (props.listing !== undefined && props.destinations.length === 0) {
    return (
      <div className="environment-move__sentence">
        <p>Join a hub to move threads between your computers.</p>
        {props.onOpenHubSettings === undefined ? null : (
          <OctantButton onClick={props.onOpenHubSettings} size="sm" variant="outline">
            Set up
          </OctantButton>
        )}
      </div>
    );
  }
  return (
    <div className="environment-move__picker">
      <p className="environment-move__label" id={labelId}>
        Move to
      </p>
      <div aria-labelledby={labelId} className="environment-move__members" role="radiogroup">
        {props.destinations.map((entry) => {
          const chosen = String(entry.memberId) === props.chosenMember;
          return (
            <div key={String(entry.memberId)}>
              <OctantButton
                aria-checked={chosen}
                className="environment-move__member window-no-drag"
                disabled={!eligible(entry)}
                onClick={() => props.onChooseMember(String(entry.memberId))}
                role="radio"
                type="button"
                variant="bare"
              >
                <EnvironmentTile icon={entry.role === "hub" ? Server : Laptop} />
                <span className="environment-move__name">{entry.name}</span>
                <OctantBadge variant={eligible(entry) ? "success" : "secondary"}>
                  {memberPill(entry, props.mode)}
                </OctantBadge>
              </OctantButton>
              {chosen && props.projectChoices.length > 1 ? (
                <OctantSelectField
                  aria-label={`Project on ${entry.name}`}
                  className="environment-move__project"
                  onValueChange={props.onChooseProject}
                  options={props.projectChoices}
                  placeholder="Choose a Project"
                  // Nothing is chosen until the person picks: a picker that
                  // showed its first Project as chosen left Review move off.
                  value={props.project ?? ""}
                />
              ) : chosen && props.projectChoices.length === 1 ? (
                <p className="environment-move__project-line">
                  Into {props.projectChoices[0]?.label}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <OctantButton
        className="environment-move__review"
        disabled={!props.ready}
        onClick={props.onReview}
        variant="secondary"
      >
        Review move
      </OctantButton>
    </div>
  );
}

function MoveProgress(props: {
  readonly client: ThreadMoveClient;
  readonly thread: MovedThreadReference;
  readonly status: ThreadMoveThreadStatus | undefined;
  readonly takeBackOffered: boolean;
  readonly onTakeBackOffered: (offered: boolean) => void;
  readonly onChanged: () => void;
}) {
  const [working, setWorking] = useState(false);
  const sending = props.status?.sending;
  const waiting = props.status?.waiting;
  if (waiting !== undefined) {
    return (
      <div className="environment-move__progress">
        <p className="environment-move__sentence">
          Moves to {waiting.destinationName} when this turn ends.
        </p>
        <OctantButton
          onClick={() => void props.client.stopWaiting(props.thread).finally(props.onChanged)}
          size="sm"
          variant="outline"
        >
          Don't move
        </OctantButton>
      </div>
    );
  }
  if (sending === undefined) return null;
  const value = percent(sending);
  return (
    <div className="environment-move__progress">
      <div
        aria-label={`Moving to ${sending.destinationName}`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={value}
        className="environment-move__bar"
        role="progressbar"
      >
        <span style={{ width: `${String(value)}%` }} />
      </div>
      <p className="environment-move__sentence">
        Moving to {sending.destinationName}
        <span className="environment-move__figures">
          {" "}
          {formatBytes(sending.bytesSent)} of {formatBytes(sending.bytesTotal)}
        </span>
      </p>
      {props.takeBackOffered ? (
        <div className="environment-move__sentence">
          <p>
            {sending.destinationName} can't be reached to confirm. Take it back here and that
            computer may still hold a copy.
          </p>
          <OctantButton
            disabled={working}
            onClick={() => {
              setWorking(true);
              void props.client.takeBack(String(sending.moveId)).finally(() => {
                setWorking(false);
                props.onTakeBackOffered(false);
                props.onChanged();
              });
            }}
            size="sm"
            variant="outline"
          >
            Take back here
          </OctantButton>
        </div>
      ) : (
        <OctantButton
          disabled={working || sending.state === "committed"}
          onClick={() => {
            setWorking(true);
            void props.client
              .cancel(String(sending.moveId))
              .then((outcome) => props.onTakeBackOffered(outcome === "destination-unreachable"))
              .finally(() => {
                setWorking(false);
                props.onChanged();
              });
          }}
          size="sm"
          variant="outline"
        >
          Cancel move
        </OctantButton>
      )}
    </div>
  );
}

function ArrivingNotice(props: {
  readonly arriving: NonNullable<ThreadMoveThreadStatus["arriving"]>;
  readonly client: ThreadMoveClient;
  readonly onChanged: () => void;
}) {
  const [working, setWorking] = useState(false);
  return (
    <OctantAlert
      {...(props.arriving.mayActivateAnyway
        ? {
            action: (
              <OctantButton
                disabled={working}
                onClick={() => {
                  setWorking(true);
                  void props.client.activate(String(props.arriving.moveId)).finally(() => {
                    setWorking(false);
                    props.onChanged();
                  });
                }}
                size="sm"
                variant="outline"
              >
                Activate anyway
              </OctantButton>
            ),
          }
        : {})}
      title={`Arriving from ${props.arriving.originName}`}
      tone="neutral"
    >
      {props.arriving.mayActivateAnyway
        ? `${props.arriving.originName} froze this thread before it went away, so it can't have gone on there.`
        : `This thread opens here once ${props.arriving.originName} confirms the move.`}
    </OctantAlert>
  );
}

function MovedNotice(props: {
  readonly departed: NonNullable<ThreadMoveThreadStatus["departed"]>;
}) {
  const time = new Date(props.departed.movedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const leftBehind = props.departed.partsLeftBehind ?? [];
  const leftBehindCount = props.departed.partsLeftBehindCount ?? leftBehind.length;
  const unnamed = leftBehindCount - leftBehind.length;
  return (
    <OctantAlert title={`Moved to ${props.departed.destinationName}`} tone="neutral">
      Moved at {time}.
      {props.departed.keptWorktree === undefined
        ? props.departed.changesRemainInCheckout
          ? " Its changes also remain in this Project's checkout."
          : null
        : ` Its worktree held files that stayed here, so it was kept at ${props.departed.keptWorktree}.`}
      {leftBehindCount === 0
        ? null
        : ` ${leftBehindCount === 1 ? "1 part" : `${leftBehindCount} parts`} could not be read here, so ${leftBehindCount === 1 ? "it" : "they"} did not move: ${leftBehind.map((part) => part.name).join(", ")}${unnamed > 0 ? `, and ${unnamed} more` : ""}.`}
    </OctantAlert>
  );
}

function ThreadMoveSheet(props: {
  readonly thread: MovedThreadReference;
  readonly threadTitle: string;
  readonly hostName: string;
  readonly member: ThreadMoveDestination;
  readonly projectId: string | undefined;
  readonly projectTitle: string | undefined;
  readonly busy: boolean;
  readonly client: ThreadMoveClient;
  readonly unlock: Pick<DesktopOwnerUnlockPort, "ownerUnlockSign"> | undefined;
  readonly onClose: () => void;
  readonly onStarted: () => void;
  /** For a Code thread: Hand over instead, a quiet button at the sheet's start edge. */
  readonly onHandOver?: () => void;
}) {
  const titleId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const { member } = props;

  const moveWithUnlock = async () => {
    if (props.unlock === undefined) return;
    setWorking(true);
    setProblem(undefined);
    try {
      const asked = await props.client.challenge(String(member.memberId));
      if (asked.status !== "challenge") {
        setProblem(challengeProblem(asked.kind, member.name));
        return;
      }
      const challenge: ThreadMoveUnlockChallenge = asked.challenge;
      const signed = await props.unlock.ownerUnlockSign(challenge);
      if (signed.status !== "done" || signed.signature === undefined) {
        setProblem(
          signed.status === "refused" && signed.kind === "cancelled"
            ? "The move wasn't unlocked. Nothing moved."
            : "Touch ID isn't available on this Mac, so the move can't be unlocked here.",
        );
        return;
      }
      const started = await props.client.start({
        thread: props.thread,
        destinationMemberId: member.memberId,
        ...(props.projectId === undefined
          ? {}
          : { destinationProjectId: decodeProjectId(props.projectId) }),
        timing: props.busy ? "after-turn" : "now",
        unlock: { challengeId: asked.challenge.challengeId, signature: signed.signature },
      });
      if (started.status === "refused") {
        setProblem(FAILURE_SENTENCES[started.reason]);
        return;
      }
      props.onStarted();
    } catch {
      setProblem("This computer could not start the move.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <OctantDialog
      className="thread-move-sheet"
      initialFocus={primary}
      label={`Move to ${member.name}`}
      labelledBy={titleId}
      onClose={props.onClose}
      open
    >
      <header className="thread-move-sheet__head">
        <h2 className="thread-move-sheet__title" id={titleId}>
          Move to {member.name}
        </h2>
        <p className="thread-move-sheet__meta">{props.threadTitle}</p>
      </header>
      <p className="thread-move-sheet__route">
        <span className="thread-move-sheet__host">
          <EnvironmentTile icon={Laptop} />
          {props.hostName}
        </span>
        <ArrowRight aria-label="to" size={14} strokeWidth={1.8} />
        <span className="thread-move-sheet__host">
          <EnvironmentTile icon={member.role === "hub" ? Server : Laptop} />
          {member.name}
          {props.projectTitle === undefined || props.projectId === undefined
            ? null
            : ` / ${props.projectTitle}`}
        </span>
      </p>
      <section className="thread-move-sheet__section">
        <h3 className="thread-move-sheet__heading">What moves</h3>
        <ul className="thread-move-sheet__list">
          <li>The conversation</li>
          <li>Its attachments, generated images, Browser captures, and Canvases</li>
          {props.thread.mode === "code" ? (
            <li>The branch, its unpushed commits, and the staged and unstaged changes</li>
          ) : null}
          {props.thread.mode === "work" ? (
            <li>Only the thread: the files in its folder stay on this computer</li>
          ) : null}
        </ul>
      </section>
      <details className="thread-move-sheet__section">
        <summary className="thread-move-sheet__heading">Stays here</summary>
        <ul className="thread-move-sheet__list">
          <li>Sign-ins and the provider's own session</li>
          <li>Full access and remembered approvals</li>
          <li>Running terminals, previews, and Browser pages</li>
          {props.thread.mode === "code" ? (
            <li>
              Ignored files, such as build output and .env files, and any file holding a secret
            </li>
          ) : null}
        </ul>
      </details>
      <p className="thread-move-sheet__consequence">
        This thread is erased from this computer once {member.name} has it.
        {props.busy ? " A turn is running, so it moves when the turn ends." : ""}
      </p>
      {problem === undefined ? null : (
        <OctantAlert title="This thread can't move" tone="warning">
          {problem}
        </OctantAlert>
      )}
      {props.unlock === undefined ? (
        <p className="thread-move-sheet__consequence">
          A move is unlocked with Touch ID in the Octant app on this Mac.
        </p>
      ) : null}
      <footer className="thread-move-sheet__foot">
        {props.onHandOver === undefined ? null : (
          <OctantButton
            className="thread-move-sheet__aside"
            onClick={props.onHandOver}
            variant="link"
          >
            Hand over instead
          </OctantButton>
        )}
        <OctantButton onClick={props.onClose} variant="ghost">
          Cancel
        </OctantButton>
        <OctantButton
          disabled={props.unlock === undefined || working}
          onClick={() => void moveWithUnlock()}
          ref={primary}
        >
          {props.busy ? "Move after this turn with Touch ID" : "Move with Touch ID"}
        </OctantButton>
      </footer>
    </OctantDialog>
  );
}

function HandedOverNotice(props: {
  readonly handedOver: NonNullable<ThreadMoveThreadStatus["handedOver"]>;
  readonly onTakeBack: () => void;
}) {
  const { handedOver } = props;
  return (
    <OctantAlert
      action={
        <OctantButton onClick={props.onTakeBack} size="sm" variant="outline">
          Take back here
        </OctantButton>
      }
      title="Handed over"
      tone={handedOver.pushed ? "neutral" : "warning"}
    >
      {handedOver.pushed
        ? `The work is committed and pushed on ${handedOver.branch}. Continue it on any computer that can fetch that branch.`
        : handedOver.shortfall === "no-remote"
          ? `The work is committed on ${handedOver.branch}, but the branch has no remote, so it is on no other computer yet.`
          : `The work is committed on ${handedOver.branch}, but the push failed, so it is on no other computer yet.`}
      {handedOver.refusedFiles.length === 0
        ? null
        : ` Left out because they hold a secret: ${handedOver.refusedFiles.join(", ")}.`}
    </OctantAlert>
  );
}

/**
 * Hand over through Git: the branch, where it pushes, and the note, before
 * anything is frozen or written. Committing is the person's act; the push is
 * never forced and never to the default branch.
 */
function HandoverSheet(props: {
  /** The computer chosen in the Computer card, which is told about the handover. */
  readonly destination?: { readonly memberId: string; readonly name: string };
  readonly thread: MovedThreadReference;
  readonly threadTitle: string;
  readonly client: ThreadMoveClient;
  readonly onClose: () => void;
  readonly onHandedOver: () => void;
}) {
  const titleId = useId();
  const summarizeHintId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const [summarize, setSummarize] = useState(true);
  const [preview, setPreview] = useState<
    Extract<HandoverOutcome, { readonly status: "preview" }> | undefined
  >(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let stopped = false;
    props.client
      .handoverPreview(props.thread)
      .then((answer) => {
        if (stopped) return;
        if (answer.status === "preview") setPreview(answer);
        else if (answer.status === "refused") setProblem(HANDOVER_REFUSALS[answer.reason]);
      })
      .catch(() => {
        if (!stopped) setProblem("This computer could not read the checkout.");
      });
    return () => {
      stopped = true;
    };
  }, [props.client, props.thread]);
  useEffect(() => {
    if (preview !== undefined) primary.current?.focus();
  }, [preview]);

  const handOver = async () => {
    setWorking(true);
    setProblem(undefined);
    try {
      const answer = await props.client.handOver(props.thread, props.destination?.memberId, {
        summarize,
      });
      if (answer.status === "refused") {
        setProblem(HANDOVER_REFUSALS[answer.reason]);
        return;
      }
      props.onHandedOver();
    } catch {
      setProblem("This computer could not hand the thread over.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <OctantDialog
      className="thread-move-sheet"
      initialFocus={primary}
      label="Hand over through Git"
      labelledBy={titleId}
      onClose={props.onClose}
      open
    >
      <header className="thread-move-sheet__head">
        <h2 className="thread-move-sheet__title" id={titleId}>
          Hand over through Git
        </h2>
        <p className="thread-move-sheet__meta">{props.threadTitle}</p>
      </header>
      {preview === undefined ? (
        problem === undefined ? (
          <p className="thread-move-sheet__consequence">Reading the checkout…</p>
        ) : null
      ) : (
        <>
          <section className="thread-move-sheet__section">
            <h3 className="thread-move-sheet__heading">
              {preview.newBranch ? "Commits to a new branch" : "Commits to its branch"}
            </h3>
            <code className="thread-move-sheet__branch">{preview.branch}</code>
          </section>
          <p className="thread-move-sheet__consequence">
            {preview.remote === undefined
              ? "This branch has no remote, so the work then stays on this computer."
              : `Then pushes it to ${preview.remote}, never forced. Continue it on any computer that can fetch the branch${props.destination === undefined ? "" : `; ${props.destination.name} is told about it`}.`}
          </p>
          <details className="thread-move-sheet__section">
            <summary className="thread-move-sheet__heading">The note</summary>
            <pre className="thread-move-sheet__note">{preview.note}</pre>
          </details>
          <div className="thread-move-sheet__choice">
            <div className="thread-move-sheet__choice-text">
              <span className="thread-move-sheet__choice-label">Ask the agent to summarize</span>
              <span className="thread-move-sheet__choice-hint" id={summarizeHintId}>
                One turn of the thread's agent adds where the work stands and what comes next. If it
                fails or takes over two minutes, the note goes without it.
              </span>
            </div>
            <OctantSwitch
              checked={summarize}
              describedBy={summarizeHintId}
              disabled={working}
              label="Ask the agent to summarize"
              onCheckedChange={setSummarize}
            />
          </div>
          <p className="thread-move-sheet__consequence">
            The thread stays here, frozen, until it is continued elsewhere or you take it back.
          </p>
        </>
      )}
      {working && summarize ? (
        <p className="thread-move-sheet__consequence" role="status">
          Asking the agent to summarize…
        </p>
      ) : null}
      {problem === undefined ? null : (
        <OctantAlert title="This thread can't be handed over" tone="warning">
          {problem}
        </OctantAlert>
      )}
      <footer className="thread-move-sheet__foot">
        <OctantButton onClick={props.onClose} variant="ghost">
          Cancel
        </OctantButton>
        <OctantButton
          disabled={preview === undefined || working}
          onClick={() => void handOver()}
          ref={primary}
        >
          {preview?.remote === undefined ? "Commit" : "Commit and push"}
        </OctantButton>
      </footer>
    </OctantDialog>
  );
}

const HANDOVER_REFUSALS: Readonly<
  Record<Extract<HandoverOutcome, { readonly status: "refused" }>["reason"], string>
> = {
  busy: "A turn is running or the thread is waiting on you. Try again when it finishes.",
  delegated: "Another computer delegated this thread here, so it stays with that delegation.",
  refused: "This thread's checkout can't be read here.",
  "nothing-to-hand-over": "There's nothing to hand over: no changes and no branch of its own.",
  "commit-failed": "Git could not write the commit. Nothing was handed over.",
};

function challengeProblem(
  kind: "unlock-required" | "destination-unreachable" | "refused",
  memberName: string,
): string {
  if (kind === "unlock-required") {
    return `This Mac isn't an owner on ${memberName}. Mark it as an owner there in Settings › Remote access › Hub, then try again.`;
  }
  if (kind === "destination-unreachable") return `${memberName} couldn't be reached.`;
  return `${memberName} doesn't accept moved threads from this computer.`;
}

/** Start, each quarter, and the end, never each chunk. */
function useLiveAnnouncement(status: ThreadMoveThreadStatus | undefined): string {
  const [said, setSaid] = useState("");
  const last = useRef<{ readonly moveId?: string; readonly quarter: number }>({ quarter: -1 });
  useEffect(() => {
    const sending = status?.sending;
    if (sending === undefined) {
      if (last.current.moveId !== undefined) {
        setSaid(
          status?.failure !== undefined
            ? "This thread can't move."
            : status?.departed !== undefined
              ? `Moved to ${status.departed.destinationName}.`
              : "The move stopped.",
        );
        last.current = { quarter: -1 };
      }
      return;
    }
    const quarter = Math.floor(percent(sending) / 25);
    if (last.current.moveId !== String(sending.moveId)) {
      setSaid(`Moving to ${sending.destinationName}.`);
      last.current = { moveId: String(sending.moveId), quarter };
      return;
    }
    if (quarter > last.current.quarter) {
      setSaid(`${String(quarter * 25)}% moved.`);
      last.current = { moveId: String(sending.moveId), quarter };
    }
  }, [status]);
  return said;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

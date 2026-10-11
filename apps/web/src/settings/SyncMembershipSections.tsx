import type { ReplicaMembershipClient } from "@octant/client-runtime/replica-membership-client";
import type { ReplicaSyncStatusClient } from "@octant/client-runtime/replica-sync-status-client";
import type {
  ReplicaBroughtIn,
  ReplicaJoinRequestView,
  ReplicaMembershipCommand,
  ReplicaMembershipResult,
  ReplicaMembershipView,
  ReplicaMemberView,
  ReplicaRestoreCommand,
  ReplicaRestoreProgress,
  ReplicaSubjectRevocation,
  ReplicaSyncStatus,
  ReplicaSyncStatusView,
} from "@octant/contracts/replica-entry";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantConfirmDialog } from "../ui/base/OctantConfirmDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { SettingRow, SettingsFactList, SettingsSection, SettingsState } from "./primitives";

/** Said where a status line has no data yet, rather than a zero or a guess. */
export const SYNC_STATUS_NOT_AVAILABLE = "Not available yet";

/** Why Create and Join are off until the store above is ready. */
export const SYNC_STORE_NOT_READY = "Choose a store and turn sync on first.";

/** Why every action that reads the store is off while the restore is stopped. */
export const SYNC_RESTORE_STOPPED =
  "The restore is stopped, so this computer reads nothing from the store. Resume it first.";

/** How often the page reads a running restore's, or a join read's, progress again. */
export const SYNC_RESTORE_POLL_MS = 2_000;

type Feedback = {
  readonly kind: "loading" | "success" | "error";
  readonly message: string;
};

type Member = Pick<ReplicaMemberView, "displayName" | "revoked" | "thisComputer"> & {
  readonly role: { readonly kind: "founder" } | { readonly kind: "approved"; approverName: string };
};

export interface SyncMembershipSectionsProps {
  readonly client: ReplicaMembershipClient;
  /** A store is chosen and sync is on, so membership commands can reach it. */
  readonly storeReady: boolean;
  /** Membership changed in a way the store section shows (its member lock). */
  readonly onMembershipChange: () => void;
}

/**
 * Settings › Sync on the host: set up a replica or join one, approve another
 * computer after comparing codes, see who is in it, and revoke a computer.
 *
 * Every decision is the host's. The page shows the codes the host derived and
 * sends back only what the person chose; the host checks the code again, and
 * refuses anything this computer may not do.
 */
export function SyncMembershipSections(props: SyncMembershipSectionsProps) {
  const { client, onMembershipChange } = props;
  const [view, setView] = useState<ReplicaMembershipView>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // A join confirmation reads the store before it decides; the page follows
  // its count and keeps Stop available while every other control waits.
  const [confirming, setConfirming] = useState(false);
  const [stoppingJoinRead, setStoppingJoinRead] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  // A restore's outcome is said in its own section.
  const [restoreFeedback, setRestoreFeedback] = useState<Feedback>();
  // A revoke's outcome is said beside the computers it changed, not in the
  // section above that the person did not act in.
  const [feedbackNearComputers, setFeedbackNearComputers] = useState(false);
  const [approving, setApproving] = useState<ReplicaJoinRequestView>();
  const [revoking, setRevoking] = useState<{
    readonly member: ReplicaMemberView;
    readonly preview: Preview;
  }>();

  const load = useCallback(async () => {
    try {
      setView(await client.read());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // A running restore reads in the background, and a join confirmation reads
  // before it answers; the page follows either count.
  const following =
    confirming ||
    view?.status.restore?.state === "running" ||
    view?.status.joinRead?.state === "running";
  useEffect(() => {
    if (!following) return;
    const timer = setInterval(() => void load(), SYNC_RESTORE_POLL_MS);
    return () => clearInterval(timer);
  }, [load, following]);

  const stopJoinRead = useCallback(async () => {
    setStoppingJoinRead(true);
    try {
      const result = await client.stopJoinRead();
      if (result.kind === "refused") setFeedback({ kind: "error", message: result.message });
      await load();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Replica membership is unavailable.",
      });
    } finally {
      setStoppingJoinRead(false);
    }
  }, [client, load]);

  const runRestore = useCallback(
    async (command: ReplicaRestoreCommand) => {
      setBusy(true);
      setRestoreFeedback(undefined);
      try {
        const result = await client.restore(command);
        if (result.kind === "refused") {
          setRestoreFeedback({ kind: "error", message: result.message });
        }
        await load();
      } catch (error) {
        setRestoreFeedback({
          kind: "error",
          message: error instanceof Error ? error.message : "Replica restore is unavailable.",
        });
      } finally {
        setBusy(false);
      }
    },
    [client, load],
  );

  /** Runs one command, reloads what the host now holds, and returns its result. */
  const run = useCallback(
    async (command: ReplicaMembershipCommand): Promise<ReplicaMembershipResult | undefined> => {
      setBusy(true);
      setFeedback(undefined);
      setFeedbackNearComputers(command.kind === "revoke-preview");
      try {
        const result = await client.execute(command);
        // A stopped join read says so in its own progress row.
        if (
          (result.kind === "refused" && result.reason !== "join-stopped") ||
          result.kind === "store-failed"
        ) {
          setFeedback({ kind: "error", message: result.message });
        }
        await load();
        return result;
      } catch (error) {
        setFeedback({
          kind: "error",
          message: error instanceof Error ? error.message : "Replica membership is unavailable.",
        });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [client, load],
  );

  if (view === undefined) {
    return (
      <SettingsSection title="This computer">
        <SettingsState kind={loadFailed ? "error" : "loading"}>
          {loadFailed ? "Replica membership could not be read from this host." : "Reading…"}
        </SettingsState>
      </SettingsSection>
    );
  }

  const here = view.thisComputer;
  const member = here.kind === "founder" || here.kind === "member";
  const nameOf = (instanceId: string) =>
    view.members.find((entry) => String(entry.instanceId) === instanceId)?.displayName ??
    "another computer";
  const feedbackSlot = (near: boolean) => (
    <div aria-live="polite" className="settings-feedback-slot">
      {feedback === undefined || near !== feedbackNearComputers ? null : (
        <SettingsState kind={feedback.kind}>{feedback.message}</SettingsState>
      )}
    </div>
  );
  // Stop means no store reads until Resume; the host refuses them too.
  const restoreStopped = view.status.restore?.state === "stopped";
  const readsOffReason = !props.storeReady
    ? SYNC_STORE_NOT_READY
    : restoreStopped
      ? SYNC_RESTORE_STOPPED
      : undefined;
  const joinRead = view.status.joinRead;
  const checkStore = (
    <OctantButton
      disabled={busy || readsOffReason !== undefined}
      onClick={() => void run({ kind: "pull" })}
      size="sm"
      title={readsOffReason}
      type="button"
      variant="ghost"
    >
      Check the store
    </OctantButton>
  );

  return (
    <>
      {here.kind === "none" || here.kind === "left" ? (
        <StartSection
          busy={busy}
          computerName={here.kind === "left" ? here.displayName : view.computerName}
          feedback={feedbackSlot(false)}
          left={here.kind === "left"}
          onCreate={async (displayName) => {
            const result = await run({ kind: "create-replica", displayName });
            if (result?.kind === "replica-created") {
              setFeedback({
                kind: "success",
                message: "This computer set up a replica in the store.",
              });
              onMembershipChange();
            }
          }}
          onJoin={async (displayName) => {
            const result = await run({ kind: "write-join-request", displayName });
            if (result?.kind === "join-requested") onMembershipChange();
          }}
          storeReady={props.storeReady}
        />
      ) : null}

      {here.kind === "joining" ? (
        <SettingsSection
          actions={checkStore}
          description={
            here.fresh
              ? `This computer asked to join as ${here.displayName}. On a computer that already syncs, open Settings › Sync and check the store. Approve there only if both screens show the same code.`
              : "This request is more than a day old, so no computer will approve it. Ask again."
          }
          title="This computer"
        >
          <div className="setgroup">
            {here.approvers.length === 0 ? (
              <div className="sync-settings__note">
                <SettingsState kind="empty">
                  No computer that already syncs is in the store yet. Check the store again once
                  your other computer has set up sync.
                </SettingsState>
              </div>
            ) : (
              here.approvers.map((approver) => (
                <SettingRow
                  description={
                    approver.approvedThisComputer
                      ? "Approved this computer. Confirm only if it showed this code."
                      : "Shows this code when it approves this computer."
                  }
                  key={String(approver.instanceId)}
                  label={approver.displayName}
                  scope="host"
                  settingId={`sync-approver-${String(approver.instanceId)}`}
                >
                  <div className="sync-settings__member-controls">
                    <MatchingCode code={approver.matchingCode} />
                    {approver.approvedThisComputer ? (
                      <OctantButton
                        disabled={busy}
                        onClick={() => {
                          setConfirming(true);
                          void run({
                            kind: "confirm-join",
                            approver: approver.instanceId,
                            confirmationCode: approver.matchingCode,
                          })
                            .then((result) => {
                              if (result?.kind !== "join-confirmed") return;
                              setFeedback({
                                kind: "success",
                                message: `This computer joined. ${approver.displayName} brought it in.`,
                              });
                              onMembershipChange();
                            })
                            .finally(() => setConfirming(false));
                        }}
                        size="sm"
                        type="button"
                      >
                        Confirm join
                      </OctantButton>
                    ) : null}
                  </div>
                </SettingRow>
              ))
            )}
            {joinRead === undefined ? null : (
              <JoinReadRow
                joinRead={joinRead}
                onStop={() => void stopJoinRead()}
                stopping={stoppingJoinRead}
              />
            )}
            {here.fresh ? null : (
              <SettingRow
                description="A new request is a new identity for this computer."
                label="Ask again"
                scope="host"
                settingId="sync-ask-again"
              >
                <OctantButton
                  disabled={busy || !props.storeReady}
                  onClick={() =>
                    void run({ kind: "write-join-request", displayName: here.displayName })
                  }
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Ask again
                </OctantButton>
              </SettingRow>
            )}
          </div>
          {feedbackSlot(false)}
        </SettingsSection>
      ) : null}

      {member ? (
        <SettingsSection
          actions={checkStore}
          description={
            restoreStopped
              ? SYNC_RESTORE_STOPPED
              : here.kind === "founder"
                ? `This computer set up the replica as ${here.displayName}. Check the store to see computers that asked to join.`
                : `This computer is a member as ${here.displayName}. Check the store to see computers that asked to join.`
          }
          title="Join requests"
        >
          <div className="setgroup">
            {view.joinRequests.length === 0 ? (
              <div className="sync-settings__note">
                <SettingsState kind="empty">No computer is asking to join.</SettingsState>
              </div>
            ) : (
              view.joinRequests.map((request) => (
                <SettingRow
                  description={
                    request.approvedByThisComputer
                      ? `Approved. ${request.request.origin.displayName} confirms the join on its own screen.`
                      : `Asked ${formatTime(request.request.requestedAt)}.`
                  }
                  key={String(request.request.origin.instanceId)}
                  label={request.request.origin.displayName}
                  scope="host"
                  settingId={`sync-join-request-${String(request.request.origin.instanceId)}`}
                >
                  <div className="sync-settings__member-controls">
                    <MatchingCode code={request.matchingCode} />
                    {request.approvedByThisComputer ? (
                      <span className="sync-settings__muted">Waiting for it to confirm</span>
                    ) : (
                      <OctantButton
                        aria-haspopup="dialog"
                        disabled={busy || restoreStopped}
                        onClick={() => setApproving(request)}
                        size="sm"
                        title={restoreStopped ? SYNC_RESTORE_STOPPED : undefined}
                        type="button"
                        variant="secondary"
                      >
                        Approve…
                      </OctantButton>
                    )}
                  </div>
                </SettingRow>
              ))
            )}
          </div>
          {feedbackSlot(false)}
        </SettingsSection>
      ) : null}

      {view.status.restore === undefined ? null : (
        <SyncRestoreSection
          busy={busy}
          feedback={
            <div aria-live="polite" className="settings-feedback-slot">
              {restoreFeedback === undefined ? null : (
                <SettingsState kind={restoreFeedback.kind}>{restoreFeedback.message}</SettingsState>
              )}
            </div>
          }
          onResume={() => void runRestore({ kind: "resume-restore" })}
          onStop={() => void runRestore({ kind: "stop-restore" })}
          restore={view.status.restore}
          storeReady={props.storeReady}
        />
      )}

      <SyncStatusSection status={view.status} />

      {view.members.length === 0 ? null : (
        <SettingsSection
          description="Revoking a computer writes a signed record. Your other computers ignore what it writes after that once they read it."
          title="Computers"
          tone="danger"
        >
          <div className="setgroup">
            {view.members.map((entry) => (
              <SettingRow
                description={roleText(entry)}
                key={String(entry.instanceId)}
                label={entry.displayName}
                scope="host"
                settingId={`sync-member-${String(entry.instanceId)}`}
              >
                {entry.revocable ? (
                  <OctantButton
                    aria-haspopup="dialog"
                    aria-label={`Revoke ${entry.displayName}`}
                    disabled={busy || restoreStopped}
                    onClick={() => {
                      setFeedbackNearComputers(true);
                      setFeedback({
                        kind: "loading",
                        message: `Reading the store before revoking ${entry.displayName}…`,
                      });
                      void run({ kind: "revoke-preview", subject: entry.instanceId }).then(
                        (result) => {
                          if (result?.kind !== "revoke-preview") return;
                          setFeedback(undefined);
                          setRevoking({ member: entry, preview: result });
                        },
                      );
                    }}
                    size="sm"
                    title={restoreStopped ? SYNC_RESTORE_STOPPED : undefined}
                    type="button"
                    variant="destructive"
                  >
                    Revoke…
                  </OctantButton>
                ) : (
                  <span className="sync-settings__muted">{memberStanding(entry)}</span>
                )}
              </SettingRow>
            ))}
          </div>
          {feedbackSlot(true)}
        </SettingsSection>
      )}

      {approving === undefined ? null : (
        <OctantConfirmDialog
          confirmLabel="Codes match, approve"
          details={<MatchingCode code={approving.matchingCode} large />}
          onCancel={() => setApproving(undefined)}
          onConfirm={() => {
            const request = approving;
            setApproving(undefined);
            void run({
              kind: "approve-join",
              joinRequest: request.request,
              confirmationCode: request.matchingCode,
            }).then((result) => {
              if (result?.kind !== "join-approved") return;
              setFeedback({
                kind: "success",
                message: `Approved ${request.request.origin.displayName}. Confirm on that computer.`,
              });
            });
          }}
          pending={busy}
          title={`Approve ${approving.request.origin.displayName}?`}
        >
          Approve only if {approving.request.origin.displayName} shows this same code. If it shows
          another code, cancel: the request in the store may not be the one you made.
        </OctantConfirmDialog>
      )}

      {revoking === undefined ? null : (
        <RevokeDialog
          client={client}
          member={revoking.member}
          nameOf={nameOf}
          preview={revoking.preview}
          onClose={(result) => {
            setRevoking(undefined);
            if (result !== undefined) setFeedback(result);
            void load();
          }}
        />
      )}
    </>
  );
}

/** Set up a replica here, or ask to join one, under a name the person can change. */
function StartSection(props: {
  readonly busy: boolean;
  readonly computerName: string;
  readonly feedback: ReactNode;
  readonly left: boolean;
  readonly storeReady: boolean;
  readonly onCreate: (displayName: string) => Promise<void>;
  readonly onJoin: (displayName: string) => Promise<void>;
}) {
  const [name, setName] = useState(props.computerName);
  const [problem, setProblem] = useState<string>();
  const nameId = useId();
  const off = props.busy || !props.storeReady;
  const offReason = props.storeReady ? undefined : SYNC_STORE_NOT_READY;
  const checked = (): string | undefined => {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 128 || /[\\/]/.test(trimmed)) {
      setProblem("Name this computer in up to 128 characters, without a slash.");
      return undefined;
    }
    setProblem(undefined);
    return trimmed;
  };
  return (
    <SettingsSection
      description={
        props.left
          ? "This computer was revoked, or lost its place when the computer that approved it was. It can ask to join again as a new computer."
          : "Set up sync here if this is your first computer. On another computer, ask to join the replica that is already in the store."
      }
      title="This computer"
    >
      <div className="setgroup">
        <SettingRow
          description="Your other computers see this name."
          htmlFor={nameId}
          label="Computer name"
          scope="host"
          settingId="sync-computer-name"
        >
          <OctantInput
            aria-invalid={problem === undefined ? undefined : true}
            autoComplete="off"
            className="settings-view__text-input"
            disabled={props.busy}
            id={nameId}
            onChange={(event) => setName(event.currentTarget.value)}
            spellCheck={false}
            value={name}
          />
        </SettingRow>
        {props.left ? null : (
          <SettingRow
            description={
              offReason ?? "Makes this computer the one that set up sync. It can revoke any other."
            }
            label="Set up sync"
            scope="host"
            settingId="sync-create-replica"
          >
            <OctantButton
              disabled={off}
              onClick={() => {
                const displayName = checked();
                if (displayName !== undefined) void props.onCreate(displayName);
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Set up sync
            </OctantButton>
          </SettingRow>
        )}
        <SettingRow
          description={
            offReason ??
            "Writes a request into the store. A computer that already syncs approves it after you compare codes."
          }
          label="Join another computer"
          scope="host"
          settingId="sync-join-replica"
        >
          <OctantButton
            disabled={off}
            onClick={() => {
              const displayName = checked();
              if (displayName !== undefined) void props.onJoin(displayName);
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            Ask to join
          </OctantButton>
        </SettingRow>
      </div>
      <div aria-live="polite" className="settings-feedback-slot">
        {problem === undefined ? null : <SettingsState kind="error">{problem}</SettingsState>}
      </div>
      {props.feedback}
    </SettingsSection>
  );
}

type Preview = Extract<ReplicaMembershipResult, { readonly kind: "revoke-preview" }>;

/**
 * Revoke one computer (D10). The host reads the store first and says where the
 * cut falls, which computers this one brought in, and which revocations it
 * already wrote; the person can revoke those computers in the same step or
 * stop counting before its first revocation, never later than the host's cut.
 */
function RevokeDialog(props: {
  readonly client: ReplicaMembershipClient;
  readonly member: ReplicaMemberView;
  readonly preview: Preview;
  readonly nameOf: (instanceId: string) => string;
  readonly onClose: (feedback: Feedback | undefined) => void;
}) {
  const { client, member, preview, onClose } = props;
  const [pending, setPending] = useState(false);
  const [alsoRevoke, setAlsoRevoke] = useState<ReadonlySet<string>>(new Set());
  const [cutEarlier, setCutEarlier] = useState(false);
  const firstRevocation = preview.subjectRevocations[0];
  const names = (ids: ReadonlyArray<string>) =>
    ids
      .map(
        (id) =>
          preview.broughtIn.find((entry) => String(entry.instanceId) === id)?.displayName ??
          props.nameOf(id),
      )
      .join(", ");

  const revoke = async () => {
    setPending(true);
    let result: ReplicaMembershipResult;
    try {
      result = await client.execute({
        kind: "revoke",
        subject: member.instanceId,
        ...(cutEarlier && firstRevocation !== undefined
          ? { cut: firstRevocation.sequence - 1 }
          : {}),
        ...(alsoRevoke.size === 0
          ? {}
          : {
              alsoRevoke: preview.broughtIn
                .filter((entry) => alsoRevoke.has(String(entry.instanceId)))
                .map((entry) => entry.instanceId),
            }),
      });
    } catch (error) {
      onClose({
        kind: "error",
        message: error instanceof Error ? error.message : "Replica membership is unavailable.",
      });
      return;
    }
    if (result.kind === "revoked") {
      const also = result.alsoRevoked.map((entry) => String(entry.subject));
      onClose({
        kind: "success",
        message:
          also.length === 0
            ? `Revoked ${member.displayName}.`
            : `Revoked ${member.displayName} and ${names(also)}.`,
      });
    } else if (result.kind === "revoked-in-part") {
      onClose({
        kind: "error",
        message: `Revoked ${member.displayName}, but not ${names(result.notRevoked.map(String))}: ${result.message} Revoke them again.`,
      });
    } else {
      onClose({
        kind: "error",
        message:
          result.kind === "refused" || result.kind === "store-failed"
            ? result.message
            : "The revoke did not finish.",
      });
    }
  };

  return (
    <OctantConfirmDialog
      confirmLabel={`Revoke ${member.displayName}`}
      destructive
      details={
        <RevokeChoices
          alsoRevoke={alsoRevoke}
          cutEarlier={cutEarlier}
          firstRevocation={firstRevocation}
          member={member}
          nameOf={props.nameOf}
          onAlsoRevoke={(id, checked) =>
            setAlsoRevoke((current) => {
              const next = new Set(current);
              if (checked) next.add(id);
              else next.delete(id);
              return next;
            })
          }
          onCutEarlier={setCutEarlier}
          preview={preview}
        />
      }
      onCancel={() => onClose(undefined)}
      onConfirm={() => void revoke()}
      pending={pending}
      title={`Revoke ${member.displayName}?`}
    >
      {cutSentence(member.displayName, preview, cutEarlier ? firstRevocation : undefined)}
    </OctantConfirmDialog>
  );
}

function RevokeChoices(props: {
  readonly preview: Preview;
  readonly member: ReplicaMemberView;
  readonly alsoRevoke: ReadonlySet<string>;
  readonly cutEarlier: boolean;
  readonly firstRevocation: ReplicaSubjectRevocation | undefined;
  readonly nameOf: (instanceId: string) => string;
  readonly onAlsoRevoke: (instanceId: string, checked: boolean) => void;
  readonly onCutEarlier: (checked: boolean) => void;
}) {
  const { preview, member } = props;
  const broughtInId = useId();
  const revocationsId = useId();
  return (
    <div className="sync-settings__revoke">
      {preview.readStore ? null : (
        <SettingsState kind="error">
          The store could not be read, so this uses what this computer already holds. Computers{" "}
          {member.displayName} approved that this computer has not read must join again.
        </SettingsState>
      )}
      {preview.broughtIn.length === 0 ? null : (
        <fieldset aria-labelledby={broughtInId} className="sync-settings__choices">
          <legend id={broughtInId}>Computers {member.displayName} brought in</legend>
          <p>They stay unless you revoke them too, for example if it was stolen.</p>
          {preview.broughtIn.map((entry: ReplicaBroughtIn) => (
            <label className="check" key={String(entry.instanceId)}>
              <OctantCheckbox
                checked={props.alsoRevoke.has(String(entry.instanceId))}
                onChange={(event) =>
                  props.onAlsoRevoke(String(entry.instanceId), event.target.checked)
                }
              />
              <span>
                Also revoke {entry.displayName}
                {String(entry.parent) === String(member.instanceId)
                  ? ""
                  : ` (approved by ${props.nameOf(String(entry.parent))})`}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {props.firstRevocation === undefined ? null : (
        <fieldset aria-labelledby={revocationsId} className="sync-settings__choices">
          <legend id={revocationsId}>Revocations {member.displayName} wrote</legend>
          <ul>
            {preview.subjectRevocations.map((revocation) => (
              <li key={revocation.sequence}>
                It revoked {props.nameOf(String(revocation.subject))} at its entry{" "}
                {revocation.sequence}.
              </li>
            ))}
          </ul>
          <label className="check">
            <OctantCheckbox
              checked={props.cutEarlier}
              onChange={(event) => props.onCutEarlier(event.target.checked)}
            />
            <span>
              Stop counting before its first revocation. Computers it approved after that point join
              again.
            </span>
          </label>
        </fieldset>
      )}
    </div>
  );
}

function cutSentence(
  name: string,
  preview: Preview,
  before: ReplicaSubjectRevocation | undefined,
): string {
  const cut = before === undefined ? preview.cut : before.sequence - 1;
  return cut === 0
    ? `Nothing ${name} wrote keeps counting. Your other computers ignore it once they read this record.`
    : `${name}'s entries up to its entry ${cut} keep counting; anything it writes after that is ignored once your other computers read this record.`;
}

/** Read-only sync status for a paired phone or a remote window. */
export function SyncStatusReadOnly(props: { readonly client: ReplicaSyncStatusClient }) {
  const { client } = props;
  const [read, setRead] = useState<
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly view: ReplicaSyncStatusView }
    | { readonly status: "refused" }
    | { readonly status: "unavailable" }
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void client.read(controller.signal).then((next) => {
      if (!controller.signal.aborted) setRead(next);
    });
    return () => controller.abort();
  }, [client]);

  if (read.status !== "ready") {
    return (
      <SettingsSection title="Sync status">
        <SettingsState kind={read.status === "loading" ? "loading" : "error"}>
          {read.status === "loading"
            ? "Reading sync status…"
            : read.status === "refused"
              ? "Sync status is not available to this device."
              : "Sync status could not be read from the host."}
        </SettingsState>
      </SettingsSection>
    );
  }
  const view = read.view;
  return (
    <>
      <SyncStatusSection
        description="Setting up sync, joining, and revoking happen in the Octant app on the host machine."
        restoreFact
        standing={STANDING[view.thisComputer]}
        status={view.status}
      />
      {view.members.length === 0 ? null : (
        <SettingsSection title="Computers">
          <SettingsFactList
            facts={view.members.map((entry) => ({
              label: entry.displayName,
              value: memberDescription(entry),
            }))}
          />
        </SettingsSection>
      )}
    </>
  );
}

const STANDING: Readonly<Record<ReplicaSyncStatusView["thisComputer"], string>> = {
  none: "Not set up",
  founder: "Set up sync",
  member: "Member",
  joining: "Asked to join",
  left: "Revoked",
};

/**
 * The first read of this computer's identity in a replica brings every
 * artifact and its history in, newest first. The person can stop it, and
 * resume it where it stopped.
 */
function SyncRestoreSection(props: {
  readonly restore: ReplicaRestoreProgress;
  readonly busy: boolean;
  readonly storeReady: boolean;
  readonly feedback: ReactNode;
  readonly onStop: () => void;
  readonly onResume: () => void;
}) {
  const { restore } = props;
  const progressId = useId();
  return (
    <SettingsSection
      description={
        restore.state === "finished"
          ? "Every artifact and its history in the store is on this computer. New versions from your other computers arrive with each sync."
          : "This computer is bringing in every artifact in the store with its full history, newest versions first. It reads in the background, and you can stop it and resume it later, also after a restart."
      }
      title="Restore library"
    >
      <div className="setgroup">
        <SettingRow
          description={restoreSentence(restore)}
          htmlFor={progressId}
          label="Progress"
          scope="host"
          settingId="sync-restore"
        >
          <div className="sync-settings__member-controls">
            <progress
              className="sync-settings__progress"
              id={progressId}
              max={Math.max(1, restore.total)}
              value={restore.total === 0 ? 1 : restore.done}
            >
              {restore.done} of {restore.total}
            </progress>
            {restore.state === "running" ? (
              <OctantButton
                disabled={props.busy}
                onClick={props.onStop}
                size="sm"
                type="button"
                variant="secondary"
              >
                Stop
              </OctantButton>
            ) : restore.state === "stopped" ? (
              <OctantButton
                disabled={props.busy || !props.storeReady}
                onClick={props.onResume}
                size="sm"
                title={props.storeReady ? undefined : SYNC_STORE_NOT_READY}
                type="button"
              >
                Resume
              </OctantButton>
            ) : null}
          </div>
        </SettingRow>
      </div>
      {props.feedback}
    </SettingsSection>
  );
}

/**
 * The read a join confirmation makes before this computer publishes its
 * accept: newest first, in batches, with the same progress as a restore.
 */
function JoinReadRow(props: {
  readonly joinRead: ReplicaRestoreProgress;
  readonly stopping: boolean;
  readonly onStop: () => void;
}) {
  const { joinRead } = props;
  const progressId = useId();
  const count = `${String(joinRead.done)} of ${String(joinRead.total)} entries read`;
  return (
    <SettingRow
      description={
        joinRead.state === "running"
          ? `Reading the store before joining: ${count}.`
          : `Stopped: ${count}. Confirm join again to carry on where it stopped.`
      }
      htmlFor={progressId}
      label="Reading the store"
      scope="host"
      settingId="sync-join-read"
    >
      <div className="sync-settings__member-controls">
        <progress
          className="sync-settings__progress"
          id={progressId}
          max={Math.max(1, joinRead.total)}
          value={joinRead.total === 0 ? 1 : joinRead.done}
        >
          {joinRead.done} of {joinRead.total}
        </progress>
        {joinRead.state === "running" ? (
          <OctantButton
            disabled={props.stopping}
            onClick={props.onStop}
            size="sm"
            type="button"
            variant="secondary"
          >
            Stop
          </OctantButton>
        ) : null}
      </div>
    </SettingRow>
  );
}

function restoreSentence(restore: ReplicaRestoreProgress): string {
  const count = `${String(restore.done)} of ${String(restore.total)} entries read`;
  switch (restore.state) {
    case "running":
      return `Restoring: ${count}.`;
    case "stopped":
      return `Stopped: ${count}. Nothing reads the store until you resume, not even Check the store.`;
    case "finished":
      return `Restored: ${count}.`;
  }
}

function SyncStatusSection(props: {
  readonly status: ReplicaSyncStatus;
  /** Off the host the restore has no section of its own, so status names it. */
  readonly restoreFact?: boolean;
  readonly description?: string;
  readonly standing?: string;
}) {
  const error = props.status.lastError;
  return (
    <SettingsSection
      description={
        props.description ??
        "The time of the last publish and pull, and the queue, are not shown yet in this preview."
      }
      title="Sync status"
    >
      <SettingsFactList
        facts={[
          ...(props.standing === undefined
            ? []
            : [{ label: "This computer", value: props.standing }]),
          { label: "Last publish", value: SYNC_STATUS_NOT_AVAILABLE },
          { label: "Last pull", value: SYNC_STATUS_NOT_AVAILABLE },
          { label: "Queued", value: SYNC_STATUS_NOT_AVAILABLE },
          ...(props.status.restore === undefined || props.restoreFact !== true
            ? []
            : [{ label: "Restore", value: restoreSentence(props.status.restore) }]),
          {
            label: "Last error",
            value:
              error === undefined ? "None" : `${formatTime(error.at)}: ${errorSentence(error)}`,
          },
        ]}
      />
    </SettingsSection>
  );
}

function MatchingCode(props: { readonly code: string; readonly large?: boolean }) {
  return (
    <span
      className={`sync-settings__code${props.large === true ? " sync-settings__code--large" : ""}`}
    >
      {props.code.slice(0, 3)} {props.code.slice(3)}
    </span>
  );
}

function roleText(entry: Member): string {
  return entry.role.kind === "founder" ? "Set up sync" : `Approved by ${entry.role.approverName}`;
}

function memberDescription(entry: Member): string {
  return [
    roleText(entry),
    entry.thisComputer ? "this computer" : undefined,
    entry.revoked ? "revoked" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

function memberStanding(entry: ReplicaMemberView): string {
  if (entry.revoked) return "Revoked";
  if (entry.thisComputer) return "This computer";
  return entry.role.kind === "founder"
    ? "Cannot be revoked"
    : `Revoke from ${entry.role.approverName}`;
}

function errorSentence(error: NonNullable<ReplicaSyncStatus["lastError"]>): string {
  switch (error.reason) {
    case "not-connected":
      return "The store could not be reached.";
    case "refused":
      return error.phase === "read" || error.phase === "list"
        ? "The store refused a read."
        : "The store refused a write.";
    case "slot-occupied":
      return "The store holds a file this computer did not write where it writes next.";
    case "truncated":
      return "The store lists more files than one pass reads.";
  }
}

function formatTime(value: string | number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "at an unknown time";
}

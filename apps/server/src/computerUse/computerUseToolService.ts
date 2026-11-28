import { createHash, randomUUID } from "node:crypto";
import {
  decodeComputerUseOwner,
  type ComputerControlCommand,
  type ComputerControlResult,
  type ComputerTypeSecretCommand,
  type ComputerUseOwner,
  type ComputerUseSettings,
  type ComputerWindowId,
} from "@octant/contracts/computer-use-plugin";
import {
  decodeComputerUseActionRequest,
  decodeToolActionRequest,
  decodeEventActor,
  sameToolActionAuthority,
  type ApprovalOutsideContent,
  type ComputerUseActionKind,
  type ProjectId,
  type ToolActionAuthority,
} from "@octant/contracts";
import type { ThreadSecretFailure } from "@octant/contracts/thread-secrets";
import {
  decideComputerUseApproval,
  decideDesktopArtifactPath,
  isToolAllowedByAllowlist,
} from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { createComputerUsePlugin } from "../plugins/computerUse/computerUsePlugin";
import type { ThreadSecretCaller, ThreadSecretService } from "../threadSecrets/threadSecretService";
import {
  ComputerUseRuntimeError,
  createComputerUseRuntime,
  type ComputerUseApprovalApprover,
  type ComputerUseDestinationReport,
  type ComputerUseEvidenceEvent,
} from "./computerUseRuntime";
import type { DesktopComputerUsePort } from "./desktopComputerUsePort";
import type { LeasedComputerUsePort } from "./desktopLeaseService";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";

/** `ComputerUsePendingApproval.summary` rejects anything longer. */
const APPROVAL_SUMMARY_LIMIT = 512;

/** Consumer registration for redeeming one-use thread-secret handles on this Mac. */
export const COMPUTER_USE_SECRET_CONSUMER = {
  id: "octant.computer-use",
  label: "Computer use",
} as const;

const SECRET_FAILURE_MESSAGES: Readonly<Record<ThreadSecretFailure, string>> = {
  declined: "The person declined this secret.",
  expired: "That secret handle is no longer valid or was already used.",
  revoked: "The person ended that secret. Do not ask again unless they say so.",
  locked: "The person's secret store is locked.",
  missing: "The person's secret store has no such item.",
  unavailable: "That thread secret cannot be used here right now.",
  "not-linked": "No secret store is linked on this computer.",
  "invalid-reference": "That secret reference is invalid.",
  "refused-by-strict": "Strict does not allow that secret's lifetime here.",
  "lifetime-not-offered": "That secret's lifetime is not allowed here.",
  "unsupported-mode": "Chat threads do not hold thread secrets.",
};

function sanitizeOneLine(value: string): string {
  return value.replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, " ").trim();
}

const refused = (reason: string, message: string): ComputerControlResult => ({
  kind: "refused",
  reason,
  message,
});
const NO_DESTINATION = refused("no-destination", "No computer-use destination is available.");
const NO_LIVE_DESKTOP = refused(
  "no-destination",
  "This host has no screen of its own, and this thread has no running desktop. Start a desktop from the thread's Desktop tab, then send again.",
);
const DESKTOP_LABEL = "this thread's disposable desktop";
const ownerKey = (owner: ComputerUseOwner) =>
  JSON.stringify([
    owner.windowId,
    owner.threadId,
    owner.mode,
    owner.providerInstanceId,
    owner.modelId,
    owner.executionPolicy,
    owner.leaseId ?? null,
  ]);

/**
 * A person's answer to a thread ask. `remembered-for-project` answers an ask
 * that offered "Remember for this Project", and names who gave it.
 */
export type ComputerUseThreadAnswer =
  | "approved"
  | "denied"
  | "cancelled"
  | "expired"
  | { readonly kind: "remembered-for-project"; readonly approver: ComputerUseApprovalApprover };

/**
 * How a turn asks its person, in the thread, to allow one thing. `offer`
 * adds "Remember for this Project" to the card.
 */
export type ComputerUseThreadAsk = (
  summary: string,
  signal?: AbortSignal,
  offer?: { readonly canRememberForProject: true },
) => Promise<ComputerUseThreadAnswer>;

export function createComputerUseToolService(options: {
  /** This Mac's driver; absent on a host with no screen of its own. */
  readonly asksFromPairedWindow?: (owner: ComputerUseOwner) => boolean;
  readonly desktop?: DesktopComputerUsePort;
  /** The thread's disposable desktops; absent on a host that cannot lease one. */
  readonly leases?: LeasedComputerUsePort;
  /**
   * What the host reports as its destination. The service's own sessions
   * start only once a send has bound one, so its runtime always admits them;
   * a host whose only option is a lease still reports itself leasable.
   */
  readonly destination?: () => ComputerUseDestinationReport;
  /** Thread secrets service for redeeming one-use handles on this Mac; absent where unsupported. */
  readonly threadSecrets?: () =>
    | Pick<ThreadSecretService, "inspectHandle" | "redeem" | "registerConsumer">
    | undefined;
  readonly settings: () => ComputerUseSettings;
  readonly authority: (owner: ComputerUseOwner) => ToolActionAuthority | undefined;
  readonly ownerIsCurrent: (owner: ComputerUseOwner) => boolean;
  readonly toolConstraints: (owner: ComputerUseOwner) => ReadonlyArray<string>;
  /**
   * Whether the owner's thread stands at Full access now. The owner's own
   * `executionPolicy` cannot say: a Work thread's owner never carries its
   * level, and a thread lowered since the turn began must ask again.
   */
  readonly fullAccess: (owner: ComputerUseOwner) => boolean;
  readonly externalContentIngested: (owner: ComputerUseOwner) => boolean;
  /**
   * Whether Strict is on for the owner's thread now. Outside Strict the mark
   * is shown but adds no ask (Architecture: "Octant adds no restrictions of
   * its own unless Strict is on"). Absent reads as Strict.
   */
  readonly strict?: (owner: ComputerUseOwner) => boolean;
  /** The sources that marked the owner's thread, read when an approval is asked. */
  readonly outsideContent?: (owner: ComputerUseOwner) => ApprovalOutsideContent | undefined;
  /** Whether a remembered Project grant already covers this Project and app. */
  readonly projectAppRemembered?: (projectId: ProjectId, appId: string) => boolean;
  /** Persists a "Remember for this Project" approval for this Project and app. */
  readonly rememberProjectApp?: (input: {
    readonly projectId: ProjectId;
    readonly appId: string;
    readonly approver: ComputerUseApprovalApprover;
  }) => void | Promise<void>;
  /**
   * Whether a remembered Project answer covers an agent's files into a
   * disposable desktop on this machine for this Project's threads.
   */
  readonly projectFileTransferRemembered?: (projectId: ProjectId) => boolean;
  /** Persists a "Remember for this Project" answer to a sent-file ask. */
  readonly rememberProjectFileTransfer?: (input: {
    readonly projectId: ProjectId;
    readonly approver: ComputerUseApprovalApprover;
  }) => void | Promise<void>;
  readonly threadTitle: (owner: ComputerUseOwner) => string;
  readonly record: (event: ComputerUseEvidenceEvent) => void | Promise<void>;
  /**
   * The server's process authority clock. An unanswered approval offer
   * expires from it, so a wall clock set back cannot extend one. An app
   * grant has no clock at all.
   */
  readonly now: () => number;
}) {
  const pending = new Map<
    string,
    {
      readonly owner: ComputerUseOwner;
      readonly command?: ComputerControlCommand;
      readonly secret?: {
        readonly command: ComputerTypeSecretCommand;
        readonly caller: ThreadSecretCaller;
        readonly label: string;
        readonly windowId: ComputerWindowId;
        readonly windowTitle: string;
        readonly signal: AbortSignal;
        readonly requiresApproval: boolean;
      };
      readonly appId: string;
      readonly sessionId: string;
      readonly authority: ToolActionAuthority;
      readonly oneTimeOnly: boolean;
      readonly canRememberForProject: boolean;
      /** The agent's stated reason, shown on the approval this action asks. */
      readonly reason?: string;
      result?: ComputerControlResult;
    }
  >();
  let closed = false;
  let unregisterSecretConsumer: (() => void) | undefined;
  let registeredSecrets:
    | Pick<ThreadSecretService, "inspectHandle" | "redeem" | "registerConsumer">
    | undefined;
  function syncSecretConsumer(): void {
    const secrets = options.threadSecrets?.();
    const shouldRegister =
      !closed &&
      secrets !== undefined &&
      options.desktop?.typeSecret !== undefined &&
      options.desktop?.inspectSecretTarget !== undefined &&
      options.settings().enabled &&
      (options.destination === undefined || options.destination().status === "available");
    if (!shouldRegister) {
      unregisterSecretConsumer?.();
      unregisterSecretConsumer = undefined;
      registeredSecrets = undefined;
      return;
    }
    if (registeredSecrets === secrets && unregisterSecretConsumer !== undefined) return;
    unregisterSecretConsumer?.();
    unregisterSecretConsumer = secrets.registerConsumer(COMPUTER_USE_SECRET_CONSUMER);
    registeredSecrets = secrets;
  }
  syncSecretConsumer();
  const owners = new Map<
    string,
    { readonly owner: ComputerUseOwner; readonly authority: ToolActionAuthority }
  >();
  const observations = new Map<
    string,
    { readonly owner: ComputerUseOwner; readonly appId: string }
  >();
  /**
   * App grants, keyed by owner, authority, and app. A grant has no clock: it
   * lasts until its owner is stopped, which `sweep` does once the thread is
   * no longer active or its authority changed, and it is held in memory only,
   * so a host restart ends every grant.
   */
  const grants = new Map<
    string,
    { readonly appId: string; readonly leaseId: ComputerUseOwner["leaseId"] }
  >();
  /**
   * Whether outside content on the owner's thread gates its actions: under
   * Strict only. Outside Strict the mark tags the thread and its approvals
   * but the grants and the level decide as they did before it.
   */
  const outsideContentGates = (owner: ComputerUseOwner): boolean =>
    options.externalContentIngested(owner) && (options.strict?.(owner) ?? true);
  /**
   * Why the tool-call authority gate refuses this owner, or undefined when it
   * admits it. `approved` says a one-time approval for this very action was
   * just recorded by the runtime, which is the "fresh confirmation" the
   * taint rule asks for: the rule exists so a standing grant cannot carry an
   * irreversible action once the thread has ingested external content, and
   * `execute` below never lets a standing grant reach here under taint.
   */
  function admissionRefusal(owner: ComputerUseOwner, approved: boolean): string | undefined {
    const authority = options.authority(owner);
    if (authority === undefined || !options.ownerIsCurrent(owner)) return "owner-changed";
    const gate = new ToolCallAuthorityService({
      resolveGrantedAuthority: () => options.authority(owner),
      resolveLiveFacts: () => ({
        providerAppManagedTools: "supported",
        host: { computerUseEnabled: options.settings().enabled },
        executionPolicy: owner.executionPolicy,
        approvalSatisfied: approved,
        externalContentIngested: outsideContentGates(owner),
        toolConstraints: options.toolConstraints(owner),
      }),
    });
    const decision = gate.authorize({
      threadId: owner.threadId,
      request: decodeToolActionRequest({
        actionId: randomUUID(),
        correlationId: randomUUID(),
        capability: { id: "computer-use", version: 1 },
        authority,
        intent: "Use Octant's bundled Computer use tool for this task.",
        approval: { kind: "not-required" },
      }),
      arguments: {
        allowlist: [],
        sensitiveFieldProtection: true,
        visibleStopControl: true,
        maxSessionDurationMs: 300_000,
        processOwnershipRequired: true,
      },
    });
    if (decision.kind === "allow") return undefined;
    if (decision.kind === "prompt") {
      if (!approved) return undefined;
      if (decision.reason === "taint-requires-fresh-confirmation") return undefined;
    }
    return decision.reason;
  }
  const admitted = (owner: ComputerUseOwner, approved: boolean): boolean =>
    admissionRefusal(owner, approved) === undefined;
  /** Sends one command to the destination the send bound. */
  function dispatch(
    owner: ComputerUseOwner,
    command: ComputerControlCommand,
    signal?: AbortSignal,
  ): Promise<ComputerControlResult> {
    if (owner.leaseId !== undefined) {
      return options.leases === undefined
        ? Promise.resolve(NO_DESTINATION)
        : options.leases.control(owner, command);
    }
    return options.desktop === undefined
      ? Promise.resolve(NO_DESTINATION)
      : options.desktop.execute(owner, command, signal);
  }
  /**
   * Gives this Mac's reservation back. A desktop lease is not the task's to
   * end here: stopping a task leaves the desktop running for the person.
   */
  async function releaseReservation(owner: ComputerUseOwner): Promise<void> {
    if (owner.leaseId === undefined) await options.desktop?.release(owner);
  }
  const runtime = createComputerUseRuntime({
    destination: { status: "available", kind: "macos-host" },
    // Where outside content makes every action ask (under Strict below Full
    // access), the offer is for this one action: offering the app there
    // promised a grant the next action would not honour.
    approvalScope: (request) => {
      const action = pending.get(String(request.actionId));
      return action !== undefined && action.oneTimeOnly ? undefined : "application-session";
    },
    approvalCanRememberForProject: (request) => {
      const action = pending.get(String(request.actionId));
      return action !== undefined && action.canRememberForProject;
    },
    onRememberForProject: async ({ request, targetApp, approver }) => {
      const action = pending.get(String(request.actionId));
      const currentAuthority = action === undefined ? undefined : options.authority(action.owner);
      if (
        action === undefined ||
        action.secret !== undefined ||
        action.owner.leaseId !== undefined ||
        action.owner.executionPolicy === "plan" ||
        !options.settings().enabled ||
        !options.ownerIsCurrent(action.owner) ||
        currentAuthority === undefined ||
        currentAuthority.projectId === undefined ||
        !sameToolActionAuthority(currentAuthority, request.authority) ||
        !sameToolActionAuthority(currentAuthority, action.authority) ||
        targetApp !== action.appId ||
        options.rememberProjectApp === undefined ||
        admissionRefusal(action.owner, true) !== undefined
      ) {
        throw new ComputerUseRuntimeError(
          "approval-denied",
          "Computer-use Project approval is no longer valid for this task's current authority.",
        );
      }
      // Re-evaluate live taint, Strict, and level posture before persisting:
      // outside content arriving under Strict while the prompt waited must
      // prevent writing a standing Project grant.
      const liveApproval = decideComputerUseApproval({
        plan: false,
        fullAccess: options.fullAccess(action.owner),
        strict: options.strict?.(action.owner) ?? true,
        externalContentIngested: options.externalContentIngested(action.owner),
        hasThreadGrant: false,
        hasProjectGrant: false,
        hasProjectScope: true,
      });
      if (liveApproval.kind !== "required" || !liveApproval.canRememberForProject) {
        throw new ComputerUseRuntimeError(
          "approval-denied",
          "This computer-use approval can no longer be remembered for the Project.",
        );
      }
      await options.rememberProjectApp({
        projectId: currentAuthority.projectId,
        appId: targetApp,
        approver,
      });
    },
    // How long an unanswered offer waits, not how long a grant lasts. An
    // offer that died sooner turned a late click into a silent no-op that the
    // agent then reported as a denial.
    approvalTtlMs: 5 * 60_000,
    approvalSummary: (request) => {
      const action = pending.get(String(request.actionId));
      // A desktop app is a file the agent sent, so its name alone does not
      // say where it runs.
      const where = action?.owner.leaseId === undefined ? "" : ` on ${DESKTOP_LABEL}`;
      // Without a chip the person no longer said "use Computer" in the send,
      // so the card carries the agent's own account of why, quoted as its
      // words rather than stated as a fact. The whole summary has a contract
      // limit, so the reason takes only what the rest leaves.
      const title =
        action === undefined ? "this task" : options.threadTitle(action.owner).slice(0, 100);
      const head =
        action?.secret !== undefined
          ? (() => {
              const windowTitle = sanitizeOneLine(action.secret.windowTitle).slice(0, 120);
              const windowLabel =
                windowTitle === "" ? `window ${action.secret.windowId}` : `window "${windowTitle}"`;
              return `Type secret "${action.secret.label}" into ${action.appId} (${windowLabel}) for "${title}".`;
            })()
          : action !== undefined && action.oneTimeOnly
            ? `Allow this one action in ${action.appId}${where} for "${title}".`
            : `Allow control of ${action?.appId ?? "this application"}${where} for "${title}" for this thread.`;
      const prefix = ' The agent says: "';
      const room = APPROVAL_SUMMARY_LIMIT - head.length - prefix.length - 2;
      if (action?.reason === undefined || room < 1) return head.slice(0, APPROVAL_SUMMARY_LIMIT);
      const reason =
        action.reason.length > room ? `${action.reason.slice(0, room - 1)}…` : action.reason;
      return `${head}${prefix}${reason}"`;
    },
    // A marked thread's one-time approval says what marked it. A mark the
    // host reads as present but whose sources it cannot name still says so,
    // with an empty list, rather than reading like an ordinary prompt.
    approvalOutsideContent: (request) => {
      const action = pending.get(String(request.actionId));
      if (action === undefined || !options.externalContentIngested(action.owner)) return undefined;
      return options.outsideContent?.(action.owner) ?? { sources: [], sourceCount: 0 };
    },
    uuid: randomUUID,
    // Approval events carry this clock's time, and an offer's expiry is
    // computed from it, so both stay on the authority clock.
    clock: () => new Date(options.now()).toISOString(),
    evidence: { record: options.record },
    adapter: {
      observe: async (request) => {
        const action = pending.get(String(request.actionId));
        if (action === undefined) throw new Error("Computer-use action is no longer pending.");
        const current = options.authority(action.owner);
        return {
          targetApp: action.appId,
          stale:
            !options.ownerIsCurrent(action.owner) ||
            !options.settings().enabled ||
            current === undefined ||
            !sameToolActionAuthority(current, request.authority),
          reference: `computer-app-${createHash("sha256").update(action.appId).digest("hex")}`,
        };
      },
      execute: async (request, _observation, signal) => {
        const action = pending.get(String(request.actionId));
        const current = action === undefined ? undefined : options.authority(action.owner);
        if (
          action === undefined ||
          current === undefined ||
          !sameToolActionAuthority(current, request.authority)
        )
          return { refused: "owner-changed" };
        // A policy refusal is not an owner change. Reporting it as one sent a
        // person to look for a task-authority problem that did not exist.
        const approvalGranted = action.secret === undefined ? true : action.secret.requiresApproval;
        const refusal = admissionRefusal(action.owner, approvalGranted);
        if (refusal !== undefined) return { refused: refusal };
        if (action.secret !== undefined) {
          const secretSignal = AbortSignal.any([signal, action.secret.signal]);
          if (secretSignal.aborted) {
            action.result = { kind: "cancelled" };
            return { refused: "cancelled" };
          }
          // If this action skipped one-time approval at admission (Full access
          // outside Strict), re-check live approval policy right before
          // dispatch so leaving Full access or turning Strict on cannot bypass
          // the one-time approval rule.
          if (!action.secret.requiresApproval) {
            const liveApproval = decideComputerUseApproval({
              plan: false,
              fullAccess: options.fullAccess(action.owner),
              strict: options.strict?.(action.owner) ?? true,
              externalContentIngested: options.externalContentIngested(action.owner),
              hasThreadGrant: false,
              hasProjectGrant: false,
              hasProjectScope: false,
              secretInput: true,
            });
            if (liveApproval.kind !== "not-required") {
              action.result = refused(
                "not-approved",
                "Computer use approval rules changed before typing the secret.",
              );
              return { refused: "not-approved" };
            }
          }
          const secrets = options.threadSecrets?.();
          const desktop = options.desktop;
          if (
            secrets === undefined ||
            desktop?.inspectSecretTarget === undefined ||
            desktop.typeSecret === undefined
          ) {
            action.result = refused(
              "unavailable",
              "Typing a thread secret is unavailable right now.",
            );
            return { refused: "unavailable" };
          }
          // Re-verify the password field and prompt identity before spending
          // the handle so a UI or title change while approval waited never
          // consumes or types the secret into an unapproved prompt.
          const verified = await desktop.inspectSecretTarget(
            action.owner,
            {
              observationId: action.secret.command.observationId,
              elementIndex: action.secret.command.elementIndex,
            },
            secretSignal,
          );
          if (secretSignal.aborted) {
            action.result = { kind: "cancelled" };
            return { refused: "cancelled" };
          }
          if (verified.kind !== "secure-target") {
            action.result =
              verified.reason === "cancelled"
                ? { kind: "cancelled" }
                : refused(verified.reason, verified.message);
            return { refused: verified.reason };
          }
          if (
            verified.appId !== action.appId ||
            verified.windowId !== action.secret.windowId ||
            verified.windowTitle !== action.secret.windowTitle
          ) {
            action.result = refused(
              "stale-observation",
              "The password prompt changed before typing. Observe the window again.",
            );
            return { refused: "stale-observation" };
          }
          const redeemed = await secrets.redeem({
            consumerId: COMPUTER_USE_SECRET_CONSUMER.id,
            caller: action.secret.caller,
            handle: action.secret.command.handle,
            signal: secretSignal,
          });
          if (redeemed.status === "refused") {
            action.result = refused(redeemed.failure, SECRET_FAILURE_MESSAGES[redeemed.failure]);
            return { refused: redeemed.failure };
          }
          try {
            if (secretSignal.aborted) {
              action.result = { kind: "cancelled" };
              return { refused: "cancelled" };
            }
            const typed = await desktop.typeSecret(
              action.owner,
              {
                observationId: action.secret.command.observationId,
                elementIndex: action.secret.command.elementIndex,
                text: redeemed.value,
              },
              secretSignal,
            );
            if (typed.kind === "typed") {
              action.result = { kind: "typed" };
              return { reference: `computer-action-${request.actionId}` };
            }
            if (
              typed.kind === "cancelled" ||
              (typed.kind === "refused" && typed.reason === "cancelled")
            ) {
              action.result = { kind: "cancelled" };
              return { refused: "cancelled" };
            }
            if (typed.kind === "refused" || typed.kind === "failed") {
              action.result = refused(typed.reason, typed.message);
              return { refused: typed.reason };
            }
            action.result = refused(
              "driver-unavailable",
              "Computer use could not verify typing the secret.",
            );
            return { refused: "driver-unavailable" };
          } finally {
            redeemed.done();
          }
        }
        if (action.command === undefined) return { refused: "invalid-command" };
        action.result = await dispatch(action.owner, action.command, signal);
        if (action.result.kind === "failed" || action.result.kind === "refused")
          return { refused: action.result.reason };
        return { reference: `computer-action-${request.actionId}` };
      },
      cleanup: async () => true,
    },
  });

  async function execute(
    owner: ComputerUseOwner,
    command: ComputerControlCommand,
    signal?: AbortSignal,
    ask?: ComputerUseThreadAsk,
    reason?: string,
  ): Promise<ComputerControlResult> {
    if (command.operation === "stop") {
      for (const action of pending.values()) {
        if (ownerKey(action.owner) === ownerKey(owner)) {
          await runtime.stop({
            ownerWindowId: owner.windowId,
            threadId: owner.threadId,
            authority: action.authority,
            sessionId: action.sessionId,
          });
        }
      }
      for (const [id, observed] of observations)
        if (ownerKey(observed.owner) === ownerKey(owner)) observations.delete(id);
      for (const grant of grants.keys())
        if (grant.startsWith(`${ownerKey(owner)}:`)) grants.delete(grant);
      await releaseReservation(owner);
      owners.delete(ownerKey(owner));
      return { kind: "stopped" };
    }
    // This Mac's driver checks a typed field against its accessibility
    // element, which keyboard-focus input would skip; only a disposable
    // desktop, which has no elements, takes it.
    if (
      owner.leaseId === undefined &&
      (command.operation === "type" || command.operation === "press") &&
      !("elementIndex" in command)
    )
      return refused(
        "unsupported",
        "On this Mac, type and press need an observed element's elementIndex.",
      );
    if (signal?.aborted) return refused("cancelled", "Computer use was cancelled.");
    const authority = options.authority(owner);
    if (
      !options.settings().enabled ||
      !options.ownerIsCurrent(owner) ||
      owner.executionPolicy === "plan" ||
      authority === undefined ||
      !admitted(owner, false)
    )
      return refused(
        "unavailable",
        "Computer use is unavailable for this task's current authority.",
      );
    const previous = owners.get(ownerKey(owner));
    if (previous !== undefined && !sameToolActionAuthority(previous.authority, authority))
      await execute(owner, { operation: "stop" });
    if (owner.leaseId === undefined) {
      if (options.desktop === undefined) return NO_DESTINATION;
      // A host with no screen of its own has no macOS permission to grant, so
      // its refusal names the desktop the thread needs instead.
      if (options.destination?.().status === "leasable") return NO_LIVE_DESKTOP;
      await options.desktop.configure(options.settings());
      if (!(await options.desktop.reserve(owner))) {
        const status = await options.desktop.status();
        if (
          !status.permissions.accessibility ||
          !status.permissions.screenRecording ||
          status.driver === "unavailable" ||
          status.driver === "failed"
        )
          return refused(
            "setup-required",
            status.message ?? "Check the driver and macOS permissions in Computer use settings.",
          );
        return refused(
          "not-permitted",
          options.asksFromPairedWindow?.(owner)
            ? "Keep the Mac desktop open in this thread and hand control back to the agent."
            : "Computer use could not reserve this window. Check whether a person has control of the desktop.",
        );
      }
    }
    if (signal?.aborted) {
      await releaseReservation(owner);
      return refused("cancelled", "Computer use was cancelled.");
    }
    owners.set(ownerKey(owner), { owner, authority });
    if (command.operation === "apps") return dispatch(owner, command, signal);
    const observed =
      "observationId" in command ? observations.get(command.observationId) : undefined;
    const appId =
      "appId" in command
        ? command.appId
        : observed !== undefined && ownerKey(observed.owner) === ownerKey(owner)
          ? observed.appId
          : undefined;
    if (appId === undefined)
      return refused(
        "stale-observation",
        "Observe this task's application window again before acting.",
      );
    const actionId = randomUUID();
    const sessionId = randomUUID();
    const commandKind: ComputerUseActionKind =
      command.operation === "type"
        ? "type-text"
        : command.operation === "press"
          ? "key-press"
          : command.operation === "click" || command.operation === "scroll"
            ? command.operation
            : "observe-window";
    const grantKey = `${ownerKey(owner)}:${JSON.stringify(authority)}:${appId}`;
    const approval = decideComputerUseApproval({
      plan: false,
      fullAccess: options.fullAccess(owner),
      strict: options.strict?.(owner) ?? true,
      externalContentIngested: options.externalContentIngested(owner),
      hasThreadGrant: grants.has(grantKey),
      hasProjectGrant:
        owner.leaseId === undefined &&
        authority.projectId !== undefined &&
        options.projectAppRemembered?.(authority.projectId, appId) === true,
      hasProjectScope:
        owner.leaseId === undefined &&
        authority.projectId !== undefined &&
        options.rememberProjectApp !== undefined,
    });
    if (approval.kind === "refused") {
      return refused(
        "unavailable",
        "Computer use is unavailable for this task's current authority.",
      );
    }
    const requiresApproval = approval.kind === "required";
    const action = {
      owner,
      command,
      appId,
      sessionId,
      authority,
      oneTimeOnly: approval.kind === "required" && approval.scope === "one-time",
      canRememberForProject: approval.kind === "required" && approval.canRememberForProject,
      ...(reason === undefined ? {} : { reason }),
    };
    pending.set(actionId, action);
    // A desktop's approval is also asked in the thread, where any client that
    // may open the thread can answer it; whichever answer lands first decides.
    let askingInThread: AbortController | undefined;
    try {
      let view = await runtime.start({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        requestedBy: decodeEventActor({
          kind: "agent",
          actorId: owner.providerInstanceId,
          providerInstanceId: owner.providerInstanceId,
          threadId: owner.threadId,
        }),
        request: decodeComputerUseActionRequest({
          actionId,
          sessionId,
          correlationId: randomUUID(),
          authority,
          kind: commandKind,
          visibility: "visible",
          target: appId,
        }),
        policy: {
          allowlist: [{ actionKind: commandKind, targetApp: appId, requiresApproval }],
          sensitiveFieldProtection: true,
          visibleStopControl: true,
          maxSessionDurationMs: 5 * 60_000,
          processOwnershipRequired: true,
        },
      });
      if (!("state" in view))
        return refused("unavailable", "No computer-use destination is available.");
      while (view.state === "waiting-for-approval" || view.state === "running") {
        if (signal?.aborted || !options.ownerIsCurrent(owner) || !options.settings().enabled) {
          await runtime.stop({
            ownerWindowId: owner.windowId,
            threadId: owner.threadId,
            authority,
            sessionId,
          });
          await releaseReservation(owner);
          return refused("cancelled", "Computer use was cancelled or its task authority changed.");
        }
        const pendingApproval = view.pendingApproval;
        if (
          ask !== undefined &&
          askingInThread === undefined &&
          view.state === "waiting-for-approval" &&
          pendingApproval !== undefined
        ) {
          const asking = new AbortController();
          askingInThread = asking;
          void ask(pendingApproval.summary, asking.signal).then(async (answer) => {
            // Withdrawn because the session moved on, or answered elsewhere.
            if (asking.signal.aborted) return;
            const scope = {
              ownerWindowId: owner.windowId,
              threadId: owner.threadId,
              authority,
              sessionId,
            };
            await (
              answer === "approved" || answer === "denied"
                ? runtime.decide({
                    ...scope,
                    actionId: pendingApproval.actionId,
                    approvalId: pendingApproval.approvalId,
                    decision: answer,
                  })
                : runtime.stop(scope)
            ).catch(() => undefined);
          });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        const current = runtime.inspect({
          ownerWindowId: owner.windowId,
          threadId: owner.threadId,
          authority,
          sessionId,
        });
        if (current === undefined) return refused("expired", "Computer-use approval expired.");
        view = current;
      }
      const result = pending.get(actionId)?.result;
      if (view.state !== "completed" || result === undefined) {
        await releaseReservation(owner);
        const failure = view.events.findLast(
          (event) =>
            event.kind === "session-failed" ||
            event.kind === "approval-denied" ||
            event.kind === "session-interrupted",
        );
        const refusalCode =
          failure?.kind === "session-interrupted"
            ? "cancelled"
            : failure?.kind === "session-failed" || failure?.kind === "approval-denied"
              ? "not-approved"
              : undefined;
        return (
          result ??
          refused(
            refusalCode ?? "not-approved",
            failure?.detail ?? "Computer use was denied, expired, or interrupted.",
          )
        );
      }
      if (requiresApproval && !action.oneTimeOnly) {
        if (view.events.some((event) => event.kind === "approval-approved"))
          grants.set(grantKey, { appId, leaseId: owner.leaseId });
      }
      if (result.kind === "observation") {
        if (observations.size >= 256) observations.clear();
        observations.set(String(result.observationId), { owner, appId });
      }
      return result;
    } finally {
      askingInThread?.abort();
      pending.delete(actionId);
    }
  }

  /**
   * Redeems a one-use thread-secret handle in host memory and types its value
   * into an observed, verified password field. Never returns the value or a
   * screenshot, and asks once per use below Full access or under Strict.
   */
  async function typeSecret(
    owner: ComputerUseOwner,
    command: ComputerTypeSecretCommand,
    caller: ThreadSecretCaller,
    signal?: AbortSignal,
    ask?: ComputerUseThreadAsk,
    reason?: string,
  ): Promise<ComputerControlResult> {
    if (signal?.aborted || caller.signal.aborted) return { kind: "cancelled" };
    if (owner.leaseId !== undefined)
      return refused(
        "unsupported",
        "Typing a thread secret is not supported on disposable desktops.",
      );
    if (owner.mode === "chat")
      return refused("unsupported", "Chat threads do not hold thread secrets.");
    const authority = options.authority(owner);
    if (
      !options.settings().enabled ||
      !options.ownerIsCurrent(owner) ||
      owner.executionPolicy === "plan" ||
      authority === undefined ||
      !admitted(owner, false)
    )
      return refused(
        "unavailable",
        "Computer use is unavailable for this task's current authority.",
      );
    const secrets = options.threadSecrets?.();
    const desktop = options.desktop;
    if (
      secrets === undefined ||
      desktop?.inspectSecretTarget === undefined ||
      desktop.typeSecret === undefined
    )
      return refused("unavailable", "Typing a thread secret is unavailable on this host.");
    if (options.destination?.().status === "leasable") return NO_LIVE_DESKTOP;
    syncSecretConsumer();
    const previous = owners.get(ownerKey(owner));
    if (previous !== undefined && !sameToolActionAuthority(previous.authority, authority))
      await execute(owner, { operation: "stop" });
    await desktop.configure(options.settings());
    if (!(await desktop.reserve(owner))) {
      const status = await desktop.status();
      if (
        !status.permissions.accessibility ||
        !status.permissions.screenRecording ||
        status.driver === "unavailable" ||
        status.driver === "failed"
      )
        return refused(
          "setup-required",
          status.message ?? "Check the driver and macOS permissions in Computer use settings.",
        );
      return refused(
        "not-permitted",
        options.asksFromPairedWindow?.(owner)
          ? "Keep the Mac desktop open in this thread and hand control back to the agent."
          : "Computer use could not reserve this window. Check whether a person has control of the desktop.",
      );
    }
    if (signal?.aborted || caller.signal.aborted) {
      await releaseReservation(owner);
      return { kind: "cancelled" };
    }
    owners.set(ownerKey(owner), { owner, authority });
    const observed = observations.get(String(command.observationId));
    if (observed === undefined || ownerKey(observed.owner) !== ownerKey(owner))
      return refused(
        "stale-observation",
        "Observe this task's application window again before typing a secret.",
      );
    const checkSignal =
      signal === undefined ? caller.signal : AbortSignal.any([signal, caller.signal]);
    // Verify the handle and password field before asking the person or spending
    // the handle, so a spent handle or visible text box never prompts or reads
    // the secret value.
    const inspectedHandle = secrets.inspectHandle({
      consumerId: COMPUTER_USE_SECRET_CONSUMER.id,
      caller,
      handle: command.handle,
      signal: checkSignal,
    });
    if (inspectedHandle.status === "refused")
      return refused(inspectedHandle.failure, SECRET_FAILURE_MESSAGES[inspectedHandle.failure]);
    const target = await desktop.inspectSecretTarget(
      owner,
      { observationId: command.observationId, elementIndex: command.elementIndex },
      checkSignal,
    );
    if (target.kind !== "secure-target")
      return target.reason === "cancelled"
        ? { kind: "cancelled" }
        : refused(target.reason, target.message);
    if (target.appId !== observed.appId)
      return refused(
        "stale-observation",
        "The observed application changed. Observe the window again.",
      );
    const approval = decideComputerUseApproval({
      plan: false,
      fullAccess: options.fullAccess(owner),
      strict: options.strict?.(owner) ?? true,
      externalContentIngested: options.externalContentIngested(owner),
      hasThreadGrant: false,
      hasProjectGrant: false,
      hasProjectScope: false,
      secretInput: true,
    });
    if (approval.kind === "refused")
      return refused(
        "unavailable",
        "Computer use is unavailable for this task's current authority.",
      );
    const requiresApproval = approval.kind === "required";
    const actionId = randomUUID();
    const sessionId = randomUUID();
    pending.set(actionId, {
      owner,
      secret: {
        command,
        caller,
        label: inspectedHandle.label,
        windowId: target.windowId,
        windowTitle: target.windowTitle,
        signal: checkSignal,
        requiresApproval,
      },
      appId: target.appId,
      sessionId,
      authority,
      oneTimeOnly: true,
      canRememberForProject: false,
      ...(reason === undefined ? {} : { reason }),
    });
    let askingInThread: AbortController | undefined;
    try {
      let view = await runtime.start({
        ownerWindowId: owner.windowId,
        threadId: owner.threadId,
        requestedBy: decodeEventActor({
          kind: "agent",
          actorId: owner.providerInstanceId,
          providerInstanceId: owner.providerInstanceId,
          threadId: owner.threadId,
        }),
        request: decodeComputerUseActionRequest({
          actionId,
          sessionId,
          correlationId: randomUUID(),
          authority,
          kind: "type-secret",
          visibility: "visible",
          target: target.appId,
        }),
        policy: {
          allowlist: [{ actionKind: "type-secret", targetApp: target.appId, requiresApproval }],
          sensitiveFieldProtection: true,
          visibleStopControl: true,
          maxSessionDurationMs: 5 * 60_000,
          processOwnershipRequired: true,
        },
      });
      if (!("state" in view))
        return refused("unavailable", "No computer-use destination is available.");
      while (view.state === "waiting-for-approval" || view.state === "running") {
        if (checkSignal.aborted || !options.ownerIsCurrent(owner) || !options.settings().enabled) {
          await runtime.stop({
            ownerWindowId: owner.windowId,
            threadId: owner.threadId,
            authority,
            sessionId,
          });
          await releaseReservation(owner);
          return { kind: "cancelled" };
        }
        const pendingApproval = view.pendingApproval;
        if (
          ask !== undefined &&
          askingInThread === undefined &&
          view.state === "waiting-for-approval" &&
          pendingApproval !== undefined
        ) {
          const asking = new AbortController();
          askingInThread = asking;
          void ask(pendingApproval.summary, asking.signal).then(async (answer) => {
            if (asking.signal.aborted) return;
            const scope = {
              ownerWindowId: owner.windowId,
              threadId: owner.threadId,
              authority,
              sessionId,
            };
            await (
              answer === "approved" || answer === "denied"
                ? runtime.decide({
                    ...scope,
                    actionId: pendingApproval.actionId,
                    approvalId: pendingApproval.approvalId,
                    decision: answer,
                  })
                : runtime.stop(scope)
            ).catch(() => undefined);
          });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        const current = runtime.inspect({
          ownerWindowId: owner.windowId,
          threadId: owner.threadId,
          authority,
          sessionId,
        });
        if (current === undefined) return refused("expired", "Computer-use approval expired.");
        view = current;
      }
      const result = pending.get(actionId)?.result;
      if (view.state !== "completed" || result === undefined) {
        await releaseReservation(owner);
        if (result?.kind === "cancelled") return { kind: "cancelled" };
        const failure = view.events.findLast(
          (event) =>
            event.kind === "session-failed" ||
            event.kind === "approval-denied" ||
            event.kind === "session-interrupted",
        );
        if (failure?.kind === "session-interrupted") return { kind: "cancelled" };
        if (result?.kind === "refused" || result?.kind === "failed")
          return refused(result.reason, result.message);
        return refused(
          "not-approved",
          failure?.detail ?? "Computer use was denied, expired, or interrupted.",
        );
      }
      observations.delete(String(command.observationId));
      return result.kind === "typed"
        ? result
        : refused("driver-unavailable", "Computer use could not verify typing the secret.");
    } finally {
      askingInThread?.abort();
      pending.delete(actionId);
    }
  }

  /**
   * An agent's transfer into its bound desktop. The lease service reads and
   * hashes the file first and decides whether anyone is asked: nobody at Full
   * access, and below it once per thread, or once per Project when the person
   * chose "Remember for this Project", for a desktop on this machine. When it
   * asks, the question goes to this turn's thread with the path, size, hash,
   * and where the file goes.
   *
   * Under Strict, a Project's answer neither covers nor is offered on a
   * thread that has read outside content, as the first action withholds
   * Project remembering there. Outside Strict the mark adds no restriction
   * of its own ("Octant adds no restrictions of its own unless Strict is
   * on").
   */
  async function sendFile(
    owner: ComputerUseOwner,
    path: string,
    ask: ComputerUseThreadAsk,
    signal?: AbortSignal,
  ): Promise<ComputerControlResult> {
    if (signal?.aborted) return refused("cancelled", "Computer use was cancelled.");
    if (
      owner.leaseId === undefined ||
      options.leases === undefined ||
      !options.settings().enabled ||
      !options.ownerIsCurrent(owner) ||
      owner.executionPolicy === "plan" ||
      options.authority(owner) === undefined ||
      !admitted(owner, false)
    )
      return refused(
        "unavailable",
        "Computer use is unavailable for this task's current authority.",
      );
    const decided = decideDesktopArtifactPath(path);
    if (decided.kind === "relative") endDesktopAppGrants(owner, decided.name);
    // The lease service reads this as "the thread is marked" for its own
    // answer: only under Strict does a mark withdraw an earlier answer
    // (maintainer decision, 2026-11-22).
    const markedAtStart = outsideContentGates(owner);
    const projectAt = (): ProjectId | undefined =>
      outsideContentGates(owner) ? undefined : options.authority(owner)?.projectId;
    const projectAtStart = projectAt();
    try {
      return await options.leases.sendFile(
        owner,
        path,
        async (request) => {
          const { artifact, provider } = request;
          // A file leaving the machine is asked about every time; one that
          // stays on it is asked about once for the thread, and the card
          // says which answer the person is giving.
          const covers =
            request.asks === "off-machine"
              ? ` This sends the file off this machine to ${provider.displayName}.`
              : " Approving also covers this thread's later files into that desktop.";
          const summary = `Send ${artifact.path.slice(0, 512)} (${artifact.size} bytes, SHA-256 ${artifact.sha256}) into ${DESKTOP_LABEL} on ${provider.displayName.slice(0, 128)} for "${options.threadTitle(owner).slice(0, 100)}"?${covers}`;
          // A Project's answer covers only desktops on this machine, so a
          // cloud desktop's ask never offers one it could not keep.
          const offersProject =
            request.asks === "in-thread" &&
            provider.locality === "host-local" &&
            projectAtStart !== undefined &&
            options.rememberProjectFileTransfer !== undefined;
          const answer = await ask(
            summary,
            signal,
            offersProject ? { canRememberForProject: true } : undefined,
          );
          if (typeof answer !== "object") return answer === "approved" ? "approved" : "declined";
          // Persisted only while the ask still stands as it was offered: the
          // same Project, an unmarked thread, and an owner that may still act.
          const projectNow = projectAt();
          if (
            !offersProject ||
            projectNow === undefined ||
            String(projectNow) !== String(projectAtStart) ||
            options.rememberProjectFileTransfer === undefined ||
            !options.settings().enabled ||
            !options.ownerIsCurrent(owner) ||
            !admitted(owner, false)
          )
            return "declined";
          try {
            await options.rememberProjectFileTransfer({
              projectId: projectNow,
              approver: answer.approver,
            });
          } catch {
            return "declined";
          }
          return "approved";
        },
        markedAtStart,
        projectAtStart !== undefined &&
          options.projectFileTransferRemembered?.(projectAtStart) === true,
      );
    } finally {
      // Again once the send settles: an approval answered while the bytes were
      // on their way must not stand for what landed.
      if (decided.kind === "relative") endDesktopAppGrants(owner, decided.name);
    }
  }

  /**
   * An agent's extension of its bound desktop's lease. The lease service
   * decides whether an agent may extend it at all and whether anyone is
   * asked; when it asks, the question goes to this turn's thread with the
   * minutes and the time the desktop would then end.
   */
  async function extendLease(
    owner: ComputerUseOwner,
    minutes: number,
    ask: ComputerUseThreadAsk,
    signal?: AbortSignal,
  ): Promise<ComputerControlResult> {
    if (signal?.aborted) return refused("cancelled", "Computer use was cancelled.");
    if (
      owner.leaseId === undefined ||
      options.leases === undefined ||
      !options.settings().enabled ||
      !options.ownerIsCurrent(owner) ||
      owner.executionPolicy === "plan" ||
      options.authority(owner) === undefined ||
      !admitted(owner, false)
    )
      return refused(
        "unavailable",
        "Computer use is unavailable for this task's current authority.",
      );
    return options.leases.extend(owner, minutes, async (request) => {
      const summary = `Keep ${DESKTOP_LABEL} on ${request.provider.displayName.slice(0, 128)} running ${request.byMinutes} more minutes, until ${request.expiresAt}, for "${options.threadTitle(owner).slice(0, 100)}"?`;
      return (await ask(summary, signal)) === "approved" ? "approved" : "declined";
    });
  }

  /**
   * A desktop app is the inbox file of its name, so a file sent under that
   * name may be a different program than the one a person allowed. Every
   * grant for the name on that lease ends, whichever turn or window holds it,
   * and whether or not the send is confirmed: a send cut off midway may still
   * have replaced the file.
   */
  function endDesktopAppGrants(owner: ComputerUseOwner, appId: string): void {
    for (const [key, grant] of grants)
      if (
        grant.leaseId !== undefined &&
        String(grant.leaseId) === String(owner.leaseId) &&
        grant.appId === appId
      )
        grants.delete(key);
  }

  return {
    runtime:
      options.destination === undefined
        ? runtime
        : { ...runtime, destination: options.destination },
    syncSecretConsumer,
    sweep: async () => {
      syncSecretConsumer();
      for (const action of pending.values()) {
        const current = options.authority(action.owner);
        if (
          !options.settings().enabled ||
          !options.ownerIsCurrent(action.owner) ||
          current === undefined ||
          !sameToolActionAuthority(current, action.authority)
        )
          await runtime.stop({
            ownerWindowId: action.owner.windowId,
            threadId: action.owner.threadId,
            authority: action.authority,
            sessionId: action.sessionId,
          });
      }
      await Promise.all(
        [...owners.values()]
          .filter(({ owner, authority }) => {
            const current = options.authority(owner);
            return (
              !options.settings().enabled ||
              !options.ownerIsCurrent(owner) ||
              current === undefined ||
              !sameToolActionAuthority(authority, current)
            );
          })
          .map(({ owner }) => execute(owner, { operation: "stop" })),
      );
    },
    revokeWindow: async (windowId: ComputerUseOwner["windowId"]) => {
      await runtime.revokeWindow(windowId);
      await Promise.all(
        [...owners.values()]
          .filter(({ owner }) => owner.windowId === windowId)
          .map(({ owner }) => execute(owner, { operation: "stop" })),
      );
    },
    /**
     * The turn's `octant_computer`, offered on every eligible turn without a
     * composer selection and bound at admission to the send's destination:
     * this Mac, or the owner's `leaseId`, one of the thread's disposable
     * desktops. A desktop binding needs `ask`, the turn's way to ask its
     * person in the thread, and refuses a lease that is not the thread's own
     * or not running. A turn that cannot use the tool gets no definition at
     * all: with the plugin disabled, in Plan, with the tool constrained out,
     * or with no screen to drive, the agent is never told it exists.
     */
    toolSet: (
      rawOwner: ComputerUseOwner,
      imagesSupported: boolean = true,
      ask?: ComputerUseThreadAsk,
      turnId?: string,
    ): AppManagedToolSet | undefined => {
      const owner = decodeComputerUseOwner(rawOwner);
      if (
        !options.settings().enabled ||
        owner.executionPolicy === "plan" ||
        !isToolAllowedByAllowlist(options.toolConstraints(owner), "octant_computer")
      )
        return undefined;
      const leases = options.leases;
      const onDesktop = owner.leaseId !== undefined;
      if (
        onDesktop
          ? leases === undefined || ask === undefined || !leases.bindable(owner)
          : options.desktop === undefined
      )
        return undefined;
      syncSecretConsumer();
      const boundAuthority = options.authority(owner);
      const authorityChanged = (): boolean => {
        const current = options.authority(owner);
        return (
          boundAuthority === undefined ||
          current === undefined ||
          !sameToolActionAuthority(boundAuthority, current)
        );
      };
      // A desktop shows only a screenshot, so a model that cannot see one has
      // nothing to act on there.
      const needsImageModel = onDesktop && !imagesSupported;
      const imageModelRefusal = refused(
        "needs-image-model",
        "This desktop has no accessibility elements, only screenshots. Select a vision-capable model to use it.",
      );
      const ownerChangedRefusal = refused(
        "owner-changed",
        "The task's computer-use authority changed.",
      );
      const lifetime = new AbortController();
      const secretTurnId = turnId ?? randomUUID();
      const secretCaller: ThreadSecretCaller = {
        windowId: String(owner.windowId),
        threadId: owner.threadId,
        turnId: secretTurnId,
        authority: () => {
          if (
            authorityChanged() ||
            !options.ownerIsCurrent(owner) ||
            owner.executionPolicy === "plan"
          )
            return undefined;
          return {
            mode: owner.mode,
            strict: options.strict?.(owner) ?? true,
            commandsConfined: false,
          };
        },
        signal: lifetime.signal,
      };
      const supportsSecretTyping =
        !onDesktop &&
        (owner.mode === "code" || owner.mode === "work") &&
        options.threadSecrets?.() !== undefined &&
        options.desktop?.inspectSecretTarget !== undefined &&
        options.desktop?.typeSecret !== undefined;
      const plugin = createComputerUsePlugin({
        execute: (command, signal, request) => {
          if (needsImageModel && command.operation !== "stop")
            return Promise.resolve(imageModelRefusal);
          if (!imagesSupported && command.operation === "click" && "x" in command)
            return Promise.resolve(
              refused(
                "image-input-unavailable",
                "This model does not accept image observations. Use the observed accessibility elements or select a vision-capable model.",
              ),
            );
          // A remote operator answers in the paired thread.
          return authorityChanged()
            ? Promise.resolve(ownerChangedRefusal)
            : execute(
                owner,
                command,
                signal,
                onDesktop || options.asksFromPairedWindow?.(owner) ? ask : undefined,
                request?.reason,
              );
        },
        ...(supportsSecretTyping
          ? {
              typeSecret: (command, signal, request) =>
                authorityChanged()
                  ? Promise.resolve(ownerChangedRefusal)
                  : typeSecret(
                      owner,
                      command,
                      secretCaller,
                      signal,
                      options.asksFromPairedWindow?.(owner) ? ask : undefined,
                      request?.reason,
                    ),
            }
          : {}),
        ...(onDesktop && ask !== undefined
          ? {
              disposableDesktop: {
                sendFile: (path: string, signal?: AbortSignal) => {
                  if (needsImageModel) return Promise.resolve(imageModelRefusal);
                  return authorityChanged()
                    ? Promise.resolve(ownerChangedRefusal)
                    : sendFile(owner, path, ask, signal);
                },
                extend: (minutes: number, signal?: AbortSignal) => {
                  if (needsImageModel) return Promise.resolve(imageModelRefusal);
                  return authorityChanged()
                    ? Promise.resolve(ownerChangedRefusal)
                    : extendLease(owner, minutes, ask, signal);
                },
              },
            }
          : {}),
      });
      const inFlight = new Set<Promise<ComputerControlResult>>();
      let closing: Promise<void> | undefined;
      return {
        definitions: plugin.definitions,
        close: () => {
          closing ??= (async () => {
            lifetime.abort();
            // A completed turn releases its tool handle, not the task's app grant.
            // Interrupted work still revokes pending approval and stops native input.
            if (inFlight.size > 0) await execute(owner, { operation: "stop" });
            await Promise.allSettled(inFlight);
          })();
          return closing;
        },
        execute: async (input) => {
          if (closing !== undefined) return { result: { error: "tool-closed" }, isError: true };
          const execution = plugin.execute({
            ...input,
            signal:
              input.signal === undefined
                ? lifetime.signal
                : AbortSignal.any([lifetime.signal, input.signal]),
          });
          inFlight.add(execution);
          let result: ComputerControlResult;
          try {
            result = await execution;
          } finally {
            inFlight.delete(execution);
          }
          if (result.kind === "observation" && result.image !== undefined) {
            const { image, ...observation } = result;
            return { result: observation, ...(imagesSupported ? { images: [image] } : {}) };
          }
          return {
            result,
            isError:
              result.kind === "refused" || result.kind === "failed" || result.kind === "cancelled",
          };
        },
      };
    },
    close: async () => {
      closed = true;
      syncSecretConsumer();
      grants.clear();
      observations.clear();
      await runtime.close();
      await Promise.all([...owners.values()].map(({ owner }) => releaseReservation(owner)));
      owners.clear();
    },
  };
}
export type ComputerUseToolService = ReturnType<typeof createComputerUseToolService>;

import { createHash, randomUUID } from "node:crypto";
import {
  decodeComputerUseOwner,
  type ComputerControlCommand,
  type ComputerControlResult,
  type ComputerUseOwner,
  type ComputerUseSettings,
} from "@octant/contracts/computer-use-plugin";
import {
  decodeComputerUseActionRequest,
  decodeToolActionRequest,
  decodeEventActor,
  sameToolActionAuthority,
  type ApprovalOutsideContent,
  type ComputerUseActionKind,
  type ToolActionAuthority,
} from "@octant/contracts";
import { decideDesktopArtifactPath, isToolAllowedByAllowlist } from "@octant/domain";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { createComputerUsePlugin } from "../plugins/computerUse/computerUsePlugin";
import {
  createComputerUseRuntime,
  type ComputerUseDestinationReport,
  type ComputerUseEvidenceEvent,
} from "./computerUseRuntime";
import type { DesktopComputerUsePort } from "./desktopComputerUsePort";
import type { LeasedComputerUsePort } from "./desktopLeaseService";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";

const refused = (reason: string, message: string): ComputerControlResult => ({
  kind: "refused",
  reason,
  message,
});
const NO_DESTINATION = refused("no-destination", "No computer-use destination is available.");
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

/** How a turn asks its person, in the thread, to allow one thing. */
export type ComputerUseThreadAsk = (
  summary: string,
  signal?: AbortSignal,
) => Promise<"approved" | "denied" | "cancelled" | "expired">;

export function createComputerUseToolService(options: {
  /** This Mac's driver; absent on a host with no screen of its own. */
  readonly desktop?: DesktopComputerUsePort;
  /** The thread's disposable desktops; absent on a host that cannot lease one. */
  readonly leases?: LeasedComputerUsePort;
  /**
   * What the host reports as its destination. The service's own sessions
   * start only once a send has bound one, so its runtime always admits them;
   * a host whose only option is a lease still reports itself leasable.
   */
  readonly destination?: () => ComputerUseDestinationReport;
  readonly settings: () => ComputerUseSettings;
  readonly authority: (owner: ComputerUseOwner) => ToolActionAuthority | undefined;
  readonly ownerIsCurrent: (owner: ComputerUseOwner) => boolean;
  readonly toolConstraints: (owner: ComputerUseOwner) => ReadonlyArray<string>;
  readonly externalContentIngested: (owner: ComputerUseOwner) => boolean;
  /** The sources that marked the owner's thread, read when an approval is asked. */
  readonly outsideContent?: (owner: ComputerUseOwner) => ApprovalOutsideContent | undefined;
  readonly threadTitle: (owner: ComputerUseOwner) => string;
  readonly record: (event: ComputerUseEvidenceEvent) => void | Promise<void>;
}) {
  const pending = new Map<
    string,
    {
      readonly owner: ComputerUseOwner;
      readonly command: ComputerControlCommand;
      readonly appId: string;
      readonly sessionId: string;
      readonly authority: ToolActionAuthority;
      /** The agent's stated reason, shown on the approval this action asks. */
      readonly reason?: string;
      result?: ComputerControlResult;
    }
  >();
  const owners = new Map<
    string,
    {
      readonly owner: ComputerUseOwner;
      readonly authority: ToolActionAuthority;
      readonly expiresAt: number;
    }
  >();
  const observations = new Map<
    string,
    { readonly owner: ComputerUseOwner; readonly appId: string }
  >();
  /** Five-minute app grants, keyed by owner, authority, and app. */
  const grants = new Map<
    string,
    {
      readonly appId: string;
      readonly leaseId: ComputerUseOwner["leaseId"];
      readonly expiresAt: number;
    }
  >();
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
        externalContentIngested: options.externalContentIngested(owner),
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
    // Once the thread has ingested external content no standing grant carries
    // an action (see `requiresApproval` below), so the offer is for this one
    // action: saying five minutes there promised a grant the next action
    // would not honour.
    approvalScope: (request) => {
      const action = pending.get(String(request.actionId));
      return action !== undefined && options.externalContentIngested(action.owner)
        ? undefined
        : "application-session";
    },
    // Both surfaces and the approval summary say five minutes; the runtime's
    // own default is one. An offer that dies while still reading as a
    // five-minute grant turns a late click into a silent no-op that the agent
    // then reports as a denial.
    approvalTtlMs: 5 * 60_000,
    approvalSummary: (request) => {
      const action = pending.get(String(request.actionId));
      // A desktop app is a file the agent sent, so its name alone does not
      // say where it runs.
      const where = action?.owner.leaseId === undefined ? "" : ` on ${DESKTOP_LABEL}`;
      // Without a chip the person no longer said "use Computer" in the send,
      // so the card carries the agent's own account of why, quoted as its
      // words rather than stated as a fact.
      const reason = action?.reason === undefined ? "" : ` The agent says: "${action.reason}"`;
      if (action !== undefined && options.externalContentIngested(action.owner)) {
        return `Allow this one action in ${action.appId}${where} for "${options.threadTitle(action.owner).slice(0, 100)}".${reason}`;
      }
      return `Allow control of ${action?.appId ?? "this application"}${where} for "${action === undefined ? "this task" : options.threadTitle(action.owner).slice(0, 100)}" for 5 minutes.${reason}`;
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
    clock: () => new Date().toISOString(),
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
        const refusal = admissionRefusal(action.owner, true);
        if (refusal !== undefined) return { refused: refusal };
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
    if (
      previous !== undefined &&
      (previous.expiresAt <= Date.now() || !sameToolActionAuthority(previous.authority, authority))
    ) {
      await execute(owner, { operation: "stop" });
    }
    if (owner.leaseId === undefined) {
      if (options.desktop === undefined) return NO_DESTINATION;
      await options.desktop.configure(options.settings());
      if (!(await options.desktop.reserve(owner)))
        return refused(
          "setup-required",
          "Open Computer use in Settings to enable the plugin and grant Octant's macOS permissions.",
        );
    }
    if (signal?.aborted) {
      await releaseReservation(owner);
      return refused("cancelled", "Computer use was cancelled.");
    }
    owners.set(ownerKey(owner), {
      owner,
      authority,
      expiresAt: owners.get(ownerKey(owner))?.expiresAt ?? Date.now() + 5 * 60_000,
    });
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
    // The first action on each app in a thread always asks: no grant exists
    // until the person approves one, and the owner's execution policy is never
    // read here, so Full access skips nothing. A five-minute app grant is a
    // standing approval. Once the thread has ingested external content,
    // standing approvals no longer carry an irreversible action
    // (untrustedContentPolicy), so the runtime asks again and the person
    // confirms this action freshly.
    const requiresApproval =
      (grants.get(grantKey)?.expiresAt ?? 0) <= Date.now() ||
      options.externalContentIngested(owner);
    const action = {
      owner,
      command,
      appId,
      sessionId,
      authority,
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
      if (requiresApproval) {
        const approved = view.events.find((event) => event.kind === "approval-approved");
        if (approved !== undefined) {
          const expiresAt = Date.parse(approved.occurredAt) + 5 * 60_000;
          grants.set(grantKey, { appId, leaseId: owner.leaseId, expiresAt });
          owners.set(ownerKey(owner), { owner, authority, expiresAt });
        }
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
   * An agent's transfer into its bound desktop. The lease service reads and
   * hashes the file first and decides whether anyone is asked; when it asks,
   * the question goes to this turn's thread with the path, size, hash, and
   * where the file goes.
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
    try {
      return await options.leases.sendFile(
        owner,
        path,
        async (request) => {
          const { artifact, provider } = request;
          const offMachine =
            request.asks === "off-machine"
              ? ` This sends the file off this machine to ${provider.displayName}.`
              : "";
          const summary = `Send ${artifact.path.slice(0, 512)} (${artifact.size} bytes, SHA-256 ${artifact.sha256}) into ${DESKTOP_LABEL} on ${provider.displayName.slice(0, 128)} for "${options.threadTitle(owner).slice(0, 100)}"?${offMachine}`;
          return (await ask(summary, signal)) === "approved" ? "approved" : "declined";
        },
        options.externalContentIngested(owner),
      );
    } finally {
      // Again once the send settles: an approval answered while the bytes were
      // on their way must not stand for what landed.
      if (decided.kind === "relative") endDesktopAppGrants(owner, decided.name);
    }
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
    sweep: async () => {
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
      for (const [key, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(key);
      await Promise.all(
        [...owners.values()]
          .filter(({ owner, authority, expiresAt }) => {
            const current = options.authority(owner);
            return (
              !options.settings().enabled ||
              !options.ownerIsCurrent(owner) ||
              expiresAt <= Date.now() ||
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
          // Only a desktop's approvals go to the thread: this Mac's stay with
          // the person at this Mac.
          return authorityChanged()
            ? Promise.resolve(ownerChangedRefusal)
            : execute(owner, command, signal, onDesktop ? ask : undefined, request?.reason);
        },
        ...(onDesktop && ask !== undefined
          ? {
              disposableDesktop: {
                sendFile: (path: string, signal?: AbortSignal) => {
                  if (needsImageModel) return Promise.resolve(imageModelRefusal);
                  return authorityChanged()
                    ? Promise.resolve(ownerChangedRefusal)
                    : sendFile(owner, path, ask, signal);
                },
              },
            }
          : {}),
      });
      const lifetime = new AbortController();
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
          return { result, isError: result.kind === "refused" || result.kind === "failed" };
        },
      };
    },
    close: async () => {
      grants.clear();
      observations.clear();
      await runtime.close();
      await Promise.all([...owners.values()].map(({ owner }) => releaseReservation(owner)));
      owners.clear();
    },
  };
}
export type ComputerUseToolService = ReturnType<typeof createComputerUseToolService>;

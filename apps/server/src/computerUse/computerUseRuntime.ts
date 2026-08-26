import type {
  ComputerUseActionRequest,
  ComputerUsePolicy,
  ComputerUseSessionView,
  ComputerUseSensitiveFieldKind,
  EventActor,
  ToolActionAuthority,
  WindowId,
} from "@octant/contracts";
import { decodeComputerUseSessionView, sameToolActionAuthority } from "@octant/contracts";
import { evaluateComputerUseAction } from "@octant/domain";
import {
  refuseComputerUseDestination,
  type ComputerUseDestinationRefusal,
  type ComputerUseDestinationReport,
} from "./computerUseDestination";

export type {
  ComputerUseDestinationRefusal,
  ComputerUseDestinationReport,
} from "./computerUseDestination";
export { reportComputerUseDestination } from "./computerUseDestination";

export type ComputerUseRuntimeState =
  | "waiting-for-approval"
  | "running"
  | "stopping"
  | "stopped"
  | "interrupted"
  | "failed"
  | "completed";

export interface ComputerUseRuntimeEvent {
  readonly sequence: number;
  readonly kind:
    | "session-started"
    | "observation-recorded"
    | "approval-requested"
    | "approval-approved"
    | "approval-denied"
    | "action-started"
    | "action-completed"
    | "stop-requested"
    | "cleanup-completed"
    | "cleanup-failed"
    | "session-interrupted"
    | "session-failed";
  readonly occurredAt: string;
  readonly detail: string;
}

export interface ComputerUsePendingApproval {
  readonly approvalId: string;
  readonly actionId: string;
  readonly expiresAt: string;
  readonly summary: string;
}

export type ComputerUseRuntimeView = ComputerUseSessionView;

export interface ComputerUseNativeObservation {
  readonly targetApp: string;
  readonly windowTitle?: string;
  readonly sensitiveFieldKind?: ComputerUseSensitiveFieldKind;
  readonly stale?: boolean;
  readonly reference: string;
}

export interface ComputerUseNativeAdapter {
  readonly observe: (
    request: ComputerUseActionRequest,
    signal: AbortSignal,
  ) => Promise<ComputerUseNativeObservation>;
  readonly execute: (
    request: ComputerUseActionRequest,
    observation: ComputerUseNativeObservation,
    signal: AbortSignal,
  ) => Promise<{ readonly reference: string }>;
  readonly cleanup: (sessionId: string) => Promise<boolean>;
}

export interface ComputerUseEvidenceEvent {
  readonly sessionId: string;
  readonly actionId: string;
  readonly correlationId: string;
  readonly threadId: string;
  readonly requestedBy: EventActor;
  readonly authority: ToolActionAuthority;
  readonly event: ComputerUseRuntimeEvent;
}

export type ComputerUseStartResult = ComputerUseRuntimeView | ComputerUseDestinationRefusal;

export interface ComputerUseRuntime {
  readonly destination: () => ComputerUseDestinationReport;
  readonly start: (input: {
    readonly ownerWindowId: WindowId;
    readonly threadId: string;
    readonly requestedBy: EventActor;
    readonly request: ComputerUseActionRequest;
    readonly policy: ComputerUsePolicy;
  }) => Promise<ComputerUseStartResult>;
  readonly decide: (input: {
    readonly ownerWindowId: WindowId;
    readonly threadId: string;
    readonly authority: ToolActionAuthority;
    readonly sessionId: string;
    readonly actionId: string;
    readonly approvalId: string;
    readonly decision: "approved" | "denied";
  }) => Promise<ComputerUseRuntimeView>;
  readonly stop: (input: {
    readonly ownerWindowId: WindowId;
    readonly threadId: string;
    readonly authority: ToolActionAuthority;
    readonly sessionId: string;
  }) => Promise<ComputerUseRuntimeView>;
  readonly inspect: (input: {
    readonly ownerWindowId: WindowId;
    readonly threadId: string;
    readonly authority: ToolActionAuthority;
    readonly sessionId: string;
  }) => ComputerUseRuntimeView | undefined;
  readonly list: (ownerWindowId: WindowId) => ReadonlyArray<ComputerUseRuntimeView>;
  readonly revokeWindow: (windowId: WindowId) => Promise<void>;
  readonly close: () => Promise<void>;
}

export class ComputerUseRuntimeError extends Error {
  override readonly name = "ComputerUseRuntimeError";

  constructor(
    readonly category: "invalid" | "unauthorized" | "unavailable" | "approval-denied",
    message: string,
  ) {
    super(message);
  }
}

const TERMINAL_SESSION_RETENTION_MS = 5 * 60_000;

export function createComputerUseRuntime(_options: {
  readonly adapter?: ComputerUseNativeAdapter;
  readonly destination?: ComputerUseDestinationReport;
  readonly evidence: { readonly record: (event: ComputerUseEvidenceEvent) => void | Promise<void> };
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly approvalTtlMs?: number;
}): ComputerUseRuntime {
  const options = _options;
  const approvalTtlMs = options.approvalTtlMs ?? 60_000;
  const sessions = new Map<string, RuntimeSession>();
  const destination = (): ComputerUseDestinationReport =>
    options.destination ??
    (options.adapter === undefined
      ? { status: "unavailable", kind: "no-provider-configured" }
      : { status: "available", kind: "macos-host" });

  const append = async (
    session: RuntimeSession,
    kind: ComputerUseRuntimeEvent["kind"],
    detail: string,
  ): Promise<void> => {
    const write = session.appendTail.then(async () => {
      const event: ComputerUseRuntimeEvent = {
        sequence: session.events.length + 1,
        kind,
        occurredAt: options.clock(),
        detail,
      };
      await options.evidence.record({
        sessionId: session.request.sessionId,
        actionId: session.request.actionId,
        correlationId: session.request.correlationId,
        threadId: session.threadId,
        requestedBy: session.requestedBy,
        authority: session.authority,
        event,
      });
      session.events.push(event);
    });
    session.appendTail = write.catch(() => undefined);
    await write;
  };

  const view = (session: RuntimeSession): ComputerUseRuntimeView =>
    decodeComputerUseSessionView({
      sessionId: session.request.sessionId,
      threadId: session.threadId,
      requestedBy: session.requestedBy,
      authority: session.authority,
      state: session.state,
      sequence: session.events.length,
      ...(session.pendingApproval === undefined
        ? {}
        : { pendingApproval: { ...session.pendingApproval } }),
      events: session.events.map((event) => ({ ...event })),
    });

  const scoped = (input: {
    readonly ownerWindowId: WindowId;
    readonly threadId: string;
    readonly authority: ToolActionAuthority;
    readonly sessionId: string;
  }): RuntimeSession | undefined => {
    const session = sessions.get(input.sessionId);
    return session !== undefined &&
      session.ownerWindowId === input.ownerWindowId &&
      session.threadId === input.threadId &&
      sameToolActionAuthority(session.authority, input.authority)
      ? session
      : undefined;
  };

  const cleanup = async (session: RuntimeSession): Promise<boolean> => {
    if (session.cleaned) return true;
    session.cleaned = true;
    if (session.expirationTimer !== undefined) clearTimeout(session.expirationTimer);
    let cleaned = false;
    try {
      cleaned =
        options.adapter === undefined
          ? true
          : await options.adapter.cleanup(session.request.sessionId);
    } catch {
      cleaned = false;
    }
    try {
      await append(
        session,
        cleaned ? "cleanup-completed" : "cleanup-failed",
        cleaned ? "Owned native resources were cleaned up." : "Owned native cleanup failed.",
      );
    } catch {
      // Cleanup remains mandatory when evidence persistence is unavailable. The
      // session cannot claim completion because the caller sets a failed or
      // interrupted terminal state on an evidence error.
    }
    return cleaned;
  };

  const execute = async (session: RuntimeSession): Promise<ComputerUseRuntimeView> => {
    session.state = "running";
    const adapter = options.adapter;
    if (adapter === undefined) {
      session.state = "failed";
      await append(session, "session-failed", "Computer-use destination is unavailable.");
      await cleanup(session);
      return view(session);
    }
    try {
      const refreshed = await adapter.observe(session.request, session.controller.signal);
      if (session.controller.signal.aborted) return await finishAborted(session);
      await append(session, "observation-recorded", "Pre-action host observation refreshed.");
      if (session.controller.signal.aborted) return await finishAborted(session);
      if (
        refreshed.stale === true ||
        refreshed.targetApp !== session.observation.targetApp ||
        (refreshed.sensitiveFieldKind !== undefined &&
          (session.request.kind === "type-text" || session.request.kind === "key-press"))
      ) {
        session.state = "failed";
        await append(
          session,
          "session-failed",
          refreshed.targetApp !== session.observation.targetApp
            ? "Target app changed after approval; action was denied."
            : refreshed.stale === true
              ? "Pre-action observation was stale; action was denied."
              : "Sensitive field is protected.",
        );
        await cleanup(session);
        return view(session);
      }
      session.observation = refreshed;
      const refreshedDecision = evaluateComputerUseAction(
        session.request,
        {
          sessionId: session.request.sessionId,
          actionId: session.request.actionId,
          correlationId: session.request.correlationId,
          authority: session.request.authority,
          policy: session.policy,
          state: "active",
          approvalId: session.request.actionId as never,
          createdAt: options.clock() as never,
        },
        session.authority,
        refreshed.targetApp,
      );
      if (refreshedDecision.kind === "denied") {
        session.state = "failed";
        await append(session, "session-failed", refreshedDecision.reason);
        await cleanup(session);
        return view(session);
      }
      await append(session, "action-started", "Visible host action started.");
      if (session.controller.signal.aborted) return await finishAborted(session);
      await adapter.execute(session.request, session.observation, session.controller.signal);
      if (session.controller.signal.aborted) return await finishAborted(session);
      session.state = "completed";
      await append(session, "action-completed", "Visible host action completed.");
      if (!(await cleanup(session))) session.state = "interrupted";
      return view(session);
    } catch (error) {
      if (session.controller.signal.aborted || isAbortError(error)) {
        return await finishAborted(session);
      }
      session.state = isProcessDeath(error) ? "interrupted" : "failed";
      try {
        await append(
          session,
          session.state === "interrupted" ? "session-interrupted" : "session-failed",
          session.state === "interrupted"
            ? "Owned native action process ended before completion."
            : "Owned native action or evidence recording failed.",
        );
      } catch {
        // The failed evidence write itself is the reason execution remains
        // failed. Never proceed to the native side effect after this path.
      }
      await cleanup(session);
      return view(session);
    }
  };

  const start: ComputerUseRuntime["start"] = async (input) => {
    const refusal = refuseComputerUseDestination(destination());
    if (refusal !== undefined) return refusal;
    const adapter = options.adapter;
    if (adapter === undefined) {
      return {
        status: "refused",
        kind: "unavailable",
        reason: "no-provider-configured",
      };
    }
    if (sessions.has(input.request.sessionId)) {
      throw new ComputerUseRuntimeError("invalid", "Computer-use session already exists.");
    }
    if (
      !input.policy.sensitiveFieldProtection ||
      !input.policy.visibleStopControl ||
      !input.policy.processOwnershipRequired ||
      input.request.visibility !== "visible"
    ) {
      throw new ComputerUseRuntimeError(
        "unauthorized",
        "Computer-use requires sensitive-field protection, visible stop, owned processes, and visible actions.",
      );
    }
    const session: RuntimeSession = {
      ownerWindowId: input.ownerWindowId,
      threadId: input.threadId,
      requestedBy: input.requestedBy,
      authority: input.request.authority,
      request: input.request,
      policy: input.policy,
      state: "running",
      events: [],
      controller: new AbortController(),
      observation: { targetApp: "unobserved", reference: "unobserved" },
      pendingApproval: undefined,
      abortReason: undefined,
      abortCompletion: undefined,
      appendTail: Promise.resolve(),
      cleaned: false,
    };
    sessions.set(input.request.sessionId, session);
    await append(session, "session-started", "Visible computer-use session started.");
    session.expirationTimer = setTimeout(
      () => void expire(session),
      input.policy.maxSessionDurationMs,
    );

    try {
      session.observation = await adapter.observe(input.request, session.controller.signal);
    } catch (error) {
      if (session.controller.signal.aborted) return await finishAborted(session);
      session.state = isProcessDeath(error) ? "interrupted" : "failed";
      await append(
        session,
        session.state === "interrupted" ? "session-interrupted" : "session-failed",
        "Host observation failed before action execution.",
      );
      await cleanup(session);
      return view(session);
    }
    if (session.controller.signal.aborted) return await finishAborted(session);
    await append(
      session,
      "observation-recorded",
      session.observation.stale === true
        ? "Host observation was stale."
        : "Fresh host observation recorded.",
    );
    if (session.controller.signal.aborted) return await finishAborted(session);

    if (session.observation.stale === true) {
      session.state = "failed";
      await append(session, "session-failed", "Stale observation cannot authorize an action.");
      await cleanup(session);
      return view(session);
    }
    if (
      session.observation.sensitiveFieldKind !== undefined &&
      (input.request.kind === "type-text" || input.request.kind === "key-press")
    ) {
      session.state = "failed";
      await append(session, "session-failed", "Sensitive field is protected.");
      await cleanup(session);
      return view(session);
    }

    const approvalId = options.uuid();
    const policyDecision = evaluateComputerUseAction(
      input.request,
      {
        sessionId: input.request.sessionId,
        actionId: input.request.actionId,
        correlationId: input.request.correlationId,
        authority: input.request.authority,
        policy: input.policy,
        state: "active",
        approvalId: approvalId as never,
        createdAt: options.clock() as never,
      },
      input.request.authority,
      session.observation.targetApp,
    );
    if (policyDecision.kind === "denied") {
      session.state = "failed";
      await append(session, "session-failed", policyDecision.reason);
      await cleanup(session);
      return view(session);
    }

    const allowlistEntry = input.policy.allowlist.find(
      (entry) =>
        entry.actionKind === input.request.kind &&
        (entry.targetApp === undefined || entry.targetApp === session.observation.targetApp),
    );
    if (allowlistEntry?.requiresApproval === true) {
      session.state = "waiting-for-approval";
      session.pendingApproval = {
        approvalId,
        actionId: input.request.actionId,
        expiresAt: new Date(Date.parse(options.clock()) + approvalTtlMs).toISOString(),
        summary: `${input.request.kind} in ${session.observation.targetApp}`,
      };
      await append(session, "approval-requested", "One-time approval is required.");
      return view(session);
    }

    session.execution = execute(session);
    return await session.execution;
  };

  const decide: ComputerUseRuntime["decide"] = async (input) => {
    const session = scoped(input);
    if (session === undefined) {
      throw new ComputerUseRuntimeError(
        "unauthorized",
        "Computer-use approval does not match its client authority.",
      );
    }
    const pending = session.pendingApproval;
    if (
      session.state !== "waiting-for-approval" ||
      pending === undefined ||
      pending.approvalId !== input.approvalId ||
      pending.actionId !== input.actionId ||
      Date.parse(options.clock()) >= Date.parse(pending.expiresAt)
    ) {
      if (pending !== undefined && Date.parse(options.clock()) >= Date.parse(pending.expiresAt)) {
        session.pendingApproval = undefined;
        session.state = "failed";
        await append(session, "approval-denied", "Approval expired before use.");
      }
      throw new ComputerUseRuntimeError(
        "approval-denied",
        "Computer-use approval is stale, expired, mismatched, or already consumed.",
      );
    }
    session.pendingApproval = undefined;
    if (input.decision === "denied") {
      session.state = "stopped";
      await append(session, "approval-denied", "User denied the proposed action.");
      await cleanup(session);
      return view(session);
    }
    await append(session, "approval-approved", "User approved this action once.");
    if (session.controller.signal.aborted) return await finishAborted(session);
    session.execution = execute(session);
    return await session.execution;
  };

  const stop: ComputerUseRuntime["stop"] = async (input) => {
    const session = scoped(input);
    if (session === undefined) {
      throw new ComputerUseRuntimeError(
        "unauthorized",
        "Computer-use stop does not match its client authority.",
      );
    }
    if (isTerminal(session.state)) return view(session);
    session.pendingApproval = undefined;
    session.state = "stopping";
    await append(session, "stop-requested", "User requested an immediate stop.");
    session.abortReason = "user-requested";
    session.controller.abort();
    if (session.execution !== undefined) return await session.execution;
    session.state = "stopped";
    await cleanup(session);
    return view(session);
  };

  const close = async (): Promise<void> => {
    await Promise.all(
      [...sessions.values()].map(async (session) => {
        if (isTerminal(session.state)) return;
        session.pendingApproval = undefined;
        session.state = "stopping";
        session.abortReason = "shutdown";
        session.controller.abort();
        if (session.execution !== undefined) await session.execution;
        else {
          session.state = "interrupted";
          await append(session, "session-interrupted", "Host shutdown interrupted the session.");
          await cleanup(session);
        }
      }),
    );
  };

  const revokeWindow = async (windowId: WindowId): Promise<void> => {
    await Promise.all(
      [...sessions.values()].map(async (session) => {
        if (session.ownerWindowId !== windowId || isTerminal(session.state)) return;
        session.pendingApproval = undefined;
        session.state = "stopping";
        session.abortReason = "authority-revoked";
        session.controller.abort();
        if (session.execution !== undefined) {
          await session.execution;
          return;
        }
        session.state = "interrupted";
        await append(session, "session-interrupted", "Window authority was revoked.");
        await cleanup(session);
      }),
    );
  };

  const expire = async (session: RuntimeSession): Promise<void> => {
    if (isTerminal(session.state)) return;
    session.pendingApproval = undefined;
    session.abortReason = "timeout";
    session.state = "stopping";
    session.controller.abort();
    if (session.execution !== undefined) return;
    session.abortCompletion = (async () => {
      session.state = "interrupted";
      try {
        await append(session, "session-interrupted", "Computer-use session duration expired.");
      } catch {
        // The timeout still revokes authority and cleans up when evidence is unavailable.
      }
      await cleanup(session);
    })();
    await session.abortCompletion;
  };

  const finishAborted = async (session: RuntimeSession): Promise<ComputerUseRuntimeView> => {
    if (session.abortCompletion !== undefined) {
      await session.abortCompletion;
      return view(session);
    }
    const reason = session.abortReason;
    if (reason === "user-requested") {
      session.state = "stopped";
    } else {
      session.state = "interrupted";
      try {
        await append(
          session,
          "session-interrupted",
          reason === "timeout"
            ? "Computer-use session duration expired."
            : reason === "authority-revoked"
              ? "Window authority was revoked."
              : "Host shutdown interrupted the session.",
        );
      } catch {
        // Abort authority is already revoked; cleanup must continue.
      }
    }
    await cleanup(session);
    return view(session);
  };

  return {
    destination,
    start,
    decide,
    stop,
    inspect: (input) => {
      const session = scoped(input);
      return session === undefined ? undefined : view(session);
    },
    list: (ownerWindowId) => {
      const now = Date.parse(options.clock());
      const owned: ComputerUseRuntimeView[] = [];
      for (const [sessionId, session] of sessions) {
        const terminalAt = session.events.at(-1)?.occurredAt;
        if (
          isTerminal(session.state) &&
          terminalAt !== undefined &&
          now - Date.parse(terminalAt) > TERMINAL_SESSION_RETENTION_MS
        ) {
          sessions.delete(sessionId);
          continue;
        }
        if (session.ownerWindowId === ownerWindowId) owned.push(view(session));
      }
      return owned;
    },
    revokeWindow,
    close,
  };
}

interface RuntimeSession {
  readonly ownerWindowId: WindowId;
  readonly threadId: string;
  readonly requestedBy: EventActor;
  readonly authority: ToolActionAuthority;
  readonly request: ComputerUseActionRequest;
  readonly policy: ComputerUsePolicy;
  state: ComputerUseRuntimeState;
  readonly events: ComputerUseRuntimeEvent[];
  readonly controller: AbortController;
  observation: ComputerUseNativeObservation;
  pendingApproval: ComputerUsePendingApproval | undefined;
  execution?: Promise<ComputerUseRuntimeView>;
  expirationTimer?: ReturnType<typeof setTimeout>;
  abortReason: "user-requested" | "timeout" | "authority-revoked" | "shutdown" | undefined;
  abortCompletion: Promise<void> | undefined;
  appendTail: Promise<void>;
  cleaned: boolean;
}

function isTerminal(state: ComputerUseRuntimeState): boolean {
  return (
    state === "stopped" || state === "interrupted" || state === "failed" || state === "completed"
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isProcessDeath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    error.category === "process-died"
  );
}

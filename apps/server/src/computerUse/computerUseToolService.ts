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
  type ComputerUseActionKind,
  type ToolActionAuthority,
} from "@octant/contracts";
import { validateComputerUseSelection } from "@octant/plugin-host/computer-use";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { createComputerUsePlugin } from "../plugins/computerUse/computerUsePlugin";
import { createComputerUseRuntime, type ComputerUseEvidenceEvent } from "./computerUseRuntime";
import type { DesktopComputerUsePort } from "./desktopComputerUsePort";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";

const refused = (reason: string, message: string): ComputerControlResult => ({
  kind: "refused",
  reason,
  message,
});
const ownerKey = (owner: ComputerUseOwner) =>
  JSON.stringify([
    owner.windowId,
    owner.threadId,
    owner.mode,
    owner.providerInstanceId,
    owner.modelId,
    owner.executionPolicy,
  ]);

export function createComputerUseToolService(options: {
  readonly desktop: DesktopComputerUsePort;
  readonly settings: () => ComputerUseSettings;
  readonly authority: (owner: ComputerUseOwner) => ToolActionAuthority | undefined;
  readonly ownerIsCurrent: (owner: ComputerUseOwner) => boolean;
  readonly toolConstraints: (owner: ComputerUseOwner) => ReadonlyArray<string>;
  readonly externalContentIngested: (owner: ComputerUseOwner) => boolean;
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
  const grants = new Map<string, number>();
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
        intent: "Use the task's explicitly selected Computer use plugin.",
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
      if (action !== undefined && options.externalContentIngested(action.owner)) {
        return `Allow this one action in ${action.appId} for "${options.threadTitle(action.owner).slice(0, 100)}".`;
      }
      return `Allow control of ${action?.appId ?? "this application"} for "${action === undefined ? "this task" : options.threadTitle(action.owner).slice(0, 100)}" for 5 minutes.`;
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
        action.result = await options.desktop.execute(action.owner, action.command, signal);
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
      await options.desktop.release(owner);
      owners.delete(ownerKey(owner));
      return { kind: "stopped" };
    }
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
    await options.desktop.configure(options.settings());
    if (!(await options.desktop.reserve(owner)))
      return refused(
        "setup-required",
        "Open Computer use in Settings to enable the plugin and grant Octant's macOS permissions.",
      );
    if (signal?.aborted) {
      await options.desktop.release(owner);
      return refused("cancelled", "Computer use was cancelled.");
    }
    owners.set(ownerKey(owner), {
      owner,
      authority,
      expiresAt: owners.get(ownerKey(owner))?.expiresAt ?? Date.now() + 5 * 60_000,
    });
    if (command.operation === "apps") return options.desktop.execute(owner, command, signal);
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
    // A five-minute app grant is a standing approval. Once the thread has
    // ingested external content, standing approvals no longer carry an
    // irreversible action (untrustedContentPolicy), so the runtime asks again
    // and the person confirms this action freshly.
    const requiresApproval =
      (grants.get(grantKey) ?? 0) <= Date.now() || options.externalContentIngested(owner);
    const action = { owner, command, appId, sessionId, authority };
    pending.set(actionId, action);
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
          await options.desktop.release(owner);
          return refused("cancelled", "Computer use was cancelled or its task authority changed.");
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
        await options.desktop.release(owner);
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
          grants.set(grantKey, expiresAt);
          owners.set(ownerKey(owner), { owner, authority, expiresAt });
        }
      }
      if (result.kind === "observation") {
        if (observations.size >= 256) observations.clear();
        observations.set(String(result.observationId), { owner, appId });
      }
      return result;
    } finally {
      pending.delete(actionId);
    }
  }

  return {
    runtime,
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
      for (const [key, expiresAt] of grants) if (expiresAt <= Date.now()) grants.delete(key);
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
    toolSet: (
      rawOwner: ComputerUseOwner,
      selection: unknown,
      imagesSupported: boolean = true,
    ): AppManagedToolSet | undefined => {
      if (!validateComputerUseSelection(selection, options.settings().enabled)) return undefined;
      const owner = decodeComputerUseOwner(rawOwner);
      const boundAuthority = options.authority(owner);
      const plugin = createComputerUsePlugin({
        execute: (command, signal) => {
          if (!imagesSupported && command.operation === "click" && "x" in command)
            return Promise.resolve(
              refused(
                "image-input-unavailable",
                "This model does not accept image observations. Use the observed accessibility elements or select a vision-capable model.",
              ),
            );
          const current = options.authority(owner);
          return boundAuthority === undefined ||
            current === undefined ||
            !sameToolActionAuthority(boundAuthority, current)
            ? Promise.resolve(
                refused("owner-changed", "The task's computer-use authority changed."),
              )
            : execute(owner, command, signal);
        },
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
      await Promise.all([...owners.values()].map(({ owner }) => options.desktop.release(owner)));
      owners.clear();
    },
  };
}
export type ComputerUseToolService = ReturnType<typeof createComputerUseToolService>;

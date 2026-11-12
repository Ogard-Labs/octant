import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_GRANT_LEVELS,
  DeviceId,
  RemoteSessionId,
  StableHostId,
  type AgentGrant,
  type AgentGrantLevel,
  type AgentGrantMode,
  type PermissionMode,
} from "@octant/contracts";
import { threadAccessOf, workAccessOfPermissionMode } from "@octant/domain";
import { agentThreadPort, isAgentSnapshotRunning } from "@octant/cli/agent-tools";
import type {
  AgentToolPolicy,
  LocalControlRequest,
  LocalControlResponse,
  OpenedLocalControlSession,
} from "@octant/cli/agent-tools";
import { Schema } from "effect";
import type { AuthenticatedProductDispatchHandoff } from "../authenticatedProductRoutes";
import { createRemoteDevicePrincipal } from "../clientPrincipal";
import type { AgentAccessService } from "./agentAccessService";

const decodeHostId = Schema.decodeUnknownSync(StableHostId);
const decodeDeviceId = Schema.decodeUnknownSync(DeviceId);
const decodeSessionId = Schema.decodeUnknownSync(RemoteSessionId);

/** The origin a paired-device principal carries when it is an outside agent. */
export const AGENT_ACCESS_ORIGIN = "octant-agent-access";

export interface AgentSessionDependencies {
  readonly service: Pick<
    AgentAccessService,
    | "threadOwner"
    | "recordThreadStarted"
    | "threadsOf"
    | "takeTurn"
    | "holdTurnStart"
    | "noteTurnThread"
    | "turnThreadsOf"
  >;
  readonly dispatch: (
    handoff: AuthenticatedProductDispatchHandoff,
  ) => Promise<Response | undefined>;
  readonly hostId: () => string;
  /**
   * The Project a thread belongs to: `{}` for a thread under no Project,
   * undefined for a thread the host does not have.
   */
  readonly threadProject: (threadId: string) => { readonly projectId?: string } | undefined;
  /**
   * The access a thread runs at now, so a turn the agent starts on it is held
   * to the grant as it reads now, not as it read when the thread was made.
   */
  readonly threadAccess: (threadId: string) => AgentThreadAccess | undefined;
  /**
   * Marks a thread as having taken in outside content. Throws when the mark
   * could not be recorded, and the agent's prompt is then not sent.
   */
  readonly markOutsideContent: (threadId: string, grant: AgentGrant) => void;
}

/** What a thread is and runs on now: its mode (`kind`), model, and access. */
export type AgentThreadAccess =
  | {
      readonly kind: "code";
      readonly modelId: string;
      readonly executionPolicy: string;
      readonly autoApprove: boolean;
      readonly fullAccessSandbox: boolean;
    }
  | {
      readonly kind: "work";
      readonly modelId: string;
      readonly access: string;
      readonly fullAccessSandbox: boolean;
    }
  | { readonly kind: "chat"; readonly modelId: string };

/**
 * The in-process session an outside agent's tool calls run in. Every request
 * passes the grant guard first; what passes is dispatched through the same
 * authenticated product dispatch paired devices use, as a paired-device
 * principal whose device id is the grant's own scope id, so every device clamp
 * applies after the grant's own.
 */
export function createAgentSession(input: {
  readonly grant: AgentGrant;
  readonly signal: AbortSignal;
  readonly deps: AgentSessionDependencies;
  /**
   * Set only when the person revoked the grant and asked to stop its running
   * turns: the session may read and cancel the grant's own threads, nothing else.
   */
  readonly stopOnly?: true;
}): OpenedLocalControlSession {
  const { grant, signal, deps } = input;
  const principal = createRemoteDevicePrincipal({
    hostId: decodeHostId(deps.hostId()),
    deviceId: decodeDeviceId(String(grant.scopeId)),
    credentialGeneration: grant.generation,
    origin: AGENT_ACCESS_ORIGIN,
    protocolVersion: 1,
    capabilityDigest: createHash("sha256")
      .update(`${String(grant.grantId)}:${grant.generation}`)
      .digest("hex"),
    sessionId: decodeSessionId(randomUUID()),
  });
  return {
    kind: "opened",
    windowId: String(grant.scopeId),
    workspace: "none",
    send: async (request) => {
      if (signal.aborted) return refusal(401, "This agent's grant was revoked or changed.");
      const body = request.body;
      const checked =
        input.stopOnly === true
          ? guardStopRequest({ grant, request, deps })
          : guardAgentRequest({ grant, request, deps });
      if (checked.kind === "refused") return refusal(403, checked.message);
      if (checked.marksThread !== undefined) {
        // Marked before the prompt is sent, so the thread is never shown it
        // unmarked; a mark that cannot be recorded stops the send.
        try {
          deps.markOutsideContent(checked.marksThread, grant);
        } catch {
          return refusal(
            503,
            "Octant could not mark that thread for outside content; nothing was sent.",
          );
        }
      }
      const product = new Request(new URL(request.path, "http://127.0.0.1"), {
        method: request.method,
        headers: {
          ...(request.bytes === undefined ? { "content-type": "application/json" } : {}),
          ...request.headers,
        },
        ...(request.bytes !== undefined
          ? { body: new Blob([request.bytes as BlobPart]) }
          : body === undefined
            ? {}
            : { body: JSON.stringify(body) }),
        signal,
      });
      const response = await deps
        .dispatch({ request: product, principal, abortSignal: signal })
        .catch(() => undefined);
      if (response === undefined) return refusal(404, "Octant does not offer that here.");
      const text = await response.text().catch(() => "");
      const parsed = parseJson(text);
      if (response.ok && checked.marksThread !== undefined && checked.turnMode !== undefined) {
        deps.service.noteTurnThread(String(grant.grantId), checked.marksThread, checked.turnMode);
      }
      if (response.ok && checked.recordsThread !== undefined) {
        const threadId = checked.recordsThread.threadId ?? createdThreadId(parsed);
        if (threadId !== undefined) {
          deps.service.recordThreadStarted({
            grantId: String(grant.grantId),
            threadId,
            mode: checked.recordsThread.mode,
            ...(checked.recordsThread.projectId === undefined
              ? {}
              : { projectId: checked.recordsThread.projectId }),
          });
          deps.markOutsideContent(threadId, grant);
        }
      }
      return { status: response.status, body: parsed };
    },
    close: async () => undefined,
  };
}

/** The tool policy that matches the guard, so refusals come before any request. */
export function agentToolPolicy(
  grant: AgentGrant,
  deps: Pick<AgentSessionDependencies, "service" | "threadProject" | "threadAccess">,
): AgentToolPolicy {
  return {
    tools: new Set(grant.scope.tools),
    projectAllowed: (projectId) => grant.scope.projects.some((id) => String(id) === projectId),
    threadAllowed: (threadId) => threadInScope(grant, threadId, deps),
    defaultAccess: grant.scope.highestLevel,
    beforeTurn: async (session) => {
      // The place is held before anything is read, so a start checked at the
      // same moment counts this one. Running turns are counted from the
      // agent's own newest threads, read as the agent would read them; the
      // daily count is the service's.
      const hold = deps.service.holdTurnStart(String(grant.grantId));
      const refuse = (message: string) => {
        hold.release();
        return { kind: "refused" as const, message };
      };
      let running = hold.startingAlready;
      // Threads it started and threads it sent turns to (a Project thread the
      // person made counts as soon as the agent runs a turn there).
      const threads = new Map<string, AgentGrantMode>();
      for (const thread of deps.service.threadsOf(String(grant.grantId)).slice(0, 20)) {
        threads.set(thread.threadId, thread.mode);
      }
      for (const thread of deps.service.turnThreadsOf(String(grant.grantId))) {
        threads.set(thread.threadId, thread.mode);
      }
      for (const [threadId, mode] of threads) {
        if (running >= grant.scope.limits.runningTurns) break;
        const snapshot = await agentThreadPort(session, mode, threadId)
          .read()
          .catch(() => undefined);
        if (isAgentSnapshotRunning(snapshot)) running += 1;
      }
      if (running >= grant.scope.limits.runningTurns) {
        return refuse(
          `This agent already has ${running} turns running or starting, its limit; wait for one to end.`,
        );
      }
      return deps.service.takeTurn(String(grant.grantId))
        ? { kind: "admitted", release: hold.release }
        : refuse(`This agent has used its ${grant.scope.limits.turnsPerDay} turns for today.`);
    },
  };
}

type GuardResult =
  | {
      readonly kind: "allowed";
      /** A create command: record the new thread as this agent's once it exists. */
      readonly recordsThread?: {
        readonly mode: AgentGrantMode;
        readonly projectId?: string;
        readonly threadId?: string;
      };
      /** A prompt or answer for an existing thread: mark it before sending. */
      readonly marksThread?: string;
      /** The marked thread's mode, so a turn the agent starts there counts toward its limit. */
      readonly turnMode?: AgentGrantMode;
    }
  | { readonly kind: "refused"; readonly message: string };

const READS: ReadonlyArray<RegExp> = [
  /^\/api\/projects\/bootstrap$/,
  /^\/api\/providers\/bootstrap$/,
  /^\/api\/chat\/navigation$/,
  /^\/api\/code\/bootstrap$/,
  /^\/api\/work\/threads\/bootstrap$/,
  /^\/api\/pending-requests$/,
];
const THREAD_READS: ReadonlyArray<RegExp> = [
  /^\/api\/chat\/threads\/([^/]+)$/,
  /^\/api\/code\/threads\/([^/]+)(?:\/conversation(?:\/window)?)?$/,
  /^\/api\/work\/turns\/transcript\/([^/]+)$/,
  /^\/api\/native-harness\/sessions\/([^/]+)$/,
];

/**
 * The grant's own rule for one request, before the product layer's. A closed
 * list: anything not named here is refused, including every approval route,
 * Project administration, and Full access.
 */
export function guardAgentRequest(input: {
  readonly grant: AgentGrant;
  readonly request: LocalControlRequest;
  readonly deps: Pick<AgentSessionDependencies, "service" | "threadProject" | "threadAccess">;
}): GuardResult {
  const { grant, request, deps } = input;
  if (grant.state !== "active") return refused("This agent's grant is revoked.");
  const url = new URL(request.path, "http://127.0.0.1");
  const path = url.pathname;
  const method = request.method;
  const scope = grant.scope;
  const inScope = (threadId: unknown) =>
    typeof threadId === "string" && threadInScope(grant, threadId, deps);
  const thread = (threadId: unknown): GuardResult =>
    inScope(threadId) ? { kind: "allowed" } : refused("That thread is not in this agent's grant.");
  // Text the agent sends a thread (a prompt or an answer) is outside content,
  // and starts work at the thread's own access, which must still be within the
  // grant: lowering a grant lowers what its agent can run on threads it made.
  const prompt = (threadId: unknown): GuardResult => {
    if (typeof threadId !== "string" || !inScope(threadId)) {
      return refused("That thread is not in this agent's grant.");
    }
    const access = deps.threadAccess(threadId);
    if (!withinCeiling(grant, access)) {
      return refused(
        `That thread runs above this agent's grant, which now allows at most ${grant.scope.highestLevel}; the person can lower the thread's access in Octant.`,
      );
    }
    if (access === undefined || !modelAllowed(grant, access.modelId)) {
      return refused("That thread runs on a model this agent's grant does not include.");
    }
    return { kind: "allowed", marksThread: threadId, turnMode: access.kind };
  };
  const body = (request.body ?? {}) as Readonly<Record<string, unknown>>;

  if (method === "GET") {
    if (READS.some((pattern) => pattern.test(path))) return { kind: "allowed" };
    for (const pattern of THREAD_READS) {
      const match = pattern.exec(path);
      if (match !== null) return thread(decodeURIComponent(match[1] ?? ""));
    }
    return refused("This agent may not read that.");
  }
  if (method === "PUT" && path === "/api/code/evidence") {
    return thread(request.headers?.["x-octant-code-thread-id"]);
  }
  if (method !== "POST") return refused("This agent may not do that.");

  if (path === "/api/code/evidence/batch") return thread(body["threadId"]);
  const question = /^\/api\/native-harness\/sessions\/([^/]+)\/questions$/.exec(path);
  if (question !== null) {
    if (!scope.tools.includes("answer_question")) {
      return refused("This agent's grant does not include answering questions.");
    }
    return prompt(decodeURIComponent(question[1] ?? ""));
  }
  const kind = body["kind"];
  if (path === "/api/chat/commands") {
    if (kind === "create-chat-thread") {
      if (!scope.modes.includes("chat")) return refused("This agent's grant has no Chat.");
      const projectId = body["projectId"];
      if (projectId !== undefined && !projectAllowed(grant, projectId)) {
        return refused("That Project is not in this agent's grant.");
      }
      return {
        kind: "allowed",
        recordsThread: {
          mode: "chat",
          ...(typeof projectId === "string" ? { projectId } : {}),
        },
      };
    }
    if (kind === "send-chat-turn") return prompt(body["threadId"]);
    if (kind === "interrupt-chat-turn") return thread(body["threadId"]);
    if (kind === "answer-chat-turn-question") {
      if (!scope.tools.includes("answer_question")) {
        return refused("This agent's grant does not include answering questions.");
      }
      return prompt(body["threadId"]);
    }
    if (kind === "change-chat-provider") {
      if (!modelAllowed(grant, body["modelId"]))
        return refused("That model is not in this agent's grant.");
      return thread(body["threadId"]);
    }
    return refused("This agent may not do that.");
  }
  if (path === "/api/work/threads/commands") {
    if (kind === "create-work-thread") {
      if (!scope.modes.includes("work")) return refused("This agent's grant has no Work.");
      if (!projectAllowed(grant, body["projectId"])) {
        return refused("That Project is not in this agent's grant.");
      }
      if (!modelAllowed(grant, body["modelId"]))
        return refused("That model is not in this agent's grant.");
      if (body["fullAccessSandbox"] !== undefined)
        return refused("Full access stays with the person.");
      return {
        kind: "allowed",
        recordsThread: {
          mode: "work",
          projectId: String(body["projectId"]),
          ...(typeof body["threadId"] === "string" ? { threadId: body["threadId"] } : {}),
        },
      };
    }
    if (kind === "change-work-thread-access") {
      if (!workAccessAllowed(grant.scope.highestLevel, body["access"])) {
        return refused(`This agent's grant allows at most ${grant.scope.highestLevel}.`);
      }
      return thread(body["threadId"]);
    }
    return refused("This agent may not do that.");
  }
  if (path === "/api/work/turns" && kind === "start-work-thread-turn")
    return prompt(body["threadId"]);
  if (path === "/api/work/turns/cancel" && kind === "cancel-work-turn")
    return thread(body["threadId"]);
  if (path === "/api/code/commands") {
    if (kind === "prepare-code-project-checkout") {
      if (!scope.modes.includes("code")) return refused("This agent's grant has no Code.");
      return projectAllowed(grant, body["projectId"])
        ? { kind: "allowed" }
        : refused("That Project is not in this agent's grant.");
    }
    if (kind === "create-code-thread") {
      const created = (body["thread"] ?? {}) as Readonly<Record<string, unknown>>;
      if (!scope.modes.includes("code")) return refused("This agent's grant has no Code.");
      if (!projectAllowed(grant, created["projectId"])) {
        return refused("That Project is not in this agent's grant.");
      }
      if (!modelAllowed(grant, created["modelId"]))
        return refused("That model is not in this agent's grant.");
      if (
        created["fullAccessSandbox"] !== undefined ||
        created["permissionPersistence"] === "project-default" ||
        !codeAccessAllowed(
          grant.scope.highestLevel,
          created["executionPolicy"],
          created["autoApprove"],
        )
      ) {
        return refused(`This agent's grant allows at most ${grant.scope.highestLevel}.`);
      }
      return {
        kind: "allowed",
        recordsThread: {
          mode: "code",
          projectId: String(created["projectId"]),
          ...(typeof created["id"] === "string" ? { threadId: created["id"] } : {}),
        },
      };
    }
    if (kind === "start-provider-turn") return prompt(body["threadId"]);
    if (kind === "cancel-provider-turn") return thread(body["threadId"]);
    return refused("This agent may not do that.");
  }
  return refused("This agent may not do that.");
}

const CANCEL_KINDS: ReadonlyArray<string> = [
  "interrupt-chat-turn",
  "cancel-work-turn",
  "cancel-provider-turn",
];

/** Reads and cancels on the grant's own threads, for stopping a revoked agent's turns. */
function guardStopRequest(input: {
  readonly grant: AgentGrant;
  readonly request: LocalControlRequest;
  readonly deps: Pick<AgentSessionDependencies, "service" | "threadProject">;
}): GuardResult {
  const { grant, request, deps } = input;
  const own = (threadId: unknown) =>
    typeof threadId === "string" &&
    deps.service.threadOwner(threadId)?.grantId === String(grant.grantId);
  const path = new URL(request.path, "http://127.0.0.1").pathname;
  if (request.method === "GET") {
    if (READS.some((pattern) => pattern.test(path))) return { kind: "allowed" };
    for (const pattern of THREAD_READS) {
      const match = pattern.exec(path);
      if (match !== null && own(decodeURIComponent(match[1] ?? ""))) return { kind: "allowed" };
    }
    return refused("Only reads and stops are allowed here.");
  }
  const body = (request.body ?? {}) as Readonly<Record<string, unknown>>;
  if (
    request.method === "POST" &&
    typeof body["kind"] === "string" &&
    CANCEL_KINDS.includes(body["kind"]) &&
    own(body["threadId"])
  ) {
    return { kind: "allowed" };
  }
  return refused("Only reads and stops are allowed here.");
}

function threadInScope(
  grant: AgentGrant,
  threadId: string,
  deps: Pick<AgentSessionDependencies, "service" | "threadProject" | "threadAccess">,
): boolean {
  const owner = deps.service.threadOwner(threadId);
  if (owner !== undefined && owner.grantId !== String(grant.grantId)) return false;
  if (owner === undefined && grant.scope.threads !== "project") return false;
  // Every thread is held to the grant as it reads now, the agent's own
  // included: its mode must be one the grant names, and taking a Project or a
  // mode out of the grant takes those threads out too.
  const mode = deps.threadAccess(threadId)?.kind ?? owner?.mode;
  if (mode === undefined || !grant.scope.modes.includes(mode)) return false;
  const project = deps.threadProject(threadId);
  if (project === undefined) return false;
  return project.projectId === undefined
    ? owner !== undefined && mode === "chat"
    : projectAllowed(grant, project.projectId);
}

function withinCeiling(grant: AgentGrant, access: AgentThreadAccess | undefined): boolean {
  if (access === undefined) return false;
  if (access.kind === "chat") return true;
  if (access.fullAccessSandbox) return false;
  return access.kind === "code"
    ? codeAccessAllowed(grant.scope.highestLevel, access.executionPolicy, access.autoApprove)
    : workAccessAllowed(grant.scope.highestLevel, access.access);
}

function projectAllowed(grant: AgentGrant, projectId: unknown): boolean {
  return (
    typeof projectId === "string" && grant.scope.projects.some((id) => String(id) === projectId)
  );
}

function modelAllowed(grant: AgentGrant, modelId: unknown): boolean {
  const models = grant.scope.models;
  if (models === undefined) return true;
  if (typeof modelId !== "string") return false;
  const wanted = modelId.toLowerCase();
  return models.some((entry) => {
    const value = entry.toLowerCase();
    return value === wanted || value.endsWith(`/${wanted}`);
  });
}

/** The levels at or below the grant's highest, safest first. */
function levelsUpTo(highest: AgentGrantLevel): ReadonlyArray<PermissionMode> {
  const order: ReadonlyArray<AgentGrantLevel> = ["plan", "ask-first", "accept-edits", "auto"];
  return order
    .slice(0, order.indexOf(highest) + 1)
    .filter((level) => (AGENT_GRANT_LEVELS as ReadonlyArray<string>).includes(level));
}

function codeAccessAllowed(
  highest: AgentGrantLevel,
  executionPolicy: unknown,
  autoApprove: unknown,
): boolean {
  return levelsUpTo(highest).some((level) => {
    const access = threadAccessOf(level);
    return (
      access.executionPolicy === executionPolicy && access.autoApprove === (autoApprove === true)
    );
  });
}

function workAccessAllowed(highest: AgentGrantLevel, access: unknown): boolean {
  return levelsUpTo(highest).some((level) => workAccessOfPermissionMode(level) === access);
}

function createdThreadId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const thread = (body as { readonly thread?: { readonly id?: unknown } }).thread;
  return typeof thread?.id === "string" ? thread.id : undefined;
}

function refused(message: string): GuardResult {
  return { kind: "refused", message };
}

function refusal(status: number, message: string): LocalControlResponse {
  return { status, body: { message } };
}

function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

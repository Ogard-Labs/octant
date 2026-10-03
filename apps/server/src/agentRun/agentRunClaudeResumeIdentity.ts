import { isAbsolute } from "node:path";
import {
  ClaudeAuthentication,
  ProviderInstanceId,
  ProviderModelId,
  ProviderSessionId,
  type AgentRun,
} from "@octant/contracts";
import { effectiveAgentRunExecutionTarget } from "@octant/domain/agent-run-policy";
import { Schema } from "effect";
import type { ClaudeResumeIdentity, ClaudeResumeIdentityPort } from "../providers/claudeDriver";
import type { AgentRunSessionRecord, AgentRunSessionStore } from "./agentRunSessionStore";

const Identity = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  octantSessionId: ProviderSessionId,
  sdkSessionId: Schema.NonEmptyString.pipe(Schema.maxLength(4096)),
  projectRoot: Schema.NonEmptyString.pipe(Schema.maxLength(16 * 1024)),
  modelId: ProviderModelId,
  authentication: ClaudeAuthentication,
});
const decodeIdentity = Schema.decodeUnknownSync(Identity);

/** The existing adapter identity port, scoped by the host to one admitted child. */
export function createAgentRunClaudeResumeIdentityPort(options: {
  readonly run: AgentRun;
  readonly store: AgentRunSessionStore;
  readonly isProviderAvailable: (providerInstanceId: ProviderInstanceId) => boolean;
}): ClaudeResumeIdentityPort {
  const { run, store } = options;
  const target = effectiveAgentRunExecutionTarget(run.routingReceipt);
  let bound: Pick<AgentRunSessionRecord, "sessionId" | "binding"> | undefined;
  const currentSession = () => {
    if (!options.isProviderAvailable(target.providerInstanceId)) return undefined;
    const session = store.sessions.read(run);
    if (
      session === undefined ||
      (bound !== undefined &&
        (session.sessionId !== bound.sessionId || session.binding !== bound.binding))
    )
      return undefined;
    bound ??= { sessionId: session.sessionId, binding: session.binding };
    return session;
  };
  const matches = (identity: ClaudeResumeIdentity, session: AgentRunSessionRecord) =>
    identity.providerInstanceId === target.providerInstanceId &&
    identity.modelId === target.modelId &&
    identity.octantSessionId === session.sessionId &&
    isAbsolute(identity.projectRoot) &&
    (session.resumeCursor === undefined ||
      (session.resumeCursor.driverKind === "claude" &&
        session.resumeCursor.value === identity.sdkSessionId));
  const storedIdentity = (input: Parameters<ClaudeResumeIdentityPort["lookup"]>[0]) => {
    const session = currentSession();
    if (
      session?.resumeCursor === undefined ||
      session.resumeCursor.driverKind !== "claude" ||
      input.providerInstanceId !== target.providerInstanceId ||
      input.sdkSessionId !== session.resumeCursor.value
    )
      return undefined;
    const record = store.readProviderIdentity(run);
    if (record?.driverKind !== "claude") return undefined;
    try {
      const identity = decodeIdentity(JSON.parse(record.value));
      return matches(identity, session) ? { identity, record } : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    lookup: async (input, signal) => {
      signal.throwIfAborted();
      await Promise.resolve();
      signal.throwIfAborted();
      return storedIdentity(input)?.identity;
    },
    put: async (input, signal) => {
      signal.throwIfAborted();
      await Promise.resolve();
      signal.throwIfAborted();
      // Persist only the adapter's validated payload. A durable cursor on its
      // own is not evidence that this host created that provider session.
      let identity: ClaudeResumeIdentity;
      try {
        identity = decodeIdentity(input);
      } catch {
        throw new Error("Child provider identity is invalid.");
      }
      const session = currentSession();
      if (
        session === undefined ||
        !matches(identity, session) ||
        !store.writeProviderIdentity(run, {
          binding: session.binding,
          sessionId: session.sessionId,
          providerInstanceId: identity.providerInstanceId,
          driverKind: "claude",
          value: JSON.stringify(identity),
        })
      )
        throw new Error("Child provider identity cannot be persisted under its admitted session.");
    },
    remove: async (input, signal) => {
      signal.throwIfAborted();
      await Promise.resolve();
      signal.throwIfAborted();
      const stored = storedIdentity(input);
      if (stored !== undefined) store.removeProviderIdentity(run, stored.record);
    },
  };
}

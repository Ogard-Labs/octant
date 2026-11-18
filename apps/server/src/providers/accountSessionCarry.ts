import { join } from "node:path";
import type {
  AccountMoveTextHandoffCause,
  ProviderInstance,
  ProviderInstanceId,
  ProviderModelId,
  ProviderResumeCursor,
  ProviderSessionId,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk";
import { Effect } from "effect";
import { copyClaudeAccountSession } from "./claudeAccountSessionCopy";
import { resolveProviderToolingAccount } from "./providerToolingAccount";

/**
 * A thread moved to another account of the same provider keeps the provider's
 * own session when it can (maintainer decision, 2026-11-17): its first turn on
 * the new account copies that one session's files from the old account's
 * directory into the new one's, then has the new account's driver take the
 * session up the way it takes up any session begun outside Octant, so the
 * ordinary exact-resume checks still decide the resume. Anything that stops
 * that returns why, and the turn hands the conversation over as text, as a
 * provider change does.
 */
export interface AccountSessionCarryRequest {
  readonly fromInstanceId: ProviderInstanceId;
  readonly toInstanceId: ProviderInstanceId;
  /** The old account's cursor for the session the thread last ran on. */
  readonly resumeCursor: ProviderResumeCursor;
  /** The Octant session the new account resumes it under. */
  readonly sessionId: ProviderSessionId;
  readonly projectRoot: string;
  readonly mode: "chat" | "work" | "code";
  readonly modelId: ProviderModelId;
}

export type AccountSessionCarry =
  | { readonly status: "carried"; readonly resumeCursor: ProviderResumeCursor }
  | { readonly status: "text"; readonly cause: AccountMoveTextHandoffCause };

export interface AccountSessionCarrier {
  /**
   * Whether two instances are accounts of one provider, so a turn after a
   * move between them tries to carry the session. A move to another provider
   * is never tried and keeps the plain text handoff.
   */
  readonly sameProvider: (from: ProviderInstanceId, to: ProviderInstanceId) => boolean;
  readonly carry: (request: AccountSessionCarryRequest) => Promise<AccountSessionCarry>;
}

export function makeAccountSessionCarrier(dependencies: {
  readonly readInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly resolveDriver: (
    id: ProviderInstanceId,
  ) => Pick<ProviderDriver, "nativeSessions"> | undefined;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}): AccountSessionCarrier {
  const sameProvider = (from: ProviderInstanceId, to: ProviderInstanceId) => {
    if (String(from) === String(to)) return false;
    const previous = dependencies.readInstance(from);
    const next = dependencies.readInstance(to);
    return previous !== undefined && next !== undefined && previous.driverKind === next.driverKind;
  };
  const carry = async (request: AccountSessionCarryRequest): Promise<AccountSessionCarry> => {
    const from = dependencies.readInstance(request.fromInstanceId);
    const to = dependencies.readInstance(request.toInstanceId);
    if (from === undefined || to === undefined)
      return { status: "text", cause: "account-unavailable" };
    // Only Claude Code's session files are known well enough to copy. Codex
    // keeps a thread's record beyond its rollout file, and a cursor of any
    // other kind names nothing in an account directory.
    if (
      from.driverKind !== "claude" ||
      to.driverKind !== "claude" ||
      request.resumeCursor.driverKind !== "claude"
    )
      return { status: "text", cause: "provider-cannot-carry" };
    const driver = dependencies.resolveDriver(request.toInstanceId);
    const nativeSessions = driver?.nativeSessions;
    if (nativeSessions === undefined) return { status: "text", cause: "provider-cannot-carry" };
    const directory = (instance: ProviderInstance) =>
      resolveProviderToolingAccount(
        instance,
        dependencies.hostEnvironment,
        dependencies.homeDirectory,
      )?.directory ?? join(dependencies.homeDirectory, ".claude");
    const copied = await copyClaudeAccountSession({
      fromDirectory: directory(from),
      toDirectory: directory(to),
      projectRoot: request.projectRoot,
      sessionId: request.resumeCursor.value,
    });
    if (copied.status === "refused") return { status: "text", cause: "session-not-copied" };
    // A turn prepared earlier and never started may already have claimed the
    // copy for this same Octant session; giving that claim back first makes
    // the move repeatable. A claim another session holds is left alone, and
    // the adoption below then refuses.
    await Effect.runPromise(
      (
        nativeSessions.release?.({
          instanceId: request.toInstanceId,
          nativeSessionId: request.resumeCursor.value,
          sessionId: request.sessionId,
        }) ?? Effect.void
      ).pipe(Effect.catchAll(() => Effect.void)),
    );
    const adopted = await Effect.runPromise(
      Effect.either(
        nativeSessions.adopt({
          instanceId: request.toInstanceId,
          projectRoot: request.projectRoot,
          mode: request.mode,
          sessionId: request.sessionId,
          nativeSessionId: request.resumeCursor.value,
          modelId: request.modelId,
        }),
      ),
    ).catch(() => undefined);
    if (adopted === undefined || adopted._tag === "Left") {
      await copied.discard();
      return { status: "text", cause: "session-not-adopted" };
    }
    return { status: "carried", resumeCursor: adopted.right };
  };
  return { sameProvider, carry };
}

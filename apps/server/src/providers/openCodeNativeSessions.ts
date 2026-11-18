/**
 * Starting an Octant thread from one of the person's own OpenCode sessions,
 * and forking an Octant OpenCode session with OpenCode's own fork.
 *
 * OpenCode keeps every session in its own store, which a launch shares with
 * the person's own use (its data folder is the person's), so the sessions it
 * lists for a folder are the person's and Octant's alike. A server is started
 * for the folder outside any thread to list them (the readiness check's
 * launch, held as its own lease per folder).
 *
 * Which OpenCode sessions an Octant thread holds is the host's own journal:
 * every session an Octant thread starts, takes up or forks is recorded there
 * with its resume cursor, the adoption in one unit with the outside-content
 * mark. `heldSessions` reads that record through the provider SDK's
 * `ProviderSessionOwnership` port, for every OpenCode account, since they
 * share one session store. A session it names is never offered
 * and never taken up a second time, so two threads never drive one session.
 * Between the driver's claim and the host's record, the claim is held here.
 */
import { isAbsolute, resolve } from "node:path";
import type { ProviderFailure, ProviderInstanceId, ProviderResumeCursor } from "@octant/contracts";
import type {
  ProviderDriver,
  ProviderNativeSession,
  ProviderSessionForkRequest,
} from "@octant/provider-sdk/driver";
import { Effect } from "effect";
import type { OpenCodeClientPort } from "./openCodeDriver";
import { providerResumeBinding } from "./resumeBinding";

/** How many of the person's sessions in a folder a thread is offered to start from. */
const MAX_OFFERED_NATIVE_SESSIONS = 50;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Runs `use` against a server for the folder, started outside any thread. */
export type OpenCodeSessionClient = <A>(
  projectRoot: string,
  use: (client: OpenCodeClientPort) => Promise<A>,
) => Promise<A>;

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function normalizedRoot(root: string): boolean {
  return isAbsolute(root) && resolve(root) === root;
}

function inFolder(directory: string, projectRoot: string): boolean {
  return isAbsolute(directory) && resolve(directory) === projectRoot;
}

/** Adoptions of one OpenCode session waiting their turn, so a check and its claim are one step. */
const adoptionsInFlight = new Map<string, Promise<unknown>>();

async function oneAtATime<A>(key: string, run: () => Promise<A>): Promise<A> {
  const before = adoptionsInFlight.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(run);
  adoptionsInFlight.set(key, mine);
  try {
    return await mine;
  } finally {
    if (adoptionsInFlight.get(key) === mine) adoptionsInFlight.delete(key);
  }
}

export function makeOpenCodeNativeSessions(options: {
  readonly instanceId: ProviderInstanceId;
  /** The OpenCode sessions the host's journal records an Octant thread holding. */
  readonly heldSessions: () => ReadonlySet<string>;
  readonly withClient: OpenCodeSessionClient;
}): NonNullable<ProviderDriver["nativeSessions"]> {
  // OpenCode session id -> the Octant session that claimed it, until the host
  // records the adoption or the driver gives the claim back.
  const claims = new Map<string, string>();
  // Only these sentences reach the person; anything else thrown on the way is
  // reduced to one generic sentence.
  const refusals = new WeakSet<ProviderFailure>();
  const refuse = (category: ProviderFailure["category"], message: string) => {
    const refusal = failure(category, message);
    refusals.add(refusal);
    return refusal;
  };
  const refusalOr = (error: unknown, fallback: ProviderFailure): ProviderFailure =>
    typeof error === "object" && error !== null && refusals.has(error as ProviderFailure)
      ? (error as ProviderFailure)
      : fallback;
  const wrongInstance = (instanceId: ProviderInstanceId) =>
    String(instanceId) !== String(options.instanceId);
  const held = (sessionId: string) =>
    claims.has(sessionId) || options.heldSessions().has(sessionId);
  return {
    list: ({ instanceId, projectRoot }) =>
      wrongInstance(instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: async () => {
              if (!normalizedRoot(projectRoot))
                throw refuse("invalid-configuration", "This thread's folder is unavailable.");
              const listed = await options.withClient(projectRoot, async (client) => {
                if (client.listSessions === undefined)
                  throw refuse("unsupported", "This OpenCode does not list its sessions.");
                return client.listSessions();
              });
              const holds = options.heldSessions();
              const sessions: ProviderNativeSession[] = [];
              for (const session of listed) {
                // A subagent's or a fork's session belongs to the session it
                // came from, which is the one offered.
                if (
                  session.parentId !== undefined ||
                  !SESSION_ID.test(session.id) ||
                  !inFolder(session.directory, projectRoot) ||
                  claims.has(session.id) ||
                  holds.has(session.id)
                )
                  continue;
                const title = session.title?.trim();
                sessions.push({
                  nativeSessionId: session.id,
                  lastModified: Math.max(0, Math.trunc(session.updated)),
                  ...(title === undefined || title.length === 0
                    ? {}
                    : { title: Array.from(title).slice(0, 256).join("") }),
                });
              }
              return sessions
                .sort((left, right) => right.lastModified - left.lastModified)
                .slice(0, MAX_OFFERED_NATIVE_SESSIONS);
            },
            catch: (error) =>
              refusalOr(error, failure("unavailable", "OpenCode's sessions could not be read.")),
          }),
    adopt: (input) =>
      Effect.tryPromise({
        try: () =>
          oneAtATime(`${String(options.instanceId)}\u0000${input.nativeSessionId}`, async () => {
            if (wrongInstance(input.instanceId))
              throw refuse("invalid-configuration", "Provider instance does not match driver.");
            if (!SESSION_ID.test(input.nativeSessionId) || !normalizedRoot(input.projectRoot))
              throw refuse("stale-resume", "That OpenCode session is not one of this folder's.");
            if (held(input.nativeSessionId))
              throw refuse(
                "unavailable",
                "That OpenCode session already belongs to an Octant thread.",
              );
            const session = await options.withClient(input.projectRoot, (client) =>
              client.getSession(input.nativeSessionId).catch(() => undefined),
            );
            if (
              session === undefined ||
              session.id !== input.nativeSessionId ||
              !inFolder(session.directory, input.projectRoot)
            )
              throw refuse("stale-resume", "That OpenCode session is not one of this folder's.");
            // Read again: the journal may have recorded it while OpenCode answered.
            if (held(input.nativeSessionId))
              throw refuse(
                "unavailable",
                "That OpenCode session already belongs to an Octant thread.",
              );
            claims.set(input.nativeSessionId, String(input.sessionId));
            return {
              driverKind: "opencode",
              value: input.nativeSessionId,
              binding: providerResumeBinding({
                instanceId: options.instanceId,
                sessionId: input.sessionId,
                projectRoot: input.projectRoot,
                mode: input.mode,
                modelId: input.modelId,
              }),
            } satisfies ProviderResumeCursor;
          }),
        catch: (error) =>
          refusalOr(error, failure("unavailable", "The OpenCode session could not be taken up.")),
      }),
    // Taken in turn with adoptions of the same session, so a release never
    // gives back a claim a later adoption made.
    release: (input) =>
      wrongInstance(input.instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.promise(() =>
            oneAtATime(`${String(options.instanceId)}\u0000${input.nativeSessionId}`, async () => {
              if (claims.get(input.nativeSessionId) === String(input.sessionId))
                claims.delete(input.nativeSessionId);
            }),
          ),
  };
}

/**
 * A fork's or rewind's first session through OpenCode's own fork: a new
 * session holding the source's history through the turn's anchor (its last
 * assistant message), cut before the message that follows it, or the whole
 * history when the anchor is the newest. The source is not changed. Only a
 * session this instance opened for the same folder and mode is forked;
 * anything else, a runtime that cannot fork, or an anchor OpenCode no longer
 * holds is undefined, so the host hands the conversation over as text.
 */
export function forkOpenCodeSession(
  options: { readonly instanceId: ProviderInstanceId; readonly withClient: OpenCodeSessionClient },
  input: ProviderSessionForkRequest,
): Effect.Effect<ProviderResumeCursor | undefined, ProviderFailure> {
  const binding = input.source.binding;
  if (
    String(input.instanceId) !== String(options.instanceId) ||
    input.source.driverKind !== "opencode" ||
    binding === undefined ||
    String(binding.instanceId) !== String(options.instanceId) ||
    binding.projectRoot !== input.projectRoot ||
    binding.mode !== input.mode ||
    !normalizedRoot(input.projectRoot)
  )
    return Effect.succeed(undefined);
  return Effect.promise(() =>
    options
      .withClient(input.projectRoot, async (client) => {
        const messageAfter = client.messageAfter;
        const fork = client.forkSession;
        if (messageAfter === undefined || fork === undefined) return undefined;
        const after = await messageAfter(input.source.value, input.anchor);
        if (after.status === "missing") return undefined;
        const copied = await fork(input.source.value, after.next);
        if (copied.id === input.source.value) return undefined;
        const discard = async () => {
          await client.deleteSession(copied.id).catch(() => undefined);
          return undefined;
        };
        if (!inFolder(copied.directory, input.projectRoot)) return discard();
        // A whole-session fork ends at the anchor only while nothing follows
        // it. The source may have moved on between the read and the fork (its
        // own thread running a turn), so it is read again after the fork: a
        // message after the anchor now means the copy may hold it too, and
        // the copy is removed for the text handoff instead.
        if (after.next === undefined) {
          const again = await messageAfter(input.source.value, input.anchor).catch(() => undefined);
          if (again?.status !== "found" || again.next !== undefined) return discard();
        }
        return {
          driverKind: "opencode" as const,
          value: copied.id,
          binding: providerResumeBinding({
            instanceId: options.instanceId,
            sessionId: input.sessionId,
            projectRoot: input.projectRoot,
            mode: input.mode,
            modelId: input.modelId,
          }),
        };
      })
      .catch(() => undefined),
  );
}

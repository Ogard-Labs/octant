/**
 * Starting an Octant thread from one of the person's own Codex sessions.
 *
 * Octant's Codex runs on the account's own Codex home, so the person's
 * sessions and Octant's sit side by side in Codex's thread store. The list
 * reads it through the app-server's `thread/list`, filtered to the thread's
 * folder, and leaves out a subagent's or an ephemeral thread.
 *
 * Which Codex threads an Octant thread holds is the host's own journal: every
 * thread an Octant thread starts, takes up or forks is recorded there with its
 * resume cursor, and `heldSessions` reads that record through the provider
 * SDK's `ProviderSessionOwnership` port, for every Codex account, since
 * accounts may share one Codex home. A held thread is never offered and never
 * taken up a second time, so two Octant threads never resume one Codex thread.
 * Between the driver's claim and the host's record, the claim is held here.
 * A thread whose recorded creator (`originator`, the `initialize` client name,
 * from codex-cli 0.154.0) is Octant is left out as well: another Octant host on
 * the same Codex home started it.
 *
 * Adopting resumes the person's own thread, as Codex's own `resume` does:
 * nothing is copied, so the thread's history is the one the person's Codex
 * shows.
 */
import type { ProviderFailure, ProviderInstanceId, ProviderResumeCursor } from "@octant/contracts";
import type { ProviderDriver, ProviderNativeSession } from "@octant/provider-sdk/driver";
import { Effect } from "effect";
import type { CodexStoredThread, CodexThreadListResult } from "./codexProtocol";
import { providerResumeBinding } from "./resumeBinding";

/** How many of the person's sessions in a folder a thread is offered to start from. */
const MAX_OFFERED_NATIVE_SESSIONS = 50;
/** `thread/list` pages read before the list stops, newest first. */
const MAX_LISTED_PAGES = 5;
const LISTED_PAGE_SIZE = 100;
/** The `initialize` client name Octant's own app-server connections send. */
export const CODEX_OCTANT_ORIGINATOR = "Octant";
/** Codex's own interactive and scripted sessions; subagents' threads are left out. */
const CODEX_PERSON_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer"] as const;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface CodexSessionCatalog {
  readonly threadList?: (input: {
    readonly cwd: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly sortKey: "updated_at";
    readonly archived: false;
    readonly sourceKinds: ReadonlyArray<string>;
  }) => Promise<CodexThreadListResult>;
  readonly threadRead?: (input: {
    readonly threadId: string;
  }) => Promise<{ readonly thread: CodexStoredThread }>;
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

/** Whether a stored thread is the person's own session in exactly this folder. */
function personSessionIn(thread: CodexStoredThread, projectRoot: string): boolean {
  return (
    thread.cwd === projectRoot &&
    THREAD_ID.test(thread.id) &&
    thread.originator !== CODEX_OCTANT_ORIGINATOR &&
    (thread.parentThreadId ?? null) === null &&
    thread.ephemeral !== true
  );
}

/** The title the person gave a thread, else its first request, on one line. */
function titleOf(thread: CodexStoredThread): string | undefined {
  const source = thread.name?.trim() || thread.preview?.trim();
  if (source === undefined || source.length === 0) return undefined;
  const line = source.split(/\r?\n/u)[0]?.trim() ?? "";
  return line.length === 0 ? undefined : Array.from(line).slice(0, 200).join("");
}

/** Adoptions of one Codex thread waiting their turn, so a check and its claim are one step. */
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

export function makeCodexNativeSessions(options: {
  readonly instanceId: ProviderInstanceId;
  /** The Codex threads the host's journal records an Octant thread holding. */
  readonly heldSessions: () => ReadonlySet<string>;
  /** Runs `use` against a catalog app-server for this account, which carries no thread. */
  readonly catalog: <A>(
    use: (client: CodexSessionCatalog) => Promise<A>,
  ) => Effect.Effect<A, unknown>;
}): NonNullable<ProviderDriver["nativeSessions"]> {
  // Codex thread id -> the Octant session that claimed it, until the host
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
  const passRefusal = (fallback: string) => (error: unknown) =>
    typeof error === "object" && error !== null && refusals.has(error as ProviderFailure)
      ? (error as ProviderFailure)
      : failure("unavailable", fallback);
  const wrongInstance = (instanceId: ProviderInstanceId) =>
    String(instanceId) !== String(options.instanceId);
  const held = (threadId: string) => claims.has(threadId) || options.heldSessions().has(threadId);
  const key = (threadId: string) => `${String(options.instanceId)}\u0000${threadId}`;
  return {
    list: ({ instanceId, projectRoot }) =>
      wrongInstance(instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : options
            .catalog(async (client) => {
              const threadList = client.threadList;
              if (threadList === undefined)
                throw refuse("unsupported", "This Codex cannot list its sessions.");
              const holds = options.heldSessions();
              const offered: ProviderNativeSession[] = [];
              let cursor: string | undefined;
              for (let page = 0; page < MAX_LISTED_PAGES; page += 1) {
                const listed = await threadList({
                  cwd: projectRoot,
                  limit: LISTED_PAGE_SIZE,
                  sortKey: "updated_at",
                  archived: false,
                  sourceKinds: CODEX_PERSON_SOURCE_KINDS,
                  ...(cursor === undefined ? {} : { cursor }),
                });
                for (const thread of listed.data) {
                  if (offered.length >= MAX_OFFERED_NATIVE_SESSIONS) break;
                  if (
                    !personSessionIn(thread, projectRoot) ||
                    claims.has(thread.id) ||
                    holds.has(thread.id)
                  )
                    continue;
                  const title = titleOf(thread);
                  const branch = thread.gitInfo?.branch?.trim();
                  offered.push({
                    nativeSessionId: thread.id,
                    lastModified: Math.max(0, Math.trunc(thread.updatedAt * 1000)),
                    ...(title === undefined ? {} : { title }),
                    ...(branch === undefined || branch.length === 0 ? {} : { gitBranch: branch }),
                  });
                }
                if (offered.length >= MAX_OFFERED_NATIVE_SESSIONS || listed.nextCursor === null)
                  break;
                cursor = listed.nextCursor;
              }
              return offered.sort((left, right) => right.lastModified - left.lastModified);
            })
            .pipe(Effect.mapError(passRefusal("Codex's sessions could not be read."))),
    adopt: (input) => {
      if (wrongInstance(input.instanceId))
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      if (!THREAD_ID.test(input.nativeSessionId))
        return Effect.fail(
          failure("stale-resume", "That Codex session is not one of this folder's."),
        );
      return options
        .catalog((client) =>
          oneAtATime(key(input.nativeSessionId), async () => {
            if (held(input.nativeSessionId))
              throw refuse(
                "unavailable",
                "That Codex session already belongs to an Octant thread.",
              );
            const threadRead = client.threadRead;
            if (threadRead === undefined)
              throw refuse("unsupported", "This Codex cannot read its sessions.");
            // `thread/read` reads the stored thread without loading it, so
            // the person's own Codex keeps it (measured with codex-cli 0.170.0).
            const { thread } = await threadRead({ threadId: input.nativeSessionId });
            if (thread.id !== input.nativeSessionId || !personSessionIn(thread, input.projectRoot))
              throw refuse("stale-resume", "That Codex session is not one of this folder's.");
            // Read again: the journal may have recorded it while Codex answered.
            if (held(input.nativeSessionId))
              throw refuse(
                "unavailable",
                "That Codex session already belongs to an Octant thread.",
              );
            claims.set(input.nativeSessionId, String(input.sessionId));
            return {
              driverKind: "codex",
              value: input.nativeSessionId,
              // Codex fixed the thread's tools when the person's Codex started
              // it, and a resume cannot add Octant's app tools.
              tools: [],
              toolDefinitions: [],
              adopted: true,
              binding: providerResumeBinding({
                instanceId: options.instanceId,
                sessionId: input.sessionId,
                projectRoot: input.projectRoot,
                mode: input.mode,
                modelId: input.modelId,
              }),
            } satisfies ProviderResumeCursor;
          }),
        )
        .pipe(Effect.mapError(passRefusal("The Codex session could not be taken up.")));
    },
    // Taken in turn with adoptions of the same thread, so a release never
    // gives back a claim a later adoption made.
    release: (input) =>
      wrongInstance(input.instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.promise(() =>
            oneAtATime(key(input.nativeSessionId), async () => {
              if (claims.get(input.nativeSessionId) === String(input.sessionId))
                claims.delete(input.nativeSessionId);
            }),
          ),
  };
}

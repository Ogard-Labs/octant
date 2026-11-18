/**
 * Starting an Octant thread from one of the person's own Codex sessions, and
 * the record of the Codex threads Octant holds that it did not start.
 *
 * Octant's Codex runs on the account's own Codex home, so the person's
 * sessions and Octant's sit side by side in Codex's thread store. The list
 * reads it through the app-server's `thread/list`, filtered to the thread's
 * folder: Codex records the folder each thread runs in and the client that
 * created it (`originator`, the `initialize` client name, from codex-cli
 * 0.154.0). A thread Octant started names Octant as its originator and is left
 * out, and so is a subagent's or an ephemeral thread.
 *
 * Adopting resumes the person's own thread, as Codex's own `resume` does:
 * nothing is copied, so the thread's history is the one the person's Codex
 * shows. The adoption is recorded in a file of Octant's own beside the
 * account's other Octant state, naming the Codex thread and the Octant
 * session that holds it; a held thread is neither offered again nor adopted
 * by a second Octant thread, which would leave the first resuming a thread it
 * no longer owned. A native fork's copy is recorded the same way, since Codex
 * copies the source's originator onto it (measured with codex-cli 0.170.0).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ProviderFailure,
  ProviderInstanceId,
  ProviderResumeCursor,
  ProviderSessionId,
} from "@octant/contracts";
import type { ProviderDriver, ProviderNativeSession } from "@octant/provider-sdk/driver";
import { providerResumeBinding } from "./resumeBinding";
import { Effect } from "effect";
import type { CodexStoredThread, CodexThreadListResult } from "./codexProtocol";
import { isAtLeastRelease } from "./releaseVersion";

/** How many of the person's sessions in a folder a thread is offered to start from. */
const MAX_OFFERED_NATIVE_SESSIONS = 50;
/** `thread/list` pages read before the list stops, newest first. */
const MAX_LISTED_PAGES = 5;
const LISTED_PAGE_SIZE = 100;
/** The `initialize` client name Octant's own app-server connections send. */
export const CODEX_OCTANT_ORIGINATOR = "Octant";
/** The first release whose stored threads name the client that created them. */
export const CODEX_THREAD_ORIGINATOR_RELEASE = [0, 154, 0] as const;
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

/**
 * The Codex threads Octant holds that it did not start, by thread id, each
 * naming the Octant session that holds it. A missing or unreadable record
 * holds nothing; an entry that is not two strings is left out.
 */
export function readCodexHeldThreads(recordFile: string): ReadonlyMap<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(recordFile, "utf8"));
  } catch {
    return new Map();
  }
  const sessions =
    typeof value === "object" && value !== null && "sessions" in value
      ? (value as { readonly sessions: unknown }).sessions
      : undefined;
  if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions))
    return new Map();
  const held = new Map<string, string>();
  for (const [threadId, sessionId] of Object.entries(sessions)) {
    if (typeof sessionId === "string" && THREAD_ID.test(threadId)) held.set(threadId, sessionId);
  }
  return held;
}

/** Replaces the record whole, so a reader never sees half of it. */
function writeCodexHeldThreads(recordFile: string, held: ReadonlyMap<string, string>): void {
  mkdirSync(dirname(recordFile), { recursive: true, mode: 0o700 });
  const staging = `${recordFile}.${process.pid}.tmp`;
  try {
    writeFileSync(staging, JSON.stringify({ sessions: Object.fromEntries(held) }), {
      mode: 0o600,
    });
    renameSync(staging, recordFile);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}

/**
 * Changes to one record waiting their turn. The check that no Octant session
 * holds a thread and the entry that then claims it are one step, so two
 * threads adopting the same session at once cannot both pass the check.
 */
const recordChanges = new Map<string, Promise<unknown>>();

export async function changingCodexHeldThreads<A>(
  recordFile: string,
  change: (held: Map<string, string>) => A | Promise<A>,
): Promise<A> {
  const before = recordChanges.get(recordFile) ?? Promise.resolve();
  const mine = before
    .catch(() => undefined)
    .then(async () => {
      const held = new Map(readCodexHeldThreads(recordFile));
      const snapshot = JSON.stringify([...held]);
      const result = await change(held);
      if (JSON.stringify([...held]) !== snapshot) writeCodexHeldThreads(recordFile, held);
      return result;
    });
  recordChanges.set(recordFile, mine);
  try {
    return await mine;
  } finally {
    if (recordChanges.get(recordFile) === mine) recordChanges.delete(recordFile);
  }
}

/** Whether a stored thread is the person's own session in exactly this folder. */
function personSessionIn(thread: CodexStoredThread, projectRoot: string): boolean {
  return (
    thread.cwd === projectRoot &&
    THREAD_ID.test(thread.id) &&
    thread.originator !== undefined &&
    thread.originator !== null &&
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

export function makeCodexNativeSessions(options: {
  readonly instanceId: ProviderInstanceId;
  /** The record of held threads, in the account's Octant state folder. */
  readonly recordFile: string;
  /**
   * Runs `use` against a catalog app-server for this account, which carries
   * no thread, with the running Codex's version.
   */
  readonly catalog: <A>(
    use: (client: CodexSessionCatalog, version: string) => Promise<A>,
  ) => Effect.Effect<A, unknown>;
}): NonNullable<ProviderDriver["nativeSessions"]> {
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
  // An older Codex cannot tell the person's sessions from Octant's own, and
  // offering one of Octant's would let two threads resume one Codex thread.
  const requireOriginator = (version: string) => {
    if (!isAtLeastRelease(version, CODEX_THREAD_ORIGINATOR_RELEASE))
      throw refuse(
        "unsupported",
        `Codex ${version} does not record who started each session. Update Codex to 0.154.0 or later to continue one here.`,
      );
  };
  return {
    list: ({ instanceId, projectRoot }) =>
      wrongInstance(instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : options
            .catalog(async (client, version) => {
              requireOriginator(version);
              const threadList = client.threadList;
              if (threadList === undefined)
                throw refuse("unsupported", "This Codex cannot list its sessions.");
              const held = readCodexHeldThreads(options.recordFile);
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
                  if (!personSessionIn(thread, projectRoot) || held.has(thread.id)) continue;
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
        .catalog((client, version) =>
          changingCodexHeldThreads(options.recordFile, async (held) => {
            requireOriginator(version);
            if (held.has(input.nativeSessionId))
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
            held.set(input.nativeSessionId, String(input.sessionId));
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
    release: (input) =>
      wrongInstance(input.instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: () => releaseCodexHeldThread(options.recordFile, input),
            catch: () => failure("unavailable", "The Codex session could not be released."),
          }),
  };
}

/** Removes a thread's entry only while it still names this Octant session. */
export function releaseCodexHeldThread(
  recordFile: string,
  input: { readonly nativeSessionId: string; readonly sessionId: ProviderSessionId },
): Promise<void> {
  return changingCodexHeldThreads(recordFile, (held) => {
    if (held.get(input.nativeSessionId) === String(input.sessionId))
      held.delete(input.nativeSessionId);
  });
}

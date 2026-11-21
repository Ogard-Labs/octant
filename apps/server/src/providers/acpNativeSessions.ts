/**
 * Starting a thread from an ACP agent's own sessions, through the agent's
 * `session/list` (advertised as `sessionCapabilities.list`), as other ACP
 * clients import an agent's CLI sessions. The list is the agent's answer for
 * the thread's folder, newest first, leaving out any session an Octant thread
 * holds; adopting one records the claim and answers the cursor whose
 * `resumeMethod` reattaches it.
 */
import { resolve } from "node:path";
import type {
  ProviderFailure,
  ProviderInstanceId,
  ProviderResumeCursor,
  ProviderDriverKind,
} from "@octant/contracts";
import type { ProviderDriver, ProviderNativeSession } from "@octant/provider-sdk/driver";
import { Effect } from "effect";
import { providerResumeBinding } from "./resumeBinding";

const MAX_OFFERED_NATIVE_SESSIONS = 50;
const MAX_SESSION_ID_CHARACTERS = 256;

/** One session as the agent's `session/list` names it. */
export interface AcpListedSession {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly title?: string;
  /** When the agent last wrote it, as it reports it. */
  readonly updatedAt?: string;
}

/**
 * The agent's sessions for one folder, or `unsupported` when its `initialize`
 * advertised no `session/list`.
 */
export type AcpSessionLister = (
  projectRoot: string,
) => Promise<ReadonlyArray<AcpListedSession> | "unsupported">;

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** The sessions a `session/list` reply names; an entry it cannot read is skipped. */
export function acpListedSessions(reply: unknown): ReadonlyArray<AcpListedSession> | undefined {
  const sessions = record(reply)?.sessions;
  if (!Array.isArray(sessions)) return undefined;
  const listed: AcpListedSession[] = [];
  for (const candidate of sessions) {
    const entry = record(candidate);
    const sessionId = entry?.sessionId;
    if (
      typeof sessionId !== "string" ||
      sessionId.trim().length === 0 ||
      sessionId.length > MAX_SESSION_ID_CHARACTERS
    )
      continue;
    listed.push({
      sessionId,
      ...(typeof entry?.cwd === "string" ? { cwd: entry.cwd } : {}),
      ...(typeof entry?.title === "string" ? { title: entry.title } : {}),
      ...(typeof entry?.updatedAt === "string" ? { updatedAt: entry.updatedAt } : {}),
    });
  }
  return listed;
}

export function makeAcpNativeSessions(options: {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  /** The agent sessions the host's journal records an Octant thread holding. */
  readonly heldSessions: () => ReadonlySet<string>;
  readonly listSessions: AcpSessionLister;
}): NonNullable<ProviderDriver["nativeSessions"]> {
  const name = options.displayName;
  // Agent session id -> the Octant session that claimed it, until the host
  // records the adoption or the driver gives the claim back.
  const claims = new Map<string, string>();
  const wrongInstance = (instanceId: ProviderInstanceId) =>
    String(instanceId) !== String(options.instanceId);
  const held = (sessionId: string) =>
    claims.has(sessionId) || options.heldSessions().has(sessionId);
  const inFolder = (session: AcpListedSession, projectRoot: string) =>
    session.cwd === undefined || resolve(session.cwd) === resolve(projectRoot);
  const listFor = async (projectRoot: string) => {
    const listed = await options.listSessions(projectRoot);
    if (listed === "unsupported")
      throw failure("unsupported", `${name} does not list its sessions.`);
    return listed.filter((session) => inFolder(session, projectRoot));
  };
  const asFailure = (error: unknown, fallback: string): ProviderFailure => {
    const candidate = record(error);
    return typeof candidate?.category === "string" && typeof candidate.message === "string"
      ? (error as ProviderFailure)
      : failure("unavailable", fallback);
  };
  return {
    list: ({ instanceId, projectRoot }) =>
      wrongInstance(instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: async () => {
              const sessions: ProviderNativeSession[] = [];
              for (const session of await listFor(projectRoot)) {
                if (held(session.sessionId)) continue;
                const updated =
                  session.updatedAt === undefined ? NaN : Date.parse(session.updatedAt);
                const title = session.title?.trim();
                sessions.push({
                  nativeSessionId: session.sessionId,
                  lastModified: Number.isFinite(updated) ? Math.max(0, Math.trunc(updated)) : 0,
                  ...(title === undefined || title.length === 0
                    ? {}
                    : { title: Array.from(title).slice(0, 256).join("") }),
                });
              }
              return sessions
                .sort((left, right) => right.lastModified - left.lastModified)
                .slice(0, MAX_OFFERED_NATIVE_SESSIONS);
            },
            catch: (error) => asFailure(error, `${name}'s sessions could not be read.`),
          }),
    adopt: (input) =>
      Effect.tryPromise({
        try: async () => {
          if (wrongInstance(input.instanceId))
            throw failure("invalid-configuration", "Provider instance does not match driver.");
          if (held(input.nativeSessionId))
            throw failure(
              "unavailable",
              `That ${name} session already belongs to an Octant thread.`,
            );
          const listed = await listFor(input.projectRoot);
          if (!listed.some((session) => session.sessionId === input.nativeSessionId))
            throw failure("stale-resume", `That ${name} session is not one of this folder's.`);
          // Read again: the journal may have recorded it while the agent answered.
          if (held(input.nativeSessionId))
            throw failure(
              "unavailable",
              `That ${name} session already belongs to an Octant thread.`,
            );
          claims.set(input.nativeSessionId, String(input.sessionId));
          return {
            driverKind: options.driverKind,
            value: input.nativeSessionId,
            binding: providerResumeBinding({
              instanceId: options.instanceId,
              sessionId: input.sessionId,
              projectRoot: input.projectRoot,
              mode: input.mode,
              modelId: input.modelId,
            }),
          } satisfies ProviderResumeCursor;
        },
        catch: (error) => asFailure(error, `The ${name} session could not be taken up.`),
      }),
    release: (input) =>
      wrongInstance(input.instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.sync(() => {
            if (claims.get(input.nativeSessionId) === String(input.sessionId))
              claims.delete(input.nativeSessionId);
          }),
  };
}

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
import type {
  ProviderDriver,
  ProviderNativeSession,
  ProviderNativeSessionMessage,
} from "@octant/provider-sdk/driver";
import { Effect } from "effect";
import { providerResumeBinding } from "./resumeBinding";

const MAX_OFFERED_NATIVE_SESSIONS = 50;
const MAX_SESSION_ID_CHARACTERS = 256;
// `session/list` pages through `nextCursor`; the folder filter and the held
// sessions apply only after collecting, so the first page alone hid every
// later session from the list and from adoption. The bounds stop an agent
// that pages without end from holding the request open.
const MAX_LISTED_PAGES = 20;
const MAX_LISTED_SESSIONS = 2000;
const MAX_CURSOR_CHARACTERS = 4096;

/** One session as the agent's `session/list` names it. */
export interface AcpListedSession {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly title?: string;
  /** When the agent last wrote it, as it reports it. */
  readonly updatedAt?: string;
}

/**
 * What a `session/list` read collected. `truncated` when it stopped at a bound
 * with sessions still unread, so a session it did not reach may still exist.
 */
export interface AcpSessionPages {
  readonly sessions: ReadonlyArray<AcpListedSession>;
  readonly truncated: boolean;
}

/**
 * The agent's sessions for one folder, or `unsupported` when its `initialize`
 * advertised no `session/list`.
 */
export type AcpSessionLister = (projectRoot: string) => Promise<AcpSessionPages | "unsupported">;

/**
 * The `session/update` payloads an agent replayed for one session while it
 * loaded it, in order, or `unsupported` when its `initialize` advertised no
 * `loadSession`.
 */
export type AcpSessionHistoryReader = (
  projectRoot: string,
  sessionId: string,
) => Promise<ReadonlyArray<Readonly<Record<string, unknown>>> | "unsupported">;

/** The most replayed updates a history read keeps; the rest are counted as omitted. */
export const MAX_ACP_REPLAYED_UPDATES = 20_000;

function chunkText(update: Readonly<Record<string, unknown>>): string | undefined {
  const content = record(update.content);
  return content?.type === "text" && typeof content.text === "string" ? content.text : undefined;
}

/**
 * A `session/load` replay as imported messages: runs of `user_message_chunk`
 * and of `agent_message_chunk` each make one message, and each `tool_call`
 * is named on the agent message it falls in (by its title, else its kind).
 * Thoughts, plans, tool-call updates and every other update are left out.
 */
export function acpReplayedMessages(
  updates: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ReadonlyArray<ProviderNativeSessionMessage> {
  const messages: Array<{ role: "person" | "agent"; text: string; tools: string[] }> = [];
  const current = (role: "person" | "agent") => {
    const last = messages.at(-1);
    if (last !== undefined && last.role === role) return last;
    const next = { role, text: "", tools: [] };
    messages.push(next);
    return next;
  };
  for (const update of updates) {
    const kind = update.sessionUpdate;
    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const text = chunkText(update);
      if (text !== undefined)
        current(kind === "user_message_chunk" ? "person" : "agent").text += text;
    } else if (kind === "tool_call") {
      const title =
        typeof update.title === "string" && update.title.trim().length > 0
          ? update.title
          : typeof update.kind === "string"
            ? update.kind
            : undefined;
      if (title !== undefined) current("agent").tools.push(title);
    }
  }
  return messages.map((message) => ({
    role: message.role,
    text: message.text,
    ...(message.tools.length === 0 ? {} : { tools: message.tools }),
  }));
}

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

/**
 * Every session the agent's `session/list` names across its pages, asking
 * for each following page with the `cursor` the previous one returned. It
 * stops at a cursor it has already followed and at the page and session
 * bounds, and says it was truncated when it stopped with a page or a session
 * left unread; `undefined` when any page cannot be read.
 */
export async function readAcpSessionPages(
  listPage: (cursor: string | undefined) => Promise<unknown>,
): Promise<AcpSessionPages | undefined> {
  const listed: AcpListedSession[] = [];
  const followed = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LISTED_PAGES; page += 1) {
    const reply = await listPage(cursor);
    const sessions = acpListedSessions(reply);
    if (sessions === undefined) return undefined;
    const room = MAX_LISTED_SESSIONS - listed.length;
    listed.push(...sessions.slice(0, room));
    const next = record(reply)?.nextCursor;
    const more = typeof next === "string" && next.length > 0;
    if (sessions.length > room) return { sessions: listed, truncated: true };
    if (!more) return { sessions: listed, truncated: false };
    if (
      listed.length >= MAX_LISTED_SESSIONS ||
      next.length > MAX_CURSOR_CHARACTERS ||
      followed.has(next)
    )
      return { sessions: listed, truncated: true };
    followed.add(next);
    cursor = next;
  }
  // The last page allowed still named a following one.
  return { sessions: listed, truncated: true };
}

export function makeAcpNativeSessions(options: {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  /** The agent sessions the host's journal records an Octant thread holding. */
  readonly heldSessions: () => ReadonlySet<string>;
  readonly listSessions: AcpSessionLister;
  /** Reads a session's replay; absent, the agent's sessions import no history. */
  readonly readHistory?: AcpSessionHistoryReader;
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
    return {
      sessions: listed.sessions.filter((session) => inFolder(session, projectRoot)),
      truncated: listed.truncated,
    };
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
              for (const session of (await listFor(projectRoot)).sessions) {
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
          if (!listed.sessions.some((session) => session.sessionId === input.nativeSessionId)) {
            // A read that stopped at a bound cannot tell a session that is gone
            // from one it never reached.
            if (listed.truncated)
              throw failure(
                "unavailable",
                `That session is past the sessions Octant can read; open it in ${name} instead.`,
              );
            throw failure("stale-resume", `That ${name} session is not one of this folder's.`);
          }
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
    ...(options.readHistory === undefined
      ? {}
      : {
          history: (input: {
            readonly instanceId: ProviderInstanceId;
            readonly projectRoot: string;
            readonly nativeSessionId: string;
          }) => {
            const readHistory = options.readHistory;
            return wrongInstance(input.instanceId) || readHistory === undefined
              ? Effect.fail(
                  failure("invalid-configuration", "Provider instance does not match driver."),
                )
              : Effect.tryPromise({
                  try: async () => {
                    const replayed = await readHistory(input.projectRoot, input.nativeSessionId);
                    if (replayed === "unsupported") return { status: "unsupported" as const };
                    return { status: "read" as const, messages: acpReplayedMessages(replayed) };
                  },
                  catch: (error) => asFailure(error, `${name}'s session could not be read.`),
                });
          },
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

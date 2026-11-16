/**
 * Starting an Octant thread from one of the person's own Pi sessions.
 *
 * Pi keeps each session as a JSONL file whose first line is its header
 * (`{"type":"session","id":...,"cwd":...}`), under
 * `<sessions>/--<folder>--/<timestamp>_<id>.jsonl`, where `<sessions>` is
 * `PI_CODING_AGENT_SESSION_DIR`, else `<agent dir>/sessions`, and the folder
 * is the working directory with its leading separator removed and `/`, `\`
 * and `:` replaced by `-` (Pi's session file format reference). Octant's own
 * Pi sessions live in its managed home instead, one flat folder that Pi's
 * `--session-dir` points at.
 *
 * Adopting copies the person's session into Octant's folder under the Octant
 * session's id, with `parentSession` naming the file it came from, as Pi's own
 * fork records its source. The person's file is never written, so their own
 * Pi keeps working on it, and the thread resumes the copy through the ordinary
 * resume checks. The copy's `parentSession` is also the record that an Octant
 * thread holds that session: it is left out of the list and a second adoption
 * is refused.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ProviderFailure,
  type ProviderInstanceId,
  type ProviderResumeCursor,
} from "@octant/contracts";
import type { ProviderDriver, ProviderNativeSession } from "@octant/provider-sdk/driver";
import { Effect } from "effect";

/** How many of the person's sessions in a folder a thread is offered to start from. */
const MAX_OFFERED_NATIVE_SESSIONS = 50;
/** A session file larger than this is offered without its name rather than read whole. */
const MAX_NAMED_SESSION_BYTES = 8 * 1024 * 1024;
/** A session file larger than this is not copied: Octant refuses rather than truncates it. */
const MAX_ADOPTED_SESSION_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

interface PiSessionHeader {
  readonly type: "session";
  readonly id: string;
  readonly cwd: string;
  readonly parentSession?: string;
  readonly [key: string]: unknown;
}

/** The person's own Pi session folder, as Pi itself resolves it. */
export function piPersonSessionDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.PI_CODING_AGENT_SESSION_DIR;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const agentDirectory = environment.PI_CODING_AGENT_DIR;
  return join(
    agentDirectory !== undefined && agentDirectory.length > 0
      ? agentDirectory
      : join(homedir(), ".pi", "agent"),
    "sessions",
  );
}

/** The folder Pi files a working directory's sessions under. */
export function piSessionFolderName(projectRoot: string): string {
  return `--${projectRoot.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}

function headerOf(line: string | undefined): PiSessionHeader | undefined {
  if (line === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const header = value as Readonly<Record<string, unknown>>;
  if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string")
    return undefined;
  if (header.parentSession !== undefined && typeof header.parentSession !== "string")
    return undefined;
  return header as PiSessionHeader;
}

/** A regular file's first line and size, never following a link. */
function readHeader(
  path: string,
):
  | { readonly header: PiSessionHeader; readonly size: number; readonly mtimeMs: number }
  | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(HEADER_BYTES, stat.size));
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const header = headerOf(buffer.subarray(0, length).toString("utf8").split("\n")[0]);
    return header === undefined ? undefined : { header, size: stat.size, mtimeMs: stat.mtimeMs };
  } finally {
    closeSync(descriptor);
  }
}

/** The last name the person gave the session (`session_info` entries), when the file is small enough to read. */
function sessionName(path: string, size: number): string | undefined {
  if (size > MAX_NAMED_SESSION_BYTES) return undefined;
  let name: string | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"session_info"')) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (
        typeof entry === "object" &&
        entry !== null &&
        "type" in entry &&
        entry.type === "session_info" &&
        "name" in entry &&
        typeof entry.name === "string" &&
        entry.name.trim().length > 0
      )
        name = Array.from(entry.name.trim()).slice(0, 256).join("");
    } catch {
      // A torn last line is Pi's to repair; it names nothing.
    }
  }
  return name;
}

function sessionFiles(directory: string): ReadonlyArray<string> {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/** The person's session files an Octant thread already adopted, by the path each was copied from. */
function adoptedSources(octantDirectory: string): ReadonlyMap<string, string> {
  const held = new Map<string, string>();
  for (const path of sessionFiles(octantDirectory)) {
    const header = readHeader(path)?.header;
    if (header?.parentSession !== undefined) held.set(header.parentSession, header.id);
  }
  return held;
}

function personSessionFile(
  personDirectory: string,
  projectRoot: string,
  nativeSessionId: string,
):
  | {
      readonly path: string;
      readonly name: string;
      readonly header: PiSessionHeader;
      readonly size: number;
    }
  | undefined {
  const folder = join(personDirectory, piSessionFolderName(projectRoot));
  const matches = sessionFiles(folder).filter((path) => path.endsWith(`_${nativeSessionId}.jsonl`));
  if (matches.length !== 1) return undefined;
  const path = matches[0];
  if (path === undefined) return undefined;
  const read = readHeader(path);
  if (read === undefined || read.header.id !== nativeSessionId || read.header.cwd !== projectRoot)
    return undefined;
  return { path, name: path.slice(folder.length + 1), header: read.header, size: read.size };
}

/**
 * Adoptions of one Pi session waiting their turn. The check that no Octant
 * thread holds the session and the copy that then claims it are one step, so
 * two threads adopting the same session at once cannot both pass the check.
 */
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

export function makePiNativeSessions(options: {
  readonly instanceId: ProviderInstanceId;
  /** Octant's own Pi session folder (`<managed home>/sessions`). */
  readonly octantSessionDirectory: string;
  /** The person's own Pi session folder; defaults to Pi's own resolution. */
  readonly personSessionDirectory?: string;
}): NonNullable<ProviderDriver["nativeSessions"]> {
  const personDirectory = options.personSessionDirectory ?? piPersonSessionDirectory();
  // Only these sentences reach the person; anything else thrown on the way is
  // reduced to one generic sentence.
  const refusals = new WeakSet<ProviderFailure>();
  const refuse = (category: ProviderFailure["category"], message: string) => {
    const refusal = failure(category, message);
    refusals.add(refusal);
    return refusal;
  };
  const wrongInstance = (instanceId: ProviderInstanceId) =>
    String(instanceId) !== String(options.instanceId);
  return {
    list: ({ instanceId, projectRoot }) =>
      wrongInstance(instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.try({
            try: () => {
              const held = adoptedSources(options.octantSessionDirectory);
              const folder = join(personDirectory, piSessionFolderName(projectRoot));
              const sessions: ProviderNativeSession[] = [];
              for (const path of sessionFiles(folder)) {
                if (held.has(path)) continue;
                const read = readHeader(path);
                if (
                  read === undefined ||
                  read.header.cwd !== projectRoot ||
                  !SESSION_ID.test(read.header.id) ||
                  !path.endsWith(`_${read.header.id}.jsonl`)
                )
                  continue;
                const title = sessionName(path, read.size);
                sessions.push({
                  nativeSessionId: read.header.id,
                  lastModified: Math.trunc(read.mtimeMs),
                  ...(title === undefined ? {} : { title }),
                });
              }
              return sessions
                .sort((left, right) => right.lastModified - left.lastModified)
                .slice(0, MAX_OFFERED_NATIVE_SESSIONS);
            },
            catch: () => failure("unavailable", "Pi's sessions could not be read."),
          }),
    adopt: (input) =>
      Effect.tryPromise({
        try: () =>
          oneAtATime(`${String(options.instanceId)}\u0000${input.nativeSessionId}`, async () => {
            if (wrongInstance(input.instanceId))
              throw refuse("invalid-configuration", "Provider instance does not match driver.");
            if (
              !SESSION_ID.test(input.nativeSessionId) ||
              !SESSION_ID.test(String(input.sessionId))
            )
              throw refuse("stale-resume", "That Pi session is not one of this folder's.");
            const source = personSessionFile(
              personDirectory,
              input.projectRoot,
              input.nativeSessionId,
            );
            if (source === undefined)
              throw refuse("stale-resume", "That Pi session is not one of this folder's.");
            if (adoptedSources(options.octantSessionDirectory).has(source.path))
              throw refuse("unavailable", "That Pi session already belongs to an Octant thread.");
            if (source.size > MAX_ADOPTED_SESSION_BYTES)
              throw refuse("unsupported", "That Pi session is too large to take up.");
            const [, ...entries] = readFileSync(source.path, "utf8").split("\n");
            const header = {
              ...source.header,
              id: String(input.sessionId),
              parentSession: source.path,
            };
            const prefix = source.name.slice(0, -`_${input.nativeSessionId}.jsonl`.length);
            const target = join(
              options.octantSessionDirectory,
              `${prefix}_${String(input.sessionId)}.jsonl`,
            );
            // An Octant session that already has a history keeps it.
            if (
              sessionFiles(options.octantSessionDirectory).some((path) =>
                path.endsWith(`_${String(input.sessionId)}.jsonl`),
              )
            )
              throw refuse("unavailable", "This thread already has a Pi session.");
            const descriptor = openSync(
              target,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            // `writeFileSync` on a descriptor writes until the whole copy is
            // down, where one `writeSync` may stop short. A copy that fails
            // part way is removed: its header would otherwise mark the
            // session as held and refuse every retry.
            let written = false;
            try {
              writeFileSync(descriptor, [JSON.stringify(header), ...entries].join("\n"));
              written = true;
            } finally {
              closeSync(descriptor);
              if (!written) rmSync(target, { force: true });
            }
            return {
              driverKind: "pi",
              value: String(input.sessionId),
              binding: {
                instanceId: options.instanceId,
                sessionId: input.sessionId,
                projectRoot: input.projectRoot,
                mode: input.mode,
                modelId: input.modelId,
              },
            } satisfies ProviderResumeCursor;
          }),
        catch: (error) =>
          typeof error === "object" && error !== null && refusals.has(error as ProviderFailure)
            ? (error as ProviderFailure)
            : failure("unavailable", "The Pi session could not be taken up."),
      }),
    // Taken in turn with adoptions of the same session, so a release never
    // removes a copy a later adoption wrote.
    release: (input) =>
      wrongInstance(input.instanceId)
        ? Effect.fail(failure("invalid-configuration", "Provider instance does not match driver."))
        : Effect.tryPromise({
            try: () =>
              oneAtATime(
                `${String(options.instanceId)}\u0000${input.nativeSessionId}`,
                async () => {
                  for (const path of sessionFiles(options.octantSessionDirectory)) {
                    if (!path.endsWith(`_${String(input.sessionId)}.jsonl`)) continue;
                    const header = readHeader(path)?.header;
                    if (
                      header === undefined ||
                      header.id !== String(input.sessionId) ||
                      header.parentSession === undefined ||
                      !header.parentSession.endsWith(`_${input.nativeSessionId}.jsonl`) ||
                      !lstatSync(path).isFile()
                    )
                      continue;
                    rmSync(path);
                  }
                },
              ),
            catch: () => failure("unavailable", "The Pi session could not be released."),
          }),
  };
}

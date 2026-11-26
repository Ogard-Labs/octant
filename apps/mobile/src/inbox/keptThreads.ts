import {
  sortMobileInboxRows,
  type MobileInboxRow,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { DEVICE_ACCESS_LEVELS } from "@octant/contracts";

export interface KeptProject {
  readonly hostId: string;
  readonly projectId: string;
  readonly name: string;
}

/**
 * What the phone last read from its computers: their threads, Project names,
 * and what each said this phone's session may do there.
 */
export interface KeptThreads {
  readonly rows: ReadonlyArray<MobileInboxRow>;
  readonly projects: ReadonlyArray<KeptProject>;
  /** By computer. */
  readonly standings: ReadonlyMap<string, RemoteSessionStanding>;
}

/** A computer the phone is paired with, as the kept list is bound to it. */
export interface KeptPairing {
  readonly hostId: string;
  readonly hostKeyFingerprint: string;
  readonly keyId: string;
}

interface KeptHost {
  readonly fingerprint: string;
  readonly keyId: string;
  readonly rows: ReadonlyArray<MobileInboxRow>;
  readonly projects: ReadonlyArray<{ readonly projectId: string; readonly name: string }>;
  readonly standing?: RemoteSessionStanding;
}

const VERSION = 1;
/** Enough to find the thread a message is for; the newest come first. */
export const KEPT_ROWS = 500;
const MODES: ReadonlySet<unknown> = new Set(["chat", "work", "code"]);

/**
 * What of a row outlives the app. A turn shown working or an ask shown waiting
 * may have ended hours ago, and whether it was read is the phone's own mark.
 */
function lasting(row: MobileInboxRow): MobileInboxRow {
  const { unread: _unread, live: _live, waitingAsk: _waitingAsk, ...kept } = row;
  return kept;
}

/** The text to keep for these rows, or none when no paired computer has any. */
export function keptThreadsText(
  read: KeptThreads,
  pairings: ReadonlyArray<KeptPairing>,
): string | undefined {
  const rows = sortMobileInboxRows(read.rows);
  const hosts: Record<string, KeptHost> = {};
  for (const { hostId, hostKeyFingerprint, keyId } of pairings) {
    const standing = read.standings.get(hostId);
    const kept: KeptHost = {
      fingerprint: hostKeyFingerprint,
      keyId,
      rows: rows
        .filter((row) => row.hostId === hostId)
        .slice(0, KEPT_ROWS)
        .map(lasting),
      projects: read.projects
        .filter((project) => project.hostId === hostId)
        .map(({ projectId, name }) => ({ projectId, name })),
      ...(standing === undefined ? {} : { standing }),
    };
    if (kept.rows.length > 0 || kept.projects.length > 0 || standing !== undefined)
      hosts[hostId] = kept;
  }
  return Object.keys(hosts).length === 0 ? undefined : JSON.stringify({ version: VERSION, hosts });
}

const isText = (value: unknown): value is string => typeof value === "string";

function isRow(value: unknown, hostId: string): value is MobileInboxRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.hostId === hostId &&
    MODES.has(row.mode) &&
    isText(row.threadId) &&
    isText(row.title) &&
    isText(row.status) &&
    isText(row.freshness)
  );
}

function isProject(value: unknown): value is KeptHost["projects"][number] {
  if (typeof value !== "object" || value === null) return false;
  const project = value as Record<string, unknown>;
  return isText(project.projectId) && isText(project.name);
}

function asStanding(value: unknown): RemoteSessionStanding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { actsAsHostPerson, accessLevel } = value as Record<string, unknown>;
  if (typeof actsAsHostPerson !== "boolean") return undefined;
  if (accessLevel === undefined) return { actsAsHostPerson };
  const level = DEVICE_ACCESS_LEVELS.find((entry) => entry === accessLevel);
  return level === undefined ? undefined : { actsAsHostPerson, accessLevel: level };
}

/**
 * What was kept of the computers this phone is paired with now. A computer
 * paired again, under its key or this phone's, or no longer paired, gets
 * nothing back.
 */
export function restoreKeptThreads(
  text: string | null,
  pairings: ReadonlyArray<KeptPairing>,
): KeptThreads {
  const none: KeptThreads = { rows: [], projects: [], standings: new Map() };
  if (text === null) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none;
  }
  if (typeof parsed !== "object" || parsed === null) return none;
  const { version, hosts } = parsed as { version?: unknown; hosts?: unknown };
  if (version !== VERSION || typeof hosts !== "object" || hosts === null) return none;
  const rows: MobileInboxRow[] = [];
  const projects: KeptProject[] = [];
  const standings = new Map<string, RemoteSessionStanding>();
  for (const { hostId, hostKeyFingerprint, keyId } of pairings) {
    if (!Object.hasOwn(hosts, hostId)) continue;
    const kept: unknown = (hosts as Record<string, unknown>)[hostId];
    if (typeof kept !== "object" || kept === null) continue;
    const host = kept as Record<string, unknown>;
    if (host.fingerprint !== hostKeyFingerprint || host.keyId !== keyId) continue;
    const standing = asStanding(host.standing);
    if (standing !== undefined) standings.set(hostId, standing);
    if (Array.isArray(host.rows))
      rows.push(...host.rows.filter((row) => isRow(row, hostId)).slice(0, KEPT_ROWS));
    if (Array.isArray(host.projects))
      projects.push(
        ...host.projects.filter(isProject).map(({ projectId, name }) => ({
          hostId,
          projectId,
          name,
        })),
      );
  }
  return { rows: sortMobileInboxRows(rows), projects, standings };
}

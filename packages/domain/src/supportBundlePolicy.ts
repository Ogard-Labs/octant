import {
  SUPPORT_BUNDLE_VERSION,
  type SupportBundleDestinationCategory,
  type SupportBundleFile,
  type SupportBundlePreview,
  type SupportBundleSectionId,
  type SupportBundleSectionPreview,
} from "@octant/contracts";
import { redactDiagnosticText, stillContainsSecret } from "./diagnosticsPolicy";

/**
 * Pure policy for the support bundle: a folder or zip of host facts a person
 * saves and sends themselves. Nothing here reads the host or writes a file.
 * The server gathers facts, this module decides what may be said about them,
 * sweeps every string through the diagnostics redaction, and lays the files
 * out. No message, prompt, or file content is a fact the bundle can carry:
 * the fact types below have no field for one.
 */

export interface SupportBundleProviderFact {
  /** The driver kind and a position among its siblings, never a name or id the person chose. */
  readonly ref: string;
  readonly driverKind: string;
  readonly readiness: string;
  readonly processState: string;
  readonly accountAuthentication?: string;
  readonly credentialStatus?: string;
  readonly unauthenticatedReason?: string;
  readonly refusalReason?: string;
  readonly detectedVersion?: string;
  readonly lastSuccessfulProbeAt?: string;
  readonly modelCount: number;
  /** Capability name to `supported`, `unsupported`, or `unavailable`. */
  readonly capabilities: Readonly<Record<string, string>>;
}

export interface SupportBundleLogLine {
  readonly timestamp: string;
  readonly level: string;
  readonly event: string;
  readonly message: string;
}

export interface SupportBundleJournalEvent {
  readonly sequence: number;
  readonly name: string;
  readonly occurredAt: string;
}

export interface SupportBundleFacts {
  readonly bundleId: string;
  readonly generatedAt: string;
  readonly versions: {
    readonly octant: string;
    readonly wire: string;
    readonly runtime: string;
  };
  readonly system: {
    readonly platform: string;
    readonly osRelease: string;
    readonly architecture: string;
    readonly cpuCount: number;
    readonly totalMemoryMb: number;
  };
  /** `undefined` for a section the host could not read; the bundle says so. */
  readonly providers?: {
    readonly enabled: ReadonlyArray<SupportBundleProviderFact>;
    readonly disabledCount: number;
  };
  readonly hostLog?: { readonly lines: ReadonlyArray<SupportBundleLogLine> };
  readonly journalEvents?: {
    readonly head: number;
    readonly events: ReadonlyArray<SupportBundleJournalEvent>;
  };
  readonly confinement?: {
    readonly defaultExecutionPolicy?: string;
    readonly defaultPermissionPersistence?: string;
    /** Code threads per execution policy: counts only. */
    readonly threadsByExecutionPolicy: Readonly<Record<string, number>>;
    /** Sandbox and service tools the host found on this machine. */
    readonly platformCapabilities: ReadonlyArray<string>;
    readonly remoteListenerEnabled: boolean;
  };
  readonly process?: {
    readonly uptimeSeconds: number;
    readonly memoryMb: {
      readonly rss: number;
      readonly heapUsed: number;
      readonly heapTotal: number;
      readonly external: number;
    };
    readonly cpuMs: { readonly user: number; readonly system: number };
    readonly eventLoopLagCount: number;
    readonly eventLoopLagWorstMs: number;
    readonly slowStatementCount: number;
    readonly slowStatementWorstMs: number;
    readonly connectedClients: number;
    readonly activeSessions: number;
    readonly storeState: string;
    readonly storeIntegrity: string;
    readonly databaseBytes?: number;
  };
}

interface SectionDescription {
  readonly id: SupportBundleSectionId;
  readonly title: string;
  readonly includes: string;
  readonly file: string;
}

/** The plain list a person reads before saving; `entries` come from the live host. */
export const SUPPORT_BUNDLE_SECTIONS: ReadonlyArray<SectionDescription> = [
  {
    id: "versions",
    title: "Versions",
    includes: "The Octant version and the runtime it runs on.",
    file: "versions.json",
  },
  {
    id: "system",
    title: "System",
    includes: "Operating system, release, processor type, processor count, and installed memory.",
    file: "system.json",
  },
  {
    id: "providers",
    title: "Providers",
    includes:
      "Each enabled provider by kind: whether it is ready, signed in, and which capabilities it reports.",
    file: "providers.json",
  },
  {
    id: "host-log",
    title: "Host log",
    includes: "The most recent host log lines: time, level, event name, and message.",
    file: "host-log.json",
  },
  {
    id: "journal-events",
    title: "Recent activity",
    includes: "The names and times of the most recent journal events, with nothing they carry.",
    file: "journal-events.json",
  },
  {
    id: "confinement",
    title: "Confinement and guardrails",
    includes:
      "The default guardrail level, how many Code threads run at each, and the sandbox tools found.",
    file: "confinement.json",
  },
  {
    id: "process",
    title: "Process",
    includes: "Uptime, memory, processor time, event-loop delays, and slow database statements.",
    file: "process.json",
  },
];

/** What the bundle never holds, in the words shown above the Save button. */
export const SUPPORT_BUNDLE_NEVER_INCLUDED: ReadonlyArray<string> = [
  "Messages, prompts, replies, or notes.",
  "File contents, file names, or Project and thread names.",
  "API keys, tokens, passwords, or sign-in details.",
  "Your home folder's full path: it is shown as ~.",
  "Anything sent anywhere: Octant only writes the file you choose.",
];

/** Newest host log lines and journal events a bundle carries. */
export const SUPPORT_BUNDLE_LOG_LINE_LIMIT = 200;
export const SUPPORT_BUNDLE_JOURNAL_EVENT_LIMIT = 200;
const MESSAGE_LIMIT = 240;
const WITHHELD = "[withheld]";
// "password is hunter2": redacting the keyword would leave the value behind, so
// a sentence that names a secret and states it is withheld whole.
const STATED_SECRET =
  /\b(?:password|passphrase|secret|token|api[-_ ]?key|access[-_ ]?token|pairing[-_ ]?(?:code|token|ticket|secret))\b\s+(?:is|was|for)\s+\S+/i;

const README_HEADER = [
  "Octant support bundle",
  "",
  "This bundle was saved on request from the Octant host it describes. Octant sent",
  "nothing anywhere. Read every file before you share it, and share it only with",
  "someone you trust to help.",
  "",
  "It never holds messages, prompts, file contents, Project or thread names,",
  "API keys, tokens, or passwords. Your home folder is shown as ~.",
  "",
];

/**
 * One string, made safe: your home folder becomes `~`, then the diagnostics
 * redaction strips secrets and any other person's home path. Text that still
 * resembles a secret afterwards is withheld whole rather than trusted.
 */
export function sanitizeSupportBundleText(
  raw: string,
  homeDirectories: ReadonlyArray<string>,
): string {
  let text = raw;
  for (const home of [...homeDirectories].sort((a, b) => b.length - a.length)) {
    const trimmed = home.replace(/\/+$/, "");
    if (trimmed.length < 2) continue;
    text = text.split(trimmed).join("~");
  }
  if (STATED_SECRET.test(text)) return WITHHELD;
  const redacted = redactDiagnosticText(text).text;
  return stillContainsSecret(redacted) ? WITHHELD : redacted;
}

function sanitizeValue(value: unknown, homes: ReadonlyArray<string>): unknown {
  if (typeof value === "string") return sanitizeSupportBundleText(value, homes);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, homes));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitizeSupportBundleText(key, homes),
        sanitizeValue(item, homes),
      ]),
    );
  }
  return value;
}

function entryCount(facts: SupportBundleFacts, id: SupportBundleSectionId): number | undefined {
  switch (id) {
    case "versions":
      return 3;
    case "system":
      return 5;
    case "providers":
      return facts.providers?.enabled.length;
    case "host-log":
      return facts.hostLog === undefined
        ? undefined
        : Math.min(facts.hostLog.lines.length, SUPPORT_BUNDLE_LOG_LINE_LIMIT);
    case "journal-events":
      return facts.journalEvents === undefined
        ? undefined
        : Math.min(facts.journalEvents.events.length, SUPPORT_BUNDLE_JOURNAL_EVENT_LIMIT);
    case "confinement":
      return facts.confinement === undefined
        ? undefined
        : Object.keys(facts.confinement.threadsByExecutionPolicy).length +
            facts.confinement.platformCapabilities.length;
    case "process":
      return facts.process === undefined ? undefined : 1;
  }
}

/** The plain list shown before saving: sections with live counts, and what is left out. */
export function describeSupportBundle(facts: SupportBundleFacts): SupportBundlePreview {
  const sections: ReadonlyArray<SupportBundleSectionPreview> = SUPPORT_BUNDLE_SECTIONS.map(
    (section) => {
      const entries = entryCount(facts, section.id);
      return {
        id: section.id,
        title: section.title,
        includes: section.includes,
        entries: entries ?? 0,
        available: entries !== undefined,
      };
    },
  );
  return {
    bundleVersion: SUPPORT_BUNDLE_VERSION,
    generatedAt: facts.generatedAt as SupportBundlePreview["generatedAt"],
    sections,
    neverIncluded: SUPPORT_BUNDLE_NEVER_INCLUDED,
  };
}

function sectionBody(
  id: SupportBundleSectionId,
  facts: SupportBundleFacts,
): Readonly<Record<string, unknown>> | undefined {
  switch (id) {
    case "versions":
      return { ...facts.versions, bundleVersion: SUPPORT_BUNDLE_VERSION };
    case "system":
      return { ...facts.system };
    case "providers":
      return facts.providers === undefined
        ? undefined
        : {
            enabled: facts.providers.enabled,
            disabledCount: facts.providers.disabledCount,
          };
    case "host-log":
      return facts.hostLog === undefined
        ? undefined
        : {
            // Named fields only: a line object that carries anything more
            // (a payload, a content field) must not reach the file.
            lines: facts.hostLog.lines.slice(-SUPPORT_BUNDLE_LOG_LINE_LIMIT).map((line) => ({
              timestamp: line.timestamp,
              level: line.level,
              event: line.event,
              message: line.message.slice(0, MESSAGE_LIMIT),
            })),
          };
    case "journal-events":
      return facts.journalEvents === undefined
        ? undefined
        : {
            head: facts.journalEvents.head,
            events: facts.journalEvents.events
              .slice(0, SUPPORT_BUNDLE_JOURNAL_EVENT_LIMIT)
              .map((event) => ({
                sequence: event.sequence,
                name: event.name,
                occurredAt: event.occurredAt,
              })),
          };
    case "confinement":
      return facts.confinement === undefined ? undefined : { ...facts.confinement };
    case "process":
      return facts.process === undefined ? undefined : { ...facts.process };
  }
}

/**
 * The bundle's files: a readme that lists what is inside, and one JSON file
 * per section. A section the host could not read still gets its file, saying
 * so, so a reader never mistakes a gap for an empty section.
 */
export function buildSupportBundleFiles(
  facts: SupportBundleFacts,
  homeDirectories: ReadonlyArray<string>,
): ReadonlyArray<SupportBundleFile> {
  const preview = describeSupportBundle(facts);
  const readme = [
    ...README_HEADER,
    `Bundle ${facts.bundleId}, version ${SUPPORT_BUNDLE_VERSION}, saved ${facts.generatedAt}.`,
    "",
    "Files:",
    ...SUPPORT_BUNDLE_SECTIONS.map((section) => {
      const row = preview.sections.find((candidate) => candidate.id === section.id);
      const state =
        row?.available === true ? supportBundleEntriesLabel(row.entries) : "not available";
      return `- ${section.file}: ${section.title}. ${section.includes} (${state})`;
    }),
    "",
  ].join("\n");
  const files: SupportBundleFile[] = [
    { path: "readme.txt", contents: sanitizeSupportBundleText(readme, homeDirectories) },
  ];
  for (const section of SUPPORT_BUNDLE_SECTIONS) {
    const body = sectionBody(section.id, facts);
    const document =
      body === undefined
        ? { available: false }
        : sanitizeValue({ available: true, ...body }, homeDirectories);
    files.push({ path: section.file, contents: `${JSON.stringify(document, null, 2)}\n` });
  }
  return files;
}

/** "1 entry" or "3 entries": one wording for the readme, the terminal, and Settings. */
export function supportBundleEntriesLabel(entries: number): string {
  return entries === 1 ? "1 entry" : `${entries} entries`;
}

function startsWithFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * Which kind of place a saved bundle went, so the journal can say "Downloads"
 * without keeping a folder name. Only the person's own well-known folders and
 * the temporary folders are named; everything else is `other-folder`.
 */
export function categorizeSupportBundleDestination(
  path: string,
  homeDirectory: string,
): SupportBundleDestinationCategory {
  const home = homeDirectory.replace(/\/+$/, "");
  const normalized = path.replace(/\/+/g, "/");
  for (const [folder, category] of [
    ["Downloads", "downloads"],
    ["Desktop", "desktop"],
    ["Documents", "documents"],
  ] as const) {
    if (home !== "" && startsWithFolder(normalized, `${home}/${folder}`)) return category;
  }
  for (const folder of ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]) {
    if (startsWithFolder(normalized, folder)) return "temporary-folder";
  }
  if (
    home !== "" &&
    normalized.startsWith(`${home}/`) &&
    !normalized.slice(home.length + 1).includes("/")
  ) {
    return "home-folder";
  }
  return "other-folder";
}

const CRC_TABLE: ReadonlyArray<number> = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A zip of the bundle's files, stored without compression: the files are a few
 * hundred kilobytes of text, and a stored archive needs no library and opens
 * in every unzip tool.
 */
export function buildSupportBundleZip(
  files: ReadonlyArray<SupportBundleFile>,
  modifiedAt: Date,
): Uint8Array {
  const encoder = new TextEncoder();
  const year = Math.max(1980, modifiedAt.getUTCFullYear());
  const dosTime =
    (modifiedAt.getUTCHours() << 11) |
    (modifiedAt.getUTCMinutes() << 5) |
    Math.floor(modifiedAt.getUTCSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) | ((modifiedAt.getUTCMonth() + 1) << 5) | modifiedAt.getUTCDate();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const header = (size: number): { readonly bytes: Uint8Array; readonly view: DataView } => {
    const bytes = new Uint8Array(size);
    return { bytes, view: new DataView(bytes.buffer) };
  };
  for (const file of files) {
    const name = encoder.encode(file.path);
    const data = encoder.encode(file.contents);
    const crc = crc32(data);
    const local = header(30 + name.length);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(8, 0, true);
    local.view.setUint16(10, dosTime, true);
    local.view.setUint16(12, dosDate, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, name.length, true);
    local.bytes.set(name, 30);
    const entry = header(46 + name.length);
    entry.view.setUint32(0, 0x02014b50, true);
    entry.view.setUint16(4, (3 << 8) | 20, true);
    entry.view.setUint16(6, 20, true);
    entry.view.setUint16(8, 0x0800, true);
    entry.view.setUint16(10, 0, true);
    entry.view.setUint16(12, dosTime, true);
    entry.view.setUint16(14, dosDate, true);
    entry.view.setUint32(16, crc, true);
    entry.view.setUint32(20, data.length, true);
    entry.view.setUint32(24, data.length, true);
    entry.view.setUint16(28, name.length, true);
    entry.view.setUint32(38, (0o100644 << 16) >>> 0, true);
    entry.view.setUint32(42, offset, true);
    entry.bytes.set(name, 46);
    chunks.push(local.bytes, data);
    central.push(entry.bytes);
    offset += local.bytes.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  const all = [...chunks, ...central, end.bytes];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of all) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

import { randomUUID } from "node:crypto";
import { arch, cpus, homedir, release, totalmem } from "node:os";
import {
  decodeSupportBundleExported,
  SUPPORT_BUNDLE_EXPORTED_EVENT,
  type CodeSettings,
  type CorrelationId,
  type DiagnosticHostHealth,
  type ProviderInstance,
  type ProviderObservedState,
  type SupportBundleExportRequest,
  type SupportBundleFile,
  type SupportBundleOutcome,
  type SupportBundlePreview,
} from "@octant/contracts";
import {
  buildSupportBundleFiles,
  describeSupportBundle,
  SUPPORT_BUNDLE_JOURNAL_EVENT_LIMIT,
  SUPPORT_BUNDLE_LOG_LINE_LIMIT,
  type SupportBundleFacts,
  type SupportBundleProviderFact,
} from "@octant/domain";
import { redactHostRuntimeText, type HostRuntimeDiagnostics } from "@octant/host-runtime";
import type { Journal } from "./persistence/journal";
import type { SqliteConnection } from "./persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";

/**
 * Where the support bundle reads each fact. A source that is missing or
 * throws leaves its section marked not available instead of failing the
 * bundle: a host in trouble is when a person most needs the rest of it.
 */
export interface SupportBundleSources {
  readonly connection: SqliteConnection;
  readonly journal: Pick<Journal, "append">;
  readonly octantVersion: string;
  readonly wireVersion?: string;
  readonly providers: () => {
    readonly instances: ReadonlyArray<ProviderInstance>;
    readonly observed: ReadonlyArray<ProviderObservedState>;
  };
  readonly readHostLog?: () => Promise<
    ReadonlyArray<{
      readonly timestamp: string;
      readonly level: string;
      readonly event: string;
      readonly message: string;
    }>
  >;
  readonly codeSettings: () => CodeSettings | undefined;
  readonly codeThreadPolicies: () => ReadonlyArray<string>;
  readonly platformCapabilities: ReadonlyArray<string>;
  readonly hostDiagnostics: () => HostRuntimeDiagnostics;
  readonly hostHealth: () => DiagnosticHostHealth;
  /** Folders to show as `~`; defaults to the account's home folder. */
  readonly homeDirectories?: ReadonlyArray<string>;
  readonly clock?: () => string;
  readonly idGenerator?: () => string;
  readonly eventIdGenerator?: () => string;
}

const MB = 1024 * 1024;
const EVENT_NAME_SHAPE = /^[a-z0-9][a-z0-9._:@-]{0,127}$/i;

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function runtimeLabel(): string {
  const bun = process.versions.bun;
  return bun === undefined ? `node ${process.version}` : `bun ${bun}`;
}

/** Leaf capability support, flattened: `sessionCompaction.chat` and the like. */
function flattenCapabilities(capabilities: object): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(capabilities)) {
    if (typeof value === "string") {
      flat[name] = value;
    } else if (typeof value === "object" && value !== null) {
      for (const [inner, leaf] of Object.entries(value)) {
        if (typeof leaf === "string") flat[`${name}.${inner}`] = leaf;
      }
    }
  }
  return flat;
}

function readProviders(sources: SupportBundleSources): SupportBundleFacts["providers"] {
  const { instances, observed } = sources.providers();
  const stateById = new Map(observed.map((state) => [String(state.instanceId), state]));
  const perKind = new Map<string, number>();
  const enabled: SupportBundleProviderFact[] = [];
  for (const instance of instances) {
    if (!instance.enabled) continue;
    const position = (perKind.get(instance.driverKind) ?? 0) + 1;
    perKind.set(instance.driverKind, position);
    const state = stateById.get(String(instance.id));
    enabled.push({
      ref: `${instance.driverKind}-${position}`,
      driverKind: instance.driverKind,
      readiness: state?.readiness ?? "unknown",
      processState: state?.processState ?? "unknown",
      ...(state?.accountAuthentication === undefined
        ? {}
        : { accountAuthentication: state.accountAuthentication }),
      ...(state?.credentialStatus === undefined
        ? {}
        : { credentialStatus: state.credentialStatus }),
      ...(state?.unauthenticatedReason === undefined
        ? {}
        : { unauthenticatedReason: state.unauthenticatedReason }),
      ...(state?.reason === undefined ? {} : { refusalReason: state.reason }),
      ...(state?.detectedVersion === undefined ? {} : { detectedVersion: state.detectedVersion }),
      ...(state?.lastSuccessfulProbeAt === undefined
        ? {}
        : { lastSuccessfulProbeAt: state.lastSuccessfulProbeAt }),
      modelCount: state?.models.length ?? 0,
      capabilities: state === undefined ? {} : flattenCapabilities(state.capabilities),
    });
  }
  return { enabled, disabledCount: instances.length - enabled.length };
}

async function readHostLog(sources: SupportBundleSources): Promise<SupportBundleFacts["hostLog"]> {
  if (sources.readHostLog === undefined) return undefined;
  const lines = await sources.readHostLog();
  return {
    lines: lines.slice(-SUPPORT_BUNDLE_LOG_LINE_LIMIT).map((line) => ({
      timestamp: line.timestamp,
      level: line.level,
      event: line.event,
      // The log store already redacts on write; a second pass costs nothing
      // and covers a line written by an older build.
      message: redactHostRuntimeText(line.message),
    })),
  };
}

/** Event names and times only: the payload column is never selected. */
function readJournalEvents(connection: SqliteConnection): SupportBundleFacts["journalEvents"] {
  const rows = connection
    .prepare(
      `SELECT global_sequence AS sequence, event_name AS name, occurred_at AS occurredAt
       FROM event_journal ORDER BY global_sequence DESC LIMIT ?`,
    )
    .all(SUPPORT_BUNDLE_JOURNAL_EVENT_LIMIT) as ReadonlyArray<{
    readonly sequence: number;
    readonly name: string;
    readonly occurredAt: string;
  }>;
  return {
    head: rows[0]?.sequence ?? 0,
    events: rows.map((row) => ({
      sequence: row.sequence,
      name: EVENT_NAME_SHAPE.test(row.name) ? row.name : "unrecognised",
      occurredAt: row.occurredAt,
    })),
  };
}

function readConfinement(sources: SupportBundleSources): SupportBundleFacts["confinement"] {
  const settings = sources.codeSettings();
  const threadsByExecutionPolicy: Record<string, number> = {};
  for (const policy of sources.codeThreadPolicies()) {
    threadsByExecutionPolicy[policy] = (threadsByExecutionPolicy[policy] ?? 0) + 1;
  }
  return {
    ...(settings === undefined
      ? {}
      : {
          defaultExecutionPolicy: settings.defaultExecutionPolicy,
          defaultPermissionPersistence: settings.defaultPermissionPersistence,
        }),
    threadsByExecutionPolicy,
    platformCapabilities: sources.platformCapabilities,
    remoteListenerEnabled: sources.hostDiagnostics().capabilities.includes("private-listener"),
  };
}

function readProcess(sources: SupportBundleSources): SupportBundleFacts["process"] {
  const diagnostics = sources.hostDiagnostics();
  const health = sources.hostHealth();
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const database = attempt(
    () =>
      sources.connection
        .prepare(
          "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()",
        )
        .get() as { readonly bytes: number },
  );
  return {
    uptimeSeconds: diagnostics.uptimeSeconds ?? Math.floor(process.uptime()),
    memoryMb: {
      rss: Math.round(memory.rss / MB),
      heapUsed: Math.round(memory.heapUsed / MB),
      heapTotal: Math.round(memory.heapTotal / MB),
      external: Math.round(memory.external / MB),
    },
    cpuMs: { user: Math.round(cpu.user / 1_000), system: Math.round(cpu.system / 1_000) },
    eventLoopLagCount: health.eventLoopLagCount,
    eventLoopLagWorstMs: health.eventLoopLagWorstMs,
    slowStatementCount: health.slowStatementCount,
    slowStatementWorstMs: health.slowStatementWorstMs,
    connectedClients: diagnostics.clients.connected,
    activeSessions: diagnostics.work.active,
    storeState: diagnostics.store.state,
    storeIntegrity: diagnostics.store.integrity,
    ...(database === undefined ? {} : { databaseBytes: database.bytes }),
  };
}

function homeDirectoriesFor(sources: SupportBundleSources): ReadonlyArray<string> {
  return sources.homeDirectories ?? [homedir()];
}

export async function gatherSupportBundleFacts(
  sources: SupportBundleSources,
  bundleId: string,
): Promise<SupportBundleFacts> {
  const generatedAt = (sources.clock ?? (() => new Date().toISOString()))();
  const providers = attempt(() => readProviders(sources));
  const hostLog = await readHostLog(sources).catch(() => undefined);
  const journalEvents = attempt(() => readJournalEvents(sources.connection));
  const confinement = attempt(() => readConfinement(sources));
  const processFacts = attempt(() => readProcess(sources));
  return {
    bundleId,
    generatedAt,
    versions: {
      octant: sources.octantVersion,
      wire: sources.wireVersion ?? "1",
      runtime: runtimeLabel(),
    },
    system: {
      platform: process.platform,
      osRelease: release(),
      architecture: arch(),
      cpuCount: cpus().length,
      totalMemoryMb: Math.round(totalmem() / MB),
    },
    ...(providers === undefined ? {} : { providers }),
    ...(hostLog === undefined ? {} : { hostLog }),
    ...(journalEvents === undefined ? {} : { journalEvents }),
    ...(confinement === undefined ? {} : { confinement }),
    ...(processFacts === undefined ? {} : { process: processFacts }),
  };
}

/** The plain list shown before saving. Reads the same facts a save would. */
export async function previewSupportBundle(
  sources: SupportBundleSources,
): Promise<SupportBundlePreview> {
  const facts = await gatherSupportBundleFacts(sources, (sources.idGenerator ?? randomUUID)());
  return describeSupportBundle(facts);
}

/**
 * Builds the bundle and journals that it was handed over: the time, the
 * number of files and bytes, and the category of place it goes, never a path
 * and never any of its content. The host sends the bundle to no one; the
 * caller writes it where the person chose.
 */
/**
 * A write the host makes itself, in two steps so the record comes first: stage
 * the file beside its destination, and put it in place only once the export is
 * journaled. Staging throws when the place cannot be written.
 */
export type StageSupportBundleDelivery = (files: ReadonlyArray<SupportBundleFile>) => {
  readonly commit: () => void;
  readonly abort: () => void;
};

export async function exportSupportBundle(
  request: SupportBundleExportRequest,
  sources: SupportBundleSources,
  stage?: StageSupportBundleDelivery,
): Promise<SupportBundleOutcome> {
  const bundleId = (sources.idGenerator ?? randomUUID)();
  const facts = await gatherSupportBundleFacts(sources, bundleId);
  const files = buildSupportBundleFiles(facts, homeDirectoriesFor(sources));
  const byteCount = files.reduce((sum, file) => sum + Buffer.byteLength(file.contents), 0);
  let staged: ReturnType<StageSupportBundleDelivery> | undefined;
  if (stage !== undefined) {
    try {
      staged = stage(files);
    } catch {
      return {
        kind: "failed",
        message: "Octant could not write the support bundle there. Nothing was saved.",
      };
    }
  }
  try {
    const payload = decodeSupportBundleExported({
      receipt: {
        bundleId,
        exportedAt: facts.generatedAt,
        destinationCategory: request.destinationCategory,
        sections: describeSupportBundle(facts)
          .sections.filter((section) => section.available)
          .map((section) => section.id),
        fileCount: files.length,
        byteCount,
      },
    });
    sources.journal.append({
      aggregate: { aggregateType: "diagnostics-support-bundle", aggregateId: bundleId },
      expectedVersion: 0,
      events: [
        {
          eventId: (sources.eventIdGenerator ?? randomUUID)(),
          eventName: SUPPORT_BUNDLE_EXPORTED_EVENT,
          eventVersion: 1,
          correlationId: randomUUID() as CorrelationId,
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          occurredAt: facts.generatedAt,
          payload,
        },
      ],
    });
    try {
      staged?.commit();
    } catch {
      staged?.abort();
      return {
        kind: "failed",
        message: "Octant could not write the support bundle there. Nothing was saved.",
      };
    }
    return { kind: "exported", files, receipt: payload.receipt };
  } catch {
    // An export nobody recorded is not offered: the record is part of the promise.
    staged?.abort();
    return {
      kind: "failed",
      message: "The support bundle could not be recorded, so nothing was saved.",
    };
  }
}

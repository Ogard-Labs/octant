import { createHash } from "node:crypto";
import {
  decodeExtensionPackageManifest,
  type ExtensionPackageManifest,
} from "@octant/contracts/extensions";
import type { ExtensionLifecycleEvent } from "@octant/contracts/extension-events";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  EXTENSION_AGGREGATE_TYPE,
  EXTENSION_LIFECYCLE_EVENT,
  readExtensionRecord,
} from "../persistence/extensionProjection";

export const BOARD_EXTENSION_ID = "10000000-0000-4000-8000-000000000001";
const BOARD_PACKAGE_ID = "10000000-0000-4000-8000-000000000002";

function digestFor(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

/**
 * Bundled first-party plugin, statically wired in server.ts exactly as it
 * was before ADR 0001 — entryPoint is an opaque marker never handed to the
 * Agent Plugins loader.
 */
export function boardPluginManifest(): ExtensionPackageManifest {
  return decodeExtensionPackageManifest({
    manifestVersion: 1,
    extensionId: BOARD_EXTENSION_ID,
    packageId: BOARD_PACKAGE_ID,
    slug: "board",
    displayName: "Thread board",
    version: "1.0.0",
    digest: digestFor("octant:board:1.0.0"),
    source: { kind: "bundled", sourceRef: "app:board" },
    provenance: { reviewed: true },
    license: { kind: "unreported" },
    compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
    declaredCapabilities: [],
    components: [
      {
        id: "board",
        kind: "board",
        displayName: "Thread board",
        declaredCapabilities: [],
        entryPoint: "builtin:board",
      },
    ],
  });
}

/**
 * Seeds a bundled first-party plugin into the extension projection if it
 * isn't there yet, appending the same install-committed /
 * source-trust-changed / plugin-desired-state-changed /
 * component-desired-state-changed events the real lifecycle commands
 * produce (see ExtensionLifecycleService#append) so it shows up as a real,
 * toggleable row through the unmodified activation ladder. Idempotent:
 * a no-op once the extension has a projected record.
 */
export function seedFirstPartyPluginIfAbsent(options: {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly manifest: ExtensionPackageManifest;
}): void {
  const { journal, connection, uuid, clock, manifest } = options;
  if (readExtensionRecord(connection, manifest.extensionId) !== undefined) return;

  const event = (payload: ExtensionLifecycleEvent["payload"]) => ({
    eventId: uuid(),
    eventName: EXTENSION_LIFECYCLE_EVENT,
    eventVersion: 1 as const,
    correlationId: uuid(),
    actor: { kind: "local-user" as const, actorId: OCTANT_LOCAL_ACTOR_ID },
    occurredAt: clock(),
    payload: { eventVersion: 1 as const, extensionId: manifest.extensionId, payload },
  });

  journal.append({
    aggregate: { aggregateType: EXTENSION_AGGREGATE_TYPE, aggregateId: manifest.extensionId },
    expectedVersion: 0,
    events: [
      event({
        kind: "install-committed",
        transactionId: uuid() as never,
        packageId: manifest.packageId,
        version: manifest.version,
        digest: manifest.digest,
        manifest,
      }),
      event({ kind: "source-trust-changed", trusted: true }),
      event({ kind: "plugin-desired-state-changed", desired: true }),
      ...manifest.components.map((component) =>
        event({
          kind: "component-desired-state-changed" as const,
          componentId: component.id,
          desired: true,
        }),
      ),
    ],
  });
}

export function seedFirstPartyPlugins(options: {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
}): void {
  seedFirstPartyPluginIfAbsent({ ...options, manifest: boardPluginManifest() });
}

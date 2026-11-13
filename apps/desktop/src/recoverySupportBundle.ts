import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { arch, cpus, release, totalmem } from "node:os";
import {
  buildSupportBundleFiles,
  buildSupportBundleZip,
  SUPPORT_BUNDLE_LOG_LINE_LIMIT,
  type SupportBundleFacts,
} from "@octant/domain";
import { BoundedHostLogStore, readHostCrashRecords } from "@octant/host-runtime";

const MB = 1024 * 1024;

/**
 * Writes the bundle owner-only, replacing any file at `path`. `writeFile`'s
 * mode applies only when it creates the file, so writing over an existing
 * world-readable file would keep its permissions; an exclusively created
 * temporary file beside it, renamed over the destination, never does. This is
 * the same staging the host's save route uses.
 */
export async function writeOwnerOnlyFile(path: string, bytes: Uint8Array): Promise<void> {
  const staged = `${path}.octant-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(staged, bytes, { mode: 0o600, flag: "wx" });
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

/**
 * The support bundle the recovery screen saves while the host is not running.
 * The host's own bundle route is unreachable then, so the desktop reads the
 * two things that live in files: the local crash records and the host's
 * service log. Everything else the host would report is marked not
 * available, never shown as empty. The same domain policy lays out and
 * redacts the files, so this bundle has the shape and the guarantees of the
 * one Settings saves.
 */
export async function buildRecoverySupportBundle(options: {
  readonly bundleId: string;
  readonly now: Date;
  readonly octantVersion: string;
  readonly runtime: string;
  readonly dataDirectory: string;
  readonly serviceLogPath?: string;
  readonly homeDirectory: string;
}): Promise<Uint8Array> {
  const crashRecords = await readHostCrashRecords(options.dataDirectory)
    .then((records) => ({ records }))
    .catch(() => undefined);
  const hostLog =
    options.serviceLogPath === undefined
      ? undefined
      : await new BoundedHostLogStore({ path: options.serviceLogPath })
          .read({ limit: SUPPORT_BUNDLE_LOG_LINE_LIMIT })
          .then((result) => ({
            lines: result.entries.map((entry) => ({
              timestamp: entry.timestamp,
              level: entry.level,
              event: entry.event,
              message: entry.message,
            })),
          }))
          .catch(() => undefined);
  const facts: SupportBundleFacts = {
    bundleId: options.bundleId,
    generatedAt: options.now.toISOString(),
    versions: {
      octant: options.octantVersion,
      wire: "not reported: the host was not running",
      runtime: options.runtime,
    },
    system: {
      platform: process.platform,
      osRelease: release(),
      architecture: arch(),
      cpuCount: cpus().length,
      totalMemoryMb: Math.round(totalmem() / MB),
    },
    ...(crashRecords === undefined ? {} : { crashRecords }),
    ...(hostLog === undefined ? {} : { hostLog }),
  };
  return buildSupportBundleZip(
    buildSupportBundleFiles(facts, [options.homeDirectory]),
    options.now,
  );
}

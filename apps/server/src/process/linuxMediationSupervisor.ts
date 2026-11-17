/** Production process-shaped owner for one compatible custom-kernel launch. */
import { constants, closeSync, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Schema } from "effect";
import { prepareLinuxMediationSession } from "./linuxMediationSession";
import {
  LinuxMediationSupervisorConfig,
  type LinuxMediationSupervisorConfig as SupervisorConfig,
} from "./linuxMediationConfig";

function readConfiguration(path: string): SupervisorConfig {
  if (!isAbsolute(path) || path.startsWith("--")) throw new Error("Invalid mediation config path.");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = fstatSync(descriptor);
    if (
      !identity.isFile() ||
      identity.nlink !== 1 ||
      identity.uid !== process.getuid?.() ||
      (identity.mode & 0o777) !== 0o600 ||
      identity.size < 2 ||
      identity.size > 262_144
    )
      throw new Error("Invalid mediation config file.");
    const value: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    unlinkSync(path);
    return Schema.decodeUnknownSync(LinuxMediationSupervisorConfig)(value, {
      onExcessProperty: "error",
    });
  } finally {
    closeSync(descriptor);
  }
}

async function supervise(path: string): Promise<number> {
  const config = readConfiguration(path);
  const owner = new AbortController();
  const stop = () => owner.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
      ),
    );
    const prepared = await prepareLinuxMediationSession({
      ownerId: config.ownerId,
      signal: owner.signal,
      maximumMs: config.maximumMs,
      receiptDirectory: config.receiptDirectory,
      brokerExecutable: process.execPath,
      brokerScript: config.workerScript,
      nativeExecutable: config.nativeExecutable,
      production: true,
      inheritStdio: true,
      launch: config.launch,
      policy: {
        ...config.policy,
        sshCompanionDirectory: config.policy.sshCompanionDirectory,
      },
      environment,
    });
    if (prepared.status !== "ready") return 70;
    const { session } = prepared;
    if ((await session.launch()).status !== "released") {
      await session.close();
      return 70;
    }
    const completed = await session.exited;
    return completed.result.status === "exited" ? completed.result.code : 70;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (process.argv.length !== 3 || path === undefined) process.exitCode = 64;
  else
    try {
      process.exitCode = await supervise(path);
    } catch {
      process.exitCode = 70;
    }
}

import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { noteIssuedSecret } from "../process/secretRedaction";
import type { SecretStoreBrokerClient, SecretStoreBrokerDown } from "./secretStoreBrokerClient";

export type PreparedGoogleCliCredentials =
  | {
      readonly status: "refused";
      readonly message: string;
      readonly reason: "changed" | "unavailable";
    }
  | {
      readonly status: "ready";
      readonly environment: Readonly<Record<string, string>>;
      /** Only a recovered resource directory receives a config write grant. */ readonly configurationDirectory?: string;
      readonly beforeLaunch: () => boolean;
      readonly close: () => Promise<void>;
      readonly warning?: string;
    };
export type GoogleCliRecovery =
  | { readonly status: "ready" }
  | {
      readonly status: "unavailable";
      readonly phase: "active-commands" | "process-recovery" | "resource-cleanup";
      readonly message: string;
    };
const CHANGED =
  "Google Cloud command-line credentials changed while this command was being prepared. Try the command again.";
const UNAVAILABLE =
  "Google Cloud command-line credentials are unavailable. Check the selected account and linked store in Settings. This command receives no Google token and cannot fall back to the host's sign-in.";
const RECOVERY =
  "Google Cloud command recovery was not confirmed. Repair this host's command recovery or storage access, then restart. This command receives no Google token.";
const PREFIX = "google-";

/** Owns command files and cancellation only. The broker remains the credential authority. */
export function createGoogleCliCommandCredentials(options: {
  readonly broker:
    | Pick<SecretStoreBrokerClient, "googleCliSession" | "googleCliReference">
    | undefined;
  readonly configurationRoot: string;
  readonly scriptRoot: string;
  readonly now?: () => number;
  readonly waitMs?: number;
  readonly recoveryWaitMs?: number;
}) {
  const now = options.now ?? Date.now;
  let ready = false;
  let recovering = false;
  let resources = 0;
  let generation = 0;
  let changing = 0;
  const pending = new Set<() => Promise<void>>();
  const invalidate = () => {
    generation += 1;
    for (const close of pending) void close().catch(() => undefined);
  };
  const beginChange = () => {
    changing += 1;
    invalidate();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      changing -= 1;
      invalidate();
    };
  };
  const recover = async (
    reconcileOwnedProcesses: () => Promise<void>,
  ): Promise<GoogleCliRecovery> => {
    ready = false;
    if (resources !== 0)
      return { status: "unavailable", phase: "active-commands", message: RECOVERY };
    if (recovering) return { status: "unavailable", phase: "process-recovery", message: RECOVERY };
    recovering = true;
    invalidate();
    const processes = Promise.resolve().then(reconcileOwnedProcesses);
    if (!(await settledWithin(processes, options.recoveryWaitMs ?? 10000))) {
      void processes.then(
        () => {
          recovering = false;
        },
        () => {
          recovering = false;
        },
      );
      return { status: "unavailable", phase: "process-recovery", message: RECOVERY };
    }
    const cleanup = (async () => {
      await mkdir(options.configurationRoot, { recursive: true, mode: 0o700 });
      const metadata = await lstat(options.configurationRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Invalid cloud command resource directory");
      await chmod(options.configurationRoot, 0o700);
      const entries = await readdir(options.configurationRoot);
      if (entries.length > 512) throw new Error("Cloud command resource recovery limit");
      // This dedicated root holds no shared scripts. rm removes a symlink
      // itself and never follows it to another folder or credential store.
      for (const entry of entries)
        if (entry.startsWith(PREFIX))
          await rm(join(options.configurationRoot, entry), { recursive: true, force: true });
    })();
    if (!(await settledWithin(cleanup, options.recoveryWaitMs ?? 10000))) {
      void cleanup.then(
        () => {
          recovering = false;
        },
        () => {
          recovering = false;
        },
      );
      return { status: "unavailable", phase: "resource-cleanup", message: RECOVERY };
    }
    recovering = false;
    ready = true;
    invalidate();
    return { status: "ready" };
  };
  const files = async (
    commandDirectory: string,
    started: number,
    signal: AbortSignal | undefined,
    accessToken: string,
    expiration: string | undefined,
    writable: boolean,
    warning?: string,
  ): Promise<PreparedGoogleCliCredentials> => {
    const directory = await mkdtemp(
      writable
        ? join(options.configurationRoot, `${PREFIX}${basename(commandDirectory)}-`)
        : join(commandDirectory, "google-unavailable-"),
    );
    const configurationDirectory = join(directory, "configuration");
    const tokenFile = join(directory, "access-token");
    resources += 1;
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closed ??= (async () => {
        pending.delete(close);
        try {
          await rm(directory, { recursive: true, force: true });
        } finally {
          resources -= 1;
        }
      })());
    try {
      if (signal?.aborted || generation !== started || changing !== 0) {
        await close();
        return { status: "refused", message: CHANGED, reason: "changed" };
      }
      await mkdir(configurationDirectory, { mode: 0o700 });
      await writeFile(tokenFile, accessToken, { mode: 0o600, flag: "wx" });
      if (signal?.aborted || generation !== started || changing !== 0) {
        await close();
        return { status: "refused", message: CHANGED, reason: "changed" };
      }
      pending.add(close);
      let consumed = false;
      return {
        status: "ready",
        ...(writable ? { configurationDirectory } : {}),
        environment: {
          CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: tokenFile,
          CLOUDSDK_CONFIG: configurationDirectory,
          CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "true",
          CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true",
          CLOUDSDK_CORE_DISABLE_PROMPTS: "true",
        },
        beforeLaunch: () => {
          if (
            consumed ||
            closed !== undefined ||
            signal?.aborted ||
            generation !== started ||
            changing !== 0 ||
            (accessToken !== "" &&
              (!ready || expiration === undefined || Date.parse(expiration) <= now()))
          )
            return false;
          consumed = true;
          pending.delete(close);
          return true;
        },
        close,
        ...(warning === undefined ? {} : { warning }),
      };
    } catch {
      await close();
      return { status: "refused", message: UNAVAILABLE, reason: "unavailable" };
    }
  };
  const prepare = async (
    commandDirectory: string,
    signal?: AbortSignal,
  ): Promise<PreparedGoogleCliCredentials | undefined> => {
    if (
      signal?.aborted ||
      dirname(resolve(commandDirectory)) !== resolve(options.scriptRoot) ||
      !basename(commandDirectory).startsWith("octant-harness-")
    )
      return { status: "refused", message: CHANGED, reason: "changed" };
    const broker = options.broker;
    if (broker === undefined) return undefined;
    const started = generation;
    if (changing !== 0) return { status: "refused", message: CHANGED, reason: "changed" };
    if (!ready) {
      // No token request while old owned processes or resources are uncertain.
      const reference = await wait(
        (signal) =>
          broker.googleCliReference?.(signal) ??
          Promise.resolve<SecretStoreBrokerDown>({ status: "broker-unavailable" }),
        signal,
        options.waitMs ?? 15000,
      );
      if (signal?.aborted || generation !== started || changing !== 0)
        return { status: "refused", message: CHANGED, reason: "changed" };
      if (reference?.status === "none") return undefined;
      try {
        return await files(commandDirectory, started, signal, "", undefined, false, RECOVERY);
      } catch {
        return { status: "refused", message: RECOVERY, reason: "unavailable" };
      }
    }
    const answer = await wait(
      (signal) =>
        broker.googleCliSession?.(signal) ??
        Promise.resolve<SecretStoreBrokerDown>({ status: "broker-unavailable" }),
      signal,
      options.waitMs ?? 15000,
    );
    if (signal?.aborted || generation !== started || changing !== 0)
      return { status: "refused", message: CHANGED, reason: "changed" };
    if (answer?.status === "none") return undefined;
    const issued = answer?.status === "issued" ? answer : undefined;
    if (issued !== undefined) noteIssuedSecret(issued.accessToken);
    const usable = issued !== undefined && Date.parse(issued.expiration) > now() + 30000;
    try {
      const prepared = await files(
        commandDirectory,
        started,
        signal,
        usable ? issued.accessToken : "",
        usable ? issued.expiration : undefined,
        true,
        usable ? undefined : UNAVAILABLE,
      );
      if (prepared.status !== "refused" || prepared.reason !== "unavailable") return prepared;
    } catch {
      /* The Google resource root can become unavailable after recovery. */
    }
    try {
      return await files(commandDirectory, started, signal, "", undefined, false, UNAVAILABLE);
    } catch {
      return { status: "refused", message: UNAVAILABLE, reason: "unavailable" };
    }
  };
  return { prepare, beginChange, invalidate, recover };
}

async function settledWithin(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function wait<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  milliseconds: number,
): Promise<T | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, milliseconds);
    abort = () => {
      controller.abort();
      resolve(undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    return await Promise.race([request(controller.signal).catch(() => undefined), stopped]);
  } finally {
    controller.abort();
    clearTimeout(timer);
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
  }
}

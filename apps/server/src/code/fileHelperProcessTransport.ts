import { spawn as nodeSpawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { FileHelperTransport } from "./fileOperationPort";

export interface FileHelperChildProcess {
  readonly stdin: {
    write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
    end(): void;
  };
  readonly stdout: {
    on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
    off(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  };
  readonly stderr?: { resume(): void };
  on(event: "error" | "close", listener: (...arguments_: unknown[]) => void): unknown;
  off(event: "error" | "close", listener: (...arguments_: unknown[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export interface FileHelperProcessTransport extends FileHelperTransport {
  close(): Promise<void>;
}

type SpawnFileHelper = (
  command: string,
  arguments_: readonly string[],
  options: {
    readonly shell: false;
    readonly stdio: readonly ["pipe", "pipe", "pipe"];
    readonly windowsHide: true;
  },
) => FileHelperChildProcess;

export class FileHelperProcessError extends Error {
  override readonly name = "FileHelperProcessError";

  constructor(readonly category: "unavailable" | "unsupported") {
    super(
      category === "unsupported"
        ? "Octant Code file helper is unsupported on this platform."
        : "Octant Code file helper is unavailable.",
    );
  }
}

export function createFileHelperProcessTransport(options: {
  readonly helperPath: string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly spawn?: SpawnFileHelper;
  readonly gracefulCloseTimeoutMs?: number;
  readonly forceCloseTimeoutMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}): FileHelperProcessTransport {
  if (options.helperPath === undefined || !isAbsolute(options.helperPath)) {
    throw new FileHelperProcessError("unavailable");
  }
  if (
    (options.platform ?? process.platform) !== "darwin" ||
    (options.arch ?? process.arch) !== "arm64"
  ) {
    throw new FileHelperProcessError("unsupported");
  }

  let child: FileHelperChildProcess;
  try {
    child = (options.spawn ?? (nodeSpawn as unknown as SpawnFileHelper))(options.helperPath, [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw new FileHelperProcessError("unavailable");
  }

  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const exitListeners = new Set<() => void>();
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? 1_000;
  const forceCloseTimeoutMs = options.forceCloseTimeoutMs ?? 1_000;
  let unavailable = false;
  let closed = false;
  let exitNotified = false;
  let closeOperation: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const onData = (chunk: Uint8Array) => {
    if (unavailable || closed) return;
    const owned = Uint8Array.from(chunk);
    for (const listener of dataListeners) listener(owned);
  };
  const notifyExit = () => {
    if (exitNotified) return;
    exitNotified = true;
    for (const listener of exitListeners) listener();
    exitListeners.clear();
  };
  const onError = () => {
    unavailable = true;
    notifyExit();
  };
  const onClose = () => {
    if (closed) return;
    closed = true;
    unavailable = true;
    child.stdout.off("data", onData);
    child.off("error", onError);
    child.off("close", onClose);
    dataListeners.clear();
    notifyExit();
    resolveClosed();
  };
  child.stdout.on("data", onData);
  child.stderr?.resume();
  child.on("error", onError);
  child.on("close", onClose);

  return {
    write: (frame) => {
      if (unavailable || closed) return Promise.reject(new FileHelperProcessError("unavailable"));
      const owned = Buffer.from(frame);
      return new Promise<void>((resolve, reject) => {
        try {
          child.stdin.write(owned, (error) =>
            error === undefined || error === null
              ? resolve()
              : reject(new FileHelperProcessError("unavailable")),
          );
        } catch {
          reject(new FileHelperProcessError("unavailable"));
        }
      });
    },
    onData: (listener) => {
      if (unavailable || closed) return () => undefined;
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onExit: (listener) => {
      if (exitNotified) {
        queueMicrotask(listener);
        return () => undefined;
      }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    close: () => {
      if (closeOperation !== undefined) return closeOperation;
      closeOperation = (async () => {
        if (closed) return;
        try {
          child.stdin.end();
        } catch {
          unavailable = true;
        }
        if (closed) return;
        try {
          child.kill("SIGTERM");
        } catch {
          unavailable = true;
        }
        if (closed) return;
        const graceful = await Promise.race([
          closedPromise.then(() => true),
          wait(gracefulCloseTimeoutMs).then(() => false),
        ]);
        if (!graceful && !closed) {
          try {
            child.kill("SIGKILL");
          } catch {
            throw new FileHelperProcessError("unavailable");
          }
        }
        if (closed) return;
        const forced = await Promise.race([
          closedPromise.then(() => true),
          wait(forceCloseTimeoutMs).then(() => false),
        ]);
        if (!forced) throw new FileHelperProcessError("unavailable");
      })();
      return closeOperation;
    },
  };
}

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CuaDriverLike, EmbeddedCuaDriverHostLike, ToolResult } from "@trycua/cua-driver";
import { verifyComputerDriverBinary } from "./computerUseDriverRelease";
import type { StagedComputerDriver } from "./computerUseDriverUpdates";

export interface ComputerDriverRuntime {
  readonly generation: string;
  readonly version: string;
  readonly call: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  readonly close: () => Promise<void>;
}

/** The GUI process must call this itself, so TCC attributes the child to Octant. */
export async function startComputerDriverRuntime(options: {
  readonly driver: StagedComputerDriver;
  readonly profileDirectory: string;
  readonly signal?: AbortSignal;
  readonly onExit: (generation: string) => void;
}): Promise<ComputerDriverRuntime> {
  await verifyComputerDriverBinary(options.driver.path, options.driver.version);
  const sdk = await import("@trycua/cua-driver");
  const directory = await mkdtemp(join(tmpdir(), "octant-cua-"));
  await mkdir(options.profileDirectory, { recursive: true, mode: 0o700 });
  let host: EmbeddedCuaDriverHostLike | undefined;
  let client: CuaDriverLike | undefined;
  const stopping = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      closed = true;
      stopping.abort();
      try {
        await host?.stop();
      } finally {
        destroyNativeObject(client);
        destroyNativeObject(host);
        await rm(directory, { recursive: true, force: true });
      }
    })();
    return closing;
  };
  try {
    host = sdk.EmbeddedCuaDriverHost.withOptions(
      sdk.EmbeddedDriverHostOptions.create({
        binaryPath: options.driver.path,
        hostBundleId: "app.octant.desktop",
        socketPath: join(directory, "driver.sock"),
        startupTimeoutMs: 15_000n,
        shutdownTimeoutMs: 3_000n,
        permissionMode: sdk.EmbeddedPermissionMode.Standard,
        environment: [
          { name: "HOME", value: options.profileDirectory },
          { name: "CUA_TELEMETRY_ENABLED", value: "0" },
          { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "0" },
        ],
        inheritStderr: false,
        approveSessionPolicy: false,
        dangerouslyBypassApprovals: false,
      }),
    );
    const connection = await host.start(
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    if (
      connection.driverVersion !== options.driver.version ||
      connection.contractVersion !== "0.8.0"
    )
      throw new Error("Computer-use driver contract is incompatible.");
    const connected = sdk.CuaDriver.connect(connection.socketPath);
    client = connected;
    void host.waitForExit(connection.generation).then(
      () => {
        if (!closed) options.onExit(connection.generation);
      },
      () => {
        if (!closed) options.onExit(connection.generation);
      },
    );
    return {
      generation: connection.generation,
      version: connection.driverVersion,
      call: (name, args, signal) => {
        if (closed) return Promise.reject(new Error("Computer-use driver has stopped."));
        const requestSignal = AbortSignal.any([
          stopping.signal,
          AbortSignal.timeout(30_000),
          ...(signal === undefined ? [] : [signal]),
        ]);
        return connected.callTool(name, JSON.stringify(args), { signal: requestSignal });
      },
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

// The SDK factories return structural interfaces; the native objects also
// expose the documented destructor, which those interfaces omit.
function destroyNativeObject(value: object | undefined): void {
  if (value !== undefined && "uniffiDestroy" in value && typeof value.uniffiDestroy === "function")
    value.uniffiDestroy();
}

export async function computerUsePermissions(request: boolean = false) {
  if (process.platform !== "darwin") return { accessibility: false, screenRecording: false };
  const sdk = await import("@trycua/cua-driver");
  return request ? sdk.requestMacOsPermissions() : sdk.currentMacOsPermissionStatus();
}

export async function openComputerUsePermissionSettings(): Promise<void> {
  if (process.platform !== "darwin") return;
  const sdk = await import("@trycua/cua-driver/electron");
  await sdk.openMacOSScreenRecordingSettings();
}

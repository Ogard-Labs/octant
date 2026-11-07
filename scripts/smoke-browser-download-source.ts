import { _electron, type ElectronApplication } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Schema } from "effect";
import { BrowserDownloadSource } from "@octant/contracts";

/** One foreground owner with bounded launch, probe and cleanup; no visible window. */
async function main() {
  const root = await mkdtemp(join(tmpdir(), "octant-native-download-source-"));
  let native: ElectronApplication | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    void native?.close().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let processIds: number[] = [];
  let cleanupFailure: string | undefined;
  let verified:
    | {
        readonly status: "passed";
        readonly source: typeof BrowserDownloadSource.Type;
        readonly byteLength: number;
        readonly ports: ReadonlyArray<number>;
      }
    | undefined;
  try {
    const entry = join(root, "native-download-source.cjs");
    const build = await Bun.build({
      entrypoints: [resolve("apps/desktop/src/browserDownloadSource.native-smoke.ts")],
      target: "node",
      format: "cjs",
      external: ["electron"],
      outdir: root,
      naming: "native-download-source.cjs",
    });
    if (!build.success) throw Error("The native download fixture could not be built.");
    const require = createRequire(import.meta.url);
    const executablePath: unknown = require("electron");
    if (typeof executablePath !== "string")
      throw Error("The pinned Electron runtime is unavailable.");
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    native = await _electron.launch({
      executablePath,
      args: [entry, root],
      env: environment,
      timeout: 15_000,
    });
    const mainPid = native.process().pid;
    if (mainPid === undefined) throw Error("The native fixture has no process identity.");
    processIds = [mainPid];
    if (interrupted) throw Error("Native download smoke was interrupted.");
    processIds = await native.evaluate(({ app }) =>
      app.getAppMetrics().map((metric) => metric.pid),
    );
    const result = await Promise.race([
      native.evaluate(async () => {
        const pending: unknown = Reflect.get(globalThis, "__octantDownloadSourceProbe");
        if (!(pending instanceof Promise))
          throw Error("The native fixture did not expose its result.");
        return await pending;
      }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(Error("Native download smoke exceeded its deadline.")),
          25_000,
        );
      }),
    ]);
    const reading = Schema.decodeUnknownSync(
      Schema.Struct({
        status: Schema.Literal("passed"),
        source: BrowserDownloadSource,
        byteLength: Schema.Number,
        ports: Schema.Array(Schema.Number),
      }),
    )(result);
    processIds = await native.evaluate(({ app }) =>
      app.getAppMetrics().map((metric) => metric.pid),
    );
    verified = reading;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      if (native !== undefined) {
        const current = await native
          .evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.pid))
          .catch(() => []);
        processIds = [...new Set([...processIds, ...current])];
      }
      await native?.close();
    } catch {
      cleanupFailure = "Native fixture shutdown could not be confirmed.";
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const alive = processIds.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (alive.length === 0) break;
      if (attempt === 19) cleanupFailure = "An owned native fixture process did not exit.";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await rm(root, { recursive: true, force: true });
    if (cleanupFailure !== undefined) console.error(cleanupFailure);
  }
  if (cleanupFailure !== undefined) throw Error(cleanupFailure);
  if (verified === undefined) throw Error("Native source verification did not complete.");
  console.log(
    JSON.stringify({
      check: "native-download-source",
      ...verified,
      processIds,
      cleanup: "verified",
      personalAccount: false,
    }),
  );
}
void main().catch(() => {
  console.error("Native download source proof failed; no native acceptance claim is established.");
  process.exitCode = 1;
});

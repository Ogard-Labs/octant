import { _electron, type ElectronApplication } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Schema } from "effect";

/** One foreground owner with bounded launch, probe and cleanup; no visible window. */
async function main() {
  const root = await mkdtemp(join(tmpdir(), "octant-native-local-navigation-"));
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
        readonly checks: ReadonlyArray<string>;
        readonly port: number;
      }
    | undefined;
  try {
    const entry = join(root, "browserLocalNavigation.native-smoke.cjs");
    const build = await Bun.build({
      entrypoints: [
        resolve("apps/desktop/src/browserLocalNavigation.native-smoke.ts"),
        resolve("apps/desktop/src/browserEditablePreload.ts"),
      ],
      target: "node",
      format: "cjs",
      external: ["electron"],
      outdir: root,
      naming: "[name].cjs",
    });
    if (!build.success) throw Error("The native local-navigation fixture could not be built.");
    const require = createRequire(import.meta.url);
    const executablePath: unknown = require("electron");
    if (typeof executablePath !== "string")
      throw Error("The pinned Electron runtime is unavailable.");
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    native = await _electron.launch({
      executablePath,
      args: [entry, "--octant-fixture-root", root],
      env: environment,
      timeout: 15_000,
    });
    const mainPid = native.process().pid;
    if (mainPid === undefined) throw Error("The native fixture has no process identity.");
    processIds = [mainPid];
    if (interrupted) throw Error("Native local-navigation smoke was interrupted.");
    processIds = await native.evaluate(({ app }) =>
      app.getAppMetrics().map((metric) => metric.pid),
    );
    const result = await Promise.race([
      native.evaluate(async () => {
        const pending: unknown = Reflect.get(globalThis, "__octantLocalNavigationProbe");
        if (!(pending instanceof Promise))
          throw Error("The native fixture did not expose its result.");
        return await pending;
      }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(Error("Native local-navigation smoke exceeded its deadline.")),
          120_000,
        );
      }),
    ]);
    const reading = Schema.decodeUnknownSync(
      Schema.Struct({
        status: Schema.Literal("passed"),
        checks: Schema.Array(Schema.String),
        port: Schema.Number,
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
    if (verified === undefined && native !== undefined) {
      const steps: unknown = await native
        .evaluate(() => Reflect.get(globalThis, "__octantLocalNavigationSteps"))
        .catch(() => undefined);
      if (steps !== undefined) console.error(`Steps reached: ${JSON.stringify(steps)}`);
    }
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
  if (verified === undefined) throw Error("Native local-navigation verification did not complete.");
  console.log(
    JSON.stringify({
      check: "native-local-navigation",
      ...verified,
      processIds,
      cleanup: "verified",
      personalAccount: false,
    }),
  );
}
void main().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message.slice(0, 2048));
  console.error("Native local-navigation proof failed; no native acceptance claim is established.");
  process.exitCode = 1;
});

import { runBoundedCommand } from "./packaged-smoke-process";

export const PACKAGED_CODE_SMOKE_STEPS = [
  "package",
  "code-lifecycle",
  "authenticated-web-authority",
  "packaged-success-cleanup",
  "packaged-failure-cleanup",
] as const;
export type PackagedCodeSmokeStep = (typeof PACKAGED_CODE_SMOKE_STEPS)[number];

export async function runPackagedCodeSmoke(
  run: (step: PackagedCodeSmokeStep) => Promise<void>,
): Promise<void> {
  for (const step of PACKAGED_CODE_SMOKE_STEPS) {
    try {
      await run(step);
    } catch {
      throw new Error(`Packaged Code smoke failed during ${step}.`);
    }
  }
}

export function combinePackagedCodeSmokeFailures(
  primary: unknown,
  cleanup: unknown,
): Error | undefined {
  if (primary !== undefined && cleanup !== undefined) {
    return new AggregateError(
      [new Error("Packaged Code workflow failed."), new Error("Packaged Code cleanup failed.")],
      "Packaged Code smoke failed during workflow and cleanup.",
    );
  }
  if (primary !== undefined) return new Error("Packaged Code workflow failed.");
  if (cleanup !== undefined) return new Error("Packaged Code cleanup failed.");
  return undefined;
}

export function acceptExpectedForcedFailure(error: unknown): void {
  if (
    error instanceof Error &&
    error.message.includes("Intentional packaged smoke failure after readiness.")
  ) {
    return;
  }
  throw new Error("Packaged forced-failure cleanup did not reach its verified failure marker.");
}

async function main(): Promise<void> {
  if (process.env.OCTANT_PACKAGED_CODE_SMOKE !== "1") {
    throw new Error("Set OCTANT_PACKAGED_CODE_SMOKE=1 to run the packaged Code smoke.");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The packaged Code smoke requires Apple Silicon macOS.");
  }
  await runPackagedCodeSmoke(async (step) => {
    switch (step) {
      case "package":
        await command(process.execPath, ["run", "build"]);
        await command(process.execPath, ["run", "package:desktop"]);
        return;
      case "code-lifecycle":
        await command(process.execPath, [
          "x",
          "vitest",
          "run",
          "apps/server/src/code/codeLifecycle.integration.test.ts",
        ]);
        return;
      case "authenticated-web-authority":
        await command(process.execPath, [
          "x",
          "vitest",
          "run",
          "apps/server/src/codeRoutes.test.ts",
          "apps/server/src/server.test.ts",
        ]);
        return;
      case "packaged-success-cleanup":
        await command(process.execPath, ["scripts/smoke-packaged-desktop.ts"]);
        return;
      case "packaged-failure-cleanup":
        try {
          await command(process.execPath, [
            "scripts/smoke-packaged-desktop.ts",
            "--fail-after-ready",
          ]);
        } catch (error) {
          acceptExpectedForcedFailure(error);
        }
    }
  });
  console.log(
    "Packaged Code payload, deterministic workflow, restart replay, and success/failure cleanup smoke passed.",
  );
}

async function command(executable: string, arguments_: readonly string[]): Promise<void> {
  await runBoundedCommand(
    executable,
    arguments_,
    { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
    180_000,
  );
}

if (import.meta.main) await main();

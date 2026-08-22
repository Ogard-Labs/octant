import { runBoundedCommand } from "./packaged-smoke-process";

export const PACKAGED_CODE_PROJECT_PULL_REQUEST_SMOKE_STEPS = ["package", "fake-gh-port"] as const;
export type PackagedCodeProjectPullRequestSmokeStep =
  (typeof PACKAGED_CODE_PROJECT_PULL_REQUEST_SMOKE_STEPS)[number];

export function darwinPackageUnavailableReason(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform !== "darwin" || arch !== "arm64") {
    return "The Darwin package step is unavailable on this host.";
  }
  return undefined;
}

export async function runPackagedCodeProjectPullRequestSmoke(
  run: (step: PackagedCodeProjectPullRequestSmokeStep) => Promise<void>,
): Promise<void> {
  for (const step of PACKAGED_CODE_PROJECT_PULL_REQUEST_SMOKE_STEPS) {
    try {
      await run(step);
    } catch {
      throw new Error(`Packaged Code project pull-request smoke failed during ${step}.`);
    }
  }
}

async function main(): Promise<void> {
  if (process.env.OCTANT_PACKAGED_CODE_PROJECT_PR_SMOKE !== "1") {
    throw new Error(
      "Set OCTANT_PACKAGED_CODE_PROJECT_PR_SMOKE=1 to run the packaged Code project pull-request smoke.",
    );
  }
  const unavailable = darwinPackageUnavailableReason();
  await runPackagedCodeProjectPullRequestSmoke(async (step) => {
    switch (step) {
      case "package":
        if (unavailable !== undefined) {
          throw new Error(unavailable);
        }
        await command(process.execPath, ["run", "package:desktop"]);
        return;
      case "fake-gh-port":
        await command(process.execPath, [
          "run",
          "--cwd",
          "apps/server",
          "test",
          "--",
          "src/code/codeProjectPullRequestFakeGh.test.ts",
        ]);
        return;
    }
  });
}

async function command(executable: string, arguments_: readonly string[]): Promise<void> {
  const result = await runBoundedCommand(executable, arguments_);
  if (result.exitCode !== 0) {
    throw new Error("Packaged Code project pull-request smoke command failed.");
  }
}

if (import.meta.main) {
  await main();
}

import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const nativeSourceDirectory = "apps/desktop/native/work-confinement-gate";

export const WORK_CONFINEMENT_GATE_BUNDLE_ID = "app.octant.desktop.work-confinement-gate";
export const WORK_CONFINEMENT_BROKER_BUNDLE_ID = "app.octant.desktop.work-confinement-gate.broker";

type BuildCommand = {
  readonly args: readonly string[];
  readonly output: string;
};

export function workConfinementBuildCommands(
  sourceRoot: string,
  outputRoot: string,
): readonly BuildCommand[] {
  const sourceDirectory = resolve(sourceRoot, nativeSourceDirectory);
  const protocol = resolve(sourceDirectory, "OctantWorkConfinementProtocol.swift");
  const command = (
    source: string,
    output: string,
    frameworks: readonly string[],
  ): BuildCommand => ({
    args: [
      "swiftc",
      "-O",
      "-target",
      "arm64-apple-macos14.0",
      ...frameworks.flatMap((framework) => ["-framework", framework]),
      "-o",
      output,
      protocol,
      resolve(sourceDirectory, source),
    ],
    output,
  });

  return [
    command("OctantWorkConfinementGate.swift", resolve(outputRoot, "OctantWorkConfinementGate"), [
      "AppKit",
      "Security",
    ]),
    command(
      "OctantWorkConfinementBroker.swift",
      resolve(outputRoot, "OctantWorkConfinementBroker"),
      ["Security"],
    ),
    command(
      "OctantWorkConfinementForeignClient.swift",
      resolve(outputRoot, "OctantWorkConfinementForeignClient"),
      ["Security"],
    ),
  ];
}

function optionValue(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

export async function buildWorkConfinementGate(
  sourceRoot = repositoryRoot,
  outputRoot = optionValue("--output") ??
    resolve(repositoryRoot, "out/work-confinement-gate/build"),
): Promise<void> {
  const resolvedOutputRoot = resolve(repositoryRoot, outputRoot);
  await mkdir(resolvedOutputRoot, { recursive: true });

  for (const command of workConfinementBuildCommands(sourceRoot, resolvedOutputRoot)) {
    await mkdir(dirname(command.output), { recursive: true });
    const process = Bun.spawn(command.args, {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await process.exited) !== 0) {
      throw new Error(`Work confinement build failed for ${command.output}.`);
    }
    await chmod(command.output, 0o755);
  }
}

if (import.meta.main) await buildWorkConfinementGate();

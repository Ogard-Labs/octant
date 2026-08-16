import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultSource = resolve(
  repositoryRoot,
  "apps/desktop/native/code-file-helper/OctantCodeFileHelper.swift",
);
const defaultDestination = resolve(
  repositoryRoot,
  "apps/desktop/dist/native/octant-code-file-helper",
);

export const codeFileHelperBuildArgs = (source: string, destination: string) => [
  "swiftc",
  "-O",
  "-target",
  "arm64-apple-macos14.0",
  "-o",
  destination,
  source,
];

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export async function buildCodeFileHelper(
  source = optionValue("--source") ?? defaultSource,
  destination = optionValue("--destination") ?? defaultDestination,
): Promise<void> {
  const resolvedSource = resolve(repositoryRoot, source);
  const resolvedDestination = resolve(repositoryRoot, destination);
  const moduleCache = resolve(tmpdir(), "octant-swift-module-cache");
  await mkdir(dirname(resolvedDestination), { recursive: true });
  await mkdir(moduleCache, { recursive: true });
  const [command, ...args] = codeFileHelperBuildArgs(resolvedSource, resolvedDestination);
  const child = spawn(command!, args, {
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache },
    stdio: "inherit",
  });
  const [exitCode] = (await once(child, "exit")) as [number | null];
  if (exitCode !== 0) {
    throw new Error("Octant Code file helper build failed.");
  }
  await chmod(resolvedDestination, 0o755);
}

if (import.meta.main) await buildCodeFileHelper();

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultSource = resolve(
  repositoryRoot,
  "apps/desktop/native/keychain-helper/OctantKeychainHelper.swift",
);
const defaultDestination = resolve(
  repositoryRoot,
  "apps/desktop/dist/native/octant-keychain-helper",
);

export const keychainHelperBuildArgs = (source: string, destination: string) => [
  "swiftc",
  "-O",
  "-framework",
  "Security",
  "-o",
  destination,
  source,
];

function optionValue(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

export async function buildKeychainHelper(
  source = optionValue("--source") ?? defaultSource,
  destination = optionValue("--destination") ?? defaultDestination,
): Promise<void> {
  const resolvedSource = resolve(repositoryRoot, source);
  const resolvedDestination = resolve(repositoryRoot, destination);
  await mkdir(dirname(resolvedDestination), { recursive: true });
  const process = Bun.spawn(keychainHelperBuildArgs(resolvedSource, resolvedDestination), {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error("Octant Keychain helper build failed.");
}

if (import.meta.main) await buildKeychainHelper();

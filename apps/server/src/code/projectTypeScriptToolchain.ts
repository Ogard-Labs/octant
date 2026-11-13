import { realpath, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/**
 * The TypeScript language server from a Project's own install, for a Project
 * whose "Use the Project's own toolchain" setting is on. Canonical:
 * docs/design/language-services.md (decision D1).
 *
 * It is the same native binary Octant bundles (`tsc --lsp --stdio`), taken
 * from the checkout's `node_modules` so the editor reads the code with the
 * version the Project pins. Only a file that really lies inside the folder
 * the server reads is named: the launch binds that folder and nothing else of
 * the repository's choosing, so a link that leads out of it names nothing
 * rather than widening what the server may read. A Project whose TypeScript
 * has no native binary for this host (an older major, or another platform's
 * install) has no copy to run, and the start fails without falling back.
 */
export async function projectTypeScriptServerBinary(
  serverRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<string | undefined> {
  const root = await realpath(serverRoot).catch(() => undefined);
  if (root === undefined) return undefined;
  const modules = join(root, "node_modules");
  const native = join("@typescript", `typescript-${platform}-${arch}`, "lib", "tsc");
  // An installer that links packages from a store keeps the native package
  // beside the real `typescript` folder, not at the top of `node_modules`.
  const linkedPackage = await realpath(join(modules, "typescript")).catch(() => undefined);
  const candidates = [
    join(modules, native),
    ...(linkedPackage === undefined ? [] : [join(dirname(linkedPackage), native)]),
  ];
  for (const candidate of candidates) {
    const binary = await realpath(candidate).catch(() => undefined);
    if (binary === undefined || !binary.startsWith(`${root}${sep}`)) continue;
    const metadata = await stat(binary).catch(() => undefined);
    if (metadata?.isFile() === true) return binary;
  }
  return undefined;
}

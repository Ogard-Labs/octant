/**
 * Build the per-user Windows installer from a packaged `win32-x64` directory.
 *
 * Two commands, because the uninstaller is written by an installer and the
 * release workflow signs it in between:
 *
 *   uninstaller --package <dir> --out <file>
 *     compiles a build that only writes the uninstaller, runs it, and leaves
 *     the uninstaller at <file>, ready to sign.
 *   installer --package <dir> --uninstaller <file> --out-dir <dir>
 *     compiles the installer that carries the package and that uninstaller,
 *     and prints its path.
 *
 * Both read the product, flavor and version from the package's own manifest,
 * so an installer cannot describe a different build than the one it carries.
 * The file lists are generated here from the package directory: the installer
 * writes each file and the uninstaller removes each one, then each folder if
 * empty, so uninstalling never removes anything this version did not install.
 *
 * The CI job builds both unsigned and installs, launches and uninstalls the
 * result; the release workflow signs the package's programs, the uninstaller
 * and the installer through Artifact Signing (`docs/architecture.md`,
 * "Current Release Boundary").
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, lstat, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type DesktopIdentity, desktopIdentityForPackage } from "@octant/host-runtime";
import {
  OCTANT_WINDOWS_PUBLISHER,
  windowsUninstallerName,
} from "../apps/desktop/src/windowsInstallerUpdate";

export const MAKENSIS_ENVIRONMENT_VARIABLE = "OCTANT_MAKENSIS";

const NSIS_SCRIPT = resolve(import.meta.dirname, "windows-installer", "octant.nsi");

/**
 * The longest install prefix a person can have: `C:\Users\`, a 20-character
 * account name (the Windows limit), `\AppData\Local\Programs\`, the product
 * folder and a separator. NSIS writes files without long-path support, so a
 * file whose full path would pass 259 characters fails at install time; this
 * refuses the build instead.
 */
const LONGEST_USER_PREFIX = "C:\\Users\\" + "u".repeat(20) + "\\AppData\\Local\\Programs\\";
const MAX_WINDOWS_PATH = 259;

export interface PackageFile {
  /** Path inside the package, with forward slashes. */
  readonly path: string;
  readonly size: number;
}

export function windowsInstallerFileName(productName: string, version: string): string {
  return `${productName}-${version}-win32-x64-setup.exe`;
}

/** Windows version resources take four numbers; the prerelease stays in the display version. */
export function numericWindowsVersion(version: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-|$)/.exec(version);
  if (match === null) throw new Error(`${version} is not a release version.`);
  return `${match[1]}.${match[2]}.${match[3]}.0`;
}

/**
 * A literal path as an NSIS string. A quote or control character cannot be
 * carried, and `$` refuses too: NSIS reads it as a variable in the paths the
 * uninstaller deletes, but takes it literally in the source paths `File`
 * reads at compile time, so no one escaping is right for both lists.
 */
function nsisLiteral(value: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/["$\u0000-\u001f]/.test(value)) {
    throw new Error(`An installer path cannot carry ${JSON.stringify(value)}.`);
  }
  return `"${value}"`;
}

/** A package path under the install folder, as an NSIS string. */
function nsisInstalled(path: string): string {
  if (path === "") return '"$INSTDIR"';
  return `"$INSTDIR\\${nsisLiteral(windowsRelative(path)).slice(1)}`;
}

function windowsRelative(path: string): string {
  return path.split("/").join("\\");
}

/**
 * The installer's and uninstaller's file lists, and the size the Apps list
 * shows, from one listing of the package.
 */
export function nsisFileLists(
  files: ReadonlyArray<PackageFile>,
  input: { readonly sourceRoot: string; readonly productName: string },
): { readonly install: string; readonly uninstall: string; readonly estimatedSizeKb: number } {
  const uninstaller = windowsUninstallerName(input.productName);
  const byDirectory = new Map<string, string[]>();
  let bytes = 0;
  for (const file of files) {
    const segments = file.path.split("/");
    if (
      file.path === "" ||
      file.path.startsWith("/") ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`Refusing a package path outside the package: ${file.path}`);
    }
    if (file.path.toLowerCase() === uninstaller.toLowerCase()) {
      throw new Error(`The package already contains ${uninstaller}.`);
    }
    const installedLength =
      `${LONGEST_USER_PREFIX}${input.productName}\\${windowsRelative(file.path)}`.length;
    if (installedLength > MAX_WINDOWS_PATH) {
      throw new Error(
        `${file.path} would be ${installedLength} characters once installed, past the ${MAX_WINDOWS_PATH} Windows allows.`,
      );
    }
    const directory = segments.slice(0, -1).join("/");
    const entries = byDirectory.get(directory) ?? [];
    entries.push(file.path);
    byDirectory.set(directory, entries);
    bytes += file.size;
  }
  const directories = [...byDirectory.keys()].sort();
  const install: string[] = [];
  for (const directory of directories) {
    install.push(`SetOutPath ${nsisInstalled(directory)}`);
    for (const path of (byDirectory.get(directory) ?? []).sort()) {
      install.push(`File ${nsisLiteral(join(input.sourceRoot, ...path.split("/")))}`);
    }
  }
  const uninstall: string[] = [];
  for (const path of files.map((file) => file.path).sort()) {
    uninstall.push(`Delete ${nsisInstalled(path)}`);
  }
  // Every ancestor folder, deepest first, removed only when empty.
  const folders = new Set<string>();
  for (const directory of directories) {
    const parts = directory === "" ? [] : directory.split("/");
    for (let depth = parts.length; depth > 0; depth -= 1) {
      folders.add(parts.slice(0, depth).join("/"));
    }
  }
  for (const folder of [...folders].sort(
    (a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a),
  )) {
    uninstall.push(`RMDir ${nsisInstalled(folder)}`);
  }
  return {
    install: `${install.join("\n")}\n`,
    uninstall: `${uninstall.join("\n")}\n`,
    estimatedSizeKb: Math.ceil(bytes / 1024),
  };
}

export type InstallerBuild =
  | { readonly kind: "uninstaller"; readonly writeTo: string }
  | { readonly kind: "installer"; readonly signedUninstaller: string };

/** The `makensis` command line for one of the two builds. */
export function makensisArguments(input: {
  readonly identity: Pick<DesktopIdentity, "productName" | "bundleId" | "scheme">;
  readonly version: string;
  readonly outFile: string;
  readonly installFiles: string;
  readonly uninstallFiles: string;
  readonly estimatedSizeKb: number;
  readonly build: InstallerBuild;
  readonly script?: string;
}): ReadonlyArray<string> {
  const defines: Record<string, string> = {
    PRODUCT_NAME: input.identity.productName,
    BUNDLE_ID: input.identity.bundleId,
    URL_SCHEME: input.identity.scheme,
    PUBLISHER: OCTANT_WINDOWS_PUBLISHER,
    DISPLAY_VERSION: input.version,
    NUMERIC_VERSION: numericWindowsVersion(input.version),
    OUT_FILE: input.outFile,
    UNINSTALL_FILES: input.uninstallFiles,
    ...(input.build.kind === "uninstaller"
      ? { WRITE_UNINSTALLER_TO: input.build.writeTo }
      : {
          SIGNED_UNINSTALLER: input.build.signedUninstaller,
          INSTALL_FILES: input.installFiles,
          ESTIMATED_SIZE_KB: String(input.estimatedSizeKb),
        }),
  };
  for (const [name, value] of Object.entries(defines)) {
    // oxlint-disable-next-line no-control-regex -- control characters are what this refuses
    if (/["$\u0000-\u001f]/.test(value)) {
      throw new Error(`The installer cannot carry ${name}=${JSON.stringify(value)}.`);
    }
  }
  return [
    "-V2",
    // Warnings are errors: an unused section or variable here is a sign the
    // two builds have drifted apart.
    "-WX",
    "-INPUTCHARSET",
    "UTF8",
    ...Object.entries(defines).map(([name, value]) => `-D${name}=${value}`),
    input.script ?? NSIS_SCRIPT,
  ];
}

/** Every file in the package. A link refuses: it would install whatever it points at. */
export async function collectPackageFiles(root: string): Promise<ReadonlyArray<PackageFile>> {
  const files: PackageFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Refusing a link in the package: ${path}`);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) {
        files.push({ path: relative(root, path).split(sep).join("/"), size: stat.size });
      } else throw new Error(`Refusing a special file in the package: ${path}`);
    }
  };
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readPackageIdentity(
  packageDirectory: string,
): Promise<{ readonly identity: DesktopIdentity; readonly version: string }> {
  const manifest: unknown = JSON.parse(
    await readFile(join(packageDirectory, "resources", "app", "package.json"), "utf8"),
  );
  const identity = desktopIdentityForPackage(manifest);
  const version = (manifest as { readonly version: string }).version;
  await access(join(packageDirectory, `${identity.productName}.exe`));
  return { identity, version };
}

function run(command: string, args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, [...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stdout.trim() !== "") console.log(stdout.trim());
      if (error === null) resolvePromise();
      else {
        if (stderr.trim() !== "") console.error(stderr.trim());
        reject(new Error(`${command} failed: ${error.message}`));
      }
    });
  });
}

async function compile(
  packageDirectory: string,
  outFile: string,
  build: InstallerBuild,
): Promise<void> {
  const { identity, version } = await readPackageIdentity(packageDirectory);
  const files = await collectPackageFiles(packageDirectory);
  const lists = nsisFileLists(files, {
    sourceRoot: resolve(packageDirectory),
    productName: identity.productName,
  });
  const work = await mkdtemp(join(tmpdir(), "octant-installer-"));
  try {
    const installFiles = join(work, "install-files.nsh");
    const uninstallFiles = join(work, "uninstall-files.nsh");
    await writeFile(installFiles, lists.install, "utf8");
    await writeFile(uninstallFiles, lists.uninstall, "utf8");
    await mkdir(dirname(outFile), { recursive: true });
    await run(
      process.env[MAKENSIS_ENVIRONMENT_VARIABLE] ?? "makensis",
      makensisArguments({
        identity,
        version,
        outFile,
        installFiles,
        uninstallFiles,
        estimatedSizeKb: lists.estimatedSizeKb,
        build,
      }),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function option(argv: ReadonlyArray<string>, name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`--${name} is required.`);
  }
  return resolve(value);
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const [command] = argv;
  const packageDirectory = option(argv, "package");
  if (command === "uninstaller") {
    // The uninstaller is written by running the first build, which only
    // Windows can do.
    if (process.platform !== "win32") throw new Error("The uninstaller is written on Windows.");
    const out = option(argv, "out");
    await rm(out, { force: true });
    const work = await mkdtemp(join(tmpdir(), "octant-uninstaller-"));
    try {
      const writer = join(work, "write-uninstaller.exe");
      await compile(packageDirectory, writer, { kind: "uninstaller", writeTo: out });
      await run(writer, []);
      await access(out);
      console.log(out);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    return;
  }
  if (command === "installer") {
    const uninstaller = option(argv, "uninstaller");
    await access(uninstaller);
    const { identity, version } = await readPackageIdentity(packageDirectory);
    const out = join(
      option(argv, "out-dir"),
      windowsInstallerFileName(identity.productName, version),
    );
    await rm(out, { force: true });
    await compile(packageDirectory, out, { kind: "installer", signedUninstaller: uninstaller });
    console.log(out);
    return;
  }
  throw new Error("Usage: package-windows-installer.ts uninstaller|installer --package <dir> ...");
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

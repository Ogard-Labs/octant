/**
 * Authenticode for a Windows release, read the way the app reads it.
 *
 *   list-unsigned --root <dir> --catalog <file>
 *     writes every Windows program under <dir> that Windows does not already
 *     accept as signed into <file>, one path per line relative to the
 *     catalog's folder (the Artifact Signing action's catalog format).
 *   verify --root <dir> --ours <catalog> [--file <path>]...
 *     requires every program under <dir> to carry a valid signature, and every
 *     program the catalog listed (and each --file) to be signed by Octant's
 *     publisher. Exits non-zero otherwise.
 *
 * A program is found by its PE headers, not its extension, so a native module
 * or a helper with an unusual name is not skipped. Programs another publisher
 * already signed validly (a Microsoft runtime DLL) keep their signature.
 * The checker and the publisher name are the app's own
 * (`apps/desktop/src/windowsInstallerUpdate.ts`), so a release passes exactly
 * the check an installed copy will apply to its updates.
 */

import { open, readdir, lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type AuthenticodeReport,
  createAuthenticodeReader,
  isPortableExecutable,
  judgeAuthenticode,
  OCTANT_WINDOWS_PUBLISHER,
} from "../apps/desktop/src/windowsInstallerUpdate";

/** Enough of a file to reach its PE header, which linkers place in the first page. */
const HEADER_BYTES = 4096;

export interface SignatureReading {
  readonly path: string;
  readonly report: AuthenticodeReport;
}

/** Programs that need Octant's signature: every one Windows does not already accept. */
export function programsToSign(readings: ReadonlyArray<SignatureReading>): ReadonlyArray<string> {
  return readings
    .filter((reading) => reading.report.kind !== "read" || reading.report.status !== "Valid")
    .map((reading) => reading.path);
}

/** Every failure of a signed release, as sentences; empty means it may ship. */
export function releaseSignatureFailures(
  readings: ReadonlyArray<SignatureReading>,
  ours: ReadonlySet<string>,
  publisher: string = OCTANT_WINDOWS_PUBLISHER,
): ReadonlyArray<string> {
  const failures: string[] = [];
  for (const { path, report } of readings) {
    const verdict = judgeAuthenticode(report, publisher);
    if (verdict.kind === "unavailable") {
      failures.push(`${path}: the signature could not be read.`);
      continue;
    }
    if (ours.has(path)) {
      if (verdict.kind === "refused")
        failures.push(`${path}: not signed by ${publisher} (${verdict.reason}).`);
      continue;
    }
    if (report.kind === "read" && report.status !== "Valid") {
      failures.push(`${path}: signature status ${report.status}.`);
    }
  }
  for (const path of ours) {
    if (!readings.some((reading) => reading.path === path)) {
      failures.push(`${path}: expected a signed program and found none.`);
    }
  }
  return failures;
}

async function isProgram(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return isPortableExecutable(new Uint8Array(buffer.subarray(0, bytesRead)));
  } finally {
    await handle.close();
  }
}

async function findPrograms(root: string): Promise<ReadonlyArray<string>> {
  const programs: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Refusing a link in a release: ${path}`);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile() && (await isProgram(path))) programs.push(path);
    }
  };
  await walk(root);
  return programs.sort();
}

async function readAll(paths: ReadonlyArray<string>): Promise<ReadonlyArray<SignatureReading>> {
  const read = createAuthenticodeReader();
  const readings: SignatureReading[] = [];
  for (const path of paths) readings.push({ path, report: await read(path) });
  return readings;
}

function options(argv: ReadonlyArray<string>, name: string): ReadonlyArray<string> {
  const values: string[] = [];
  argv.forEach((argument, index) => {
    const value = argv[index + 1];
    if (argument === `--${name}` && value !== undefined && !value.startsWith("--")) {
      values.push(resolve(value));
    }
  });
  return values;
}

function single(argv: ReadonlyArray<string>, name: string): string {
  const [value, extra] = options(argv, name);
  if (value === undefined || extra !== undefined) throw new Error(`--${name} is required once.`);
  return value;
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  if (process.platform !== "win32") throw new Error("Authenticode is read on Windows.");
  const [command] = argv;
  const root = single(argv, "root");
  if (command === "list-unsigned") {
    const catalog = single(argv, "catalog");
    const toSign = programsToSign(await readAll(await findPrograms(root)));
    if (toSign.length === 0) throw new Error(`No unsigned program under ${root}; nothing to sign.`);
    const lines = toSign.map((path) => relative(dirname(catalog), path).split(sep).join("\\"));
    await writeFile(catalog, `${lines.join("\r\n")}\r\n`, "utf8");
    console.log(`${toSign.length} programs to sign:\n${lines.join("\n")}`);
    return;
  }
  if (command === "verify") {
    const catalog = single(argv, "ours");
    const listed = (await readFile(catalog, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => resolve(dirname(catalog), line));
    const extra = options(argv, "file");
    const ours = new Set([...listed, ...extra]);
    const programs = [...new Set([...(await findPrograms(root)), ...extra])].sort();
    const failures = releaseSignatureFailures(await readAll(programs), ours);
    if (failures.length > 0) {
      throw new Error(`Refusing to ship unsigned or foreign programs:\n${failures.join("\n")}`);
    }
    console.log(
      `${programs.length} programs carry valid signatures; ${ours.size} are signed by ${OCTANT_WINDOWS_PUBLISHER}.`,
    );
    return;
  }
  throw new Error("Usage: windows-authenticode.ts list-unsigned|verify --root <dir> ...");
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

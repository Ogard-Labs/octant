import { execFile, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

/**
 * The publisher a Windows release is signed as: the common name of the
 * certificate Octant's Artifact Signing profile issues, which is what Windows
 * shows as the verified publisher.
 *
 * Compared exactly. "Validly signed" alone would admit any publisher's
 * program, so the installer an update runs must name this one. The release
 * workflow asserts the same name on every file it signs, so a certificate
 * whose subject differs fails the release instead of shipping an installer
 * every install refuses.
 */
export const OCTANT_WINDOWS_PUBLISHER = "Ogard Labs";

/** The arguments an update starts the installer with: silent, then start Octant again. */
export const WINDOWS_UPDATE_INSTALLER_ARGUMENTS: ReadonlyArray<string> = ["/S", "/relaunch"];

/**
 * How long the signature check may take. It reads one local file; past this
 * the check is unavailable, never passed.
 */
const AUTHENTICODE_CHECK_TIMEOUT_MS = 30_000;

export type WindowsInstallLocation =
  | { readonly kind: "installed"; readonly installDirectory: string }
  | { readonly kind: "not-installed" };

/** What Windows reported for one file: its signature status and signer, or nothing usable. */
export type AuthenticodeReport =
  | { readonly kind: "read"; readonly status: string; readonly publisher: string | null }
  | { readonly kind: "unavailable" };

export type AuthenticodeRefusal = "unsigned" | "invalid" | "other-publisher";

export type AuthenticodeVerdict =
  | { readonly kind: "trusted" }
  | { readonly kind: "refused"; readonly reason: AuthenticodeRefusal }
  | { readonly kind: "unavailable" };

export type WindowsInstallerApplyResult =
  | { readonly kind: "launched" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "untrusted-publisher"; readonly reason: AuthenticodeRefusal }
  | { readonly kind: "check-unavailable" }
  | { readonly kind: "launch-failed" }
  | { readonly kind: "not-installed" };

export interface WindowsInstallerPort {
  locate(): Promise<WindowsInstallLocation>;
  /** Verify the downloaded installer, start it, and quit so it can replace this copy. */
  verifyAndRun(bytes: Uint8Array, expectedSha256: string): Promise<WindowsInstallerApplyResult>;
}

/** The filesystem the installer hand-off talks to, injected so a refusal is testable anywhere. */
export interface WindowsInstallerFiles {
  /** A new directory only this user can reach. */
  makePrivateDirectory(): Promise<string>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  removeDirectory(path: string): Promise<void>;
}

/** Where the per-user installer puts a product: never the product's data folder. */
export function windowsInstallDirectory(localAppData: string, productName: string): string {
  return win32.join(localAppData, "Programs", productName);
}

export function windowsUninstallerName(productName: string): string {
  return `Uninstall ${productName}.exe`;
}

/**
 * Whether this launch is a copy the installer placed, and so one an installer
 * may replace.
 *
 * Only the installer's own fixed location counts, with its uninstaller beside
 * the program. The unpacked QA archive, a copy moved elsewhere, and the other
 * app's folder are refused before any request: running the installer would
 * write a second copy rather than replace the one running.
 */
export async function readWindowsInstallLocation(input: {
  readonly executablePath: string;
  readonly localAppData: string;
  readonly productName: string;
  readonly exists: (path: string) => Promise<boolean>;
}): Promise<WindowsInstallLocation> {
  if (!/^[A-Za-z]:\\/.test(input.localAppData) || !/^[A-Za-z]:\\/.test(input.executablePath)) {
    return { kind: "not-installed" };
  }
  const installDirectory = windowsInstallDirectory(
    win32.normalize(input.localAppData),
    input.productName,
  );
  const expected = win32.join(installDirectory, `${input.productName}.exe`);
  // The raw path, not a normalized one: a launch through `..` is not the
  // installer's spelling of its own program.
  if (input.executablePath.toLowerCase() !== expected.toLowerCase()) {
    return { kind: "not-installed" };
  }
  const uninstaller = win32.join(installDirectory, windowsUninstallerName(input.productName));
  if (!(await input.exists(uninstaller))) return { kind: "not-installed" };
  return { kind: "installed", installDirectory };
}

/** True when these bytes carry the DOS and PE headers of a Windows program. */
export function isPortableExecutable(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(0x3c, true);
  if (offset + 4 > bytes.byteLength) return false;
  return (
    bytes[offset] === 0x50 &&
    bytes[offset + 1] === 0x45 &&
    bytes[offset + 2] === 0 &&
    bytes[offset + 3] === 0
  );
}

/**
 * Trust a file only when Windows accepts its signature and its signer is
 * exactly Octant's publisher. Letter case counts: a certificate is issued to
 * one spelling.
 */
export function judgeAuthenticode(
  report: AuthenticodeReport,
  publisher: string,
): AuthenticodeVerdict {
  if (report.kind === "unavailable") return { kind: "unavailable" };
  if (report.status === "NotSigned") return { kind: "refused", reason: "unsigned" };
  if (report.status !== "Valid") return { kind: "refused", reason: "invalid" };
  if (report.publisher !== publisher) return { kind: "refused", reason: "other-publisher" };
  return { kind: "trusted" };
}

/** Read the checker's one-line report; anything but its exact shape is unavailable. */
export function parseAuthenticodeReport(output: string): AuthenticodeReport {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return { kind: "unavailable" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "unavailable" };
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "publisher" || keys[1] !== "status") {
    return { kind: "unavailable" };
  }
  const { status, publisher } = record;
  if (typeof status !== "string" || (publisher !== null && typeof publisher !== "string")) {
    return { kind: "unavailable" };
  }
  return { kind: "read", status, publisher };
}

/**
 * Verify a downloaded installer and start it.
 *
 * The feed signature already covered `expectedSha256`; this adds the second,
 * independent gate macOS gets from its code-signature check. The bytes are
 * hashed again from disk after writing, so the file checked and started is
 * the file the feed signed, and then Windows must report a valid signature
 * from Octant's publisher. A refusal removes the download and starts nothing.
 */
export async function runVerifiedInstaller(input: {
  readonly bytes: Uint8Array;
  readonly expectedSha256: string;
  readonly publisher: string;
  readonly files: WindowsInstallerFiles;
  readonly readSignature: (path: string) => Promise<AuthenticodeReport>;
  readonly launch: (path: string, args: ReadonlyArray<string>) => Promise<void>;
}): Promise<WindowsInstallerApplyResult> {
  if (!hashesMatch(input.bytes, input.expectedSha256) || !isPortableExecutable(input.bytes)) {
    return { kind: "corrupt" };
  }
  const directory = await input.files.makePrivateDirectory();
  const refuse = async (
    result: WindowsInstallerApplyResult,
  ): Promise<WindowsInstallerApplyResult> => {
    await input.files.removeDirectory(directory).catch(() => undefined);
    return result;
  };
  const path = win32.join(directory, "octant-update-setup.exe");
  try {
    await input.files.writeFile(path, input.bytes);
    if (!hashesMatch(await input.files.readFile(path), input.expectedSha256)) {
      return await refuse({ kind: "corrupt" });
    }
  } catch {
    return await refuse({ kind: "corrupt" });
  }
  let report: AuthenticodeReport;
  try {
    report = await input.readSignature(path);
  } catch {
    report = { kind: "unavailable" };
  }
  const verdict = judgeAuthenticode(report, input.publisher);
  if (verdict.kind === "unavailable") return await refuse({ kind: "check-unavailable" });
  if (verdict.kind === "refused") {
    return await refuse({ kind: "untrusted-publisher", reason: verdict.reason });
  }
  try {
    await input.launch(path, WINDOWS_UPDATE_INSTALLER_ARGUMENTS);
  } catch {
    return await refuse({ kind: "launch-failed" });
  }
  // The running installer holds its own file; it stays in this user's
  // temporary folder, which Windows cleans.
  return { kind: "launched" };
}

/**
 * The PowerShell that asks Windows for one file's signature.
 *
 * The path arrives in an environment variable, never in the script text, so
 * nothing about the file name is parsed as code. The cmdlet is named with its
 * module so a same-named command earlier on the module path is not run.
 */
const AUTHENTICODE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$s = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:OCTANT_AUTHENTICODE_TARGET",
  "$p = $null",
  "if ($s.SignerCertificate) { $p = $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }",
  "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([ordered]@{ status = [string]$s.Status; publisher = $p })))",
].join("\n");

/**
 * Ask Windows (through its own PowerShell, by absolute path and without a
 * shell) for a file's Authenticode status and signer.
 */
export function createAuthenticodeReader(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): (path: string) => Promise<AuthenticodeReport> {
  return (path) => {
    const systemRoot = environment.SystemRoot ?? "";
    if (!/^[A-Za-z]:\\/.test(systemRoot)) return Promise.resolve({ kind: "unavailable" });
    const powershell = win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const encoded = Buffer.from(AUTHENTICODE_SCRIPT, "utf16le").toString("base64");
    return new Promise((resolvePromise) => {
      execFile(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        {
          env: {
            SystemRoot: systemRoot,
            windir: systemRoot,
            OCTANT_AUTHENTICODE_TARGET: path,
          },
          timeout: AUTHENTICODE_CHECK_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        },
        (error, stdout) => {
          resolvePromise(error === null ? parseAuthenticodeReport(stdout.trim()) : unavailable);
        },
      );
    });
  };
}

const unavailable: AuthenticodeReport = { kind: "unavailable" };

export function createNodeWindowsInstallerFiles(): WindowsInstallerFiles {
  return {
    makePrivateDirectory: () => mkdtemp(join(tmpdir(), "octant-update-")),
    writeFile: (path, bytes) => writeFile(path, bytes, { flag: "wx" }),
    readFile: async (path) => new Uint8Array(await readFile(path)),
    removeDirectory: (path) => rm(path, { recursive: true, force: true }),
  };
}

/** Start the installer detached, so it outlives this process and can replace it. */
export function launchDetachedInstaller(path: string, args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(path, [...args], { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", (error) => reject(error));
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

/**
 * The installer hand-off for a packaged Windows copy.
 *
 * Not wired into the packaged app yet: the Windows signed feed stays off until
 * the Linux signed-feed path it builds on has been exercised on a real image
 * (`docs/architecture.md`, "Windows sequence").
 */
export function createWindowsInstallerPort(options: {
  readonly quit: () => void;
  readonly productName: string;
  readonly executablePath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): WindowsInstallerPort {
  const environment = options.environment ?? process.env;
  const executablePath = options.executablePath ?? process.execPath;
  const files = createNodeWindowsInstallerFiles();
  const readSignature = createAuthenticodeReader(environment);
  const locate = () =>
    readWindowsInstallLocation({
      executablePath,
      localAppData: environment.LOCALAPPDATA ?? "",
      productName: options.productName,
      exists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
    });
  return {
    locate,
    verifyAndRun: async (bytes, expectedSha256) => {
      if ((await locate()).kind !== "installed") return { kind: "not-installed" };
      const result = await runVerifiedInstaller({
        bytes,
        expectedSha256,
        publisher: OCTANT_WINDOWS_PUBLISHER,
        files,
        readSignature,
        launch: launchDetachedInstaller,
      });
      if (result.kind === "launched") options.quit();
      return result;
    },
  };
}

function hashesMatch(bytes: Uint8Array, expectedHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  const actual = createHash("sha256").update(bytes).digest();
  return timingSafeEqual(actual, Buffer.from(expectedHex, "hex"));
}

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AuthenticodeReport,
  isPortableExecutable,
  judgeAuthenticode,
  OCTANT_WINDOWS_PUBLISHER,
  parseAuthenticodeReport,
  readWindowsInstallLocation,
  runVerifiedInstaller,
  type WindowsInstallerFiles,
  windowsInstallDirectory,
} from "./windowsInstallerUpdate";

/** The smallest bytes Windows would call a PE image: `MZ`, a header offset, `PE\0\0`. */
function portableExecutable(body = "octant-setup"): Uint8Array {
  const bytes = Buffer.alloc(0x80 + body.length);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write("PE\0\0", 0x40, "latin1");
  bytes.write(body, 0x80, "latin1");
  return new Uint8Array(bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function memoryFiles(options: { readonly corruptOnDisk?: boolean } = {}) {
  const written = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const files: WindowsInstallerFiles = {
    makePrivateDirectory: async () => "C:\\Users\\person\\AppData\\Local\\Temp\\octant-update-1",
    writeFile: async (path, bytes) => {
      written.set(path, options.corruptOnDisk === true ? new Uint8Array([0]) : bytes);
    },
    readFile: async (path) => {
      const bytes = written.get(path);
      if (bytes === undefined) throw new Error("missing");
      return bytes;
    },
    removeDirectory: async (path) => {
      removed.push(path);
      for (const key of written.keys()) if (key.startsWith(path)) written.delete(key);
    },
  };
  return { files, written, removed };
}

function installer(
  report: AuthenticodeReport | "throws",
  options: { readonly bytes?: Uint8Array; readonly corruptOnDisk?: boolean } = {},
) {
  const bytes = options.bytes ?? portableExecutable();
  const memory = memoryFiles(options);
  const launched: Array<{ readonly path: string; readonly args: ReadonlyArray<string> }> = [];
  const checked: string[] = [];
  const run = (expectedSha256 = sha256(bytes)) =>
    runVerifiedInstaller({
      bytes,
      expectedSha256,
      publisher: OCTANT_WINDOWS_PUBLISHER,
      files: memory.files,
      readSignature: async (path) => {
        checked.push(path);
        if (report === "throws") throw new Error("powershell missing");
        return report;
      },
      launch: async (path, args) => {
        launched.push({ path, args });
      },
    });
  return { run, launched, checked, ...memory };
}

const SIGNED_BY_OCTANT: AuthenticodeReport = {
  kind: "read",
  status: "Valid",
  publisher: OCTANT_WINDOWS_PUBLISHER,
};

describe("Windows installer updates", () => {
  it("runs the verified installer silently and asks it to relaunch Octant", async () => {
    const { run, launched, checked } = installer(SIGNED_BY_OCTANT);

    expect(await run()).toEqual({ kind: "launched" });
    expect(checked).toHaveLength(1);
    expect(launched).toEqual([{ path: checked[0], args: ["/S", "/relaunch"] }]);
  });

  it("refuses bytes that do not match the signed hash before writing anything", async () => {
    const { run, launched, written, checked } = installer(SIGNED_BY_OCTANT);

    expect(await run("0".repeat(64))).toEqual({ kind: "corrupt" });
    expect(written.size).toBe(0);
    expect(checked).toHaveLength(0);
    expect(launched).toHaveLength(0);
  });

  it("refuses a signed download that is not a Windows program", async () => {
    const zip = new Uint8Array(Buffer.from("PK\u0003\u0004 not an installer"));
    const { run, launched, written } = installer(SIGNED_BY_OCTANT, { bytes: zip });

    expect(await run()).toEqual({ kind: "corrupt" });
    expect(written.size).toBe(0);
    expect(launched).toHaveLength(0);
  });

  it("checks the bytes it wrote, not only the ones it downloaded", async () => {
    const { run, launched, removed } = installer(SIGNED_BY_OCTANT, { corruptOnDisk: true });

    expect(await run()).toEqual({ kind: "corrupt" });
    expect(launched).toHaveLength(0);
    expect(removed).toHaveLength(1);
  });

  it("refuses an unsigned installer, removes it and never runs it", async () => {
    const { run, launched, written, removed } = installer({
      kind: "read",
      status: "NotSigned",
      publisher: null,
    });

    expect(await run()).toEqual({ kind: "untrusted-publisher", reason: "unsigned" });
    expect(launched).toHaveLength(0);
    expect(removed).toHaveLength(1);
    expect(written.size).toBe(0);
  });

  it("refuses an installer validly signed by another publisher", async () => {
    const { run, launched } = installer({
      kind: "read",
      status: "Valid",
      publisher: "Microsoft Windows",
    });

    expect(await run()).toEqual({ kind: "untrusted-publisher", reason: "other-publisher" });
    expect(launched).toHaveLength(0);
  });

  it("refuses Octant's name on a signature Windows does not accept", async () => {
    const { run, launched } = installer({
      kind: "read",
      status: "HashMismatch",
      publisher: OCTANT_WINDOWS_PUBLISHER,
    });

    expect(await run()).toEqual({ kind: "untrusted-publisher", reason: "invalid" });
    expect(launched).toHaveLength(0);
  });

  it("says the signature check could not run rather than blaming the publisher", async () => {
    const unreadable = installer({ kind: "unavailable" });
    expect(await unreadable.run()).toEqual({ kind: "check-unavailable" });
    expect(unreadable.launched).toHaveLength(0);

    const failing = installer("throws");
    expect(await failing.run()).toEqual({ kind: "check-unavailable" });
    expect(failing.launched).toHaveLength(0);
    expect(failing.removed).toHaveLength(1);
  });

  it("removes the verified installer again when Windows will not start it", async () => {
    const memory = memoryFiles();
    const bytes = portableExecutable();
    const result = await runVerifiedInstaller({
      bytes,
      expectedSha256: sha256(bytes),
      publisher: OCTANT_WINDOWS_PUBLISHER,
      files: memory.files,
      readSignature: async () => SIGNED_BY_OCTANT,
      launch: async () => {
        throw new Error("spawn EACCES");
      },
    });

    expect(result).toEqual({ kind: "launch-failed" });
    expect(memory.removed).toHaveLength(1);
  });
});

describe("judging a Windows signature", () => {
  it("trusts only a valid signature whose signer is exactly Octant's publisher", () => {
    expect(judgeAuthenticode(SIGNED_BY_OCTANT, OCTANT_WINDOWS_PUBLISHER)).toEqual({
      kind: "trusted",
    });
    expect(
      judgeAuthenticode(
        { kind: "read", status: "Valid", publisher: `${OCTANT_WINDOWS_PUBLISHER} Ltd` },
        OCTANT_WINDOWS_PUBLISHER,
      ),
    ).toEqual({ kind: "refused", reason: "other-publisher" });
    expect(
      judgeAuthenticode(
        { kind: "read", status: "Valid", publisher: OCTANT_WINDOWS_PUBLISHER.toUpperCase() },
        OCTANT_WINDOWS_PUBLISHER,
      ),
    ).toEqual({ kind: "refused", reason: "other-publisher" });
    expect(
      judgeAuthenticode({ kind: "read", status: "Valid", publisher: null }, "Ogard Labs"),
    ).toEqual({ kind: "refused", reason: "other-publisher" });
  });

  it("reads the checker's report strictly", () => {
    expect(parseAuthenticodeReport('{"status":"Valid","publisher":"Ogard Labs"}')).toEqual({
      kind: "read",
      status: "Valid",
      publisher: "Ogard Labs",
    });
    expect(parseAuthenticodeReport('{"status":"NotSigned","publisher":null}')).toEqual({
      kind: "read",
      status: "NotSigned",
      publisher: null,
    });
    for (const unreadable of [
      "",
      "Valid",
      "[]",
      '{"status":"Valid"}',
      '{"status":1,"publisher":null}',
      '{"status":"Valid","publisher":"Ogard Labs","extra":true}',
    ]) {
      expect(parseAuthenticodeReport(unreadable)).toEqual({ kind: "unavailable" });
    }
  });

  it("recognizes a Windows program by its headers, not its name", () => {
    expect(isPortableExecutable(portableExecutable())).toBe(true);
    const truncated = portableExecutable().slice(0, 0x42);
    expect(isPortableExecutable(truncated)).toBe(false);
    const wrongSignature = portableExecutable();
    wrongSignature[0x41] = 0x46;
    expect(isPortableExecutable(wrongSignature)).toBe(false);
    expect(isPortableExecutable(new Uint8Array(Buffer.from("MZ")))).toBe(false);
  });
});

describe("where an installed copy lives", () => {
  const localAppData = "C:\\Users\\person\\AppData\\Local";
  const installed = windowsInstallDirectory(localAppData, "Octant");
  const beside = (present: ReadonlyArray<string>) => async (path: string) =>
    present.some((entry) => entry.toLowerCase() === path.toLowerCase());

  it("offers updates only to the copy at the installer's own location with its uninstaller", async () => {
    expect(installed).toBe("C:\\Users\\person\\AppData\\Local\\Programs\\Octant");
    expect(
      await readWindowsInstallLocation({
        executablePath: `${installed}\\Octant.exe`,
        localAppData,
        productName: "Octant",
        exists: beside([`${installed}\\Uninstall Octant.exe`]),
      }),
    ).toEqual({ kind: "installed", installDirectory: installed });
  });

  it("accepts the folder in any letter case, as Windows does", async () => {
    expect(
      await readWindowsInstallLocation({
        executablePath: `${installed.toLowerCase()}\\octant.exe`,
        localAppData,
        productName: "Octant",
        exists: beside([`${installed}\\Uninstall Octant.exe`]),
      }),
    ).toMatchObject({ kind: "installed" });
  });

  it("refuses the unpacked QA archive, a copy without its uninstaller, and the other app", async () => {
    const exists = beside([`${installed}\\Uninstall Octant.exe`]);
    for (const executablePath of [
      "C:\\Users\\person\\Downloads\\Octant-win32-x64\\Octant.exe",
      `${installed}\\..\\Octant\\Octant.exe`,
      `${installed}\\resources\\Octant.exe`,
      `\\\\server\\share\\Programs\\Octant\\Octant.exe`,
      "Octant.exe",
    ]) {
      expect(
        await readWindowsInstallLocation({
          executablePath,
          localAppData,
          productName: "Octant",
          exists,
        }),
      ).toEqual({ kind: "not-installed" });
    }
    expect(
      await readWindowsInstallLocation({
        executablePath: `${installed}\\Octant.exe`,
        localAppData,
        productName: "Octant",
        exists: beside([]),
      }),
    ).toEqual({ kind: "not-installed" });
    expect(
      await readWindowsInstallLocation({
        executablePath: `${installed}\\Octant.exe`,
        localAppData,
        productName: "Octant Nightly",
        exists,
      }),
    ).toEqual({ kind: "not-installed" });
    expect(
      await readWindowsInstallLocation({
        executablePath: `${installed}\\Octant.exe`,
        localAppData: "relative\\Local",
        productName: "Octant",
        exists,
      }),
    ).toEqual({ kind: "not-installed" });
  });
});

import { describe, expect, it } from "vitest";
import { DESKTOP_FLAVOR_IDENTITIES } from "@octant/host-runtime";
import {
  makensisArguments,
  nsisFileLists,
  numericWindowsVersion,
  windowsInstallerFileName,
} from "./package-windows-installer";

const sourceRoot = "D:\\a\\out\\Octant-win32-x64";

describe("Windows installer file lists", () => {
  it("installs each packaged file and uninstalls exactly those files, then their empty folders", () => {
    const lists = nsisFileLists(
      [
        { path: "Octant.exe", size: 2048 },
        { path: "resources/app/package.json", size: 100 },
        { path: "resources/native/octant-credential-helper.exe", size: 1024 },
      ],
      { sourceRoot: "/build/Octant-win32-x64", productName: "Octant" },
    );

    expect(lists.install.split("\n")).toEqual([
      'SetOutPath "$INSTDIR"',
      'File "/build/Octant-win32-x64/Octant.exe"',
      'SetOutPath "$INSTDIR\\resources\\app"',
      'File "/build/Octant-win32-x64/resources/app/package.json"',
      'SetOutPath "$INSTDIR\\resources\\native"',
      'File "/build/Octant-win32-x64/resources/native/octant-credential-helper.exe"',
      "",
    ]);
    expect(lists.uninstall.split("\n")).toEqual([
      'Delete "$INSTDIR\\Octant.exe"',
      'Delete "$INSTDIR\\resources\\app\\package.json"',
      'Delete "$INSTDIR\\resources\\native\\octant-credential-helper.exe"',
      'RMDir "$INSTDIR\\resources\\native"',
      'RMDir "$INSTDIR\\resources\\app"',
      'RMDir "$INSTDIR\\resources"',
      "",
    ]);
    expect(lists.uninstall).not.toContain("/r");
    expect(lists.estimatedSizeKb).toBe(4);
  });

  it("refuses a file name the installer would read as a variable", () => {
    expect(() =>
      nsisFileLists([{ path: "a$b.txt", size: 1 }], { sourceRoot, productName: "Octant" }),
    ).toThrow(/cannot carry/);
  });

  it("refuses a package that reaches outside itself or shadows the uninstaller", () => {
    for (const path of ["../outside.dll", "resources/../../x", "/abs.exe", "a//b"]) {
      expect(() =>
        nsisFileLists([{ path, size: 1 }], { sourceRoot, productName: "Octant" }),
      ).toThrow(/outside the package/);
    }
    expect(() =>
      nsisFileLists([{ path: "uninstall octant.exe", size: 1 }], {
        sourceRoot,
        productName: "Octant",
      }),
    ).toThrow(/already contains/);
  });

  it("refuses a file that would pass the Windows path limit in a long user profile", () => {
    const deep = `resources/app/${"node_modules/".repeat(14)}x.js`;
    expect(() =>
      nsisFileLists([{ path: deep, size: 1 }], { sourceRoot, productName: "Octant" }),
    ).toThrow(/past the 259/);
  });
});

describe("Windows installer builds", () => {
  const identity = DESKTOP_FLAVOR_IDENTITIES.stable;
  const common = {
    identity,
    version: "0.3.0-candidate.20261115.4",
    outFile: "D:\\out\\setup.exe",
    installFiles: "D:\\work\\install-files.nsh",
    uninstallFiles: "D:\\work\\uninstall-files.nsh",
    estimatedSizeKb: 1,
    script: "octant.nsi",
  } as const;

  it("names the installer after the build it carries", () => {
    expect(windowsInstallerFileName("Octant", "0.3.0")).toBe("Octant-0.3.0-win32-x64-setup.exe");
    expect(numericWindowsVersion("0.3.0-candidate.20261115.4")).toBe("0.3.0.0");
    expect(() => numericWindowsVersion("latest")).toThrow();
  });

  it("writes only the uninstaller in the first build and carries the signed one in the second", () => {
    const first = makensisArguments({
      ...common,
      build: { kind: "uninstaller", writeTo: "D:\\out\\Uninstall Octant.exe" },
    });
    expect(first).toContain("-DWRITE_UNINSTALLER_TO=D:\\out\\Uninstall Octant.exe");
    expect(first.some((argument) => argument.startsWith("-DINSTALL_FILES="))).toBe(false);

    const second = makensisArguments({
      ...common,
      build: { kind: "installer", signedUninstaller: "D:\\signed\\Uninstall Octant.exe" },
    });
    expect(second).toContain("-DSIGNED_UNINSTALLER=D:\\signed\\Uninstall Octant.exe");
    expect(second).toContain("-DINSTALL_FILES=D:\\work\\install-files.nsh");
    expect(second).toContain("-DDISPLAY_VERSION=0.3.0-candidate.20261115.4");
    expect(second).toContain("-DBUNDLE_ID=app.octant.desktop");
    expect(second).toContain("-WX");
    expect(second.some((argument) => argument.startsWith("-DWRITE_UNINSTALLER_TO="))).toBe(false);
    expect(second.at(-1)).toBe("octant.nsi");
  });

  it("refuses a define the installer script would read as code", () => {
    expect(() =>
      makensisArguments({
        ...common,
        outFile: "D:\\$PLUGINSDIR\\setup.exe",
        build: { kind: "installer", signedUninstaller: "D:\\u.exe" },
      }),
    ).toThrow(/cannot carry OUT_FILE/);
  });
});

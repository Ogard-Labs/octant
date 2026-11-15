import { describe, expect, it } from "vitest";
import { NO_PROTECTED_FILES_CHANGES, resolveProtectedFiles } from "./secretGuardPolicy";
import {
  planWindowsConfinedLaunch,
  type WindowsConfinementInput,
  windowsConfinedLauncherArguments,
  windowsFullAccessLauncherArguments,
  windowsNativePath,
} from "./windowsConfinementPolicy";

const HOME = "C:\\Users\\Ada";
const DATA = `${HOME}\\AppData\\Local\\Octant\\data`;
const protectedEntries = resolveProtectedFiles(
  { platform: "win32", home: HOME, dataDirectory: DATA },
  NO_PROTECTED_FILES_CHANGES,
);
const LAUNCH_ID = "0123456789abcdef0123456789abcdef";

function input(overrides: Partial<WindowsConfinementInput> = {}): WindowsConfinementInput {
  return {
    launchId: LAUNCH_ID,
    executable: "D:\\tools\\git\\bin\\git.exe",
    boundRoot: `${HOME}\\src\\octant`,
    extraBoundRoots: [],
    writeBoundRoot: true,
    temporaryDirectory: `${HOME}\\AppData\\Local\\Temp\\octant-launch-1`,
    additionalWriteRoots: [],
    readRoots: [],
    network: "none",
    processCreation: "allowed",
    protectedEntries,
    ownAccountPaths: [],
    ...overrides,
  };
}

function planned(overrides: Partial<WindowsConfinementInput> = {}) {
  const decision = planWindowsConfinedLaunch(input(overrides));
  if (decision.status !== "planned") throw new Error(decision.message);
  return decision;
}

function refusal(overrides: Partial<WindowsConfinementInput>) {
  const decision = planWindowsConfinedLaunch(input(overrides));
  return decision.status === "refused" ? decision.refusal : undefined;
}

describe("Windows confined launch plan", () => {
  it("grants the checkout and temporary directory to a fresh AppContainer with no network", () => {
    const plan = planned();
    expect(plan.appContainerName).toBe(`Octant.Confined.${LAUNCH_ID}`);
    expect(plan.capabilities).toEqual([]);
    expect(plan.grants).toEqual([
      { path: `${HOME}\\src\\octant`, access: "modify" },
      { path: `${HOME}\\AppData\\Local\\Temp\\octant-launch-1`, access: "modify" },
      { path: "D:\\tools\\git\\bin", access: "read" },
    ]);
    expect(plan.workingDirectory).toBe(`${HOME}\\src\\octant`);
    expect(plan.activeProcessLimit).toBeUndefined();
  });

  it("grants a Plan launch's checkout read-only and lets it start no process", () => {
    const plan = planned({ writeBoundRoot: false, processCreation: "denied" });
    expect(plan.grants[0]).toEqual({ path: `${HOME}\\src\\octant`, access: "read" });
    expect(plan.activeProcessLimit).toBe(1);
  });

  it("refuses a read-only checkout beneath a folder the launch may write", () => {
    expect(
      refusal({
        writeBoundRoot: false,
        boundRoot: "D:\\tmp\\checkout",
        temporaryDirectory: "D:\\tmp",
      }),
    ).toBe("writable-above-read-only");
    expect(
      refusal({
        writeBoundRoot: false,
        extraBoundRoots: ["D:\\cache\\docs"],
        additionalWriteRoots: ["D:\\cache"],
      }),
    ).toBe("writable-above-read-only");
    // A write root inside a read-only checkout is its own explicit grant, as
    // the other platforms re-allow it, and a writable checkout has nothing to
    // keep read-only.
    expect(
      planned({
        writeBoundRoot: false,
        additionalWriteRoots: [`${HOME}\\src\\octant\\.octant-scratch`],
      }).grants,
    ).toContainEqual({ path: `${HOME}\\src\\octant\\.octant-scratch`, access: "modify" });
    expect(
      planned({ boundRoot: "D:\\tmp\\checkout", temporaryDirectory: "D:\\tmp" }).grants,
    ).toContainEqual({ path: "D:\\tmp\\checkout", access: "modify" });
  });

  it("keeps a folder's strongest grant once whatever its letter case", () => {
    const plan = planned({
      writeBoundRoot: false,
      readRoots: [`${HOME}\\SRC\\octant`],
      additionalWriteRoots: [`${HOME}\\src\\Octant`],
    });
    expect(plan.grants.filter((grant) => /octant$/iu.test(grant.path))).toEqual([
      { path: `${HOME}\\src\\octant`, access: "modify" },
    ]);
  });

  it("gives open network only the client capabilities and refuses the proxied form", () => {
    expect(planned({ network: "allow" }).capabilities).toEqual([
      "internetClient",
      "privateNetworkClientServer",
    ]);
    expect(refusal({ network: "proxied" })).toBe("proxied-network");
  });

  it("refuses a grant at, inside or above a protected location", () => {
    expect(refusal({ boundRoot: HOME })).toBe("covers-protected");
    expect(refusal({ readRoots: [`${HOME}\\.aws`] })).toBe("covers-protected");
    expect(refusal({ readRoots: [`${HOME}\\.aws\\credentials`] })).toBe("covers-protected");
    expect(refusal({ readRoots: [`${HOME}\\AppData\\Roaming\\Microsoft`] })).toBe(
      "covers-protected",
    );
    expect(refusal({ readRoots: [`${HOME}\\AppData\\Local`] })).toBe("covers-protected");
    expect(refusal({ readRoots: [DATA] })).toBe("covers-protected");
  });

  it("refuses a grant that is itself a protected store, or sits inside one", () => {
    const network = `${HOME}\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network`;
    expect(refusal({ readRoots: [`${network}\\Cookies`] })).toBe("covers-protected");
    expect(refusal({ readRoots: [`${network}\\Cookies-journal`] })).toBe("covers-protected");
    expect(refusal({ readRoots: [`${HOME}\\.ssh\\keys\\id_ed25519`] })).toBe("covers-protected");
    expect(refusal({ additionalWriteRoots: [`${HOME}\\.ssh\\id_work\\cache`] })).toBe(
      "covers-protected",
    );
    expect(refusal({ readRoots: [`${network}\\Reporting and NEL`] })).toBeUndefined();
  });

  it("matches protected locations whatever spelling or case the grant uses", () => {
    expect(refusal({ readRoots: ["c:/users/ada/.AWS"] })).toBe("covers-protected");
  });

  it("lets a runtime reach its own account home and no other account's", () => {
    const own = `${DATA}\\providers\\codex\\account-1`;
    expect(planned({ additionalWriteRoots: [own], ownAccountPaths: [own] }).grants).toContainEqual({
      path: own,
      access: "modify",
    });
    expect(refusal({ additionalWriteRoots: [own] })).toBe("covers-protected");
    expect(refusal({ additionalWriteRoots: [`${DATA}\\providers`], ownAccountPaths: [own] })).toBe(
      "covers-protected",
    );
  });

  it("asks for a pattern scan beneath a grant inside a browser-store folder", () => {
    const plan = planned({
      executable: `${HOME}\\AppData\\Roaming\\npm\\node_modules\\tool\\bin\\tool.exe`,
    });
    const scans = plan.patternScans.map((scan) => [scan.directory, scan.levels]);
    expect(scans).toContainEqual([`${HOME}\\AppData\\Roaming\\npm\\node_modules\\tool\\bin`, 2]);
    expect(scans).toContainEqual([`${HOME}\\AppData\\Local\\Temp\\octant-launch-1`, 4]);
  });

  it("refuses a path the guard cannot spell, a drive root and a non-exe program", () => {
    expect(refusal({ boundRoot: "\\\\server\\share\\repo" })).toBe("unspelled-path");
    expect(refusal({ boundRoot: "\\\\?\\C:\\repo" })).toBe("unspelled-path");
    expect(refusal({ boundRoot: "C:repo" })).toBe("unspelled-path");
    expect(refusal({ boundRoot: "C:\\repo\\..\\Users\\Ada" })).toBe("unspelled-path");
    expect(refusal({ readRoots: ["C:\\repo\\notes.txt::$DATA"] })).toBe("unspelled-path");
    expect(refusal({ readRoots: ["C:\\repo."] })).toBe("unspelled-path");
    expect(refusal({ readRoots: ["C:\\Users\\RUNNER~1\\.aws"] })).toBe("unspelled-path");
    expect(refusal({ temporaryDirectory: "/tmp/octant" })).toBe("unspelled-path");
    expect(refusal({ boundRoot: "D:\\" })).toBe("drive-root");
    expect(refusal({ executable: "D:\\tool.exe" })).toBe("drive-root");
    expect(refusal({ executable: "D:\\tools\\npm\\claude.cmd" })).toBe("not-an-executable");
    expect(refusal({ launchId: "not-hex" })).toBe("invalid-launch-id");
  });

  it("builds the launcher's arguments with the command after the separator", () => {
    const plan = planned({
      network: "allow",
      processCreation: "denied",
      writeBoundRoot: false,
    });
    expect(windowsConfinedLauncherArguments(plan, ["status", "--"])).toEqual([
      "--container",
      `Octant.Confined.${LAUNCH_ID}`,
      "--capability",
      "internetClient",
      "--capability",
      "privateNetworkClientServer",
      "--grant-read",
      `${HOME}\\src\\octant`,
      "--grant-modify",
      `${HOME}\\AppData\\Local\\Temp\\octant-launch-1`,
      "--grant-read",
      "D:\\tools\\git\\bin",
      "--active-process-limit",
      "1",
      "--cwd",
      `${HOME}\\src\\octant`,
      "--",
      "D:\\tools\\git\\bin\\git.exe",
      "status",
      "--",
    ]);
  });

  it("runs Full access as a job alone, with no container or grants", () => {
    expect(
      windowsFullAccessLauncherArguments({
        executable: "D:\\tools\\git.exe",
        workingDirectory: "d:/repo/",
        args: ["log"],
      }),
    ).toEqual(["--full-access", "--cwd", "D:\\repo", "--", "D:\\tools\\git.exe", "log"]);
    expect(
      windowsFullAccessLauncherArguments({
        executable: "git.exe",
        workingDirectory: "D:\\repo",
        args: [],
      }),
    ).toBeUndefined();
  });

  it("spells native paths with backslashes and an upper-case drive", () => {
    expect(windowsNativePath("c:/Users/Ada/src/")).toBe("C:\\Users\\Ada\\src");
    expect(windowsNativePath("C:\\")).toBe("C:");
    expect(windowsNativePath("C:\\a\\.\\b")).toBeUndefined();
  });
});

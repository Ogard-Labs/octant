import { describe, expect, it } from "vitest";
import {
  makeProcessConfinementLive,
  ProcessConfinementError,
  type ProcessConfinementPrepareInput,
} from "./seatbeltProfile";

const HOME = "C:\\Users\\Ada";
const LAUNCHER = "C:\\Program Files\\Octant\\resources\\native\\octant-windows-confine.exe";
const LAUNCH_ID = "fedcba9876543210fedcba9876543210";
const TOOL_BIN = `${HOME}\\AppData\\Roaming\\npm\\node_modules\\tool\\bin`;

const launch: ProcessConfinementPrepareInput = {
  executable: "D:\\tools\\git\\bin\\git.exe",
  args: ["status", "--short"],
  boundRoot: `${HOME}\\src\\octant`,
  temporaryDirectory: "D:\\octant-tmp\\launch-1",
  networkEgress: "none",
};

function windowsPort(
  folders: Readonly<Record<string, ReadonlyArray<{ name: string; directory: boolean }>>> = {},
) {
  return makeProcessConfinementLive({
    platform: "win32",
    unverifiedWindowsConfinement: {
      launcherPath: LAUNCHER,
      homeDirectory: HOME,
      launchId: LAUNCH_ID,
      readDirectory: (path) => folders[path] ?? [],
    },
  });
}

function refusalOf(prepare: () => unknown): string | undefined {
  try {
    prepare();
  } catch (error) {
    if (error instanceof ProcessConfinementError) return error.message;
    throw error;
  }
  return undefined;
}

describe("Windows confinement port", () => {
  it("keeps refusing every Windows launch unless the unverified launcher is named", () => {
    const port = makeProcessConfinementLive({ platform: "win32" });
    expect(refusalOf(() => port.prepare(launch))).toBe(
      "Confinement is supported only on macOS and Linux.",
    );
  });

  it("starts the command through the launcher with its container, grants and cwd", () => {
    const prepared = windowsPort().prepare(launch);
    expect(prepared.command).toBe(LAUNCHER);
    expect(prepared.args).toEqual([
      "--container",
      `Octant.Confined.${LAUNCH_ID}`,
      "--grant-modify",
      `${HOME}\\src\\octant`,
      "--grant-modify",
      "D:\\octant-tmp\\launch-1",
      "--grant-read",
      "D:\\tools\\git\\bin",
      "--cwd",
      `${HOME}\\src\\octant`,
      "--",
      "D:\\tools\\git\\bin\\git.exe",
      "status",
      "--short",
    ]);
  });

  it("denies a browser store found beneath a grant and nothing outside the grants", () => {
    const prepared = windowsPort({
      [TOOL_BIN]: [
        { name: "profile", directory: true },
        { name: "tool.exe", directory: false },
      ],
      [`${TOOL_BIN}\\profile`]: [{ name: "Cookies", directory: false }],
    }).prepare({
      ...launch,
      executable: `${TOOL_BIN}\\tool.exe`,
      isolatedRoots: [`${HOME}\\src\\octant\\.octant-private`, "E:\\elsewhere"],
    });
    const denies = prepared.args.flatMap((arg, index) =>
      arg === "--deny" ? [prepared.args[index + 1]] : [],
    );
    expect(denies).toEqual([
      `${TOOL_BIN}\\profile\\Cookies`,
      `${HOME}\\src\\octant\\.octant-private`,
    ]);
  });

  it("refuses a launch whose pattern scan cannot finish", () => {
    const crowded = Array.from({ length: 4_097 }, (_, index) => ({
      name: `f${String(index)}`,
      directory: false,
    }));
    const message = refusalOf(() =>
      windowsPort({ [TOOL_BIN]: crowded }).prepare({
        ...launch,
        executable: `${TOOL_BIN}\\tool.exe`,
      }),
    );
    expect(message).toMatch(/could not finish checking/u);
  });

  it("refuses what has no Windows form instead of running with less confinement", () => {
    const port = windowsPort();
    const proxied = {
      kind: "proxied",
      endpoint: { kind: "loopback", port: 9000 },
    } as const;
    expect(refusalOf(() => port.prepare({ ...launch, networkEgress: proxied }))).toMatch(
      /no proxied network/u,
    );
    expect(refusalOf(() => port.prepare({ ...launch, allowFileReadStar: true }))).toMatch(
      /read-everywhere/u,
    );
    expect(refusalOf(() => port.prepare({ ...launch, extraRules: ["(allow default)"] }))).toMatch(
      /Seatbelt rules/u,
    );
    expect(refusalOf(() => port.prepare({ ...launch, loopbackRelayPorts: [8080] }))).toMatch(
      /loopback relay/u,
    );
    expect(refusalOf(() => port.prepare({ ...launch, boundRoot: HOME }))).toMatch(
      /secret guard protects/u,
    );
  });

  it("refuses a launcher that is not the fixed Octant program", () => {
    const port = makeProcessConfinementLive({
      platform: "win32",
      unverifiedWindowsConfinement: { launcherPath: "C:\\Windows\\System32\\cmd.exe" },
    });
    expect(refusalOf(() => port.prepare(launch))).toMatch(/octant-windows-confine\.exe/u);
  });
});

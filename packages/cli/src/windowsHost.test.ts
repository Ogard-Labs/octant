import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import type { WindowsHostProfileNative } from "@octant/host-runtime";
import { runServerLifecycleCommand } from "./serverLifecycle";
import type { UserServiceManager, UserServiceStatus } from "./serviceManager";
import {
  createWindowsHostOwnerPort,
  windowsLogonEntryPolicy,
  openWindowsCliHost,
  windowsNativeHostOwnerPath,
} from "./windowsHost";

const profileId = "11111111-1111-4111-8111-111111111111";
const root = "C:\\Users\\fixture\\AppData\\Local\\Octant\\hosts\\octant";

function native(lookup: unknown = { status: "missing" }): WindowsHostProfileNative {
  return {
    apiVersion: 1,
    frameBytes: 16384,
    openProfile: () => ({
      status: "ready",
      profile: "octant",
      profileId,
      rootDirectory: root,
      dataDirectory: win32.join(root, "data"),
      configDirectory: win32.join(root, "config"),
      stateDirectory: win32.join(root, "state"),
      logsDirectory: win32.join(root, "logs"),
    }),
    prepare: () => ({ status: "refused" }),
    claim: () => ({ status: "refused" }),
    poll: () => ({ status: "idle" }),
    reply: () => ({ status: "refused" }),
    close: () => ({ status: "closed" }),
    lookup: () => lookup,
    beginRequest: () => ({ status: "refused" }),
    pollRequest: () => ({ status: "refused" }),
    closeRequest: () => ({ status: "closed" }),
  };
}

const paths = {
  platform: "win32",
  profile: "octant",
  profileId,
  rootDirectory: root,
  dataDirectory: win32.join(root, "data"),
  configDirectory: win32.join(root, "config"),
  stateDirectory: win32.join(root, "state"),
  logsDirectory: win32.join(root, "logs"),
} as const;

describe("the CLI's Windows host", () => {
  it("loads the same native binding as the server it starts, from source or a staged layout", () => {
    for (const app of ["C:\\Users\\Ada\\src", "C:\\Program Files\\Octant\\resources"]) {
      const checkout = app.endsWith("resources")
        ? win32.join(app, "app")
        : win32.join(app, "octant");
      const cli = windowsNativeHostOwnerPath(win32.join(checkout, "packages", "cli", "src"));
      const server = windowsNativeHostOwnerPath(win32.join(checkout, "apps", "server", "src"));
      expect(cli).toBe(server);
      expect(cli).toBe(win32.join(app, "native", "octant-windows-host-owner.node"));
    }
  });

  it("refuses data and log folder overrides instead of choosing another store", () => {
    for (const env of [{ OCTANT_DATA_DIR: "C:\\elsewhere" }, { OCTANT_LOGS_DIR: "C:\\logs" }]) {
      const opened = openWindowsCliHost({ env, native: native() });
      expect(opened).toMatchObject({ status: "refused" });
      expect(opened.status === "refused" && opened.message).toContain("not supported on Windows");
    }
  });

  it("refuses a native profile outside Octant's hosts folder", () => {
    const binding = native();
    const opened = openWindowsCliHost({
      env: {},
      native: {
        ...binding,
        openProfile: () => ({
          ...(binding.openProfile("octant") as Record<string, unknown>),
          rootDirectory: "C:\\Users\\fixture\\AppData\\Local\\Other\\octant",
        }),
      },
    });
    expect(opened).toMatchObject({ status: "refused" });
    expect(opened.status === "refused" && opened.message).toContain(
      "could not open its private Windows profile",
    );
  });

  it("refuses when the native binding is not installed beside the command", () => {
    // Off Windows the loader never admits a binding, as on a Windows install without one.
    expect(openWindowsCliHost({ env: {} })).toMatchObject({ status: "refused" });
  });

  it("observes no host when the native lookup proves the owner is gone", async () => {
    for (const status of ["missing", "dead"]) {
      const owner = createWindowsHostOwnerPort({ native: native({ status }), paths });
      await expect(owner.observe()).resolves.toEqual({ status: "absent" });
      await expect(owner.requestStop()).resolves.toBe(false);
    }
  });

  it("never treats an unreadable owner record as a host it may stop", async () => {
    const owner = createWindowsHostOwnerPort({ native: native({ status: "corrupt" }), paths });
    await expect(owner.observe()).resolves.toEqual({ status: "unanswered" });
  });
});

describe("automatic startup on Windows", () => {
  function logonEntry() {
    let installed = false;
    const status = async (): Promise<UserServiceStatus> => ({
      kind: "run-key",
      installed,
      enabled: installed,
      active: false,
      session: "active",
      lingering: "unknown",
    });
    const manager: UserServiceManager = {
      kind: "run-key",
      install: async () => void (installed = true),
      uninstall: async () => void (installed = false),
      start: async () => undefined,
      stop: async () => undefined,
      enable: async () => void (installed = true),
      disable: async () => void (installed = false),
      status,
      logs: async () => ({ entries: [], follow: false }),
    };
    return { manager, installed: () => installed };
  }
  const noOwner = { request: async () => undefined, proveNoOwner: async () => true };

  it("follows the logon entry, so disable and enable never need the owner's policy record", async () => {
    const entry = logonEntry();
    const run = (action: "status" | "enable" | "disable") =>
      runServerLifecycleCommand({
        action,
        serviceManager: entry.manager,
        policyStore: windowsLogonEntryPolicy(entry.manager),
        control: noOwner,
        sleep: async () => undefined,
      });

    await expect(run("status")).resolves.toMatchObject({ state: "disabled" });
    await expect(run("enable")).resolves.toMatchObject({ policy: { enabled: true } });
    expect(entry.installed()).toBe(true);
    await expect(run("disable")).resolves.toMatchObject({ state: "disabled" });
    expect(entry.installed()).toBe(false);
    await expect(run("status")).resolves.toMatchObject({ policy: { enabled: false } });
  });

  it("reports a start as enabled once it has written the logon entry", async () => {
    const entry = logonEntry();
    const report = await runServerLifecycleCommand({
      action: "start",
      serviceManager: entry.manager,
      policyStore: windowsLogonEntryPolicy(entry.manager),
      control: noOwner,
      sleep: async () => undefined,
    });
    expect(report.policy.enabled).toBe(true);
    expect(report.state).not.toBe("disabled");
  });
});

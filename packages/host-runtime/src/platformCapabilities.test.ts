import { describe, expect, it } from "vitest";
import {
  availablePlatformCapabilityNames,
  probeHostPlatformCapabilities,
  type HostPlatformCapabilityProbeRunner,
} from "./platformCapabilities";

function runnerFrom(
  handler: (command: string, args: readonly string[]) => string,
): HostPlatformCapabilityProbeRunner {
  return {
    run: async (command, args) => ({ stdout: handler(command, args), stderr: "" }),
  };
}

const commandUnavailable = () => {
  const error = new Error("spawn ENOENT") as Error & { code: string };
  error.code = "ENOENT";
  throw error;
};

describe("platform capability probes", () => {
  it("reports every Linux native tool available when probes succeed", async () => {
    const commands: string[] = [];
    const report = await probeHostPlatformCapabilities({
      platform: "linux",
      uid: 1000,
      runner: {
        run: async (command, args) => {
          commands.push(command);
          expect(args.every((argument) => typeof argument === "string")).toBe(true);
          return { stdout: "probe-ok\n", stderr: "" };
        },
      },
      executable: async () => true,
    });
    expect(report.platform).toBe("linux");
    expect(report.capabilities.map((capability) => capability.name).sort()).toEqual([
      "login-session",
      "process-inspection",
      "secret-store",
      "service-manager",
    ]);
    expect(report.capabilities.every((capability) => capability.state === "available")).toBe(true);
    expect(commands.every((command) => command.startsWith("/"))).toBe(true);
  });

  it("reports macOS native tools and omits Linux-only probes", async () => {
    const report = await probeHostPlatformCapabilities({
      platform: "darwin",
      uid: 501,
      runner: runnerFrom(() => "probe-ok\n"),
    });
    expect(report.platform).toBe("darwin");
    expect(report.capabilities.map((capability) => capability.name).sort()).toEqual([
      "process-inspection",
      "secret-store",
      "service-manager",
    ]);
    expect(report.capabilities.every((capability) => capability.state === "available")).toBe(true);
  });

  it("fails closed when a native tool is missing", async () => {
    const report = await probeHostPlatformCapabilities({
      platform: "linux",
      uid: 1000,
      runner: { run: commandUnavailable },
    });
    expect(report.capabilities.every((capability) => capability.state === "unavailable")).toBe(
      true,
    );
    expect(
      report.capabilities.every((capability) => capability.detail === "tool-unavailable"),
    ).toBe(true);
  });

  it("fails closed when the Secret Service client executable is missing", async () => {
    const report = await probeHostPlatformCapabilities({
      platform: "linux",
      uid: 1000,
      runner: runnerFrom(() => "probe-ok\n"),
      executable: async () => false,
    });
    const secretStore = report.capabilities.find(
      (capability) => capability.name === "secret-store",
    );
    expect(secretStore).toEqual({
      name: "secret-store",
      state: "unavailable",
      detail: "tool-unavailable",
    });
  });

  it("fails closed when a probe fails or reports empty output", async () => {
    const report = await probeHostPlatformCapabilities({
      platform: "linux",
      uid: 1000,
      runner: {
        run: async (command) => {
          if (command.includes("systemctl")) throw new Error("exit status 1");
          return { stdout: "", stderr: "" };
        },
      },
    });
    for (const capability of report.capabilities) {
      expect(capability.state).toBe("unavailable");
    }
    const serviceManager = report.capabilities.find(
      (capability) => capability.name === "service-manager",
    );
    expect(serviceManager?.detail).toBe("probe-failed");
  });

  it("fails closed for unsupported platforms", async () => {
    const report = await probeHostPlatformCapabilities({
      platform: "win32",
      uid: 0,
      runner: runnerFrom(() => "probe-ok\n"),
    });
    expect(report.capabilities.length).toBeGreaterThan(0);
    expect(report.capabilities.every((capability) => capability.state === "unavailable")).toBe(
      true,
    );
    expect(
      report.capabilities.every((capability) => capability.detail === "unsupported-platform"),
    ).toBe(true);
  });

  it("never throws when a probe throws synchronously", async () => {
    const report = await probeHostPlatformCapabilities({
      platform: "darwin",
      uid: 501,
      runner: {
        run: () => {
          throw new Error("synchronous failure");
        },
      },
    });
    expect(report.capabilities.every((capability) => capability.state === "unavailable")).toBe(
      true,
    );
  });

  it("lists only available capabilities for diagnostics projection", async () => {
    const report = await probeHostPlatformCapabilities({
      platform: "linux",
      uid: 1000,
      runner: {
        run: async (command) => {
          if (command.includes("loginctl")) throw new Error("no session");
          return { stdout: "probe-ok\n", stderr: "" };
        },
      },
      executable: async () => true,
    });
    expect(availablePlatformCapabilityNames(report)).toEqual([
      "process-inspection",
      "secret-store",
      "service-manager",
    ]);
  });

  it("probes the real host with the default runner without throwing", async () => {
    const report = await probeHostPlatformCapabilities({
      platform: process.platform,
      uid: process.getuid?.() ?? 0,
    });
    for (const capability of report.capabilities) {
      expect(["available", "unavailable"]).toContain(capability.state);
    }
  });
});

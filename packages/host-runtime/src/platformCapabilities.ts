import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isExecutable } from "./executableCheck";

const execFileAsync = promisify(execFile);

// Honest platform capability probing for native host tools. Every probe runs a
// fixed absolute command with an argument array (never a shell), and every
// failure mode — missing tool, non-zero exit, timeout, empty output — resolves
// to a typed `unavailable` state. A capability is reported available only when
// its probe demonstrably succeeded.

export type HostPlatformCapabilityName =
  | "process-inspection"
  | "service-manager"
  | "login-session"
  | "secret-store";

export type HostPlatformCapabilityState = "available" | "unavailable";

export type HostPlatformCapabilityDetail =
  | "probe-succeeded"
  | "tool-unavailable"
  | "probe-failed"
  | "empty-probe-output"
  | "unsupported-platform";

export interface HostPlatformCapability {
  readonly name: HostPlatformCapabilityName;
  readonly state: HostPlatformCapabilityState;
  readonly detail: HostPlatformCapabilityDetail;
}

export interface HostPlatformCapabilityReport {
  readonly platform: string;
  readonly capabilities: ReadonlyArray<HostPlatformCapability>;
}

export interface HostPlatformCapabilityProbeRunner {
  run(
    command: string,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export interface ProbeHostPlatformCapabilitiesOptions {
  readonly platform: string;
  readonly uid: number;
  readonly runner?: HostPlatformCapabilityProbeRunner;
  readonly executable?: (path: string) => Promise<boolean>;
}

interface CapabilityProbe {
  readonly name: HostPlatformCapabilityName;
  readonly command: string;
  readonly args: readonly string[];
  readonly additionalExecutablePaths?: readonly string[];
}

const ALL_CAPABILITIES: ReadonlyArray<HostPlatformCapabilityName> = [
  "process-inspection",
  "service-manager",
  "login-session",
  "secret-store",
];

function probesFor(platform: "darwin" | "linux", uid: number): ReadonlyArray<CapabilityProbe> {
  const pid = String(process.pid);
  if (platform === "darwin") {
    return [
      { name: "process-inspection", command: "/bin/ps", args: ["-o", "lstart=", "-p", pid] },
      { name: "service-manager", command: "/bin/launchctl", args: ["managername"] },
      { name: "secret-store", command: "/usr/bin/security", args: ["list-keychains"] },
    ];
  }
  return [
    { name: "process-inspection", command: "/bin/ps", args: ["-o", "lstart=", "-p", pid] },
    {
      name: "service-manager",
      command: "/usr/bin/systemctl",
      args: ["--user", "--no-ask-password", "show-environment"],
    },
    {
      name: "login-session",
      command: "/usr/bin/loginctl",
      args: ["show-user", String(uid), "--property=Linger", "--value"],
    },
    {
      name: "secret-store",
      command: "/usr/bin/busctl",
      args: ["--user", "--no-pager", "status", "org.freedesktop.secrets"],
      additionalExecutablePaths: ["/usr/bin/secret-tool"],
    },
  ];
}

export async function probeHostPlatformCapabilities(
  options: ProbeHostPlatformCapabilitiesOptions,
): Promise<HostPlatformCapabilityReport> {
  if (options.platform !== "darwin" && options.platform !== "linux") {
    return {
      platform: options.platform,
      capabilities: ALL_CAPABILITIES.map((name) => ({
        name,
        state: "unavailable" as const,
        detail: "unsupported-platform" as const,
      })),
    };
  }
  const runner = options.runner ?? defaultProbeRunner;
  const executable = options.executable ?? isExecutable;
  const capabilities = await Promise.all(
    probesFor(options.platform, options.uid).map((probe) => runProbe(runner, probe, executable)),
  );
  return { platform: options.platform, capabilities };
}

export function availablePlatformCapabilityNames(
  report: HostPlatformCapabilityReport,
): ReadonlyArray<HostPlatformCapabilityName> {
  return report.capabilities
    .filter((capability) => capability.state === "available")
    .map((capability) => capability.name)
    .sort();
}

async function runProbe(
  runner: HostPlatformCapabilityProbeRunner,
  probe: CapabilityProbe,
  executable: (path: string) => Promise<boolean>,
): Promise<HostPlatformCapability> {
  try {
    const result = await runner.run(probe.command, probe.args);
    if (result.stdout.trim() === "") {
      return { name: probe.name, state: "unavailable", detail: "empty-probe-output" };
    }
    for (const path of probe.additionalExecutablePaths ?? []) {
      if (!(await executable(path))) {
        return { name: probe.name, state: "unavailable", detail: "tool-unavailable" };
      }
    }
    return { name: probe.name, state: "available", detail: "probe-succeeded" };
  } catch (error) {
    return {
      name: probe.name,
      state: "unavailable",
      detail: isCommandUnavailable(error) ? "tool-unavailable" : "probe-failed",
    };
  }
}

const defaultProbeRunner: HostPlatformCapabilityProbeRunner = {
  run: async (command, args) =>
    execFileAsync(command, [...args], {
      shell: false,
      timeout: 2_000,
      maxBuffer: 16 * 1_024,
      env: { ...process.env, LC_ALL: "C" },
    }),
};

function isCommandUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { readonly code?: unknown }).code === "ENOENT" ||
      (error as { readonly code?: unknown }).code === "ENOTSUP")
  );
}

import { probeHostHealth } from "./hostLauncher";
import { probeHostPlatformCapabilities } from "@octant/host-runtime";

export interface StatusCommandOptions {
  readonly hostname?: string | undefined;
  readonly port?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly stdout?: { write: (chunk: string) => unknown };
}

export interface StatusReport {
  readonly status: "ready" | "disabled" | "unreachable";
  readonly url: URL;
  readonly instanceId?: string;
  readonly version?: string;
  readonly secretStore?: "available" | "unavailable";
}

export async function runStatusCommand(options: StatusCommandOptions = {}): Promise<StatusReport> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 13_773;
  const url = new URL(`http://${formatUrlHostname(hostname)}:${port}`);
  const fetch = options.fetch ?? globalThis.fetch;
  const stdout = options.stdout ?? process.stdout;

  const isLocalTarget =
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]";
  const [health, capabilities] = await Promise.all([
    probeHostHealth({ url, fetch }),
    isLocalTarget
      ? probeHostPlatformCapabilities({
          platform: process.platform,
          uid: process.getuid?.() ?? 0,
        })
      : Promise.resolve(undefined),
  ]);
  const secretStore = capabilities?.capabilities.find(
    (capability) => capability.name === "secret-store",
  );
  const report: StatusReport = {
    status: health.status === "timeout" ? "unreachable" : health.status,
    url,
    ...(health.instanceId === undefined ? {} : { instanceId: health.instanceId }),
    ...(health.version === undefined ? {} : { version: health.version }),
    ...(isLocalTarget
      ? { secretStore: secretStore?.state === "available" ? "available" : "unavailable" }
      : {}),
  };
  stdout.write(formatStatusReport(report));
  return report;
}

export function formatStatusReport(report: StatusReport): string {
  const lines = [
    `Octant host status: ${report.status}`,
    `Endpoint: ${report.url.toString()}`,
    ...(report.instanceId === undefined ? [] : [`Instance: ${report.instanceId}`]),
    ...(report.version === undefined ? [] : [`Version: ${report.version}`]),
    ...(report.secretStore === undefined ? [] : [`Secret store: ${report.secretStore}`]),
  ];
  if (report.status === "unreachable") {
    lines.push(
      "No healthy Octant host is reachable. Start one with the Octant desktop application or `octant web`.",
    );
  } else if (report.status === "disabled") {
    lines.push(
      "Octant host storage is not ready. Restart the Octant desktop application or `octant server` and retry.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** An IPv6 host is only a valid URL authority in brackets. */
function formatUrlHostname(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

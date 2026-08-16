import { probeHostHealth } from "./hostLauncher";

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
}

export async function runStatusCommand(options: StatusCommandOptions = {}): Promise<StatusReport> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 13_773;
  const url = new URL(`http://${hostname}:${port}`);
  const fetch = options.fetch ?? globalThis.fetch;
  const stdout = options.stdout ?? process.stdout;

  const health = await probeHostHealth({ url, fetch });
  const report: StatusReport = {
    status: health.status === "timeout" ? "unreachable" : health.status,
    url,
    ...(health.instanceId === undefined ? {} : { instanceId: health.instanceId }),
    ...(health.version === undefined ? {} : { version: health.version }),
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

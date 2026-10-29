// The local Tailscale command-line tool as the certificate daemon. The host
// asks the tool for the machine's tailnet name (`tailscale status --json`) and
// for a certificate (`tailscale cert`), and reads back the two files the tool
// wrote. The tool runs through an exec seam so tests never start it. The files
// live in an owner-only folder (`0700`, files `0600`); the PEM text goes to the
// caller and is never logged or returned by a route.

import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TailscaleDaemonPort } from "./tailscaleCertificate";

export interface TailscaleExecResult {
  /** Null when the tool could not be started at all (not installed, not executable). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one program with arguments, without a shell; never throws. */
export type TailscaleExec = (
  file: string,
  args: ReadonlyArray<string>,
) => Promise<TailscaleExecResult>;

const MAC_APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const CERTIFICATE_FILE = "tailscale.crt";
const KEY_FILE = "tailscale.key";
const SUBDIR = "hub";
const CERTIFICATE_SUBDIR = "tailscale-certificate";

/** `tailscale` on the path, or on macOS the binary inside the app when the command is not installed. */
export function tailscaleBinaryCandidates(platform: NodeJS.Platform): ReadonlyArray<string> {
  return platform === "darwin" ? ["tailscale", MAC_APP_BINARY] : ["tailscale"];
}

export interface TailscaleCliDaemonOptions {
  readonly dataDirectory: string;
  readonly exec: TailscaleExec;
  readonly platform: NodeJS.Platform;
}

function selfDnsName(statusJson: string): { name?: string; certDomains: ReadonlyArray<string> } {
  try {
    const parsed: unknown = JSON.parse(statusJson);
    if (typeof parsed !== "object" || parsed === null) return { certDomains: [] };
    const self = "Self" in parsed ? parsed.Self : undefined;
    const dns =
      typeof self === "object" && self !== null && "DNSName" in self ? self.DNSName : undefined;
    const domains = "CertDomains" in parsed ? parsed.CertDomains : undefined;
    return {
      ...(typeof dns === "string" && dns.length > 0 ? { name: dns.replace(/\.$/, "") } : {}),
      certDomains: Array.isArray(domains)
        ? domains.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return { certDomains: [] };
  }
}

export function createTailscaleCliDaemon(options: TailscaleCliDaemonOptions): TailscaleDaemonPort {
  const directory = join(options.dataDirectory, SUBDIR, CERTIFICATE_SUBDIR);

  /** Tries each candidate until one starts; a tool that starts and exits non-zero is an answer. */
  const run = async (args: ReadonlyArray<string>): Promise<TailscaleExecResult> => {
    let last: TailscaleExecResult = { exitCode: null, stdout: "", stderr: "" };
    for (const file of tailscaleBinaryCandidates(options.platform)) {
      last = await options.exec(file, args);
      if (last.exitCode !== null) return last;
    }
    return last;
  };

  return {
    certificateFor: async (domain) => {
      const status = await run(["status", "--json"]);
      if (status.exitCode !== 0) return { status: "unavailable", kind: "daemon-not-reachable" };
      const self = selfDnsName(status.stdout);
      if (self.name === undefined) return { status: "unavailable", kind: "daemon-not-reachable" };
      // HTTPS certificates are off on the tailnet when the daemon lists no domain for them.
      if (self.certDomains.length === 0)
        return { status: "unavailable", kind: "https-not-enabled" };
      if (
        self.name.toLowerCase() !== domain.toLowerCase() ||
        !self.certDomains.some((entry) => entry.toLowerCase() === domain.toLowerCase())
      ) {
        return { status: "unavailable", kind: "name-not-served" };
      }

      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const certificatePath = join(directory, CERTIFICATE_FILE);
      const keyPath = join(directory, KEY_FILE);
      const issued = await run([
        "cert",
        "--cert-file",
        certificatePath,
        "--key-file",
        keyPath,
        domain,
      ]);
      if (issued.exitCode !== 0) {
        return {
          status: "unavailable",
          kind: /https/i.test(issued.stderr) ? "https-not-enabled" : "daemon-not-reachable",
        };
      }
      if (!existsSync(certificatePath) || !existsSync(keyPath)) {
        return { status: "unavailable", kind: "daemon-not-reachable" };
      }
      chmodSync(certificatePath, 0o600);
      chmodSync(keyPath, 0o600);
      const certificatePem = readFileSync(certificatePath, "utf8");
      let notAfter: number;
      try {
        notAfter = new Date(new X509Certificate(certificatePem).validTo).getTime();
      } catch {
        return { status: "unavailable", kind: "daemon-not-reachable" };
      }
      if (!Number.isFinite(notAfter)) {
        return { status: "unavailable", kind: "daemon-not-reachable" };
      }
      return {
        status: "issued",
        certificatePem,
        privateKeyPem: readFileSync(keyPath, "utf8"),
        notAfter,
      };
    },
  };
}

/** The real exec seam: a program that cannot start answers with a null exit code. */
export const execTailscale: TailscaleExec = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: 60_000, maxBuffer: 1_000_000, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code: unknown = error === null ? 0 : (error as { code?: unknown }).code;
        resolve({ exitCode: typeof code === "number" ? code : null, stdout, stderr });
      },
    );
  });

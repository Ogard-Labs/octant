import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfMadeListenerCertificateStore } from "../remote/selfMadeListenerCertificate";
import {
  createTailscaleCliDaemon,
  tailscaleBinaryCandidates,
  type TailscaleExec,
  type TailscaleExecResult,
} from "./tailscaleCliDaemon";

const DOMAIN = "mini.tail1234.ts.net";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A real certificate made by the host's own certificate maker, so no fixture holds key material. */
function certificate(): { readonly pem: string; readonly key: string } {
  const directory = mkdtempSync(join(tmpdir(), "octant-ts-daemon-cert-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const made = createSelfMadeListenerCertificateStore({ dataDirectory: directory }).ensure(DOMAIN);
  if (made.status !== "ready") throw new Error("test certificate was not made");
  return { pem: String(made.tls.cert), key: String(made.tls.key) };
}

function statusJson(input: {
  readonly name?: string;
  readonly certDomains?: ReadonlyArray<string>;
}) {
  return JSON.stringify({
    Self: input.name === undefined ? {} : { DNSName: `${input.name}.` },
    CertDomains: input.certDomains ?? [],
  });
}

function setup(input: {
  readonly status: TailscaleExecResult;
  readonly cert?: TailscaleExecResult;
  readonly platform?: NodeJS.Platform;
  readonly issued?: { readonly pem: string; readonly key: string };
}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "octant-ts-daemon-"));
  cleanups.push(() => rmSync(dataDirectory, { recursive: true, force: true }));
  const calls: Array<{ readonly file: string; readonly args: ReadonlyArray<string> }> = [];
  const exec: TailscaleExec = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === "status") return input.status;
    const certIndex = args.indexOf("--cert-file");
    const keyIndex = args.indexOf("--key-file");
    const certPath = args[certIndex + 1];
    const keyPath = args[keyIndex + 1];
    if (input.issued !== undefined && certPath !== undefined && keyPath !== undefined) {
      writeFileSync(certPath, input.issued.pem, { mode: 0o644 });
      writeFileSync(keyPath, input.issued.key, { mode: 0o644 });
    }
    return input.cert ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  return {
    calls,
    dataDirectory,
    daemon: createTailscaleCliDaemon({
      dataDirectory,
      exec,
      platform: input.platform ?? "linux",
    }),
  };
}

const ok = (stdout: string): TailscaleExecResult => ({ exitCode: 0, stdout, stderr: "" });

describe("the Tailscale command-line daemon client", () => {
  it("refuses when the tool cannot be started or the machine is not on a tailnet", async () => {
    const missing = setup({ status: { exitCode: null, stdout: "", stderr: "" } });
    expect(await missing.daemon.certificateFor(DOMAIN)).toEqual({
      status: "unavailable",
      kind: "daemon-not-reachable",
    });
    expect(missing.calls.every((call) => call.args[0] === "status")).toBe(true);

    const offline = setup({ status: ok(statusJson({})) });
    expect(await offline.daemon.certificateFor(DOMAIN)).toEqual({
      status: "unavailable",
      kind: "daemon-not-reachable",
    });
  });

  it("refuses without asking for a certificate when HTTPS is off on the tailnet", async () => {
    const { daemon, calls } = setup({ status: ok(statusJson({ name: DOMAIN })) });

    expect(await daemon.certificateFor(DOMAIN)).toEqual({
      status: "unavailable",
      kind: "https-not-enabled",
    });
    expect(calls.map((call) => call.args[0])).toEqual(["status"]);
  });

  it("refuses a name the machine does not serve", async () => {
    const { daemon, calls } = setup({
      status: ok(statusJson({ name: DOMAIN, certDomains: [DOMAIN] })),
    });

    expect(await daemon.certificateFor("other.tail1234.ts.net")).toEqual({
      status: "unavailable",
      kind: "name-not-served",
    });
    expect(calls.map((call) => call.args[0])).toEqual(["status"]);
  });

  it("takes the machine's name from the status output and writes the files owner-only", async () => {
    const issued = certificate();
    const { daemon, calls, dataDirectory } = setup({
      status: ok(statusJson({ name: DOMAIN, certDomains: [DOMAIN] })),
      issued,
    });

    const reading = await daemon.certificateFor(DOMAIN);

    expect(reading.status).toBe("issued");
    expect(reading.status === "issued" && reading.notAfter > Date.now()).toBe(true);
    const cert = calls.find((call) => call.args[0] === "cert");
    expect(cert?.args.at(-1)).toBe(DOMAIN);
    const folder = join(dataDirectory, "hub", "tailscale-certificate");
    expect(cert?.args).toEqual([
      "cert",
      "--cert-file",
      join(folder, "tailscale.crt"),
      "--key-file",
      join(folder, "tailscale.key"),
      DOMAIN,
    ]);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "tailscale.crt")).mode & 0o777).toBe(0o600);
    expect(statSync(join(folder, "tailscale.key")).mode & 0o777).toBe(0o600);
  });

  it("reports HTTPS as off when the tool says certificates are not enabled", async () => {
    const { daemon } = setup({
      status: ok(statusJson({ name: DOMAIN, certDomains: [DOMAIN] })),
      cert: { exitCode: 1, stdout: "", stderr: "HTTPS is not enabled for this tailnet" },
    });

    expect(await daemon.certificateFor(DOMAIN)).toEqual({
      status: "unavailable",
      kind: "https-not-enabled",
    });
  });

  it("falls back to the binary inside the macOS app when the command is not installed", async () => {
    expect(tailscaleBinaryCandidates("darwin")).toEqual([
      "tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]);
    expect(tailscaleBinaryCandidates("linux")).toEqual(["tailscale"]);

    const dataDirectory = mkdtempSync(join(tmpdir(), "octant-ts-daemon-"));
    cleanups.push(() => rmSync(dataDirectory, { recursive: true, force: true }));
    const files: Array<string> = [];
    const daemon = createTailscaleCliDaemon({
      dataDirectory,
      platform: "darwin",
      exec: async (file) => {
        files.push(file);
        return file === "tailscale"
          ? { exitCode: null, stdout: "", stderr: "" }
          : ok(statusJson({ name: DOMAIN }));
      },
    });

    expect(await daemon.certificateFor(DOMAIN)).toEqual({
      status: "unavailable",
      kind: "https-not-enabled",
    });
    expect(files).toEqual(["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  });
});

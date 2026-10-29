// The `*.ts.net` certificate a browser needs to trust the hub's web app. The
// host asks the local Tailscale daemon for it, keeps it renewed, and does so
// only after the person turned it on having read the certificate-transparency
// note: Tailscale gets the certificate from a public authority, so the
// machine's tailnet name appears in public logs. Off by default.
//
// The daemon and the place the listener reads a certificate from are seams.
// What this file owns is the policy: off until acknowledged, a tailnet name
// only, and renewal before expiry. Key material passes through to the sink and
// is never kept in the state file, returned, or logged.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tailscaleCertificateRenewal } from "@octant/domain";
import { Schema } from "effect";
import type { PrivateListenerHostStatus } from "../remote/privateListenerLifecycleController";

/** What the local daemon hands back; the PEM bodies go to the sink and nowhere else. */
export type TailscaleCertificateReading =
  | {
      readonly status: "issued";
      readonly certificatePem: string;
      readonly privateKeyPem: string;
      /** Epoch milliseconds the certificate stops being valid. */
      readonly notAfter: number;
    }
  | {
      readonly status: "unavailable";
      readonly kind: "daemon-not-reachable" | "https-not-enabled" | "name-not-served";
    };

export interface TailscaleDaemonPort {
  readonly certificateFor: (domain: string) => Promise<TailscaleCertificateReading>;
}

/** Where the listener reads the certificate it serves the web app with. */
export interface TailscaleCertificateSink {
  readonly install: (input: {
    readonly domain: string;
    readonly certificatePem: string;
    readonly privateKeyPem: string;
  }) => Promise<{ readonly status: "installed" } | { readonly status: "unsupported" }>;
}

/**
 * The daemon's certificate interface differs by platform (a unix socket on
 * Linux, a local port with a token on macOS) and is not yet confirmed against
 * a running daemon, so the host ships no daemon client: it reports the daemon
 * as unreachable rather than guess at a protocol.
 */
export const unwiredTailscaleDaemon: TailscaleDaemonPort = {
  certificateFor: async () => ({ status: "unavailable", kind: "daemon-not-reachable" }),
};

/** The listener reads no certificate from here yet, so an installation is reported unsupported. */
export const unwiredCertificateSink: TailscaleCertificateSink = {
  install: async () => ({ status: "unsupported" }),
};

const SUBDIR = "hub";
const FILE = "tailscale-certificate.json";
const strict = { parseOptions: { onExcessProperty: "error" as const } };

const CertificateSetting = Schema.Struct({
  enabled: Schema.Boolean,
  acknowledgedAt: Schema.optional(Schema.Number),
  /** When the certificate last installed stops being valid. The certificate itself is not kept here. */
  notAfter: Schema.optional(Schema.Number),
}).annotations(strict);
type CertificateSetting = typeof CertificateSetting.Type;
const decodeSetting = Schema.decodeUnknownSync(CertificateSetting);

export interface TailscaleCertificateSettingPort {
  readonly load: () => CertificateSetting;
  readonly save: (setting: CertificateSetting) => void;
}

export function createTailscaleCertificateSetting(
  dataDirectory: string,
): TailscaleCertificateSettingPort {
  const directory = join(dataDirectory, SUBDIR);
  const path = join(directory, FILE);
  return {
    load: () => {
      try {
        return decodeSetting(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return { enabled: false };
      }
    },
    save: (setting) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const staging = `${path}.${process.pid}.tmp`;
      writeFileSync(staging, JSON.stringify(Schema.encodeSync(CertificateSetting)(setting)), {
        mode: 0o600,
      });
      chmodSync(staging, 0o600);
      renameSync(staging, path);
    },
  };
}

export type TailscaleCertificateRefusal =
  | "acknowledgement-required"
  | "listener-not-running"
  | "not-a-tailnet-name"
  | "turned-off"
  | "daemon-not-reachable"
  | "https-not-enabled"
  | "name-not-served"
  | "nowhere-to-install";

export type TailscaleCertificateStatus = {
  readonly enabled: boolean;
  readonly domain?: string;
  readonly notAfter?: number;
  readonly renewal?: "current" | "due" | "expired";
};

export type TailscaleCertificateOutcome =
  | { readonly status: "enabled" | "disabled" }
  | { readonly status: "current"; readonly notAfter: number }
  | { readonly status: "renewed"; readonly notAfter: number }
  | { readonly status: "refused"; readonly kind: TailscaleCertificateRefusal };

export interface TailscaleCertificateOptions {
  readonly setting: TailscaleCertificateSettingPort;
  readonly daemon: TailscaleDaemonPort;
  readonly sink: TailscaleCertificateSink;
  readonly listener: () => PrivateListenerHostStatus;
  readonly now: () => number;
}

/** A tailnet machine name: the only kind of name Tailscale issues a certificate for. */
const isTailnetName = (hostname: string): boolean =>
  /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(hostname);

export class TailscaleCertificateService {
  readonly #options: TailscaleCertificateOptions;

  constructor(options: TailscaleCertificateOptions) {
    this.#options = options;
  }

  status(): TailscaleCertificateStatus {
    const setting = this.#options.setting.load();
    const hostname = this.#options.listener().hostname;
    const domain = hostname !== null && isTailnetName(hostname) ? hostname : undefined;
    return {
      enabled: setting.enabled,
      ...(domain === undefined ? {} : { domain }),
      ...(setting.notAfter === undefined
        ? {}
        : {
            notAfter: setting.notAfter,
            renewal: tailscaleCertificateRenewal({
              notAfter: setting.notAfter,
              now: this.#options.now(),
            }).status,
          }),
    };
  }

  /**
   * Turns the certificate on. The request must say the person read the
   * certificate-transparency note; without it nothing is asked of the daemon.
   */
  enable(input: {
    readonly acknowledgedCertificateTransparency: boolean;
  }): TailscaleCertificateOutcome {
    if (!input.acknowledgedCertificateTransparency) {
      return { status: "refused", kind: "acknowledgement-required" };
    }
    const named = this.#tailnetName();
    if (named.status === "refused") return named;
    this.#options.setting.save({ enabled: true, acknowledgedAt: this.#options.now() });
    return { status: "enabled" };
  }

  disable(): TailscaleCertificateOutcome {
    this.#options.setting.save({ enabled: false });
    return { status: "disabled" };
  }

  /**
   * Asks the daemon for a certificate when none is held, one is due for
   * renewal, or the last one expired; otherwise leaves it. A refusal keeps the
   * certificate the listener already serves.
   */
  async renewIfDue(): Promise<TailscaleCertificateOutcome> {
    const setting = this.#options.setting.load();
    if (!setting.enabled) return { status: "refused", kind: "turned-off" };
    const named = this.#tailnetName();
    if (named.status === "refused") return named;
    if (setting.notAfter !== undefined) {
      const renewal = tailscaleCertificateRenewal({
        notAfter: setting.notAfter,
        now: this.#options.now(),
      });
      if (renewal.status === "current") return { status: "current", notAfter: setting.notAfter };
    }
    const reading = await this.#options.daemon.certificateFor(named.domain);
    if (reading.status === "unavailable") return { status: "refused", kind: reading.kind };
    const installed = await this.#options.sink.install({
      domain: named.domain,
      certificatePem: reading.certificatePem,
      privateKeyPem: reading.privateKeyPem,
    });
    if (installed.status === "unsupported")
      return { status: "refused", kind: "nowhere-to-install" };
    this.#options.setting.save({ ...setting, notAfter: reading.notAfter });
    return { status: "renewed", notAfter: reading.notAfter };
  }

  #tailnetName():
    | { readonly status: "named"; readonly domain: string }
    | { readonly status: "refused"; readonly kind: "listener-not-running" | "not-a-tailnet-name" } {
    const hostname = this.#options.listener().hostname;
    if (hostname === null) return { status: "refused", kind: "listener-not-running" };
    return isTailnetName(hostname)
      ? { status: "named", domain: hostname }
      : { status: "refused", kind: "not-a-tailnet-name" };
  }
}

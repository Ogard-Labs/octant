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
import type {
  PrivateListenerHostStatus,
  PrivateListenerLifecycleController,
} from "../remote/privateListenerLifecycleController";

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

/** Where the listener reads the certificate it serves browsers with. */
export interface TailscaleCertificateSink {
  readonly install: (input: {
    readonly domain: string;
    readonly certificatePem: string;
    readonly privateKeyPem: string;
  }) => Promise<
    | { readonly status: "installed" }
    | { readonly status: "refused"; readonly kind: "invalid-certificate" | "could-not-apply" }
  >;
  /** Goes back to the one certificate the listener made. */
  readonly remove: () => Promise<void>;
  /** Whether a certificate is being served now; the host forgets it when it restarts. */
  readonly holdsCertificate: () => boolean;
}

/**
 * The listener keeps serving the certificate whose key the roster pins, and
 * serves this one only to a client that asks for the machine's tailnet name:
 * one port and one listener, and the phone and desktop apps that pin the
 * self-made certificate are unaffected.
 */
export function createListenerCertificateSink(
  listener: Pick<
    PrivateListenerLifecycleController,
    "setTailnetCertificate" | "tailnetCertificateName"
  >,
): TailscaleCertificateSink {
  return {
    install: async (input) => {
      const applied = await listener.setTailnetCertificate({
        cert: input.certificatePem,
        key: input.privateKeyPem,
        serverName: input.domain.toLowerCase(),
      });
      return applied.status === "applied"
        ? { status: "installed" }
        : { status: "refused", kind: applied.kind };
    },
    remove: async () => {
      await listener.setTailnetCertificate(undefined);
    },
    holdsCertificate: () => listener.tailnetCertificateName() !== undefined,
  };
}

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
  | "invalid-certificate"
  | "could-not-apply";

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
  /** Counts the times the person turned the certificate off, so a renewal in flight can tell. */
  #turnedOff = 0;

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

  async disable(): Promise<TailscaleCertificateOutcome> {
    this.#turnedOff += 1;
    this.#options.setting.save({ enabled: false });
    await this.#options.sink.remove();
    return { status: "disabled" };
  }

  /**
   * Asks the daemon for a certificate when the listener serves none (the host
   * keeps it in memory only), one is due for renewal, or the last one expired;
   * otherwise leaves it. A refusal keeps the certificate the listener already
   * serves.
   */
  async renewIfDue(): Promise<TailscaleCertificateOutcome> {
    const setting = this.#options.setting.load();
    if (!setting.enabled) return { status: "refused", kind: "turned-off" };
    const named = this.#tailnetName();
    if (named.status === "refused") return named;
    if (setting.notAfter !== undefined && this.#options.sink.holdsCertificate()) {
      const renewal = tailscaleCertificateRenewal({
        notAfter: setting.notAfter,
        now: this.#options.now(),
      });
      if (renewal.status === "current") return { status: "current", notAfter: setting.notAfter };
    }
    const turnedOffAt = this.#turnedOff;
    const reading = await this.#options.daemon.certificateFor(named.domain);
    if (reading.status === "unavailable") return { status: "refused", kind: reading.kind };
    // The person may turn the certificate off while the daemon or the listener
    // is still answering; a late renewal must not bring it back.
    if (this.#turnedOff !== turnedOffAt) return { status: "refused", kind: "turned-off" };
    const installed = await this.#options.sink.install({
      domain: named.domain,
      certificatePem: reading.certificatePem,
      privateKeyPem: reading.privateKeyPem,
    });
    if (this.#turnedOff !== turnedOffAt) {
      await this.#options.sink.remove();
      return { status: "refused", kind: "turned-off" };
    }
    if (installed.status === "refused") return { status: "refused", kind: installed.kind };
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

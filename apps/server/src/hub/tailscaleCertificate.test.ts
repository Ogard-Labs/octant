import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrivateListenerHostStatus } from "../remote/privateListenerLifecycleController";
import {
  TailscaleCertificateService,
  createTailscaleCertificateSetting,
  type TailscaleCertificateReading,
  type TailscaleCertificateSink,
  type TailscaleDaemonPort,
} from "./tailscaleCertificate";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 9, 29);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function listener(hostname: string | null): PrivateListenerHostStatus {
  return {
    enabled: hostname !== null,
    state: hostname === null ? "disabled" : "ready",
    hostname,
    port: 8443,
    origin: hostname === null ? null : `https://${hostname}:8443`,
    exposureClass: "tailscale",
    certificateFingerprint: null,
    certificateReady: hostname !== null,
    certificateSource: "self-made",
    tlsPin: null,
  };
}

function setup(input: {
  readonly hostname?: string | null;
  readonly reading?: TailscaleCertificateReading;
  readonly installs?: "installed" | "invalid-certificate" | "could-not-apply";
}) {
  const directory = mkdtempSync(join(tmpdir(), "octant-ts-cert-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  let now = NOW;
  const certificateFor = vi.fn<TailscaleDaemonPort["certificateFor"]>(
    async () =>
      input.reading ?? {
        status: "issued",
        certificatePem: "CERTIFICATE-BODY",
        privateKeyPem: "PRIVATE-KEY-BODY",
        notAfter: NOW + 90 * DAY,
      },
  );
  let held = false;
  const install = vi.fn<TailscaleCertificateSink["install"]>(async () => {
    const outcome = input.installs ?? "installed";
    if (outcome !== "installed") return { status: "refused", kind: outcome };
    held = true;
    return { status: "installed" };
  });
  const remove = vi.fn(async () => {
    held = false;
  });
  const service = new TailscaleCertificateService({
    setting: createTailscaleCertificateSetting(directory),
    daemon: { certificateFor },
    sink: { install, remove, holdsCertificate: () => held },
    listener: () =>
      listener(input.hostname === undefined ? "mini.tail1234.ts.net" : input.hostname),
    now: () => now,
  });
  return {
    service,
    certificateFor,
    install,
    remove,
    forgetHeld: () => {
      held = false;
    },
    directory,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the Tailscale certificate for the web app", () => {
  it("is off until the person turns it on, and asks the daemon for nothing while off", async () => {
    const { service, certificateFor } = setup({});

    expect(service.status().enabled).toBe(false);
    expect(await service.renewIfDue()).toEqual({ status: "refused", kind: "turned-off" });
    expect(certificateFor).not.toHaveBeenCalled();
  });

  it("refuses to turn on without the certificate-transparency acknowledgement", async () => {
    const { service, certificateFor } = setup({});

    const refused = service.enable({ acknowledgedCertificateTransparency: false });

    expect(refused).toEqual({ status: "refused", kind: "acknowledgement-required" });
    expect(service.status().enabled).toBe(false);
    expect(certificateFor).not.toHaveBeenCalled();
  });

  it("refuses a listener that is not named by a tailnet name, whatever was acknowledged", () => {
    expect(
      setup({ hostname: "100.101.102.103" }).service.enable({
        acknowledgedCertificateTransparency: true,
      }),
    ).toEqual({ status: "refused", kind: "not-a-tailnet-name" });
    expect(
      setup({ hostname: "laptop.example.com" }).service.enable({
        acknowledgedCertificateTransparency: true,
      }),
    ).toEqual({ status: "refused", kind: "not-a-tailnet-name" });
    expect(
      setup({ hostname: null }).service.enable({ acknowledgedCertificateTransparency: true }),
    ).toEqual({ status: "refused", kind: "listener-not-running" });
  });

  it("gets a certificate once turned on, leaves it while it is current, and renews it before it expires", async () => {
    const { service, certificateFor, install, advance } = setup({});
    expect(service.enable({ acknowledgedCertificateTransparency: true })).toEqual({
      status: "enabled",
    });

    const first = await service.renewIfDue();
    expect(first).toEqual({ status: "renewed", notAfter: NOW + 90 * DAY });
    expect(install).toHaveBeenCalledWith({
      domain: "mini.tail1234.ts.net",
      certificatePem: "CERTIFICATE-BODY",
      privateKeyPem: "PRIVATE-KEY-BODY",
    });

    advance(30 * DAY);
    expect(await service.renewIfDue()).toEqual({ status: "current", notAfter: NOW + 90 * DAY });
    expect(certificateFor).toHaveBeenCalledTimes(1);

    advance(50 * DAY);
    expect(service.status().renewal).toBe("due");
    expect((await service.renewIfDue()).status).toBe("renewed");
    expect(certificateFor).toHaveBeenCalledTimes(2);
  });

  it("asks again when the certificate expired while the host was away", async () => {
    const { service, certificateFor, advance } = setup({});
    service.enable({ acknowledgedCertificateTransparency: true });
    await service.renewIfDue();

    advance(120 * DAY);

    expect(service.status().renewal).toBe("expired");
    expect((await service.renewIfDue()).status).toBe("renewed");
    expect(certificateFor).toHaveBeenCalledTimes(2);
  });

  it("asks the daemon again after the host restarted and the listener serves no certificate", async () => {
    const { service, certificateFor, install, forgetHeld } = setup({});
    service.enable({ acknowledgedCertificateTransparency: true });
    await service.renewIfDue();

    forgetHeld();

    expect((await service.renewIfDue()).status).toBe("renewed");
    expect(certificateFor).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("keeps what it holds and says why when the daemon refuses or the listener will not take the certificate", async () => {
    const unreachable = setup({ reading: { status: "unavailable", kind: "https-not-enabled" } });
    unreachable.service.enable({ acknowledgedCertificateTransparency: true });
    expect(await unreachable.service.renewIfDue()).toEqual({
      status: "refused",
      kind: "https-not-enabled",
    });
    expect(unreachable.install).not.toHaveBeenCalled();

    for (const kind of ["invalid-certificate", "could-not-apply"] as const) {
      const refused = setup({ installs: kind });
      refused.service.enable({ acknowledgedCertificateTransparency: true });
      expect(await refused.service.renewIfDue()).toEqual({ status: "refused", kind });
      expect(refused.service.status().notAfter).toBeUndefined();
    }
  });

  it("never writes certificate or key material to the state it keeps", async () => {
    const { service, directory } = setup({});
    service.enable({ acknowledgedCertificateTransparency: true });
    await service.renewIfDue();

    const kept = readFileSync(join(directory, "hub", "tailscale-certificate.json"), "utf8");

    expect(kept).not.toContain("CERTIFICATE-BODY");
    expect(kept).not.toContain("PRIVATE-KEY-BODY");
    expect(JSON.stringify(service.status())).not.toContain("PRIVATE-KEY-BODY");
  });

  it("stays off when the person turns it off while a renewal is still waiting on the daemon", async () => {
    const { service, certificateFor, install, remove } = setup({});
    service.enable({ acknowledgedCertificateTransparency: true });
    let answer: (reading: TailscaleCertificateReading) => void = () => undefined;
    certificateFor.mockImplementationOnce(
      () =>
        new Promise<TailscaleCertificateReading>((resolve) => {
          answer = resolve;
        }),
    );

    const renewal = service.renewIfDue();
    await service.disable();
    answer({
      status: "issued",
      certificatePem: "CERTIFICATE-BODY",
      privateKeyPem: "PRIVATE-KEY-BODY",
      notAfter: NOW + 90 * DAY,
    });

    expect(await renewal).toEqual({ status: "refused", kind: "turned-off" });
    expect(install).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(service.status().enabled).toBe(false);
    expect(service.status().notAfter).toBeUndefined();
  });

  it("takes the certificate away again when the person turns it off while it is being installed", async () => {
    const { service, install, remove } = setup({});
    service.enable({ acknowledgedCertificateTransparency: true });
    let finish: () => void = () => undefined;
    install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: "installed" });
        }),
    );

    const renewal = service.renewIfDue();
    await Promise.resolve();
    await Promise.resolve();
    await service.disable();
    finish();

    expect(await renewal).toEqual({ status: "refused", kind: "turned-off" });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(service.status().enabled).toBe(false);
  });

  it("turns off again by taking the tailnet certificate away and leaving the pinned one", async () => {
    const { service, install, remove } = setup({});
    service.enable({ acknowledgedCertificateTransparency: true });
    await service.renewIfDue();

    expect(await service.disable()).toEqual({ status: "disabled" });

    expect(service.status().enabled).toBe(false);
    expect(install).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

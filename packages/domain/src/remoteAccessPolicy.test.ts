import { describe, expect, it } from "vitest";
import {
  authorizePrincipalAction,
  classifyRemoteAction,
  listRemoteActionCatalog,
  classifyRemoteListenerAddress,
  DEVICE_ABSOLUTE_TTL_MS,
  DEVICE_INACTIVITY_TTL_MS,
  evaluateDeviceRegistration,
  evaluatePairingAttempt,
  evaluatePairingClaim,
  evaluateSession,
  normalizeDeviceLabel,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PAIRING_TICKET_TTL_MS,
  negotiateRemoteProtocol,
  SESSION_ROTATION_INTERVAL_MS,
} from "./remoteAccessPolicy";

describe("remote access policy", () => {
  it.each([
    "host.service.start",
    "host.service.stop",
    "host.service.restart",
    "host.service.enable",
    "host.service.disable",
    "host.service.status",
    "host.service.logs",
    "host.store.backup",
    "host.store.restore",
    "host.store.retention",
    "host.store.purge",
    "host.store.data-map",
  ])("requires a local principal for %s", (action) => {
    expect(authorizePrincipalAction({ principalKind: "remote-device", action })).toMatchObject({
      kind: "deny",
      reason: "local-host-required",
    });
    expect(authorizePrincipalAction({ principalKind: "local-window", action })).toEqual({
      kind: "allow",
    });
  });

  it("selects the highest safe mutual protocol and security floor", () => {
    expect(
      negotiateRemoteProtocol({
        server: { min: 1, max: 3, securityFloor: 2 },
        client: { min: 2, max: 4, securityFloor: 1 },
      }),
    ).toEqual({ kind: "negotiated", protocolVersion: 3, securityFloor: 2 });
  });

  it.each([
    [{ min: 1, max: 1, securityFloor: 2 }, { min: 1, max: 1, securityFloor: 1 }, "security-floor"],
    [{ min: 1, max: 1, securityFloor: 1 }, { min: 2, max: 3, securityFloor: 1 }, "incompatible"],
  ] as const)("fails closed for %s and %s", (server, client, reason) => {
    expect(negotiateRemoteProtocol({ server, client })).toEqual({ kind: "rejected", reason });
  });

  it("classifies only private or Tailscale remote addresses", () => {
    expect(classifyRemoteListenerAddress("127.0.0.1")).toBe("loopback");
    expect(classifyRemoteListenerAddress("192.168.1.10")).toBe("lan-private");
    expect(classifyRemoteListenerAddress("fe90::1")).toBe("lan-private");
    expect(classifyRemoteListenerAddress("100.100.10.2")).toBe("tailscale");
    expect(classifyRemoteListenerAddress("8.8.8.8")).toBe("public");
    expect(classifyRemoteListenerAddress("0.0.0.0")).toBe("invalid");
    expect(classifyRemoteListenerAddress("fc-not-an-ip")).toBe("invalid");
    expect(classifyRemoteListenerAddress("100.64.999.999")).toBe("public");
  });

  it("denies unknown actions and classifies high-risk work locally", () => {
    expect(classifyRemoteAction("chat.send-turn")).toEqual({ kind: "remote-approvable" });
    expect(classifyRemoteAction("desktop.enable-listener")).toEqual({
      kind: "local-host-required",
    });
    expect(classifyRemoteAction("provider.credentials.write")).toEqual({
      kind: "local-host-required",
    });
    expect(classifyRemoteAction("extension.trust")).toEqual({ kind: "local-host-required" });
    expect(classifyRemoteAction("project.root.bind")).toEqual({ kind: "local-host-required" });
    expect(classifyRemoteAction("code.remember-full-access")).toEqual({
      kind: "local-host-required",
    });
    expect(classifyRemoteAction("code.open-external-editor")).toEqual({
      kind: "local-host-required",
    });
    expect(classifyRemoteAction("host-key.rotate")).toEqual({ kind: "local-host-required" });
    expect(classifyRemoteAction("diagnostics.export")).toEqual({ kind: "local-host-required" });
    expect(classifyRemoteAction("invented.action")).toEqual({ kind: "rejected" });
  });

  it("authorizes remote-approvable actions and fails closed for local-host work", () => {
    expect(
      authorizePrincipalAction({ principalKind: "remote-device", action: "chat.send-turn" }),
    ).toEqual({ kind: "allow" });
    expect(
      authorizePrincipalAction({
        principalKind: "remote-device",
        action: "desktop.enable-listener",
      }),
    ).toEqual({ kind: "deny", reason: "local-host-required" });
    expect(
      authorizePrincipalAction({
        principalKind: "local-window",
        action: "desktop.rotate-host-key",
      }),
    ).toEqual({ kind: "allow" });
    expect(
      authorizePrincipalAction({ principalKind: "remote-device", action: "invented.action" }),
    ).toEqual({ kind: "deny", reason: "unknown-action" });
  });

  it("lets a paired device watch a thread's running product without driving the host", () => {
    // A companion screen is a read of what the host is already showing, plus
    // the gestures that land inside that view. Pointing the host's browser
    // somewhere new, typing into it, or opening and closing its sessions are
    // not watching, so they stay on the host.
    expect(classifyRemoteAction("browser.observe")).toEqual({ kind: "remote-approvable" });
    expect(classifyRemoteAction("browser.interact")).toEqual({ kind: "remote-approvable" });
    expect(classifyRemoteAction("simulator.observe")).toEqual({ kind: "remote-approvable" });
    expect(classifyRemoteAction("terminal.read")).toEqual({ kind: "remote-approvable" });
    expect(classifyRemoteAction("browser.session.manage")).toEqual({
      kind: "local-host-required",
    });
    expect(classifyRemoteAction("terminal.write")).toEqual({ kind: "local-host-required" });
    expect(
      authorizePrincipalAction({ principalKind: "remote-device", action: "browser.observe" }),
    ).toEqual({ kind: "allow" });
    expect(
      authorizePrincipalAction({
        principalKind: "remote-device",
        action: "browser.session.manage",
      }),
    ).toEqual({ kind: "deny", reason: "local-host-required" });
    expect(
      authorizePrincipalAction({ principalKind: "remote-device", action: "terminal.write" }),
    ).toEqual({ kind: "deny", reason: "local-host-required" });
  });

  it("lets a remote device perform ordinary Automation Center mutations", () => {
    // Design §4.3/§10: a RemoteDevicePrincipal may run the ordinary Automation
    // commands on the owning host; it never gains local-window authority.
    expect(classifyRemoteAction("automation.manage")).toEqual({ kind: "remote-approvable" });
    expect(
      authorizePrincipalAction({ principalKind: "remote-device", action: "automation.manage" }),
    ).toEqual({ kind: "allow" });
    expect(
      authorizePrincipalAction({ principalKind: "local-window", action: "automation.manage" }),
    ).toEqual({ kind: "allow" });
  });

  it("denies remote principal laundering and local-receipt minting", () => {
    expect(
      authorizePrincipalAction({
        principalKind: "remote-device",
        action: "chat.send-turn",
        requestedPrincipalKind: "local-window",
      }),
    ).toEqual({ kind: "deny", reason: "principal-laundering" });
    expect(
      authorizePrincipalAction({
        principalKind: "remote-device",
        action: "desktop.issue-local-approval",
      }),
    ).toEqual({ kind: "deny", reason: "remote-cannot-mint-local-receipt" });
    expect(
      authorizePrincipalAction({
        principalKind: "remote-device",
        action: "principal.upgrade-to-local-window",
      }),
    ).toEqual({ kind: "deny", reason: "remote-cannot-mint-local-receipt" });
  });

  it("exports a stable least-authority catalog covering required surfaces", () => {
    const catalog = listRemoteActionCatalog();
    expect(catalog.localHostRequired).toEqual(
      expect.arrayContaining([
        "desktop.enable-listener",
        "desktop.approve-device",
        "desktop.rotate-host-key",
        "provider.credentials.write",
        "extension.trust",
        "project.root.bind",
        "code.remember-full-access",
        "code.open-external-editor",
        "host-key.rotate",
        "diagnostics.export",
      ]),
    );
    expect(catalog.remoteApprovable).toEqual(
      expect.arrayContaining(["chat.send-turn", "code.create-thread", "project.overview.read"]),
    );
  });

  it("limits pairing failures and invalidates used or expired tickets", () => {
    expect(
      evaluatePairingAttempt({ state: "pending", attempts: 0, now: 10, expiresAt: 20 }),
    ).toEqual({
      kind: "accepted",
      attempts: 1,
    });
    expect(
      evaluatePairingAttempt({ state: "pending", attempts: 5, now: 10, expiresAt: 20 }),
    ).toEqual({
      kind: "rejected",
      reason: "attempt-limit",
    });
    expect(
      evaluatePairingAttempt({ state: "pending", attempts: 0, now: 21, expiresAt: 20 }),
    ).toEqual({
      kind: "rejected",
      reason: "expired",
    });
    expect(
      evaluatePairingAttempt({ state: "approved", attempts: 0, now: 10, expiresAt: 20 }),
    ).toEqual({
      kind: "rejected",
      reason: "already-consumed",
    });
  });

  it("accepts only the first concurrent claim and fails closed for stolen or used tickets", () => {
    expect(
      evaluatePairingClaim({
        state: "pending",
        claimState: "unclaimed",
        attempts: 0,
        now: 10,
        expiresAt: 10 + PAIRING_TICKET_TTL_MS,
        proofMatches: true,
      }),
    ).toEqual({ kind: "claimed", attempts: 0 });
    expect(
      evaluatePairingClaim({
        state: "pending",
        claimState: "claimed",
        attempts: 0,
        now: 10,
        expiresAt: 10 + PAIRING_TICKET_TTL_MS,
        proofMatches: true,
      }),
    ).toEqual({ kind: "rejected", reason: "already-claimed" });
    expect(
      evaluatePairingClaim({
        state: "pending",
        claimState: "unclaimed",
        attempts: 0,
        now: 10,
        expiresAt: 10 + PAIRING_TICKET_TTL_MS,
        proofMatches: false,
      }),
    ).toEqual({ kind: "rejected", reason: "invalid-proof", attempts: 1 });
    expect(
      evaluatePairingClaim({
        state: "pending",
        claimState: "unclaimed",
        attempts: PAIRING_MAX_FAILED_ATTEMPTS - 1,
        now: 10,
        expiresAt: 10 + PAIRING_TICKET_TTL_MS,
        proofMatches: false,
      }),
    ).toEqual({ kind: "rejected", reason: "attempt-limit", attempts: PAIRING_MAX_FAILED_ATTEMPTS });
  });

  it("bounds and sanitizes device labels so they cannot inject logs or UI", () => {
    expect(normalizeDeviceLabel("  Ada's Safari  ")).toEqual({
      kind: "accepted",
      deviceLabel: "Ada's Safari",
    });
    expect(normalizeDeviceLabel("bad\nlabel<script>")).toEqual({
      kind: "rejected",
      reason: "invalid-label",
    });
    expect(normalizeDeviceLabel("x".repeat(129))).toEqual({
      kind: "rejected",
      reason: "invalid-label",
    });
  });

  it("expires devices by absolute and inactivity windows without inventing recovery", () => {
    const createdAt = 1_000;
    expect(
      evaluateDeviceRegistration({
        state: "active",
        now: createdAt + DEVICE_ABSOLUTE_TTL_MS,
        createdAt,
        lastSeenAt: createdAt + 1_000,
      }),
    ).toEqual({ kind: "expired", reason: "absolute-expiry" });
    expect(
      evaluateDeviceRegistration({
        state: "active",
        now: createdAt + DEVICE_INACTIVITY_TTL_MS,
        createdAt,
        lastSeenAt: createdAt,
      }),
    ).toEqual({ kind: "expired", reason: "inactivity-expiry" });
    expect(
      evaluateDeviceRegistration({
        state: "revoked",
        now: createdAt + 1,
        createdAt,
        lastSeenAt: createdAt,
      }),
    ).toEqual({ kind: "rejected", reason: "revoked" });
  });

  it("treats session expiry as deny and exposes rotation without extending expiry", () => {
    expect(
      evaluateSession({
        now: SESSION_ROTATION_INTERVAL_MS,
        issuedAt: 0,
        idleExpiresAt: SESSION_ROTATION_INTERVAL_MS + 1,
        absoluteExpiresAt: SESSION_ROTATION_INTERVAL_MS + 100,
      }),
    ).toEqual({ kind: "active", rotate: true });
    expect(
      evaluateSession({ now: 201, issuedAt: 0, idleExpiresAt: 300, absoluteExpiresAt: 200 }),
    ).toEqual({ kind: "expired", reason: "absolute-expiry" });
    expect(
      evaluateSession({ now: 301, issuedAt: 0, idleExpiresAt: 300, absoluteExpiresAt: 400 }),
    ).toEqual({ kind: "expired", reason: "idle-expiry" });
    expect(
      evaluateSession({ now: -1, issuedAt: 0, idleExpiresAt: 300, absoluteExpiresAt: 400 }),
    ).toEqual({ kind: "expired", reason: "clock-skew" });
  });
});

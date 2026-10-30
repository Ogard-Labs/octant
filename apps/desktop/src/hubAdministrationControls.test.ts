import { describe, expect, it, vi } from "vitest";
import {
  HubAdministrationControlFailure,
  sendHubAdministrationOperation,
} from "./hubAdministrationControls";

const MEMBER_ID = "77777777-7777-4777-8777-777777777777";
const ALERT_ID = "88888888-8888-4888-8888-888888888888";

function runtime(respond: (url: string, init: RequestInit | undefined) => Response) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  return {
    calls,
    runtime: {
      serverUrl: "http://127.0.0.1:4317",
      desktopBridgeSecret: "bridge-secret",
      windowCapability: "A".repeat(43),
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        return respond(url, init);
      }) as unknown as typeof globalThis.fetch,
    },
  };
}

describe("hub administration controls", () => {
  it("sends a valid operation to its fixed route with this window's authority and hands back a refusal as an answer", async () => {
    const { calls, runtime: controls } = runtime(() =>
      Response.json({ status: "refused", kind: "not-a-member" }, { status: 409 }),
    );
    expect(
      await sendHubAdministrationOperation(controls, "remove", { memberId: MEMBER_ID }),
    ).toEqual({ status: 409, body: { status: "refused", kind: "not-a-member" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/api/desktop/hub/members/remove");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ memberId: MEMBER_ID }));
    expect(calls[0]?.init?.headers).toEqual({
      "x-octant-desktop-secret": "bridge-secret",
      "x-octant-window-capability": "A".repeat(43),
      "content-type": "application/json",
    });
  });

  it("reads the hub status with a GET and no body", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ hub: {}, spoke: {} }));
    expect(await sendHubAdministrationOperation(controls, "status", undefined)).toEqual({
      status: 200,
      body: { hub: {}, spoke: {} },
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/api/desktop/hub/status");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("sends the certificate choice to its fixed route and refuses a body that names anything else", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ status: "enabled" }));
    await sendHubAdministrationOperation(controls, "certificate", {
      action: "enable",
      acknowledgedCertificateTransparency: true,
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/api/desktop/hub/certificate");
    expect(calls[0]?.init?.method).toBe("POST");

    expect(
      await sendHubAdministrationOperation(controls, "certificate", {
        action: "enable",
        path: "/",
      }),
    ).toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);

    await sendHubAdministrationOperation(controls, "certificate-status", undefined);
    expect(calls[1]?.init?.method).toBe("GET");
  });

  it("refuses an operation it does not name or a path in its place, sending nothing", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({}));
    for (const operation of ["../desktop/remote/pairing-tickets", "__proto__", "toString", 7]) {
      expect(await sendHubAdministrationOperation(controls, operation, {})).toMatchObject({
        status: 400,
        body: { category: "invalid" },
      });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a body that fails its schema, sending nothing", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({}));
    const refused: ReadonlyArray<readonly [string, unknown]> = [
      ["remove", { memberId: "not-a-uuid" }],
      ["remove", { memberId: MEMBER_ID, extra: true }],
      ["join-code", { owner: "yes" }],
      ["join-code", undefined],
      ["join", { code: 7 }],
      ["join", { code: "x".repeat(4_097) }],
      ["grant", { items: ["shell"], actProjects: [] }],
      ["grant", { items: ["status"], actProjects: ["99999999-9999-4999-8999-999999999999"] }],
      ["enable", { anything: true }],
      ["leave", {}],
    ];
    for (const [operation, body] of refused) {
      expect(await sendHubAdministrationOperation(controls, operation, body)).toMatchObject({
        status: 400,
      });
    }
    expect(calls).toEqual([]);
  });

  it("sends each owner operation to its fixed route with the decoded body", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ status: "changed" }));
    const added = {
      owners: [
        {
          memberId: MEMBER_ID,
          identityKeyFingerprint: "a".repeat(64),
          unlockKeyFingerprint: "b".repeat(64),
        },
      ],
    };
    const sent: ReadonlyArray<readonly [string, unknown, string]> = [
      ["owners-add", added, "/api/desktop/hub/owners/add"],
      ["owners-remove", { memberId: MEMBER_ID }, "/api/desktop/hub/owners/remove"],
      ["confirm-new-members", { enabled: true }, "/api/desktop/hub/confirm-new-members"],
      ["confirm-member", { memberId: MEMBER_ID }, "/api/desktop/hub/members/confirm"],
      ["alert-dismiss", { alertId: ALERT_ID }, "/api/desktop/hub/alerts/dismiss"],
      ["alert-remove", { alertId: ALERT_ID }, "/api/desktop/hub/alerts/remove"],
    ];
    for (const [operation, body, path] of sent) {
      await sendHubAdministrationOperation(controls, operation, body);
      expect(calls.at(-1)?.url).toBe(`http://127.0.0.1:4317${path}`);
      expect(calls.at(-1)?.init?.method).toBe("POST");
      expect(calls.at(-1)?.init?.body).toBe(JSON.stringify(body));
    }
    expect(calls).toHaveLength(sent.length);
  });

  it("sends the standby order and the promotion only with their decoded bodies", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ status: "ordered" }));

    await sendHubAdministrationOperation(controls, "standby-order", { memberIds: [MEMBER_ID] });
    await sendHubAdministrationOperation(controls, "promote", { confirmed: true });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4317/api/desktop/hub/standby-order",
      "http://127.0.0.1:4317/api/desktop/hub/promote",
    ]);

    for (const [operation, body] of [
      ["standby-order", { memberIds: [MEMBER_ID, MEMBER_ID] }],
      ["standby-order", { memberIds: ["not-a-uuid"] }],
      ["standby-order", undefined],
      ["promote", {}],
      ["promote", { confirmed: false }],
      ["promote", undefined],
    ] as const) {
      expect(await sendHubAdministrationOperation(controls, operation, body)).toMatchObject({
        status: 400,
      });
    }
    expect(calls).toHaveLength(2);
  });

  it("sends the push switch only with its decoded body", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ status: "changed" }));

    await sendHubAdministrationOperation(controls, "push", { enabled: true });
    expect(calls.map((call) => call.url)).toEqual(["http://127.0.0.1:4317/api/desktop/hub/push"]);

    for (const body of [{}, { enabled: "yes" }, { enabled: true, extra: 1 }, undefined]) {
      expect(await sendHubAdministrationOperation(controls, "push", body)).toMatchObject({
        status: 400,
      });
    }
    expect(calls).toHaveLength(1);
  });

  it("sends the direct sending operations only with their decoded bodies", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ status: "changed" }));

    await sendHubAdministrationOperation(controls, "direct-push", { enabled: true });
    await sendHubAdministrationOperation(controls, "direct-push-environment", {
      environment: "development",
    });
    await sendHubAdministrationOperation(controls, "direct-push-credential-remove", {
      platform: "ios",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4317/api/desktop/hub/direct-push",
      "http://127.0.0.1:4317/api/desktop/hub/direct-push/environment",
      "http://127.0.0.1:4317/api/desktop/hub/direct-push/credential/remove",
    ]);

    for (const [operation, body] of [
      ["direct-push", { enabled: "yes" }],
      ["direct-push-environment", { environment: "staging" }],
      ["direct-push-credential", { platform: "android" }],
      ["direct-push-credential", { platform: "android", serviceAccount: "{}", extra: 1 }],
      ["direct-push-credential", { platform: "ios", keyId: "x", teamId: "x", bundleId: "x" }],
      ["direct-push-credential-remove", { platform: "web" }],
    ] as const) {
      expect(await sendHubAdministrationOperation(controls, operation, body)).toMatchObject({
        status: 400,
      });
    }
    expect(calls).toHaveLength(3);
  });

  it("sends an offer, and a proposal's apply, only with a body that carries no secret", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ status: "offered" }));
    const offer = {
      kind: "plugin",
      catalogId: "octant",
      entryId: "review-helper",
      expectedDigest: `sha256:${"a".repeat(64)}`,
    };

    await sendHubAdministrationOperation(controls, "provision-offer", { offer });
    await sendHubAdministrationOperation(controls, "provision-auto-apply", {
      kind: "plugin",
      enabled: true,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4317/api/desktop/hub/provision/offers",
      "http://127.0.0.1:4317/api/desktop/hub/provision/auto-apply",
    ]);

    for (const [operation, body] of [
      ["provision-offer", { offer: { ...offer, apiKey: "x" } }],
      ["provision-offer", {}],
      ["provision-auto-apply", { kind: "routine", enabled: true }],
      ["provision-apply", { offerId: "not-an-id" }],
      ["provision", { enabled: "yes" }],
    ] as const) {
      expect(await sendHubAdministrationOperation(controls, operation, body)).toMatchObject({
        status: 400,
      });
    }
    expect(calls).toHaveLength(2);
  });

  it("sends the wake switch and the hardware address only with their decoded bodies", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ status: "changed" }));

    await sendHubAdministrationOperation(controls, "wake", { enabled: true });
    await sendHubAdministrationOperation(controls, "wake-hardware-address", {
      address: "aa:bb:cc:00:11:22",
    });
    await sendHubAdministrationOperation(controls, "wake-hardware-address", { address: null });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:4317/api/desktop/hub/wake",
      "http://127.0.0.1:4317/api/desktop/hub/wake/hardware-address",
      "http://127.0.0.1:4317/api/desktop/hub/wake/hardware-address",
    ]);

    for (const [operation, body] of [
      ["wake", {}],
      ["wake", { enabled: "yes" }],
      ["wake", { enabled: true, extra: 1 }],
      ["wake", undefined],
      ["wake-hardware-address", {}],
      ["wake-hardware-address", { address: 7 }],
    ] as const) {
      expect(await sendHubAdministrationOperation(controls, operation, body)).toMatchObject({
        status: 400,
      });
    }
    expect(calls).toHaveLength(3);
  });

  it("refuses an owner request that fails its schema, sending nothing", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({}));
    const owner = {
      memberId: MEMBER_ID,
      identityKeyFingerprint: "a".repeat(64),
      unlockKeyFingerprint: "b".repeat(64),
    };
    const refused: ReadonlyArray<readonly [string, unknown]> = [
      ["owners-add", { owners: [] }],
      ["owners-add", { owners: [{ ...owner, unlockKeyFingerprint: "not a digest" }] }],
      ["owners-add", { owners: [{ ...owner, unlockPublicKey: "MFkw" }] }],
      ["owners-add", { owners: [{ ...owner, role: "hub" }] }],
      ["owners-add", { owners: [owner], extra: true }],
      ["owners-add", undefined],
      ["owners-remove", { memberId: "not-a-uuid" }],
      ["owners-remove", { memberId: MEMBER_ID, force: true }],
      ["confirm-new-members", { enabled: "yes" }],
      ["confirm-new-members", {}],
      ["confirm-member", { memberId: MEMBER_ID, signature: "x" }],
      ["alert-dismiss", { alertId: "not-a-uuid" }],
      ["alert-remove", { alertId: ALERT_ID, memberId: MEMBER_ID }],
    ];
    for (const [operation, body] of refused) {
      expect(await sendHubAdministrationOperation(controls, operation, body)).toMatchObject({
        status: 400,
      });
    }
    expect(calls).toEqual([]);
  });

  it("sends the decoded grant, not the window's own object", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({ status: "granted" }));
    await sendHubAdministrationOperation(controls, "grant", {
      items: ["roster", "introduce"],
      actProjects: [],
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/api/desktop/hub/grant");
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ items: ["roster", "introduce"], actProjects: [] }),
    );
  });

  it("throws when the host cannot be reached", async () => {
    const { runtime: controls } = runtime(() => {
      throw new Error("connection refused");
    });
    await expect(
      sendHubAdministrationOperation(controls, "status", undefined),
    ).rejects.toBeInstanceOf(HubAdministrationControlFailure);
  });
});

import { describe, expect, it } from "vitest";
import {
  listRemoteShellSurfaces,
  listRemoteShellSurfacesByAvailability,
  listRemoteThreadSurfaces,
  listRemoteThreadSurfacesByReach,
  readRemoteSessionStanding,
  remoteShellSurfaceAvailability,
  remoteThreadSurfaceReach,
} from "./remoteSurfaceMatrix";

describe("remoteSurfaceMatrix", () => {
  it("classifies mode and auxiliary surfaces as remote-approvable", () => {
    // A reported session without a level, not the unread fallback, is the
    // catalogue's baseline remote device.
    const reported = { actsAsHostPerson: false };
    for (const surface of listRemoteShellSurfacesByAvailability("remote", reported)) {
      expect(remoteShellSurfaceAvailability(surface, reported)).toBe("remote");
    }
    expect(
      listRemoteShellSurfacesByAvailability("remote", reported).map((surface) => surface.id),
    ).toEqual([
      "chat",
      "work",
      "code",
      "preview",
      "provider-models",
      "settings-read",
      "agent-revoke",
    ]);
  });

  it("classifies desktop-only surfaces as local-host-only", () => {
    const reported = { actsAsHostPerson: false };
    for (const surface of listRemoteShellSurfacesByAvailability("local-host-only", reported)) {
      expect(remoteShellSurfaceAvailability(surface, reported)).toBe("local-host-only");
    }
    expect(
      listRemoteShellSurfacesByAvailability("local-host-only", reported).map(
        (surface) => surface.id,
      ),
    ).toEqual([
      "shell-settings",
      "design-systems",
      "usage-ledger",
      "file-event-routines",
      "provider-discovery",
      "server-projects",
      "approvals",
      "extension-install",
      "provider-setup",
      "provider-credentials",
      "device-management",
      "agent-access",
      "diagnostics",
      "listener-controls",
      "host-controls",
    ]);
  });

  it("keeps host lifecycle controls off the remote surface even if the descriptor drifts", () => {
    const hostControls = listRemoteShellSurfaces().find(
      (surface) => surface.id === "host-controls",
    );
    expect(hostControls).toBeDefined();
    expect(remoteShellSurfaceAvailability(hostControls!)).toBe("local-host-only");
  });

  it("lists every declared surface exactly once", () => {
    expect(listRemoteShellSurfaces()).toHaveLength(22);
  });
});

describe("the surfaces a companion client may watch a thread through", () => {
  it("keeps a terminal watchable and never typeable from a companion client", () => {
    const terminal = listRemoteThreadSurfaces().find((surface) => surface.id === "terminal");
    if (terminal === undefined) throw new Error("the terminal surface is missing");
    expect(remoteThreadSurfaceReach(terminal)).toBe("read-only");
  });

  it("reports a surface whose read the catalog does not allow as unavailable", () => {
    expect(
      remoteThreadSurfaceReach({
        id: "simulator",
        label: "Simulator",
        description: "",
        observeAction: "never.catalogued",
      }),
    ).toBe("unavailable");
  });

  it("falls back to watching when only the interaction is host work", () => {
    expect(
      remoteThreadSurfaceReach({
        id: "browser",
        label: "Browser",
        description: "",
        observeAction: "browser.observe",
        interactAction: "browser.session.manage",
      }),
    ).toBe("read-only");
  });

  it("offers every declared thread surface exactly once", () => {
    expect(listRemoteThreadSurfaces().map((surface) => surface.id)).toEqual([
      "chat",
      "browser",
      "terminal",
      "simulator",
      "canvas",
      "preview",
    ]);
  });
});

describe("what a session that acts as the host's own person reaches", () => {
  const hostPerson = { actsAsHostPerson: true };
  const restricted = { actsAsHostPerson: false };

  it("offers a device the host's person paired every surface the host forwards to it", () => {
    expect(
      listRemoteShellSurfacesByAvailability("remote", hostPerson).map((surface) => surface.id),
    ).toEqual([
      "chat",
      "work",
      "code",
      "preview",
      "provider-models",
      "settings-read",
      "agent-revoke",
      "shell-settings",
      "design-systems",
      "usage-ledger",
      "file-event-routines",
      "provider-discovery",
      "server-projects",
      "approvals",
      "extension-install",
      "provider-setup",
      "provider-credentials",
      "device-management",
      "agent-access",
      "diagnostics",
      "host-controls",
    ]);
  });

  it("keeps what the host forwards to no device off a person-paired device too", () => {
    expect(
      listRemoteShellSurfacesByAvailability("local-host-only", hostPerson).map(
        (surface) => surface.id,
      ),
    ).toEqual(["listener-controls"]);
  });

  it("holds a restricted session to the catalogue, and a session that says nothing to the read-only fallback", () => {
    const local = [
      "shell-settings",
      "design-systems",
      "usage-ledger",
      "file-event-routines",
      "provider-discovery",
      "server-projects",
      "approvals",
      "extension-install",
      "provider-setup",
      "provider-credentials",
      "device-management",
      "agent-access",
      "diagnostics",
      "listener-controls",
      "host-controls",
    ];
    expect(
      listRemoteShellSurfacesByAvailability("local-host-only", restricted).map(
        (surface) => surface.id,
      ),
    ).toEqual(local);
    // Standing unread narrows to Read only: the catalogue's reads stay
    // remote and everything else reads as host work.
    const readOnly = { actsAsHostPerson: false, accessLevel: "read-only" as const };
    expect(listRemoteShellSurfacesByAvailability("remote").map((surface) => surface.id)).toEqual(
      listRemoteShellSurfacesByAvailability("remote", readOnly).map((surface) => surface.id),
    );
    expect(
      listRemoteShellSurfacesByAvailability("local-host-only").map((surface) => surface.id),
    ).toEqual(
      listRemoteShellSurfacesByAvailability("local-host-only", readOnly).map(
        (surface) => surface.id,
      ),
    );
  });

  it("lets a person-paired device type into a terminal a restricted session only watches", () => {
    expect(
      listRemoteThreadSurfacesByReach("interactive", hostPerson).map((surface) => surface.id),
    ).toEqual(["chat", "browser", "terminal"]);
    expect(
      listRemoteThreadSurfacesByReach("interactive", restricted).map((surface) => surface.id),
    ).toEqual(["chat", "browser"]);
  });

  it("lets a device paired Read only watch every surface and act on none", () => {
    const readOnly = { actsAsHostPerson: false, accessLevel: "read-only" as const };
    expect(listRemoteThreadSurfacesByReach("interactive", readOnly)).toEqual([]);
    expect(
      listRemoteThreadSurfacesByReach("read-only", readOnly).map((surface) => surface.id),
    ).toEqual(["chat", "browser", "terminal", "simulator", "canvas", "preview"]);
    // Sending a turn is not watching, so the modes' composers are not offered.
    expect(
      listRemoteShellSurfacesByAvailability("remote", readOnly).map((surface) => surface.id),
    ).toEqual(["preview", "provider-models", "settings-read", "agent-revoke"]);
  });

  it("gives a device paired at Approve and steer what the catalogue gives a restricted session", () => {
    const steer = { actsAsHostPerson: false, accessLevel: "approve-and-steer" as const };
    expect(
      listRemoteThreadSurfacesByReach("interactive", steer).map((surface) => surface.id),
    ).toEqual(["chat", "browser"]);
    expect(listRemoteShellSurfacesByAvailability("remote", steer)).toEqual(
      listRemoteShellSurfacesByAvailability("remote", restricted),
    );
  });

  it("reads the session's standing from the host's own-device answer and nothing else", async () => {
    const device = {
      deviceId: "22222222-2222-4222-8222-222222222222",
      deviceLabel: "Ada's phone",
      origin: "https://mac.example.test",
      credentialGeneration: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:00:00.000Z",
      lastSeenAt: "2026-08-03T07:00:00.000Z",
      state: "active",
    };
    const asked: string[] = [];
    const answering = (status: number, body: unknown) => ({
      authenticatedFetch: async (input: { readonly method: string; readonly path: string }) => {
        asked.push(`${input.method} ${input.path}`);
        return new Response(JSON.stringify(body), { status });
      },
    });

    expect(
      await readRemoteSessionStanding(answering(200, { ...device, actsAsHostPerson: true })),
    ).toEqual({ actsAsHostPerson: true });
    expect(asked).toEqual(["GET /api/remote/auth/device"]);
    expect(
      await readRemoteSessionStanding(answering(200, { ...device, actsAsHostPerson: false })),
    ).toEqual({ actsAsHostPerson: false });
    // The device's own level says why controls are missing; an unknown level is not trusted.
    expect(
      await readRemoteSessionStanding(
        answering(200, { ...device, actsAsHostPerson: false, accessLevel: "read-only" }),
      ),
    ).toEqual({ actsAsHostPerson: false, accessLevel: "read-only" });
    expect(
      await readRemoteSessionStanding(
        answering(200, { ...device, actsAsHostPerson: false, accessLevel: "owner" }),
      ),
    ).toEqual({ actsAsHostPerson: false, accessLevel: "read-only" });
  });

  it("reads a session as restricted when the host does not say, refuses, or cannot be reached", async () => {
    const restrictedAnswers = [
      async () => new Response(JSON.stringify({ deviceId: "not-a-device" }), { status: 200 }),
      async () => new Response("{}", { status: 403 }),
      async () => {
        throw new Error("offline");
      },
    ];
    for (const authenticatedFetch of restrictedAnswers) {
      expect(await readRemoteSessionStanding({ authenticatedFetch })).toEqual({
        actsAsHostPerson: false,
        accessLevel: "read-only",
      });
    }
    const olderHost = {
      deviceId: "22222222-2222-4222-8222-222222222222",
      deviceLabel: "Ada's phone",
      origin: "https://mac.example.test",
      credentialGeneration: 1,
      createdAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:00:00.000Z",
      lastSeenAt: "2026-08-03T07:00:00.000Z",
      state: "active",
    };
    expect(
      await readRemoteSessionStanding({
        authenticatedFetch: async () => new Response(JSON.stringify(olderHost), { status: 200 }),
      }),
    ).toEqual({ actsAsHostPerson: false });
  });

  it("gives no session a surface whose action the catalogue does not know", () => {
    expect(
      remoteThreadSurfaceReach(
        { id: "simulator", label: "Simulator", description: "", observeAction: "never.catalogued" },
        hostPerson,
      ),
    ).toBe("unavailable");
  });
});

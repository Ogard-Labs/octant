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
    for (const surface of listRemoteShellSurfacesByAvailability("remote")) {
      expect(remoteShellSurfaceAvailability(surface)).toBe("remote");
    }
    expect(listRemoteShellSurfacesByAvailability("remote").map((surface) => surface.id)).toEqual([
      "chat",
      "work",
      "code",
      "preview",
      "provider-models",
      "settings-read",
    ]);
  });

  it("classifies desktop-only surfaces as local-host-only", () => {
    for (const surface of listRemoteShellSurfacesByAvailability("local-host-only")) {
      expect(remoteShellSurfaceAvailability(surface)).toBe("local-host-only");
    }
    expect(
      listRemoteShellSurfacesByAvailability("local-host-only").map((surface) => surface.id),
    ).toEqual([
      "approvals",
      "extension-install",
      "provider-setup",
      "provider-credentials",
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
    expect(listRemoteShellSurfaces()).toHaveLength(12);
  });
});

describe("the surfaces a companion client may watch a thread through", () => {
  it("lets a paired device act only where the catalog says acting is remote work", () => {
    expect(listRemoteThreadSurfacesByReach("interactive").map((surface) => surface.id)).toEqual([
      "chat",
      "browser",
    ]);
  });

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
      "approvals",
      "extension-install",
      "provider-setup",
    ]);
  });

  it("keeps what the host forwards to no device off a person-paired device too", () => {
    expect(
      listRemoteShellSurfacesByAvailability("local-host-only", hostPerson).map(
        (surface) => surface.id,
      ),
    ).toEqual(["provider-credentials", "listener-controls", "host-controls"]);
  });

  it("holds a restricted session to the catalogue, as a session that says nothing is held", () => {
    const local = [
      "approvals",
      "extension-install",
      "provider-setup",
      "provider-credentials",
      "listener-controls",
      "host-controls",
    ];
    expect(
      listRemoteShellSurfacesByAvailability("local-host-only", restricted).map(
        (surface) => surface.id,
      ),
    ).toEqual(local);
    expect(
      listRemoteShellSurfacesByAvailability("local-host-only").map((surface) => surface.id),
    ).toEqual(local);
  });

  it("lets a person-paired device type into a terminal a restricted session only watches", () => {
    expect(
      listRemoteThreadSurfacesByReach("interactive", hostPerson).map((surface) => surface.id),
    ).toEqual(["chat", "browser", "terminal"]);
    expect(
      listRemoteThreadSurfacesByReach("interactive", restricted).map((surface) => surface.id),
    ).toEqual(["chat", "browser"]);
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

import { describe, expect, it } from "vitest";
import {
  DESKTOP_ARTIFACT_MAXIMUM_BYTES,
  DESKTOP_RECIPE_KEY_MAXIMUM_BYTES,
  decodeComputerUseDestinationSelection,
  decodeDesktopArtifactSent,
  decodeDesktopLeaseOperated,
  decodeDesktopLeaseRequested,
  decodeLeasableDesktopProvider,
  decodeDesktopLeaseTransitioned,
  decodeDesktopPaneAnswer,
  decodeDesktopPaneRequest,
  decodeDesktopRecipe,
  decodeDesktopRecipeKeyChange,
} from "./desktopLease";
import { decodeProjectCommand } from "./projects";

const leaseId = "d1000000-0000-4000-8000-000000000001";
const threadId = "d1000000-0000-4000-8000-000000000002";
const hostTag = "d1000000-0000-4000-8000-000000000003";
const credentialRef = "d1000000-0000-4000-8000-000000000004";

const recipe = {
  providerId: "host-local",
  screen: { width: 1280, height: 800 },
  network: "none",
  leaseMinutes: 30,
  maximumLeaseMinutes: 240,
  idleMinutes: 15,
} as const;

const requested = {
  leaseId,
  owner: { mode: "code", threadId },
  providerId: "cloud.example",
  locality: "cloud",
  billed: true,
  hostTag,
  credentialRef,
  network: "none",
  expiresAt: "2026-10-26T12:30:00.000Z",
  maximumExpiresAt: "2026-10-26T16:00:00.000Z",
  idleMinutes: 15,
} as const;

describe("desktop lease contract", () => {
  it("refuses a recipe whose lease outlives four hours or starts beyond its own maximum", () => {
    expect(decodeDesktopRecipe(recipe).maximumLeaseMinutes).toBe(240);
    expect(() => decodeDesktopRecipe({ ...recipe, maximumLeaseMinutes: 241 })).toThrow();
    expect(() =>
      decodeDesktopRecipe({ ...recipe, leaseMinutes: 60, maximumLeaseMinutes: 45 }),
    ).toThrow();
  });

  it("never lets a Chat thread own a lease", () => {
    expect(decodeDesktopLeaseRequested(requested).owner.mode).toBe("code");
    expect(() =>
      decodeDesktopLeaseRequested({ ...requested, owner: { mode: "chat", threadId } }),
    ).toThrow();
  });

  it("journals the credential reference and refuses credential material", () => {
    expect(decodeDesktopLeaseRequested(requested).credentialRef).toBe(credentialRef);
    expect(() => decodeDesktopLeaseRequested({ ...requested, apiKey: "sk-live" })).toThrow();
  });

  it("carries a recipe's placement into the lease's journal and refuses one that is not an id", () => {
    expect(decodeDesktopRecipe({ ...recipe, placementId: "this-machine" }).placementId).toBe(
      "this-machine",
    );
    expect(
      decodeDesktopLeaseRequested({ ...requested, placementId: "own-cloud" }).placementId,
    ).toBe("own-cloud");
    for (const placementId of ["", "This Machine", "../cloud", "a".repeat(65)]) {
      expect(() => decodeDesktopRecipe({ ...recipe, placementId })).toThrow();
    }
  });

  it("records the daemon a lease used by its home-relative socket and user, never a path out of home", () => {
    const daemon = { socketPath: ".cua/cua.sock", userId: 1000 };
    expect(decodeDesktopLeaseRequested({ ...requested, daemon }).daemon).toEqual(daemon);
    for (const socketPath of ["/home/a/.cua/cua.sock", "../x.sock", ".cua/../x", "", "a//b"]) {
      expect(() =>
        decodeDesktopLeaseRequested({ ...requested, daemon: { ...daemon, socketPath } }),
      ).toThrow();
    }
    expect(() =>
      decodeDesktopLeaseRequested({ ...requested, daemon: { ...daemon, token: "secret" } }),
    ).toThrow();
  });

  it("offers a provider's placements and whether a daemon holds its sign-in", () => {
    const offered = decodeLeasableDesktopProvider({
      providerId: "cua",
      displayName: "Cua Spaces",
      locality: "host-local",
      billed: false,
      daemon: true,
      placements: [
        {
          placementId: "this-machine",
          displayName: "This computer",
          locality: "host-local",
          billed: false,
        },
        {
          placementId: "other-machine",
          displayName: "Your other computer",
          locality: "cloud",
          billed: false,
          choosesMachine: true,
        },
      ],
    });
    expect(offered.placements?.[0]?.placementId).toBe("this-machine");
    expect(offered.placements?.[1]?.choosesMachine).toBe(true);
    expect(() => decodeLeasableDesktopProvider({ ...offered, daemon: false })).toThrow();
  });

  it("attributes a release a person asked for while teardown records the transition", () => {
    const transitioned = decodeDesktopLeaseTransitioned({
      leaseId,
      owner: { mode: "work", threadId },
      providerId: "host-local",
      from: "ready",
      to: "releasing",
      endReason: "released",
      requestedBy: { kind: "local-user", actorId: "d1000000-0000-4000-8000-000000000005" },
    });
    expect(transitioned.requestedBy?.kind).toBe("local-user");
  });

  it("journals a transfer's path, size, and SHA-256 and nothing of its contents", () => {
    const sent = {
      leaseId,
      owner: { mode: "code", threadId },
      providerId: "host-local",
      path: "dist/app.AppImage",
      name: "app.AppImage",
      size: 1_024,
      sha256: "a".repeat(64),
    } as const;
    expect(decodeDesktopArtifactSent(sent).sha256).toBe("a".repeat(64));
    expect(() => decodeDesktopArtifactSent({ ...sent, bytes: "AAAA" })).toThrow();
    expect(() => decodeDesktopArtifactSent({ ...sent, sha256: "A".repeat(64) })).toThrow();
    expect(() => decodeDesktopArtifactSent({ ...sent, name: "dist/app" })).toThrow();
    expect(() =>
      decodeDesktopArtifactSent({ ...sent, size: DESKTOP_ARTIFACT_MAXIMUM_BYTES + 1 }),
    ).toThrow();
  });

  it("journals which input an operator sent and refuses the text or key it carried", () => {
    const operated = {
      leaseId,
      owner: { mode: "code", threadId },
      providerId: "host-local",
      operation: "launch",
      appId: "notes-app",
    } as const;
    expect(decodeDesktopLeaseOperated(operated)).toEqual(operated);
    expect(() =>
      decodeDesktopLeaseOperated({ ...operated, operation: "type", text: "secret" }),
    ).toThrow();
    expect(() => decodeDesktopLeaseOperated({ ...operated, operation: "observe" })).toThrow();
  });

  it("names a send's desktop destination by its lease id alone", () => {
    expect(decodeComputerUseDestinationSelection({ kind: "desktop-lease", leaseId })).toEqual({
      kind: "desktop-lease",
      leaseId,
    });
    expect(() =>
      decodeComputerUseDestinationSelection({ kind: "desktop-lease", leaseId, providerId: "x" }),
    ).toThrow();
    expect(() => decodeComputerUseDestinationSelection({ kind: "this-mac" })).toThrow();
  });

  it("takes a Desktop tab's request with no person in it, so the host names who sent it", () => {
    const viewId = "d1000000-0000-4000-8000-000000000005";
    const input = {
      kind: "input",
      threadId,
      leaseId,
      viewId,
      event: { kind: "pointer", action: "down", button: "left", x: 10, y: 20 },
    } as const;
    expect(decodeDesktopPaneRequest(input)).toEqual(input);
    expect(() => decodeDesktopPaneRequest({ ...input, windowId: threadId })).toThrow();
    expect(() =>
      decodeDesktopPaneRequest({ ...input, actor: { kind: "agent", actorId: threadId } }),
    ).toThrow();
    expect(() =>
      decodeDesktopPaneRequest({ kind: "extend", threadId, leaseId, byMinutes: 0 }),
    ).toThrow();
  });

  it("names the person's machine in a recipe, its lease, and a person's confirmation, and refuses one that is not an id", () => {
    const machine = { machineId: "m-7f3a", displayName: "spare mini" };
    expect(decodeDesktopRecipe({ ...recipe, machine }).machine).toEqual(machine);
    expect(decodeDesktopLeaseRequested({ ...requested, machine }).machine).toEqual(machine);
    expect(
      decodeDesktopPaneRequest({ kind: "acquire", threadId, confirmedMachine: "m-7f3a" }),
    ).toMatchObject({ confirmedMachine: "m-7f3a" });
    for (const machineId of ["", "../m", "-m", "m/7", "a".repeat(129)]) {
      expect(() =>
        decodeDesktopRecipe({ ...recipe, machine: { ...machine, machineId } }),
      ).toThrow();
    }
    expect(() =>
      decodeDesktopRecipe({ ...recipe, machine: { ...machine, token: "secret" } }),
    ).toThrow();
  });

  it("lists the person's machines for the recipe editor, at most 64", () => {
    const machine = { machineId: "m-7f3a", displayName: "spare mini", online: true };
    expect(
      decodeDesktopPaneRequest({
        kind: "recipe-machines",
        providerId: "cua",
        placementId: "other-machine",
      }),
    ).toMatchObject({ kind: "recipe-machines" });
    expect(decodeDesktopPaneAnswer({ status: "recipe-machines", machines: [machine] })).toEqual({
      status: "recipe-machines",
      machines: [machine],
    });
    expect(() =>
      decodeDesktopPaneAnswer({
        status: "recipe-machines",
        machines: Array.from({ length: 65 }, () => machine),
      }),
    ).toThrow();
  });

  it("takes a recipe key only as a trimmed value the credential store accepts, and a journal marker never holds one", () => {
    expect(decodeDesktopRecipeKeyChange({ action: "enter", key: "e2b_abc" })).toEqual({
      action: "enter",
      key: "e2b_abc",
    });
    expect(decodeDesktopRecipeKeyChange({ action: "remove" })).toEqual({ action: "remove" });
    for (const refused of [
      { action: "enter", key: "" },
      { action: "enter", key: " e2b_abc" },
      { action: "enter", key: "k".repeat(DESKTOP_RECIPE_KEY_MAXIMUM_BYTES + 1) },
      { action: "remove", key: "e2b_abc" },
    ]) {
      expect(() => decodeDesktopRecipeKeyChange(refused)).toThrow();
    }
    expect(
      decodeProjectCommand({
        kind: "change-code-project-desktop-recipe",
        projectId: threadId,
        expectedVersion: 2,
        recipe,
        key: { action: "enter", key: "e2b_abc" },
      }),
    ).toMatchObject({ key: { action: "enter" } });

    const transition = {
      leaseId,
      owner: { mode: "code", threadId },
      providerId: "cloud.example",
      from: "provisioning",
      to: "refused",
    } as const;
    expect(
      decodeDesktopLeaseTransitioned({ ...transition, credentialRejected: true }),
    ).toMatchObject({ credentialRejected: true });
    expect(
      decodeDesktopLeaseTransitioned({ ...transition, credentialMissing: true }),
    ).toMatchObject({ credentialMissing: true });
    expect(() =>
      decodeDesktopLeaseTransitioned({ ...transition, credentialRejected: "e2b_abc" }),
    ).toThrow();
    expect(
      decodeDesktopPaneAnswer({ status: "recipe-key", key: "rejected", store: "available" }),
    ).toEqual({ status: "recipe-key", key: "rejected", store: "available" });
    expect(
      decodeDesktopPaneAnswer({
        status: "recipe-key",
        key: "none",
        store: "available",
        releasing: true,
      }),
    ).toMatchObject({ releasing: true });
    expect(() =>
      decodeDesktopPaneAnswer({
        status: "recipe-key",
        key: "none",
        store: "available",
        releasing: false,
      }),
    ).toThrow();
    expect(() =>
      decodeDesktopPaneAnswer({
        status: "recipe-key",
        key: "saved",
        store: "available",
        credential: "e2b_abc",
      }),
    ).toThrow();
  });

  it("answers a view refusal apart from the lease's own refusals", () => {
    expect(decodeDesktopPaneAnswer({ status: "refused", reason: "view-ended" })).toEqual({
      status: "refused",
      reason: "view-ended",
    });
    expect(decodeDesktopPaneAnswer({ status: "refused", reason: "session-readable" })).toEqual({
      status: "refused",
      reason: "session-readable",
    });
    expect(() => decodeDesktopPaneAnswer({ status: "refused", reason: "stream-lost" })).toThrow();
  });
});

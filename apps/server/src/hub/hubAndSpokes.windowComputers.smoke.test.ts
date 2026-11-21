// A hub and three spokes in one process, each the real remote gateway behind a
// real TLS listener serving a certificate it made itself. A desktop window on
// spoke A runs the client runtime's own hub-window sync: A's loopback hub
// route asks the hub to list the window as a guest, and the window then asks
// every other member, directly, for a device of its own, and opens a session
// on each with the client runtime's federation transports. The window's
// channel stands in for the desktop's main process: it holds each origin to
// the pin A's own answer named, and to nothing the window chose. Member B
// serves the real Code route behind the real authenticated product dispatch,
// with its Act item read from B's real spoke link; only B's Code service is a
// stand-in that keeps the threads it was asked to create.

import { afterEach, describe, expect, it } from "vitest";
import {
  decodeCodeThread,
  decodeHubWindowComputers,
  decodeWindowId,
  type HubGrant,
  type HubWindowGuestRequest,
} from "@octant/contracts";
import {
  createClientHostRegistry,
  createHostFederationLifecycle,
  createHostFederationTransports,
  createHubWindowIdentityStore,
  createInMemoryClientHostRegistryStorage,
  createInMemoryDeviceKeyStore,
  syncHubWindowComputers,
  type PinnedListenerTransportPort,
} from "@octant/client-runtime";
import { createAuthenticatedProductDispatch } from "../authenticatedProductRoutes";
import { createCodeRouteHandler } from "../codeRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { hubActScopeFromSpokeLink } from "./hubActScope";
import { createHubAdministrationRouteHandler } from "./hubAdministrationRoutes";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { publicKeyFingerprint } from "./hubCrypto";
import { createPinnedHubTransport } from "./pinnedHubTransport";
import {
  TailscaleCertificateService,
  createTailscaleCertificateSetting,
} from "./tailscaleCertificate";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const secret = "desktop-secret";
const ACT_PROJECT = "00000000-0000-4000-8000-000000000906";
const OTHER_PROJECT = "30000000-0000-4000-8000-0000000000aa";
const OTHER_THREAD = "00000000-0000-4000-8000-0000000009a2";
const now = "2026-07-20T22:00:00.000Z";
const thread = decodeCodeThread({
  id: "00000000-0000-4000-8000-000000000902",
  projectId: ACT_PROJECT,
  bindingRevisionId: "00000000-0000-4000-8000-000000000907",
  repositoryId: `repo_${"b".repeat(64)}`,
  checkoutId: "00000000-0000-4000-8000-000000000903",
  title: "Started from another computer",
  lifecycle: "active",
  providerInstanceId: "00000000-0000-4000-8000-000000000908",
  modelId: "model-a",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/from-another-computer",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "main",
    outcomeKind: "opened-pr",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});

async function joinSpoke(hub: HubTestHost, spoke: HubTestHost) {
  const minted = hub.hub.mintJoinCode({ owner: false });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await spoke.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const [pending] = hub.administration.listPendingPairings();
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await spoke.spoke.finishJoin(window);
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

/** The loopback hub routes a desktop window on this host reaches through main. */
function hubAdministration(host: HubTestHost) {
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  return createHubAdministrationRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    hub: host.hub,
    spoke: host.spoke,
    pairedMergeUnlock: host.pairedMergeUnlock,
    ownerApprovalAnswerUnlock: host.ownerApprovalAnswerUnlock,
    failover: host.failover,
    wake: host.wake,
    spokeWake: host.spokeWake,
    push: host.push,
    spokePush: host.spokePush,
    directPush: host.directPush,
    provision: host.provision,
    spokeProvision: host.spokeProvision,
    signIn: host.signIn,
    spokeSignIn: host.spokeSignIn,
    certificate: new TailscaleCertificateService({
      setting: createTailscaleCertificateSetting(host.directory),
      daemon: {
        certificateFor: async () => ({ status: "unavailable", kind: "daemon-not-reachable" }),
      },
      sink: {
        install: async () => ({ status: "refused", kind: "could-not-apply" }),
        remove: async () => ({ status: "removed" }),
        holdsCertificate: () => false,
      },
      listener: () => host.listener,
      now: Date.now,
    }),
  });
}

/**
 * A desktop window on `host`: its federation stack, and a channel that holds
 * each origin to the pin the host's own answer named, as the desktop's main
 * process does. The window names no pin.
 */
function desktopWindow(host: HubTestHost, network: HubTestNetwork) {
  const administration = hubAdministration(host);
  const pins = new Map<string, string>();
  const pinned = createPinnedHubTransport(network.network);
  const channelFetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const pin = pins.get(new URL(url).origin);
    if (pin === undefined) throw new Error("Octant isn't paired with that computer.");
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    // A session request signs its body as bytes; the pinned transport sends text.
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : undefined;
    return pinned({ origin: new URL(url).origin, pin })(url, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      headers,
      ...(body === undefined ? {} : { body }),
      ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
    });
  };
  const transport: PinnedListenerTransportPort = () => ({
    status: "available",
    fetch: channelFetch,
  });
  const storage = createInMemoryClientHostRegistryStorage();
  const registry = createClientHostRegistry(storage);
  const deviceKeyStore = createInMemoryDeviceKeyStore();
  const transports = createHostFederationTransports({
    registry,
    deviceKeyStore,
    fetch: channelFetch,
  });
  const lifecycle = createHostFederationLifecycle({ registry, transports, deviceKeyStore });
  const introductions: HubWindowGuestRequest[] = [];
  const sync = async () => {
    const outcome = await syncHubWindowComputers({
      introduce: async (request) => {
        introductions.push(request);
        const response = await administration(
          new Request("http://127.0.0.1/api/desktop/hub/window-guest", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-octant-desktop-secret": secret,
              "x-octant-window-capability": capability,
            },
            body: JSON.stringify(request),
          }),
        );
        if (response === undefined) throw new Error("No hub administration route answered.");
        const answer = decodeHubWindowComputers(await response.json());
        // Main keeps a pin only for the members the host itself named.
        pins.clear();
        if (answer.membership === "member") {
          for (const member of answer.members) pins.set(member.origin, member.pin);
        }
        return answer;
      },
      transport,
      registry,
      deviceKeyStore,
      identity: createHubWindowIdentityStore(storage),
      deviceLabel: `${host.name} window`,
      removeHost: (hostId) => lifecycle.removeLocal(hostId),
      retryDelay: async () => undefined,
    });
    await lifecycle.sync();
    return outcome;
  };
  return { sync, registry, transports, lifecycle, introductions };
}

/** B's Code route as production builds it, over a Code service that keeps the threads it starts. */
function memberCodeRoutes(member: { current?: HubTestHost }) {
  const started: Array<{ readonly projectId: string }> = [];
  const operated: Array<{ readonly kind: string; readonly threadId: string }> = [];
  const routes = createCodeRouteHandler({
    service: {
      navigation: async () => ({ threads: started, activity: [], runtime: [] }),
      execute: async (_window: unknown, command: { readonly kind: string; thread?: unknown }) => {
        if (command.kind === "create-code-thread") {
          started.push(command.thread as { readonly projectId: string });
        }
        return { kind: "thread-created" };
      },
      // B's two threads: this file's in the named Project, the other outside it.
      read: async (_window: unknown, threadId: string) => ({
        thread: threadId === OTHER_THREAD ? { ...thread, projectId: OTHER_PROJECT } : thread,
        checkout: { checkoutId: thread.checkoutId },
        lastSequence: 0,
      }),
      executeOperation: async (
        _window: unknown,
        operation: {
          readonly kind: string;
          readonly threadId: string;
          readonly operationId: string;
        },
      ) => {
        operated.push({ kind: operation.kind, threadId: operation.threadId });
        return { kind: "operation-accepted", operationId: operation.operationId };
      },
    } as never,
    windowAuthorityStore: new WindowAuthorityStore(),
    hubActScope: () =>
      member.current === undefined ? undefined : hubActScopeFromSpokeLink(member.current.spoke),
  });
  const productDispatch = createAuthenticatedProductDispatch({
    dispatch: (request) => routes(request),
  });
  return { started, operated, productDispatch };
}

async function startWorld() {
  const network = new HubTestNetwork();
  const bHost: { current?: HubTestHost } = {};
  const bCode = memberCodeRoutes(bHost);
  const hub = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.102.103",
    network,
    cleanups,
  });
  const a = await startHubTestHost({
    name: "Laptop",
    address: "100.101.102.104",
    network,
    cleanups,
  });
  const b = await startHubTestHost({
    name: "Studio",
    address: "100.101.102.105",
    network,
    cleanups,
    productDispatch: bCode.productDispatch,
  });
  bHost.current = b;
  const c = await startHubTestHost({
    name: "Mini PC",
    address: "100.101.102.106",
    network,
    cleanups,
  });
  hub.hub.enable(window);
  for (const spoke of [a, b, c]) await joinSpoke(hub, spoke);
  return { network, hub, a, b, c, bCode };
}

function grantWithAct(host: HubTestHost, actProjects: ReadonlyArray<string>): HubGrant {
  const status = host.spoke.status();
  if (status.membership === "none") throw new Error(`${host.name} is in no hub.`);
  return {
    ...status.grant,
    items: [...status.grant.items.filter((item) => item !== "act"), "act"],
    actProjects: actProjects as HubGrant["actProjects"],
  };
}

/** The devices a member holds for the window's key. */
function windowDevices(member: HubTestHost, fingerprint: string) {
  return member.administration
    .listDevices()
    .filter((device) => device.deviceKeyFingerprint === fingerprint);
}

async function readySession(desktop: ReturnType<typeof desktopWindow>, member: HubTestHost) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const remote = desktop.transports.remoteTransportFor(member.hostId);
    if (remote !== undefined) return remote;
    if (Date.now() > deadline) {
      throw new Error(`No session on ${member.name}: ${JSON.stringify(desktop.lifecycle.list())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function createIn(projectId: string): string {
  return JSON.stringify({
    kind: "create-code-thread",
    thread: { ...thread, id: crypto.randomUUID(), projectId },
  });
}

describe("a desktop window on a hub member", () => {
  it("a desktop window connected to a hub lists every other member as a computer and reaches it directly with that member's own credential", async () => {
    const { network, hub, a, b, c } = await startWorld();
    const desktop = desktopWindow(a, network);

    const outcome = await desktop.sync();

    expect(outcome).toMatchObject({ status: "synced", refused: [], unreachable: [] });
    const listed = (await desktop.registry.list()).filter((host) => host.kind === "remote");
    expect(listed.map((host) => [host.displayName, host.through]).sort()).toEqual([
      ["Mini PC", "hub"],
      ["Studio", "hub"],
    ]);
    // The hub listed the window as a guest of its own, named for A's window.
    const [asked] = desktop.introductions;
    if (asked === undefined) throw new Error("The window asked for no introduction.");
    const fingerprint = publicKeyFingerprint(asked.devicePublicKey);
    const guest = hub.hub
      .status()
      .roster?.roster.members.find((member) => member.identityKeyFingerprint === fingerprint);
    expect(guest).toMatchObject({ role: "guest", name: "Laptop window" });
    // Each member issued its own device for the window's key, and nothing else
    // holds one: not the hub, not A.
    const onB = windowDevices(b, fingerprint);
    const onC = windowDevices(c, fingerprint);
    expect(onB).toHaveLength(1);
    expect(onC).toHaveLength(1);
    expect(onB[0]?.deviceId).not.toBe(onC[0]?.deviceId);
    expect(windowDevices(hub, fingerprint)).toEqual([]);
    expect(windowDevices(a, fingerprint)).toEqual([]);
    expect(listed.find((host) => host.displayName === "Studio")?.credential?.deviceId).toBe(
      onB[0]?.deviceId,
    );
    expect(b.records.filter((entry) => entry.change === "guest-admitted")).toHaveLength(1);

    // The sessions run between the window and each member; the hub sees none of it.
    const hubRequestsBefore = hub.requests.length;
    const onStudio = await readySession(desktop, b);
    await readySession(desktop, c);
    const read = await onStudio.authenticatedFetch({ method: "GET", path: "/api/code/navigation" });
    expect(read.status).toBe(200);
    expect(hub.requests.slice(hubRequestsBefore)).toEqual([]);

    // Asking again keeps the same devices and the same guest.
    const again = await desktop.sync();
    expect(again).toMatchObject({ status: "synced", replaced: [], removed: [] });
    expect(windowDevices(b, fingerprint)).toHaveLength(1);
    expect(
      hub.hub.status().roster?.roster.members.filter((member) => member.role === "guest"),
    ).toHaveLength(1);
  }, 60_000);

  it("lists the spokes on the hub's own window, which the hub introduces itself", async () => {
    const { network, hub } = await startWorld();
    const desktop = desktopWindow(hub, network);

    await desktop.sync();

    expect(
      (await desktop.registry.list())
        .filter((host) => host.kind === "remote")
        .map((host) => host.displayName)
        .sort(),
    ).toEqual(["Laptop", "Mini PC", "Studio"]);
    expect(hub.records.filter((entry) => entry.change === "member-added").at(-1)).toMatchObject({
      actingPrincipal: { kind: "local-window" },
    });
  }, 60_000);

  it("starts a Code thread on another member only in a Project that member's Act item names, and that member's list shows it", async () => {
    const { network, a, b, bCode } = await startWorld();
    expect(b.spoke.setGrant(grantWithAct(b, [ACT_PROJECT]), window).status).toBe("changed");
    const desktop = desktopWindow(a, network);
    await desktop.sync();
    const onStudio = await readySession(desktop, b);

    const named = await onStudio.authenticatedFetch({
      method: "POST",
      path: "/api/code/commands",
      body: createIn(ACT_PROJECT),
    });
    const unnamed = await onStudio.authenticatedFetch({
      method: "POST",
      path: "/api/code/commands",
      body: createIn(OTHER_PROJECT),
    });

    expect(named.status, await named.clone().text()).toBe(200);
    expect(unnamed.status).toBe(403);
    expect(await unnamed.json()).toMatchObject({
      message: "This computer's Act item for its hub does not name this Project.",
    });
    expect(bCode.started.map((started) => started.projectId)).toEqual([ACT_PROJECT]);
    const listed = await onStudio.authenticatedFetch({
      method: "GET",
      path: "/api/code/navigation",
    });
    expect(
      ((await listed.json()) as { threads: Array<{ projectId: string }> }).threads.map(
        (entry) => entry.projectId,
      ),
    ).toEqual([ACT_PROJECT]);
  }, 60_000);

  it("answers an approval and stops a turn on another member only in a Project that member's Act item names", async () => {
    const { network, a, b, bCode } = await startWorld();
    expect(b.spoke.setGrant(grantWithAct(b, [ACT_PROJECT]), window).status).toBe("changed");
    const desktop = desktopWindow(a, network);
    await desktop.sync();
    const onStudio = await readySession(desktop, b);
    const operate = (body: Record<string, unknown>) =>
      onStudio.authenticatedFetch({
        method: "POST",
        path: "/api/code/commands",
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          checkoutId: thread.checkoutId,
          ...body,
        }),
      });
    const approve = (threadId: string) =>
      operate({
        kind: "answer-provider-approval",
        threadId,
        approvalId: "00000000-0000-4000-8000-0000000009a3",
        decision: "approved",
      });
    const stop = (threadId: string) => operate({ kind: "cancel-provider-turn", threadId });

    const named = [await approve(thread.id), await stop(thread.id)];
    const unnamed = [await approve(OTHER_THREAD), await stop(OTHER_THREAD)];

    expect(named.map((response) => response.status)).toEqual([200, 200]);
    expect(unnamed.map((response) => response.status)).toEqual([403, 403]);
    expect(await unnamed[0]?.json()).toMatchObject({
      message: "This computer's Act item for its hub does not name this Project.",
    });
    expect(bCode.operated).toEqual([
      { kind: "answer-provider-approval", threadId: thread.id },
      { kind: "cancel-provider-turn", threadId: thread.id },
    ]);
  }, 60_000);

  it("removing the Act item refuses the next create and ends the device's open sessions on that member", async () => {
    const { network, a, b, c, bCode } = await startWorld();
    expect(b.spoke.setGrant(grantWithAct(b, [ACT_PROJECT]), window).status).toBe("changed");
    expect(c.spoke.setGrant(grantWithAct(c, [ACT_PROJECT]), window).status).toBe("changed");
    const desktop = desktopWindow(a, network);
    await desktop.sync();
    const onStudio = await readySession(desktop, b);
    const onMiniPc = await readySession(desktop, c);
    const read = { method: "GET", path: "/api/remote/auth/device" } as const;
    expect((await onStudio.authenticatedFetch(read)).status).toBe(200);

    const status = b.spoke.status();
    if (status.membership === "none") throw new Error("B is in no hub.");
    const withoutAct: HubGrant = {
      items: status.grant.items.filter((item) => item !== "act"),
      actProjects: [],
    };
    expect(b.spoke.setGrant(withoutAct, window).status).toBe("changed");

    // The session the window had open on B is over; C, whose Act item stands, is untouched.
    expect((await onStudio.authenticatedFetch(read)).status).toBe(401);
    expect((await onMiniPc.authenticatedFetch(read)).status).toBe(200);
    // The device is still B's to admit: a new session opens, and B refuses its next start.
    await desktop.transports.disconnectHost(b.hostId);
    await desktop.lifecycle.sync();
    const renewed = await readySession(desktop, b);
    const refused = await renewed.authenticatedFetch({
      method: "POST",
      path: "/api/code/commands",
      body: createIn(ACT_PROJECT),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      message:
        "This computer has not ticked Act for its hub, so a device the hub introduced cannot start threads here.",
    });
    expect(bCode.started).toEqual([]);
  }, 60_000);

  it("a member removed from the hub leaves the computer list", async () => {
    const { network, hub, a, b, c } = await startWorld();
    const desktop = desktopWindow(a, network);
    await desktop.sync();
    const [asked] = desktop.introductions;
    if (asked === undefined) throw new Error("The window asked for no introduction.");
    const fingerprint = publicKeyFingerprint(asked.devicePublicKey);

    expect((await hub.hub.removeMember({ memberId: c.hostId }, window)).status).toBe("removed");
    const after = await desktop.sync();

    expect(after).toMatchObject({ status: "synced", removed: [c.hostId] });
    expect(
      (await desktop.registry.list())
        .filter((host) => host.kind === "remote")
        .map((host) => host.displayName),
    ).toEqual(["Studio"]);

    // A member's window leaves with that member: B lets the window's device go.
    expect((await hub.hub.removeMember({ memberId: a.hostId }, window)).status).toBe("removed");
    expect(
      hub.hub
        .status()
        .roster?.roster.members.some((member) => member.identityKeyFingerprint === fingerprint),
    ).toBe(false);
    expect(windowDevices(b, fingerprint).map((device) => device.state)).toEqual(["revoked"]);
  }, 60_000);
});

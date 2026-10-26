import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { createRemoteRoutePolicy } from "../remoteRoutePolicy";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  SSH_TARGET_ROUTES,
  createSshTargetAdministrationRouteHandler,
} from "./sshTargetAdministrationRoutes";
import { SshRemoteProjectService } from "./sshRemoteProjectService";
import { SshTargetConnectionService } from "./sshTargetConnectionService";
import { openSshTargetTestStore } from "./sshTargetStore.test-support";

const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const secret = "desktop-secret";
const HOST_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

let directory: string;
const openConnections: Array<{ close(): void }> = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "octant-ssh-routes-"));
  // A client that records the probe key and refuses every session, so no
  // route here can reach a real network.
  writeFileSync(
    join(directory, "ssh"),
    `#!/bin/sh
for argument in "$@"; do
  case "$argument" in UserKnownHostsFile=*) known="\${argument#UserKnownHostsFile=}"; known="\${known#?}"; known="\${known%?}" ;; esac
done
touch "${directory}/ssh-ran"
case " $* " in *" -N "*) printf 'devbox ssh-ed25519 ${HOST_KEY}\\n' > "$known" ;; esac
exit 255
`,
    { mode: 0o700 },
  );
});

afterEach(() => {
  for (const connection of openConnections.splice(0)) connection.close();
  rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  const opened = openSshTargetTestStore(directory);
  openConnections.push(opened.connection);
  const connections = new SshTargetConnectionService({
    store: opened.store,
    buildVersion: "0.9.0",
    sshExecutable: join(directory, "ssh"),
    environment: { PATH: "/usr/bin:/bin" },
  });
  const projects = new SshRemoteProjectService({
    store: opened.store,
    connections,
    uuid: () => "55555555-5555-4555-8555-555555555555",
    clock: () => new Date().toISOString(),
  });
  return {
    connections,
    projects,
    handle: createSshTargetAdministrationRouteHandler({
      desktopBridgeSecret: secret,
      windowAuthorityStore: authority,
      connections,
      projects,
    }),
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": secret,
      "x-octant-window-capability": capability,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("SSH target administration routes", () => {
  it("probes, pins the confirmed key, and lists the target for a local window", async () => {
    const { handle, connections } = setup();
    const probed = await handle(post(SSH_TARGET_ROUTES.hostKey, { destination: "devbox" }));
    expect(probed?.status).toBe(200);
    const probe = (await probed?.json()) as { probeId: string; fingerprint: string };
    const registered = await handle(
      post(SSH_TARGET_ROUTES.register, {
        probeId: probe.probeId,
        fingerprint: probe.fingerprint,
        executorPath: "/opt/octant/bin/octant",
      }),
    );
    expect(registered?.status).toBe(200);
    // The stand-in client refuses every session, so the target is registered
    // and pinned but nothing is admitted on it.
    expect(await registered?.json()).toMatchObject({
      target: { destination: "devbox", hostKey: { publicKey: HOST_KEY } },
      fingerprint: probe.fingerprint,
      connection: "unreachable",
    });
    const listed = await handle(
      new Request(`http://127.0.0.1${SSH_TARGET_ROUTES.list}`, {
        headers: { "x-octant-desktop-secret": secret, "x-octant-window-capability": capability },
      }),
    );
    expect(await listed?.json()).toMatchObject({ targets: [{ fingerprint: probe.fingerprint }] });
    connections.close();
  });

  it("refuses registration from a paired device, a browser page, another interface, or a caller without window authority", async () => {
    const { handle } = setup();
    const body = { destination: "devbox" };
    const refused = [
      // A paired device holds no bridge secret.
      post(SSH_TARGET_ROUTES.hostKey, body, { "x-octant-desktop-secret": "" }),
      post(SSH_TARGET_ROUTES.hostKey, body, { origin: "http://127.0.0.1:5173" }),
      post(SSH_TARGET_ROUTES.hostKey, body, { "x-octant-window-capability": "B".repeat(43) }),
      new Request(`http://192.168.1.20${SSH_TARGET_ROUTES.hostKey}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(body),
      }),
    ];
    for (const request of refused) {
      expect((await handle(request))?.status).toBe(401);
    }
    const unconfigured = createSshTargetAdministrationRouteHandler({
      desktopBridgeSecret: undefined,
      windowAuthorityStore: new WindowAuthorityStore(),
      ...setup(),
    });
    expect((await unconfigured(post(SSH_TARGET_ROUTES.hostKey, body)))?.status).toBe(503);

    // The remote gateway never forwards these paths to the product routes.
    const origin = "https://octant.example:8443";
    const remote = createRemoteRoutePolicy({ origin });
    for (const path of Object.values(SSH_TARGET_ROUTES)) {
      const decision = remote.inspect(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: {
            origin,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(decision).toMatchObject({ kind: "reject", facts: { surface: "local-only" } });
    }
    expect(existsSync(join(directory, "ssh-ran"))).toBe(false);
  });

  it("refuses to bind a remote root on a target with no attested connection, and binds nothing", async () => {
    const { handle } = setup();
    const probed = await handle(post(SSH_TARGET_ROUTES.hostKey, { destination: "devbox" }));
    const probe = (await probed?.json()) as { probeId: string; fingerprint: string };
    const registered = await handle(
      post(SSH_TARGET_ROUTES.register, {
        probeId: probe.probeId,
        fingerprint: probe.fingerprint,
        executorPath: "/opt/octant/bin/octant",
      }),
    );
    if (registered === undefined) throw new Error("the route did not answer");
    const { target } = (await registered.json()) as { target: { id: string } };

    const bound = await handle(
      post(SSH_TARGET_ROUTES.bind, {
        targetId: target.id,
        remoteRoot: "/home/build/app",
        name: "App",
      }),
    );
    expect(bound?.status).toBe(409);
    expect(await bound?.json()).toEqual({
      status: "refused",
      reason: "not-admitted",
      decision: { status: "refused", reason: "target-unreachable" },
    });
    const listed = await handle(
      new Request(`http://127.0.0.1${SSH_TARGET_ROUTES.projects}`, {
        headers: { "x-octant-desktop-secret": secret, "x-octant-window-capability": capability },
      }),
    );
    expect(await listed?.json()).toEqual({ projects: [] });

    // A read names a Project; one this host never bound is not found.
    const read = await handle(
      post(SSH_TARGET_ROUTES.gitStatus, { projectId: "66666666-6666-4666-8666-666666666666" }),
    );
    expect(read?.status).toBe(404);
    // A path that climbs out of the root never reaches the service.
    expect(
      (
        await handle(
          post(SSH_TARGET_ROUTES.file, {
            projectId: "66666666-6666-4666-8666-666666666666",
            path: "../.ssh/id_ed25519",
          }),
        )
      )?.status,
    ).toBe(400);
  });

  it("refuses a destination the SSH client could read as an option before running the client", async () => {
    const { handle } = setup();
    for (const destination of ["-oProxyCommand=sh", "build@-oProxyCommand=sh", "devbox;id"]) {
      expect((await handle(post(SSH_TARGET_ROUTES.hostKey, { destination })))?.status).toBe(400);
    }
    expect(
      (
        await handle(
          post(SSH_TARGET_ROUTES.register, {
            probeId: "44444444-4444-4444-8444-444444444444",
            fingerprint: `SHA256:${"A".repeat(43)}`,
            executorPath: "/opt/octant;id",
          }),
        )
      )?.status,
    ).toBe(400);
    expect(existsSync(join(directory, "ssh-ran"))).toBe(false);
  });
});

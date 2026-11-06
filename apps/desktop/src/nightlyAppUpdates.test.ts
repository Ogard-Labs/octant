import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { decodeAppUpdateRelease, decodeAppVersion } from "@octant/contracts/app-updates";
import { decodeNightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { canonicalReleaseBytes } from "@octant/domain";
import { createFeedVerifier } from "./appUpdateFeed";
import { createNightlyAppUpdates } from "./nightlyAppUpdates";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const instance = "00000000-0000-4000-8000-000000000597";
const bootstrap = decodeNightlyWindowBootstrap({
  kind: "registered",
  protocol: 1,
  generation: 1,
  windowId: "00000000-0000-4000-8000-000000000596",
  hostOrigin: "http://127.0.0.1:13773",
  hostInstance: instance,
  capability: "A".repeat(43),
  rendererIdentity: "A".repeat(43),
  leaseMs: 15_000,
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "octant-nightly-updates-"));
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const release = decodeAppUpdateRelease({
    product: "octant-nightly",
    version: "0.1.0-preview.20261104.2",
    platform: "darwin",
    arch: "arm64",
    ring: "preview",
    url: "https://updates.example.test/Nightly.zip",
    sha256: createHash("sha256").update("fixture-artifact").digest("hex"),
    releasedAt: "2026-11-04T10:00:00.000Z",
  });
  const feed = {
    schemaVersion: 1,
    release,
    signature: sign(null, canonicalReleaseBytes(release), keys.privateKey).toString("base64"),
  };
  const listeners = new Map<string, (...args: readonly unknown[]) => void>();
  const apply = vi.fn(() => {});
  const prepare = vi.fn(
    async (): Promise<{ readonly kind: "closed" | "failed" }> => ({ kind: "closed" }),
  );
  const recover = vi.fn(async (_message: string) => {});
  const current = vi.fn(() => true);
  const canApply = vi.fn(() => true);
  const fetchActivity = vi.fn<typeof fetch>(async () =>
    Response.json({
      product: "Octant",
      status: "ok",
      storage: "ready",
      instanceId: instance,
      activeAgentCount: 0,
    }),
  );
  const fetchImpl = vi.fn<typeof fetch>(async (input) =>
    String(input).includes(".json") ? Response.json(feed) : new Response("fixture-artifact"),
  );
  const options = {
    userDataDirectory: directory,
    prepare,
    recover,
    canApply,
    fetchActivity,
    service: {
      updater: {
        setFeedURL: () => {},
        checkForUpdates: () => {},
        quitAndInstall: apply,
        on: (event: string, listener: (...args: readonly unknown[]) => void) => {
          listeners.set(event, listener);
        },
      },
      app: {
        version: decodeAppVersion("0.1.0-preview.20261104.1"),
        platform: "darwin",
        arch: "arm64",
      },
      feedBaseUrl: "https://updates.example.test",
      fetchImpl,
      verifier: createFeedVerifier({
        stable: [publicKey],
        preview: [publicKey],
        candidate: [publicKey],
      }),
      schedule: () => () => {},
    },
  };
  const updates = await createNightlyAppUpdates(options);
  cleanups.push(async () => {
    updates.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    updates,
    options,
    directory,
    prepare,
    recover,
    apply,
    current,
    canApply,
    fetchActivity,
    fetchImpl,
    ready: async () => {
      expect((await updates.check()).status).toBe("available");
      expect((await updates.download()).status).toBe("downloading");
      listeners.get("update-downloaded")?.();
      expect(updates.state().status).toBe("ready");
    },
    install: () => updates.install({ bootstrap, current }),
  };
}

it("persists only Nightly's own automatic choice on its one ring without starting a check", async () => {
  const f = await fixture();
  expect(f.updates.state()).toMatchObject({
    ring: "preview",
    automaticChecks: false,
    allowedRings: ["preview"],
  });
  await Promise.all([f.updates.setAutomatic(true), f.updates.setRing("preview")]);
  expect(JSON.parse(await readFile(join(f.directory, "update-preferences.json"), "utf8"))).toEqual({
    ring: "preview",
    automaticChecks: true,
  });
  const reopened = await createNightlyAppUpdates(f.options);
  expect(reopened.state()).toMatchObject({ ring: "preview", automaticChecks: true });
  reopened.dispose();
  expect(f.fetchImpl).not.toHaveBeenCalled();
  for (const other of ["stable", "candidate"]) {
    expect((await f.updates.setRing(other)).refusal).toBe("wrong-ring");
    expect(f.updates.state().ring).toBe("preview");
  }
  expect(JSON.parse(await readFile(join(f.directory, "update-preferences.json"), "utf8"))).toEqual({
    ring: "preview",
    automaticChecks: true,
  });
});

it("follows Nightly's ring when an earlier choice stored the candidate ring", async () => {
  const f = await fixture();
  await writeFile(
    join(f.directory, "update-preferences.json"),
    JSON.stringify({ ring: "candidate", automaticChecks: true }),
  );
  const reopened = await createNightlyAppUpdates(f.options);
  expect(reopened.state()).toMatchObject({ ring: "preview", automaticChecks: true });
  reopened.dispose();
});

it("leaves automatic checks off when the stored preference names an unknown ring", async () => {
  const f = await fixture();
  await writeFile(
    join(f.directory, "update-preferences.json"),
    JSON.stringify({ ring: "stable", automaticChecks: true }),
  );
  const reopened = await createNightlyAppUpdates(f.options);
  expect(reopened.state()).toMatchObject({ ring: "preview", automaticChecks: false });
  expect(f.fetchImpl).not.toHaveBeenCalled();
  reopened.dispose();
});

it("does not adopt preferences redirected outside Nightly's own preference file", async () => {
  const f = await fixture();
  const foreign = join(f.directory, "foreign-settings.json");
  await writeFile(foreign, JSON.stringify({ ring: "preview", automaticChecks: true }));
  await symlink(foreign, join(f.directory, "update-preferences.json"));
  const reopened = await createNightlyAppUpdates(f.options);
  expect(reopened.state()).toMatchObject({ ring: "preview", automaticChecks: false });
  expect(f.fetchImpl).not.toHaveBeenCalled();
  reopened.dispose();
});

it.each([
  { instanceId: instance, activeAgentCount: 2 },
  { instanceId: instance },
  { instanceId: "another-host", activeAgentCount: 0 },
])("waits for active or unconfirmed host work before touching the client: %j", async (activity) => {
  const f = await fixture();
  await f.ready();
  f.fetchActivity.mockResolvedValueOnce(
    Response.json({ product: "Octant", status: "ok", storage: "ready", ...activity }),
  );
  expect((await f.install()).kind).toBe("wait");
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.apply).not.toHaveBeenCalled();
});

it("refuses an owner retired while the fresh activity probe is in flight", async () => {
  const f = await fixture();
  await f.ready();
  let answer: ((response: Response) => void) | undefined;
  f.fetchActivity.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  const pending = f.install();
  f.current.mockReturnValue(false);
  answer?.(
    Response.json({
      product: "Octant",
      status: "ok",
      storage: "ready",
      instanceId: instance,
      activeAgentCount: 0,
    }),
  );
  expect(await pending).toEqual({ kind: "not-ready" });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.apply).not.toHaveBeenCalled();
});

it("refuses failed client cleanup, allows recovery, and applies only after a later clean attempt", async () => {
  const f = await fixture();
  await f.ready();
  f.prepare.mockResolvedValueOnce({ kind: "failed" });
  expect(await f.install()).toEqual({ kind: "not-ready" });
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.recover).toHaveBeenCalledOnce();
  expect(await f.install()).toEqual({ kind: "installing" });
  expect(f.apply).toHaveBeenCalledOnce();
});

it("lets person quit supersede apply while cleanup is pending", async () => {
  const f = await fixture();
  await f.ready();
  let finish: (() => void) | undefined;
  f.prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ kind: "closed" });
      }),
  );
  const pending = f.install();
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  f.canApply.mockReturnValue(false);
  finish?.();
  expect(await pending).toEqual({ kind: "not-ready" });
  expect(f.apply).not.toHaveBeenCalled();
});

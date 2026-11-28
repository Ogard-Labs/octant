import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { AppUpdateRelease, AppVersion } from "@octant/contracts/app-updates";
import type {
  DesktopHostUpdatePending,
  DesktopHostUpdateReport,
} from "@octant/contracts/host-update";
import { canonicalReleaseBytes } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { createFeedVerifier } from "./appUpdateFeed";
import { createAppUpdateService, type AppUpdaterPort } from "./appUpdateService";
import { DesktopRemoteUpdateController } from "./desktopRemoteUpdateController";

function createFakeUpdater() {
  const listeners = new Map<string, Array<(...args: readonly unknown[]) => void>>();
  const quitAndInstall = vi.fn();
  const port: AppUpdaterPort = {
    setFeedURL: () => undefined,
    checkForUpdates: () => {
      queueMicrotask(() => {
        for (const listener of listeners.get("update-downloaded") ?? []) listener();
      });
    },
    quitAndInstall,
    on: (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
  };
  return { port, quitAndInstall };
}

describe("DesktopRemoteUpdateController", () => {
  it("runs signed appUpdateService checks and holds relaunch via resolveUpdateInstallReadiness while agents are running", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const artifactBytes = Buffer.from("signed-desktop-zip-bytes");
    const artifactUrl = "https://updates.octant.example/artifacts/octant-0.2.0.zip";
    const release: AppUpdateRelease = {
      version: "0.2.0" as AppVersion,
      platform: "darwin",
      arch: "arm64",
      product: "octant",
      ring: "stable",
      url: artifactUrl,
      sha256: createHash("sha256").update(artifactBytes).digest("hex"),
      releasedAt: "2026-11-28T12:00:00.000Z",
    } as AppUpdateRelease;
    const feedDoc = {
      schemaVersion: 1,
      release,
      signature: sign(null, canonicalReleaseBytes(release), privateKey).toString("base64"),
    };
    const fakeUpdater = createFakeUpdater();
    const updates = createAppUpdateService({
      updater: fakeUpdater.port,
      feedBaseUrl: "https://updates.octant.example",
      app: {
        version: "0.1.0" as AppVersion,
        platform: "darwin",
        arch: "arm64",
        product: "octant",
      },
      automaticChecks: false,
      ring: "stable",
      verifier: createFeedVerifier({ stable: [publicKeyBase64], candidate: [], preview: [] }),
      fetchImpl: async (input) => {
        if (String(input) === artifactUrl) {
          return new Response(new Uint8Array(artifactBytes), { status: 200 });
        }
        return new Response(JSON.stringify(feedDoc), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const requestId = randomUUID() as DesktopHostUpdateReport["requestId"];
    let pending: DesktopHostUpdatePending = {
      pending: { requestId, action: "prepare", expectedCurrentVersion: "0.1.0" },
    };
    let activeAgentCount = 2;
    const reports: DesktopHostUpdateReport[] = [];

    const controller = new DesktopRemoteUpdateController({
      readPending: async () => pending,
      reportUpdate: async (report) => {
        reports.push(report);
      },
      updater: updates,
      readWorkInFlight: async () => ({ activeAgentCount, activityUnconfirmed: false }),
    });

    // 1. Prepare checks the signed feed and reports update-available.
    await controller.pollNow();
    expect(reports.at(-1)).toMatchObject({
      requestId,
      state: "update-available",
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
    });

    // 2. Start downloads/verifies, then once staged holds relaunch while agents are running.
    pending = {
      pending: {
        requestId,
        action: "start",
        expectedCurrentVersion: "0.1.0",
        drain: { kind: "wait", minutes: 10 },
      },
    };
    await controller.pollNow();
    expect(reports.at(-1)).toMatchObject({
      requestId,
      state: "running",
      step: "download",
    });
    // Wait for the async native updater download completion event, then poll again.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await controller.pollNow();
    expect(reports.at(-1)).toMatchObject({
      requestId,
      state: "waiting-for-work",
      activeAgentCount: 2,
      activityUnconfirmed: false,
    });
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();

    // 3. Once running work finishes, resolveUpdateInstallReadiness allows relaunch.
    activeAgentCount = 0;
    await controller.pollNow();
    expect(reports.at(-1)).toMatchObject({
      requestId,
      state: "installing",
      toVersion: "0.2.0",
    });
    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    controller.dispose();
    updates.dispose();
  });
});

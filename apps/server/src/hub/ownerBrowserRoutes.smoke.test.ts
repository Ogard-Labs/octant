import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { HubMemberId } from "@octant/contracts";
import {
  decodeOwnerBrowserResponse,
  decodeOwnerBrowserTarget,
  type OwnerBrowserTarget,
} from "@octant/contracts/owner-browser";
import { OwnerBrowserControlService } from "../browser/ownerBrowserControl";
import { HubTestNetwork, startHubTestHost } from "./hubHost.test-support";
import { ownerCall, softwareAuthenticator } from "./hubOwner.test-support";
import { HUB_OWNER_ROUTES } from "./hubOwnerRoutes";
import { publicKeyFingerprint } from "./hubCrypto";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("signed owner Browser requests", () => {
  it("requires an own-class unlock and revokes held frames and queued inputs when the owner is removed", async () => {
    let target: OwnerBrowserTarget | undefined;
    let claims = 0;
    let held = false;
    let delay = false;
    const started = Promise.withResolvers<void>();
    const capture = Promise.withResolvers<void>();
    const inputStarted = Promise.withResolvers<void>();
    const inputRelease = Promise.withResolvers<void>();
    let inputEffects = 0;
    const browser = new OwnerBrowserControlService({
      now: Date.now,
      timestamp: () => new Date().toISOString(),
      uuid: randomUUID,
      audit: () => undefined,
      host: {
        authorityCurrent: () => true,
        targets: async () =>
          target === undefined ? [] : [{ target, threadTitle: "Synthetic Code page" }],
        inspect: async () => target,
        privateHeld: () => false,
        claim: async () => {
          claims += 1;
          held = true;
          return true;
        },
        frame: async () => {
          started.resolve();
          if (delay) await capture.promise;
          return {
            status: "frame",
            frame: {
              sequence: 1,
              documentRevision: 1,
              width: 1,
              height: 1,
              dataUrl: "data:image/jpeg;base64,AA==",
            },
          };
        },
        input: async (_target, _id, _sequence, _frame, _input, signal) => {
          inputStarted.resolve();
          await inputRelease.promise;
          if (signal?.aborted) return { status: "refused" };
          inputEffects += 1;
          return { status: "input", effect: "completed" };
        },
        release: async (_target, _control, disposition) => {
          if (disposition === "hand-back") held = false;
          return { status: "released" };
        },
      },
    });
    cleanups.push(() => browser.close());
    const network = new HubTestNetwork();
    const hub = await startHubTestHost({
      name: "Synthetic Mac",
      address: "100.101.102.103",
      network,
      cleanups,
      ownerBrowser: browser,
    });
    const phone = await startHubTestHost({
      name: "Synthetic owner phone",
      address: "100.101.102.104",
      network,
      cleanups,
    });
    const principal = { kind: "local-window" } as const;
    const authenticator = softwareAuthenticator();
    hub.hub.enable(principal);
    const code = hub.hub.mintJoinCode({ owner: true });
    if (code.status !== "minted") throw new Error("Synthetic join code refused");
    expect((await phone.spoke.startJoin({ code: code.code })).status).toBe("awaiting-approval");
    const pending = hub.administration.listPendingPairings()[0];
    if (pending === undefined) throw new Error("Synthetic pairing missing");
    hub.administration.approvePairing({ ticketId: pending.ticketId });
    expect(
      (await phone.spoke.finishJoin(principal, { unlockPublicKey: authenticator.publicKey }))
        .status,
    ).toBe("joined");
    target = decodeOwnerBrowserTarget({
      hostMemberId: hub.hostId,
      threadId: randomUUID(),
      contextId: randomUUID(),
      targetVersion: "a".repeat(64),
      documentRevision: 1,
      origin: "https://fixture.invalid",
      profile: "private",
    });
    const call = (
      route: string,
      body: unknown,
      extra: Partial<Parameters<typeof ownerCall>[0]> = {},
    ) => ownerCall({ device: phone, target: hub, network, route, body, ...extra });
    const take = { kind: "take-over", target };
    expect((await call(HUB_OWNER_ROUTES.browserTakeOver, take)).status).toBe(403);
    const unlock = { authenticator, shape: "raw" } as const;
    const session = await call(HUB_OWNER_ROUTES.session, undefined, { unlock });
    const sessionId = (session.json as { readonly session: { readonly sessionId: string } }).session
      .sessionId;
    expect(
      (await call(HUB_OWNER_ROUTES.browserTakeOver, take, { session: sessionId })).status,
    ).toBe(403);
    expect(claims).toBe(0);
    const listed = await call(
      HUB_OWNER_ROUTES.browserTargets,
      { kind: "targets" },
      { session: sessionId },
    );
    expect(decodeOwnerBrowserResponse(listed.json).status).toBe("targets");
    const controlled = decodeOwnerBrowserResponse(
      (await call(HUB_OWNER_ROUTES.browserTakeOver, take, { unlock })).json,
    );
    if (controlled.status !== "controlled")
      throw new Error("Synthetic own unlock did not claim page");
    expect(claims).toBe(1);
    const frame = { kind: "frame", controlId: controlled.control.id, sequence: 1 };
    expect(
      (await call(HUB_OWNER_ROUTES.browserControl, frame, { omitIdentityKey: true })).status,
    ).toBe(401);
    delay = true;
    const response = call(HUB_OWNER_ROUTES.browserControl, frame);
    await started.promise;
    hub.hub.removeOwner(Schema.decodeUnknownSync(HubMemberId)(phone.hostId), principal);
    capture.resolve();
    expect(decodeOwnerBrowserResponse((await response).json).status).toBe("refused");
    expect(held).toBe(true);
    expect(
      hub.hub.addOwners(
        [
          {
            memberId: Schema.decodeUnknownSync(HubMemberId)(phone.hostId),
            identityKeyFingerprint: publicKeyFingerprint(phone.hostPublicKey),
            unlockKeyFingerprint: authenticator.fingerprint,
          },
        ],
        principal,
      ).status,
    ).toBe("changed");
    delay = false;
    const next = decodeOwnerBrowserResponse(
      (await call(HUB_OWNER_ROUTES.browserTakeOver, take, { unlock })).json,
    );
    if (next.status !== "controlled") throw new Error("Expected freshly reviewed second control");
    await call(HUB_OWNER_ROUTES.browserControl, {
      kind: "frame",
      controlId: next.control.id,
      sequence: 1,
    });
    const input = call(HUB_OWNER_ROUTES.browserControl, {
      kind: "input",
      controlId: next.control.id,
      sequence: 2,
      expectedFrame: 1,
      input: { kind: "press", key: "Enter" },
    });
    await inputStarted.promise;
    hub.hub.removeOwner(Schema.decodeUnknownSync(HubMemberId)(phone.hostId), principal);
    inputRelease.resolve();
    expect(decodeOwnerBrowserResponse((await input).json).status).toBe("refused");
    expect(inputEffects).toBe(0);
    expect(held).toBe(true);
  });
});

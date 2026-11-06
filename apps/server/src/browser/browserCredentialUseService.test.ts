import { describe, expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import {
  decodeBrowserCredentialCommand,
  decodeBrowserCredentialMetadata,
  decodeBrowserCredentialTarget,
  type BrowserCredentialResult,
  decodeBrowserCredentialNativeResult,
  decodeBrowserCredentialHostResult,
  type BrowserCredentialHostCommand,
} from "@octant/contracts/browser-credential-use";
import {
  createBrowserCredentialUseService,
  type BrowserCredentialUseOptions,
} from "./browserCredentialUseService";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const windowId = decodeWindowId(id(1));
const context = { contextId: id(2), threadId: id(3), mode: "code" as const };
const item = {
  store: "onepassword" as const,
  accountId: "a".repeat(26),
  vaultId: "v".repeat(26),
  itemId: "i".repeat(26),
};
function fixture(
  fill?: (
    readTarget: () => Promise<{
      readonly kind: "browser-credential-target";
      readonly target: ReturnType<typeof decodeBrowserCredentialTarget>;
    }>,
  ) => NonNullable<BrowserCredentialUseOptions["fill"]>,
  additionalOrigins: ReadonlyArray<string> = [],
) {
  let now = Date.parse("2026-11-03T10:00:00Z");
  let sequence = 10;
  let target = decodeBrowserCredentialTarget({
    ...context,
    projectId: id(4),
    profile: { kind: "project", projectId: id(4) },
    topOrigin: "https://login.example:8443",
    frame: { kind: "top", origin: "https://login.example:8443" },
  });
  let metadata = decodeBrowserCredentialMetadata({
    item,
    title: "Fixture login",
    version: 1,
    websiteOrigins: [target.topOrigin, ...additionalOrigins],
    storeRevision: "link-1",
  });
  const record = vi.fn();
  const readMetadata = vi.fn(async () => ({ status: "described" as const, metadata }));
  const readTarget = vi.fn(async () => ({ kind: "browser-credential-target" as const, target }));
  const service = createBrowserCredentialUseService({
    currentTarget: readTarget,
    ...(fill === undefined ? {} : { fill: fill(readTarget) }),
    metadata: readMetadata,
    record,
    now: () => now,
    uuid: () => id(sequence++),
  });
  const review = () =>
    service.execute(
      windowId,
      decodeBrowserCredentialCommand({ kind: "review-browser-credential", ...context, item }),
    );
  const allow = (reviewId: string, scope = "project") =>
    service.execute(
      windowId,
      decodeBrowserCredentialCommand({
        kind: "allow-browser-credential",
        ...context,
        reviewId,
        scope,
      }),
    );
  const list = () =>
    service.execute(
      windowId,
      decodeBrowserCredentialCommand({ kind: "list-browser-credential-grants", ...context }),
    );
  return {
    service,
    review,
    allow,
    list,
    record,
    readMetadata,
    readTarget,
    metadata: () => metadata,
    setMetadata: (next: unknown) => {
      metadata = decodeBrowserCredentialMetadata(next);
    },
    target: () => target,
    setTarget: (next: unknown) => {
      target = decodeBrowserCredentialTarget(next);
    },
    setNow: (next: number) => {
      now = next;
    },
  };
}
function reviewId(result: BrowserCredentialResult): string {
  if (result.kind !== "browser-credential-review") throw new Error("Expected review");
  return result.reviewId;
}

describe("explicit Browser credential filling", () => {
  it("refuses an unlisted form destination before private custody even after permission was saved", async () => {
    const host = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const f = fixture(
      (readTarget) => ({
        prepare: async () => {
          const result = decodeBrowserCredentialNativeResult({
            status: "prepared",
            planId: id(99),
            usernameLabel: "Email",
            passwordLabel: "Password",
            submissionOrigin: "https://identity.example:8443",
            expiresAt: "2026-11-03T10:03:00.000Z",
          });
          if (result.status !== "prepared") throw new Error("Expected form");
          return result;
        },
        hold: () => ({
          kind: "held",
          current: readTarget,
          signal: new AbortController().signal,
          release: () => undefined,
        }),
        host,
        cancel,
        submit: async () => ({ status: "authentication-required", effect: "completed" }),
      }),
      ["https://identity.example"],
    );
    const reviewed = await f.review();
    const allowed = await f.allow(reviewId(reviewed));
    if (allowed.kind !== "browser-credential-grants" || allowed.grants[0] === undefined)
      throw new Error("Expected grant");
    expect(
      await f.service.execute(
        windowId,
        decodeBrowserCredentialCommand({
          kind: "prepare-browser-credential-fill",
          ...context,
          grantId: allowed.grants[0].grantId,
        }),
      ),
    ).toMatchObject({ kind: "browser-credential-refused", reason: "site-mismatch" });
    expect(host).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["revoke", "cancel"])(
    "invalidates a submit still awaiting native validation when the person chooses %s",
    async (action) => {
      let finish: (() => void) | undefined;
      let cancelled = false;
      const cancel = vi.fn(async () => {
        cancelled = true;
        return { status: "cancelled" as const, effect: "none" as const };
      });
      const f = fixture(
        (readTarget) => ({
          prepare: async () => {
            const result = decodeBrowserCredentialNativeResult({
              status: "prepared",
              planId: id(99),
              usernameLabel: "Email",
              passwordLabel: "Password",
              submissionOrigin: "https://identity.example",
              expiresAt: "2026-11-03T10:03:00.000Z",
            });
            if (result.status !== "prepared") throw new Error("Expected form");
            return result;
          },
          hold: () => ({
            kind: "held",
            current: readTarget,
            signal: new AbortController().signal,
            release: () => undefined,
          }),
          host: async (command) =>
            decodeBrowserCredentialHostResult(
              command.kind === "stage-browser-credential-fill"
                ? { status: "ready", custodyId: id(90) }
                : { status: "filled", effect: "completed" },
            ),
          cancel,
          submit: async () => {
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            return cancelled
              ? { status: "cancelled", effect: "none" }
              : { status: "authentication-required", effect: "completed" };
          },
        }),
        ["https://identity.example"],
      );
      const reviewed = await f.review();
      if (reviewed.kind !== "browser-credential-review") throw new Error("Expected review");
      const allowed = await f.allow(reviewed.reviewId);
      if (allowed.kind !== "browser-credential-grants" || allowed.grants[0] === undefined)
        throw new Error("Expected grant");
      const grantId = allowed.grants[0].grantId;
      const plan = await f.service.execute(
        windowId,
        decodeBrowserCredentialCommand({
          kind: "prepare-browser-credential-fill",
          ...context,
          grantId,
        }),
      );
      if (plan.kind !== "browser-credential-fill-review") throw new Error("Expected form plan");
      await f.service.execute(
        windowId,
        decodeBrowserCredentialCommand({
          kind: "confirm-browser-credential-fill",
          ...context,
          planId: plan.planId,
        }),
      );
      const pending = f.service.execute(
        windowId,
        decodeBrowserCredentialCommand({
          kind: "submit-browser-credential-fill",
          ...context,
          planId: plan.planId,
        }),
      );
      await vi.waitFor(() => expect(finish).toBeDefined());
      const result = await f.service.execute(
        windowId,
        decodeBrowserCredentialCommand(
          action === "revoke"
            ? { kind: "revoke-browser-credential", ...context, grantId }
            : { kind: "cancel-browser-credential-fill", ...context, planId: plan.planId },
        ),
      );
      if (action === "cancel")
        expect(result).toMatchObject({ status: "cancelled", effect: "none" });
      expect(cancel).toHaveBeenCalled();
      finish?.();
      expect(await pending).toMatchObject({ status: "cancelled", effect: "none" });
    },
  );

  it("requires a current form review and a separate submit while reporting no authentication success", async () => {
    const host = vi.fn(async (command: BrowserCredentialHostCommand) =>
      decodeBrowserCredentialHostResult(
        command.kind === "stage-browser-credential-fill"
          ? { status: "ready", custodyId: id(90) }
          : command.kind === "commit-browser-credential-fill"
            ? { status: "filled", effect: "completed" }
            : { status: "cancelled", effect: "none" },
      ),
    );
    const release = vi.fn();
    const f = fixture(
      (readTarget) => ({
        prepare: async () => {
          const result = decodeBrowserCredentialNativeResult({
            status: "prepared",
            planId: id(99),
            usernameLabel: "Email",
            passwordLabel: "Password",
            submissionOrigin: "https://identity.example",
            expiresAt: "2026-11-03T10:03:00.000Z",
          });
          if (result.status !== "prepared") throw new Error("Expected plan");
          return result;
        },
        hold: () => ({
          kind: "held",
          current: readTarget,
          signal: new AbortController().signal,
          release,
        }),
        host,
        cancel: async () => undefined,
        submit: async () => ({ status: "authentication-required", effect: "completed" }),
      }),
      ["https://identity.example"],
    );
    const reviewed = await f.review();
    if (reviewed.kind !== "browser-credential-review") throw new Error("Expected review");
    const allowed = await f.allow(reviewed.reviewId);
    if (allowed.kind !== "browser-credential-grants" || allowed.grants[0] === undefined)
      throw new Error("Expected grant");
    const plan = await f.service.execute(
      windowId,
      decodeBrowserCredentialCommand({
        kind: "prepare-browser-credential-fill",
        ...context,
        grantId: allowed.grants[0].grantId,
      }),
    );
    expect(plan).toMatchObject({
      kind: "browser-credential-fill-review",
      submissionOrigin: "https://identity.example",
    });
    expect(host).not.toHaveBeenCalled();
    if (plan.kind !== "browser-credential-fill-review") throw new Error("Expected form review");
    const filled = await f.service.execute(
      windowId,
      decodeBrowserCredentialCommand({
        kind: "confirm-browser-credential-fill",
        ...context,
        planId: plan.planId,
      }),
    );
    expect(filled).toMatchObject({
      kind: "browser-credential-fill-outcome",
      status: "filled",
      effect: "completed",
    });
    expect(JSON.stringify(filled)).not.toContain("signed-in");
    expect(host.mock.calls.map(([command]) => command.kind)).toEqual([
      "stage-browser-credential-fill",
      "commit-browser-credential-fill",
    ]);
    const submitted = await f.service.execute(
      windowId,
      decodeBrowserCredentialCommand({
        kind: "submit-browser-credential-fill",
        ...context,
        planId: plan.planId,
      }),
    );
    expect(submitted).toMatchObject({ status: "authentication-required", effect: "completed" });
    expect(release).toHaveBeenCalledTimes(2);
  });
  it("cancels a private read when permission is revoked and never commits its late receipt", async () => {
    let finish: (() => void) | undefined;
    const host = vi.fn(async (command: BrowserCredentialHostCommand) => {
      if (command.kind === "stage-browser-credential-fill") {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return decodeBrowserCredentialHostResult({ status: "ready", custodyId: id(90) });
      }
      return decodeBrowserCredentialHostResult({ status: "cancelled", effect: "none" });
    });
    const f = fixture((readTarget) => ({
      prepare: async () => {
        const result = decodeBrowserCredentialNativeResult({
          status: "prepared",
          planId: id(99),
          usernameLabel: "Email",
          passwordLabel: "Password",
          submissionOrigin: "https://login.example:8443",
          expiresAt: "2026-11-03T10:03:00.000Z",
        });
        if (result.status !== "prepared") throw new Error("Expected plan");
        return result;
      },
      hold: () => ({
        kind: "held",
        current: readTarget,
        signal: new AbortController().signal,
        release: () => undefined,
      }),
      host,
      cancel: async () => undefined,
      submit: async () => ({ status: "authentication-required", effect: "completed" }),
    }));
    const review = await f.review();
    if (review.kind !== "browser-credential-review") throw new Error("Expected review");
    const allowed = await f.allow(review.reviewId);
    if (allowed.kind !== "browser-credential-grants" || allowed.grants[0] === undefined)
      throw new Error("Expected grant");
    const grantId = allowed.grants[0].grantId;
    const plan = await f.service.execute(
      windowId,
      decodeBrowserCredentialCommand({
        kind: "prepare-browser-credential-fill",
        ...context,
        grantId,
      }),
    );
    if (plan.kind !== "browser-credential-fill-review") throw new Error("Expected plan");
    const pending = f.service.execute(
      windowId,
      decodeBrowserCredentialCommand({
        kind: "confirm-browser-credential-fill",
        ...context,
        planId: plan.planId,
      }),
    );
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.service.execute(
      windowId,
      decodeBrowserCredentialCommand({ kind: "revoke-browser-credential", ...context, grantId }),
    );
    finish?.();
    expect(await pending).toMatchObject({ status: "cancelled", effect: "none" });
    expect(
      host.mock.calls.some(([command]) => command.kind === "commit-browser-credential-fill"),
    ).toBe(false);
  });
});

describe("selected Browser login permission", () => {
  it("reviews the exact metadata before journaling and reuses the Project permission across threads", async () => {
    const f = fixture();
    const reviewed = await f.review();
    expect(reviewed.kind).toBe("browser-credential-review");
    expect(f.record).not.toHaveBeenCalled();
    const result = await f.allow(reviewId(reviewed));
    expect(result.kind).toBe("browser-credential-grants");
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({ name: "browser-credential.granted" }),
    );
    f.setTarget({
      ...f.target(),
      threadId: id(5) as typeof context.threadId,
      contextId: id(6) as typeof context.contextId,
    });
    expect(await f.list()).toMatchObject({
      kind: "browser-credential-grants",
      grants: [expect.objectContaining({ kind: "browser-credential-grant" })],
    });
  });

  it("still shows an earlier permission for the page after allowing another scope", async () => {
    const f = fixture();
    await f.allow(reviewId(await f.review()));
    const result = await f.allow(reviewId(await f.review()), "task");
    expect(result).toMatchObject({
      kind: "browser-credential-grants",
      grants: [
        expect.objectContaining({ scope: expect.objectContaining({ kind: "task" }) }),
        expect.objectContaining({ scope: expect.objectContaining({ kind: "project" }) }),
      ],
    });
  });

  it("refuses a changed page after the metadata await", async () => {
    const f = fixture();
    f.readMetadata.mockImplementation(async () => {
      f.setTarget({
        ...f.target(),
        topOrigin: "https://changed.example",
        frame: { kind: "top", origin: "https://changed.example" },
      });
      return { status: "described", metadata: f.metadata() };
    });
    expect(await f.review()).toMatchObject({ kind: "browser-credential-refused", reason: "stale" });
    expect(f.record).not.toHaveBeenCalled();
  });

  it.each(["version", "storeRevision"] as const)(
    "requires a new review after metadata %s changes",
    async (field) => {
      const f = fixture();
      const reviewed = await f.review();
      f.setMetadata({ ...f.metadata(), [field]: field === "version" ? 2 : "relinked" });
      expect(await f.allow(reviewId(reviewed))).toMatchObject({
        kind: "browser-credential-refused",
        reason: "stale",
      });
      expect(f.record).not.toHaveBeenCalled();
    },
  );

  it("keeps no permission when its journal write fails", async () => {
    const f = fixture();
    const reviewed = await f.review();
    f.record.mockImplementation(() => {
      throw new Error("fixture journal failed");
    });
    expect(await f.allow(reviewId(reviewed))).toMatchObject({
      kind: "browser-credential-refused",
      reason: "journal-unavailable",
    });
    expect(await f.list()).toMatchObject({ kind: "browser-credential-grants", grants: [] });
  });

  it("expires within eight hours and never revives permission from a new host session", async () => {
    const f = fixture();
    await f.allow(reviewId(await f.review()));
    f.setNow(Date.parse("2026-11-03T18:00:00Z"));
    expect(await f.list()).toMatchObject({ kind: "browser-credential-grants", grants: [] });
    const restarted = fixture();
    expect(await restarted.list()).toMatchObject({ kind: "browser-credential-grants", grants: [] });
  });

  it("does not return a usable permission when relinking occurs during the final page check", async () => {
    const f = fixture();
    const reviewed = await f.review();
    f.readTarget
      .mockImplementationOnce(async () => ({
        kind: "browser-credential-target",
        target: f.target(),
      }))
      .mockImplementationOnce(async () => {
        f.setMetadata({ ...f.metadata(), storeRevision: "relinked-during-target-await" });
        return { kind: "browser-credential-target", target: f.target() };
      });
    const recorded = await f.allow(reviewId(reviewed));
    expect(recorded.kind).toBe("browser-credential-grants");
    expect(await f.list()).toEqual({ kind: "browser-credential-grants", grants: [] });
    expect(f.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "browser-credential.revoked", reason: "changed" }),
    );
  });

  it("records no permission when its request is cancelled during metadata inspection", async () => {
    const f = fixture();
    const reviewed = await f.review();
    const abort = new AbortController();
    f.readMetadata.mockImplementation(async () => {
      abort.abort();
      return { status: "described", metadata: f.metadata() };
    });
    const command = decodeBrowserCredentialCommand({
      kind: "allow-browser-credential",
      ...context,
      reviewId: reviewId(reviewed),
      scope: "project",
    });
    expect(await f.service.execute(windowId, command, abort.signal)).toMatchObject({
      reason: "cancelled",
    });
    expect(f.record).not.toHaveBeenCalled();
  });

  it("clears saved permissions and pending reviews when their profile is cleared", async () => {
    const f = fixture();
    await f.allow(reviewId(await f.review()));
    const pending = await f.review();
    expect(f.service.invalidateProfile(f.target().profile)).toBe(true);
    expect(await f.list()).toMatchObject({ grants: [] });
    expect(await f.allow(reviewId(pending))).toMatchObject({ reason: "expired" });
  });

  it("limits Private permission to its exact task and context", async () => {
    const f = fixture();
    f.setTarget({ ...f.target(), profile: { kind: "private" } });
    expect(await f.allow(reviewId(await f.review()))).toMatchObject({
      kind: "browser-credential-refused",
    });
    await f.allow(reviewId(await f.review()), "task");
    f.setTarget({ ...f.target(), threadId: id(5) as typeof context.threadId });
    expect(await f.list()).toMatchObject({ kind: "browser-credential-grants", grants: [] });
  });
});

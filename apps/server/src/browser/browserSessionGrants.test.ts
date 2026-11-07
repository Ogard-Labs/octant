import { describe, expect, it, vi } from "vitest";
import {
  decodeToolActionAuthority,
  decodeProviderModelId,
  decodeWindowId,
} from "@octant/contracts";
import {
  decodeBrowserSessionGrantsCommand,
  type BrowserSessionTarget,
} from "@octant/contracts/browser-session-grants";
import { BrowserSessionGrants, type CurrentBrowserSessionTarget } from "./browserSessionGrants";

const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
const otherWindow = decodeWindowId("10000000-0000-4000-8000-000000000002");
const decoded = decodeBrowserSessionGrantsCommand({
  kind: "review",
  grantee: { kind: "child", runId: "20000000-0000-4000-8000-000000000001" },
  profile: { kind: "personal" },
  origins: ["https://example.com"],
  durationMinutes: 15,
});
if (decoded.kind !== "review") throw Error("Expected fixture review");
const command = decoded;
const target: BrowserSessionTarget = {
  grantee: command.grantee,
  label: "Read the report",
  modelId: decodeProviderModelId("example-model"),
  authority: decodeToolActionAuthority({
    hostId: "30000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId: "40000000-0000-4000-8000-000000000001",
    providerInstanceId: "50000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  }),
};

function fixture() {
  let now = Date.parse("2026-11-07T10:00:00Z");
  let current: CurrentBrowserSessionTarget | undefined = { target, revision: "child-workspace-1" };
  let local = true;
  const record = vi.fn();
  const profileLabel = vi.fn(async () => "Personal");
  const onRevoked = vi.fn();
  const service = new BrowserSessionGrants({
    now: () => now,
    uuid: () => crypto.randomUUID(),
    isLocalWindow: () => local,
    canReview: (window) => String(window) === String(windowId),
    targets: () => (current === undefined ? [] : [current]),
    current: () => current,
    profileLabel,
    record,
    onRevoked,
  });
  return {
    service,
    record,
    profileLabel,
    onRevoked,
    advance: (ms: number) => {
      now += ms;
    },
    setCurrent: (value: CurrentBrowserSessionTarget | undefined) => {
      current = value;
    },
    setLocal: (value: boolean) => {
      local = value;
    },
  };
}

async function grant(f: ReturnType<typeof fixture>) {
  const review = await f.service.execute(windowId, command);
  if (review.kind !== "browser-session-review") throw Error(JSON.stringify(review));
  expect(f.service.find(command.grantee, command.profile, command.origins)).toBeUndefined();
  const result = await f.service.execute(windowId, { kind: "grant", reviewId: review.reviewId });
  if (result.kind !== "browser-session-granted") throw Error(JSON.stringify(result));
  return result.grant;
}

describe("explicit Browser session permissions", () => {
  it("withholds a review when its window is revoked while profile metadata is being read", async () => {
    const f = fixture();
    f.profileLabel.mockImplementationOnce(async () => {
      f.setLocal(false);
      return "Personal";
    });
    expect(await f.service.execute(windowId, command)).toMatchObject({
      kind: "browser-session-refused",
      reason: "stale",
    });
    expect(f.record).not.toHaveBeenCalled();
    f.service.close();
  });
  it("refuses a review that expires while the native profile is being checked", async () => {
    const f = fixture();
    try {
      const review = await f.service.execute(windowId, command);
      if (review.kind !== "browser-session-review") throw Error("Missing review");
      f.advance(2 * 60_000 - 1);
      f.profileLabel.mockImplementationOnce(async () => {
        f.advance(1);
        return "Personal";
      });
      expect(
        await f.service.execute(windowId, { kind: "grant", reviewId: review.reviewId }),
      ).toMatchObject({ kind: "browser-session-refused", reason: "stale" });
      expect(f.record).not.toHaveBeenCalled();
      expect(f.service.find(command.grantee, command.profile, command.origins)).toBeUndefined();
    } finally {
      f.service.close();
    }
  });
  it.each(["profile clear", "window revocation", "host close"] as const)(
    "refuses a pending native grant after %s invalidates its review",
    async (cause) => {
      const f = fixture();
      try {
        const review = await f.service.execute(windowId, command);
        if (review.kind !== "browser-session-review") throw Error("Missing review");
        f.profileLabel.mockImplementationOnce(async () => {
          if (cause === "profile clear") f.service.invalidateProfile(command.profile);
          if (cause === "window revocation") f.service.revokeWindow(windowId);
          if (cause === "host close") f.service.close();
          return "Personal";
        });
        expect(
          await f.service.execute(windowId, { kind: "grant", reviewId: review.reviewId }),
        ).toMatchObject({ kind: "browser-session-refused", reason: "stale" });
        expect(f.record).not.toHaveBeenCalled();
        expect(f.service.find(command.grantee, command.profile, command.origins)).toBeUndefined();
      } finally {
        f.service.close();
      }
    },
  );
  it("consumes one review only once across simultaneous native profile checks", async () => {
    const f = fixture();
    try {
      const review = await f.service.execute(windowId, command);
      if (review.kind !== "browser-session-review") throw Error("Missing review");
      const results = await Promise.all([
        f.service.execute(windowId, { kind: "grant", reviewId: review.reviewId }),
        f.service.execute(windowId, { kind: "grant", reviewId: review.reviewId }),
      ]);
      expect(results.filter((result) => result.kind === "browser-session-granted")).toHaveLength(1);
      expect(f.record).toHaveBeenCalledOnce();
    } finally {
      f.service.close();
    }
  });
  it("expires and closes permission without waiting for another agent call", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const allowed = await grant(f);
      f.advance(15 * 60_000);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(f.onRevoked).toHaveBeenCalledWith(allowed.grantId);
      expect(f.record).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "expired" }));
    } finally {
      f.service.close();
      vi.useRealTimers();
    }
  });
  it("grants only the reviewed caller, model, host, profile and HTTPS origins until expiry", async () => {
    const f = fixture();
    const allowed = await grant(f);
    expect(f.service.find(command.grantee, command.profile, command.origins)).toBe(allowed.grantId);
    expect(f.service.isCurrent(allowed.grantId, target, command.profile, command.origins)).toBe(
      true,
    );
    expect(
      f.service.isCurrent(
        allowed.grantId,
        { ...target, modelId: decodeProviderModelId("another-model") },
        command.profile,
        command.origins,
      ),
    ).toBe(false);
    expect(
      f.service.isCurrent(allowed.grantId, target, command.profile, ["https://elsewhere.example"]),
    ).toBe(false);
    expect(
      f.service.isCurrent(
        allowed.grantId,
        target,
        { kind: "project", projectId: target.authority.projectId as never },
        command.origins,
      ),
    ).toBe(false);
    f.advance(15 * 60_000);
    expect(f.service.find(command.grantee, command.profile, command.origins)).toBeUndefined();
    expect(f.onRevoked).toHaveBeenCalledWith(allowed.grantId);
    expect(f.record).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "expired" }));
  });

  it("refuses stale, foreign-window and non-local reviews without granting anything", async () => {
    const f = fixture();
    const review = await f.service.execute(windowId, command);
    if (review.kind !== "browser-session-review") throw Error("Missing review");
    expect(
      await f.service.execute(otherWindow, { kind: "grant", reviewId: review.reviewId }),
    ).toMatchObject({ kind: "browser-session-refused" });
    const another = await f.service.execute(windowId, command);
    if (another.kind !== "browser-session-review") throw Error("Missing review");
    f.setCurrent({ target, revision: "changed-workspace" });
    expect(
      await f.service.execute(windowId, { kind: "grant", reviewId: another.reviewId }),
    ).toMatchObject({ reason: "stale" });
    f.setLocal(false);
    expect(await f.service.execute(windowId, command)).toMatchObject({ reason: "not-local" });
    expect(f.record).not.toHaveBeenCalled();
  });

  it("refuses HTTP, paths and another Project profile", async () => {
    const f = fixture();
    for (const origin of [
      "http://example.com",
      "https://example.com/path",
      "https://user@example.com",
      "https://example.com?secret=1",
    ])
      expect(await f.service.execute(windowId, { ...command, origins: [origin] })).toMatchObject({
        reason: "invalid",
      });
    expect(
      await f.service.execute(windowId, {
        ...command,
        profile: { kind: "project", projectId: "40000000-0000-4000-8000-000000000002" as never },
      }),
    ).toMatchObject({ reason: "invalid" });
  });

  it("revokes on explicit removal, changed caller authority, profile clear and terminal end", async () => {
    const f = fixture();
    const allowed = await grant(f);
    expect(
      await f.service.execute(windowId, { kind: "revoke", grantId: allowed.grantId }),
    ).toMatchObject({ kind: "browser-session-revoked" });
    expect(f.service.isCurrent(allowed.grantId, target, command.profile, command.origins)).toBe(
      false,
    );
    const second = await grant(f);
    f.setCurrent(undefined);
    expect(f.service.isCurrent(second.grantId, target, command.profile, command.origins)).toBe(
      false,
    );
    f.setCurrent({ target, revision: "child-workspace-1" });
    const third = await grant(f);
    f.service.invalidateProfile(command.profile);
    expect(f.service.isCurrent(third.grantId, target, command.profile, command.origins)).toBe(
      false,
    );
    expect(f.onRevoked).toHaveBeenCalledTimes(3);
  });

  it("fails closed when grant recording fails and revokes even if its audit write fails", async () => {
    const f = fixture();
    const allowed = await grant(f);
    f.record.mockImplementation(() => {
      throw Error("disk full");
    });
    expect(
      await f.service.execute(windowId, { kind: "revoke", grantId: allowed.grantId }),
    ).toMatchObject({ reason: "record-failed" });
    expect(f.service.find(command.grantee, command.profile, command.origins)).toBeUndefined();
    const review = await f.service.execute(windowId, command);
    if (review.kind !== "browser-session-review") throw Error("Missing review");
    expect(
      await f.service.execute(windowId, { kind: "grant", reviewId: review.reviewId }),
    ).toMatchObject({ reason: "record-failed" });
    expect(f.service.find(command.grantee, command.profile, command.origins)).toBeUndefined();
  });
});

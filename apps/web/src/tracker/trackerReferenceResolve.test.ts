import { describe, expect, it, vi } from "vitest";
import type { TrackerReference } from "@octant/contracts";
import {
  githubUnavailableReason,
  linearFailureToLookup,
  linearStateToChipState,
  resolveTrackerReferences,
  trackerReferenceIdentity,
  type TrackerReferenceResolvePorts,
} from "./trackerReferenceResolve";

const githubReference: TrackerReference = {
  patternKind: "github-issue-or-pull",
  raw: "octant/octant#12",
  owner: "octant",
  name: "octant",
  number: 12,
};

const trackerKeyReference: TrackerReference = {
  patternKind: "tracker-key",
  raw: "#ABC-99",
  key: "ABC-99",
};

describe("resolveTrackerReferences", () => {
  it("resolves a GitHub issue through the catalogue port when issues-read is available", async () => {
    const readIssue = vi.fn(async () => ({
      kind: "resolved" as const,
      title: "Ship the catalogue",
      url: "https://github.com/octant/octant/issues/12",
      state: "open" as const,
    }));
    const ports: TrackerReferenceResolvePorts = {
      github: { available: true, readIssue },
    };
    await expect(resolveTrackerReferences([githubReference], ports)).resolves.toEqual([
      {
        status: "resolved",
        reference: githubReference,
        kind: "issue",
        title: "Ship the catalogue",
        url: "https://github.com/octant/octant/issues/12",
        state: "open",
      },
    ]);
    expect(readIssue).toHaveBeenCalledWith({
      owner: "octant",
      name: "octant",
      number: 12,
    });
  });

  it("leaves a GitHub tag as unclaimed when issues-read is not available", async () => {
    const readIssue = vi.fn();
    const ports: TrackerReferenceResolvePorts = {
      github: { available: false, readIssue },
    };
    await expect(resolveTrackerReferences([githubReference], ports)).resolves.toEqual([
      { status: "unclaimed", reference: githubReference },
    ]);
    expect(readIssue).not.toHaveBeenCalled();
  });

  it("fails closed to unavailable when GitHub reports a rate limit", async () => {
    const ports: TrackerReferenceResolvePorts = {
      github: {
        available: true,
        readIssue: async () => ({ kind: "unavailable", reason: "rate-limited" }),
      },
    };
    await expect(resolveTrackerReferences([githubReference], ports)).resolves.toEqual([
      {
        status: "unavailable",
        reference: githubReference,
        reason: "rate-limited",
      },
    ]);
  });

  it("resolves a tracker-key tag through Linear when the integration is available", async () => {
    const getIssue = vi.fn(async () => ({
      kind: "resolved" as const,
      title: "Read-only chip",
      url: "https://linear.app/example/issue/ABC-99",
      state: "open" as const,
    }));
    const ports: TrackerReferenceResolvePorts = {
      linear: { available: true, getIssue },
    };
    await expect(resolveTrackerReferences([trackerKeyReference], ports)).resolves.toEqual([
      {
        status: "resolved",
        reference: trackerKeyReference,
        kind: "issue",
        title: "Read-only chip",
        url: "https://linear.app/example/issue/ABC-99",
        state: "open",
      },
    ]);
    expect(getIssue).toHaveBeenCalledWith("ABC-99");
  });

  it("leaves a tracker-key tag as unclaimed when Linear is disconnected", async () => {
    const getIssue = vi.fn();
    const ports: TrackerReferenceResolvePorts = {
      linear: { available: false, getIssue },
    };
    await expect(resolveTrackerReferences([trackerKeyReference], ports)).resolves.toEqual([
      { status: "unclaimed", reference: trackerKeyReference },
    ]);
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("maps a missing Linear issue to not-found without inventing a title", async () => {
    const ports: TrackerReferenceResolvePorts = {
      linear: {
        available: true,
        getIssue: async () => ({ kind: "not-found" }),
      },
    };
    await expect(resolveTrackerReferences([trackerKeyReference], ports)).resolves.toEqual([
      { status: "not-found", reference: trackerKeyReference },
    ]);
  });

  it("refuses resolved lookups whose url is not http(s)", async () => {
    const ports: TrackerReferenceResolvePorts = {
      linear: {
        available: true,
        getIssue: async () => ({
          kind: "resolved",
          title: "Unsafe href",
          url: "javascript:alert(1)",
          state: "open",
        }),
      },
    };
    await expect(resolveTrackerReferences([trackerKeyReference], ports)).resolves.toEqual([
      {
        status: "unavailable",
        reference: trackerKeyReference,
        reason: "unavailable",
      },
    ]);
  });
});

describe("tracker reference helpers", () => {
  it("keys GitHub and tracker-key identities independently of display raw text", () => {
    expect(trackerReferenceIdentity(githubReference)).toBe("github:octant/octant#12");
    expect(trackerReferenceIdentity(trackerKeyReference)).toBe("tracker:ABC-99");
    expect(
      trackerReferenceIdentity({
        patternKind: "tracker-key",
        raw: "ABC-99",
        key: "ABC-99",
      }),
    ).toBe("tracker:ABC-99");
  });

  it("maps Linear workflow types onto the open/closed chip states", () => {
    expect(linearStateToChipState("started")).toBe("open");
    expect(linearStateToChipState("completed")).toBe("closed");
    expect(linearStateToChipState("canceled")).toBe("closed");
  });

  it("maps Linear failure reasons onto closed lookup outcomes", () => {
    expect(linearFailureToLookup("That Linear issue is not available.")).toEqual({
      kind: "not-found",
    });
    expect(linearFailureToLookup("Linear is rate limited. Try again in a moment.")).toEqual({
      kind: "unavailable",
      reason: "rate-limited",
    });
    expect(linearFailureToLookup("Connect Linear to authorize this host.")).toEqual({
      kind: "unavailable",
      reason: "unauthorized",
    });
  });

  it("narrows GitHub catalogue reasons that the tracker contract does not name", () => {
    expect(githubUnavailableReason("unauthorized")).toBe("unauthorized");
    expect(githubUnavailableReason("insecure-storage")).toBe("unavailable");
    expect(githubUnavailableReason("external-token")).toBe("unavailable");
  });
});

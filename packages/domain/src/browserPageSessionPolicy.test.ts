import { describe, expect, it } from "vitest";
import {
  browserPageOfferProfile,
  browserPageProfileFacts,
  chooseBrowserPageOffers,
  isRecordedBrowserSession,
} from "./browserPageSessionPolicy";

const person = {
  mode: "code",
  dedicated: false,
  hostRun: false,
  unattended: false,
  terminalGrant: false,
} as const;

describe("browser session recording", () => {
  it("records only the person's own page in a thread's Browser pane", () => {
    expect(isRecordedBrowserSession(person)).toBe(true);
    expect(isRecordedBrowserSession({ ...person, mode: "work" })).toBe(true);
    expect(isRecordedBrowserSession({ ...person, mode: "chat" })).toBe(false);
    expect(isRecordedBrowserSession({ ...person, dedicated: true })).toBe(false);
    expect(isRecordedBrowserSession({ ...person, hostRun: true })).toBe(false);
    expect(isRecordedBrowserSession({ ...person, unattended: true })).toBe(false);
    expect(isRecordedBrowserSession({ ...person, terminalGrant: true })).toBe(false);
  });

  it("keeps only the profile kind, and an account's own id", () => {
    const accountId = "11111111-1111-4111-8111-111111111111" as never;
    expect(browserPageProfileFacts(undefined)).toEqual({ profileKind: "private" });
    expect(browserPageProfileFacts({ kind: "private" })).toEqual({ profileKind: "private" });
    expect(browserPageProfileFacts({ kind: "personal" })).toEqual({ profileKind: "personal" });
    expect(browserPageProfileFacts({ kind: "project", projectId: "p" as never })).toEqual({
      profileKind: "project",
    });
    expect(browserPageProfileFacts({ kind: "account", profileId: accountId })).toEqual({
      profileKind: "account",
      accountId,
    });
  });

  it("names the profile a blank page opens in from the record", () => {
    const projectId = "p" as never;
    expect(browserPageOfferProfile({ profileKind: "project", projectId })).toEqual({
      kind: "project",
      projectId,
    });
    expect(browserPageOfferProfile({ profileKind: "private", projectId })).toEqual({
      kind: "private",
    });
  });

  it("offers the newest page of a thread and supersedes the older ones", () => {
    const pages = [
      { pageId: "a", threadId: "t1", openedAt: "2026-11-01T00:00:00.000Z" },
      { pageId: "b", threadId: "t1", openedAt: "2026-11-02T00:00:00.000Z" },
      { pageId: "c", threadId: "t2", openedAt: "2026-11-01T00:00:00.000Z" },
    ];
    const chosen = chooseBrowserPageOffers(pages);
    expect(chosen.offered.map((page) => page.pageId).sort()).toEqual(["b", "c"]);
    expect(chosen.superseded.map((page) => page.pageId)).toEqual(["a"]);
  });
});

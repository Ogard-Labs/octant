import { describe, expect, it, vi } from "vitest";
import { createExtensionTabsService, type ExtensionTabsCaller } from "./browserExtensionTabs";
import type { ProfileTab, ProfileTabResult } from "./browserSurfaceHost";

const caller: ExtensionTabsCaller = {
  profile: { kind: "personal" },
  windowId: "w1",
  seesTabAddresses: true,
};

function tab(id: number, active = false): ProfileTab {
  return {
    id,
    contextId: "c",
    tabId: `c:${String(id)}`,
    url: `https://site${String(id)}.test/`,
    title: `Site ${String(id)}`,
    active,
  };
}

function service(tabs: ReadonlyArray<ProfileTab> = [tab(1), tab(2, true)]) {
  const surface = {
    profileTabs: vi.fn(() => tabs),
    openProfileTab: vi.fn(
      async (): Promise<ProfileTabResult> => ({ status: "tab", tab: tab(3, true) }),
    ),
    updateProfileTab: vi.fn(
      async (): Promise<ProfileTabResult> => ({ status: "tab", tab: tab(1, true) }),
    ),
  };
  return { surface, tabs: createExtensionTabsService(surface) };
}

describe("an extension's tab calls", () => {
  it("lists the profile's pages in the window and finds the active one", async () => {
    const { tabs } = service();
    const all = await tabs.handle(caller, { method: "query", args: [{}] });
    expect(all).toMatchObject({
      ok: true,
      value: [
        { id: 1, active: false },
        { id: 2, active: true },
      ],
    });
    const active = await tabs.handle(caller, {
      method: "query",
      args: [{ active: true, currentWindow: true }],
    });
    expect(active).toMatchObject({ ok: true, value: [{ id: 2, url: "https://site2.test/" }] });
  });

  it("hides every address and title from an extension that did not ask for tabs", async () => {
    const { tabs } = service();
    const answer = await tabs.handle(
      { ...caller, seesTabAddresses: false },
      { method: "get", args: [2] },
    );
    expect(answer).toEqual({
      ok: true,
      value: expect.not.objectContaining({ url: expect.anything() }),
    });
    expect(JSON.stringify(answer)).not.toContain("site2");
  });

  it("does not know a tab that is not one of the profile's pages", async () => {
    const { tabs, surface } = service();
    expect(await tabs.handle(caller, { method: "get", args: [99] })).toEqual({
      ok: false,
      error: "No tab with id: 99.",
    });
    expect(await tabs.handle(caller, { method: "authorize", args: [99] })).toMatchObject({
      ok: false,
    });
    expect(
      await tabs.handle(caller, { method: "update", args: [99, { url: "https://a.test/" }] }),
    ).toMatchObject({ ok: false });
    expect(surface.updateProfileTab).not.toHaveBeenCalled();
    expect(await tabs.handle(caller, { method: "authorize", args: [1] })).toEqual({
      ok: true,
      value: null,
    });
  });

  it("scopes every lookup to the caller's profile and window", async () => {
    const { tabs, surface } = service();
    await tabs.handle(
      { ...caller, profile: { kind: "personal" }, windowId: "w9" },
      { method: "query", args: [] },
    );
    expect(surface.profileTabs).toHaveBeenCalledWith({ kind: "personal" }, "w9");
  });

  it("opens and navigates only web addresses", async () => {
    const { tabs, surface } = service();
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "chrome-extension://abc/page.html",
      "data:text/html,x",
    ]) {
      expect(await tabs.handle(caller, { method: "create", args: [{ url }] })).toMatchObject({
        ok: false,
      });
      expect(await tabs.handle(caller, { method: "update", args: [1, { url }] })).toMatchObject({
        ok: false,
      });
    }
    expect(surface.openProfileTab).not.toHaveBeenCalled();
    expect(surface.updateProfileTab).not.toHaveBeenCalled();

    expect(
      await tabs.handle(caller, { method: "create", args: [{ url: "https://a.test/" }] }),
    ).toMatchObject({ ok: true, value: { id: 3 } });
    expect(surface.openProfileTab).toHaveBeenCalledWith(caller.profile, "w1", "https://a.test/");
  });

  it("updates the active tab when no id is given", async () => {
    const { tabs, surface } = service();
    await tabs.handle(caller, { method: "update", args: [{ url: "https://a.test/" }] });
    expect(surface.updateProfileTab).toHaveBeenCalledWith(caller.profile, "w1", 2, {
      url: "https://a.test/",
    });
  });

  it("says in words when the page refuses an address the profile page does not allow", async () => {
    const { tabs, surface } = service();
    surface.openProfileTab.mockResolvedValue({ status: "origin-refused" });
    expect(
      await tabs.handle(caller, { method: "create", args: [{ url: "https://other.test/" }] }),
    ).toEqual({
      ok: false,
      error: "Octant opens only pages this window's profile page already allows.",
    });
  });

  it("names every other chrome.tabs call as unsupported and rejects odd shapes", async () => {
    const { tabs } = service();
    expect(await tabs.handle(caller, { method: "remove", args: [1] })).toEqual({
      ok: false,
      error: "chrome.tabs.remove is not supported here.",
    });
    expect(
      await tabs.handle(caller, { method: "query", args: [{ url: "*://*/*" }] }),
    ).toMatchObject({ ok: false });
    expect(
      await tabs.handle(caller, { method: "create", args: [{ active: false }] }),
    ).toMatchObject({ ok: false });
    for (const odd of [
      null,
      "query",
      { method: "query" },
      { method: "query", args: [], extra: 1 },
    ]) {
      expect(await tabs.handle(caller, odd)).toMatchObject({ ok: false });
    }
  });
});

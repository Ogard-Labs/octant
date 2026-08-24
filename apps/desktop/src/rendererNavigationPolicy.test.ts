import { describe, expect, it, vi } from "vitest";
import {
  createRendererNavigationPolicy,
  installRendererNavigationGuards,
} from "./rendererNavigationPolicy";

describe("renderer navigation policy", () => {
  it("confines packaged navigation to the exact renderer asset", () => {
    const policy = createRendererNavigationPolicy({
      packagedRendererPath:
        "/Applications/Octant.app/Contents/Resources/app/apps/web/dist/index.html",
    });

    expect(
      policy.allows(
        "file:///Applications/Octant.app/Contents/Resources/app/apps/web/dist/index.html?windowId=one",
      ),
    ).toBe(true);
    expect(
      policy.allows(
        "file:///Applications/Octant.app/Contents/Resources/app/apps/web/dist/other.html",
      ),
    ).toBe(false);
    expect(policy.allows("https://attacker.example/")).toBe(false);
    expect(policy.allows("not a URL")).toBe(false);
  });

  it("allows only the configured development origin", () => {
    const policy = createRendererNavigationPolicy({
      developmentUrl: "http://127.0.0.1:5173/",
      packagedRendererPath: "/unused/index.html",
    });

    expect(policy.allows("http://127.0.0.1:5173/settings")).toBe(true);
    expect(policy.allows("http://127.0.0.1:5174/settings")).toBe(false);
    expect(policy.allows("https://127.0.0.1:5173/settings")).toBe(false);
  });

  it("refuses arbitrary navigation and popups while preserving trusted loads", () => {
    const preventNavigate = vi.fn();
    const preventRedirect = vi.fn();
    const on = vi.fn();
    let openHandler:
      | ((details: { readonly url: string }) => { action: "allow" | "deny" })
      | undefined;
    const webContents = {
      on,
      setWindowOpenHandler: (handler: typeof openHandler) => {
        openHandler = handler;
      },
    };
    installRendererNavigationGuards(webContents, {
      developmentUrl: "http://localhost:5173/",
      packagedRendererPath: "/unused/index.html",
    });

    const navigateGuard = on.mock.calls.find(([event]) => event === "will-navigate")?.[1] as
      | ((event: { preventDefault: () => void }, details: { url: string }) => void)
      | undefined;
    const redirectGuard = on.mock.calls.find(([event]) => event === "will-redirect")?.[1] as
      | ((event: { preventDefault: () => void }, details: { url: string }) => void)
      | undefined;
    navigateGuard?.({ preventDefault: preventNavigate }, { url: "https://attacker.example/" });
    redirectGuard?.({ preventDefault: preventRedirect }, { url: "http://localhost:5174/" });
    navigateGuard?.({ preventDefault: vi.fn() }, { url: "http://localhost:5173/settings" });

    expect(preventNavigate).toHaveBeenCalledOnce();
    expect(preventRedirect).toHaveBeenCalledOnce();
    expect(openHandler?.({ url: "https://attacker.example/" })).toEqual({ action: "deny" });
    expect(openHandler?.({ url: "http://localhost:5173/help" })).toEqual({ action: "allow" });
  });
});

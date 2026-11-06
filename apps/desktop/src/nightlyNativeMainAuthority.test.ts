import { randomBytes } from "node:crypto";
import { decodeNightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { describe, expect, it } from "vitest";
import { registerNightlyWindow, type NativeDesktopWindows } from "./desktopPeerWindows";
import { createNativeMainAuthority } from "./nightlyNativeMainAuthority";

const token = () => randomBytes(32).toString("base64url");

function bootstrap(extra: Record<string, unknown>) {
  return decodeNightlyWindowBootstrap({
    kind: "registered",
    protocol: 1,
    windowId: "10000000-0000-4000-8000-0000000006a1",
    generation: 1,
    hostOrigin: "http://127.0.0.1:13773",
    hostInstance: "00000000-0000-4000-8000-000000000594",
    capability: token(),
    rendererIdentity: token(),
    leaseMs: 15_000,
    ...extra,
  });
}

describe("Nightly native main authority", () => {
  it("gives brokered host headers for exactly one remembered window until it closes", () => {
    const authority = createNativeMainAuthority();
    const nativeMainToken = token();
    const window = bootstrap({
      nativeMainToken,
      hostFeatures: ["provider-credentials", "a-feature-from-a-newer-host"],
    });
    authority.remember(7, window);
    expect(authority.headers(7)).toEqual({
      "x-octant-window-capability": window.capability,
      "x-octant-native-main-authority": nativeMainToken,
    });
    expect(authority.headers(8)).toBeUndefined();
    expect(authority.supports(7, "provider-credentials")).toBe(true);
    expect(authority.supports(7, "preview-handoff")).toBe(false);
    authority.forget(7);
    expect(authority.headers(7)).toBeUndefined();
  });

  it("opens a window from an older Octant's original bootstrap and brokers nothing for it", async () => {
    const original = {
      kind: "registered",
      protocol: 1,
      windowId: "10000000-0000-4000-8000-0000000006a1",
      generation: 2,
      hostOrigin: "http://127.0.0.1:13773",
      hostInstance: "00000000-0000-4000-8000-000000000594",
      capability: token(),
      rendererIdentity: token(),
      leaseMs: 15_000,
    };
    const native = { openWindow: async () => original } as unknown as NativeDesktopWindows;
    const registration = await registerNightlyWindow(native, "handle", 2);
    expect(registration.kind).toBe("registered");
    if (registration.kind !== "registered") return;
    const authority = createNativeMainAuthority();
    authority.remember(7, registration.bootstrap);
    expect(authority.headers(7)).toBeUndefined();
    expect(authority.supports(7, "provider-credentials")).toBe(false);
  });

  it("brokers nothing for a window whose older host sent no main-only token", () => {
    const authority = createNativeMainAuthority();
    authority.remember(7, bootstrap({}));
    expect(authority.headers(7)).toBeUndefined();
    expect(authority.supports(7, "project-root-receipts")).toBe(false);
  });
});

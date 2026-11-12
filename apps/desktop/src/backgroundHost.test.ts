import { describe, expect, it, vi } from "vitest";
import {
  createBackgroundHostSettings,
  decodeBackgroundHostChange,
  decodeBackgroundHostState,
} from "./backgroundHost";

function fakeService(initiallyInstalled = false) {
  let installed = initiallyInstalled;
  return {
    install: vi.fn(async () => {
      installed = true;
    }),
    enable: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => {
      installed = false;
    }),
    status: vi.fn(async () => ({
      kind: "launchd" as const,
      installed,
      enabled: installed,
      active: false,
      session: "active" as const,
      lingering: "unknown" as const,
    })),
  };
}

function fakeLoginItem(initial = false) {
  let open = initial;
  return {
    read: () => open,
    write: vi.fn((next: boolean) => {
      open = next;
    }),
  };
}

describe("background host settings", () => {
  it("starts off and shows what is actually installed", async () => {
    const settings = createBackgroundHostSettings({
      service: fakeService(),
      loginItem: fakeLoginItem(),
    });
    await expect(settings.read()).resolves.toEqual({
      status: "available",
      backgroundService: false,
      openAtLogin: false,
    });

    // A service installed outside the app, such as by `octant`, shows as on.
    const existing = createBackgroundHostSettings({
      service: fakeService(true),
      loginItem: fakeLoginItem(),
    });
    await expect(existing.read()).resolves.toMatchObject({ backgroundService: true });
  });

  it("installs and enables the service when turned on and removes it when turned off", async () => {
    const service = fakeService();
    const settings = createBackgroundHostSettings({ service, loginItem: fakeLoginItem() });

    await expect(settings.change({ backgroundService: true })).resolves.toMatchObject({
      backgroundService: true,
    });
    expect(service.install).toHaveBeenCalledOnce();
    expect(service.enable).toHaveBeenCalledOnce();

    await expect(settings.change({ backgroundService: false })).resolves.toMatchObject({
      backgroundService: false,
    });
    expect(service.uninstall).toHaveBeenCalledOnce();
  });

  it("reports a change that failed and still shows the switch as it really is", async () => {
    const service = fakeService();
    service.install.mockRejectedValueOnce(new Error("launchctl failed"));
    const settings = createBackgroundHostSettings({ service, loginItem: fakeLoginItem() });

    await expect(settings.change({ backgroundService: true })).resolves.toEqual({
      status: "available",
      backgroundService: false,
      openAtLogin: false,
      failure: "background-service",
    });
  });

  it("sets the login item apart from the background service", async () => {
    const service = fakeService();
    const loginItem = fakeLoginItem();
    const settings = createBackgroundHostSettings({ service, loginItem });

    await expect(settings.change({ openAtLogin: true })).resolves.toMatchObject({
      backgroundService: false,
      openAtLogin: true,
    });
    expect(service.install).not.toHaveBeenCalled();
  });

  it("leaves out the login item where the system has none", async () => {
    const settings = createBackgroundHostSettings({ service: fakeService(), loginItem: undefined });

    await expect(settings.read()).resolves.toEqual({
      status: "available",
      backgroundService: false,
    });
    await expect(settings.change({ openAtLogin: true })).resolves.toMatchObject({
      failure: "open-at-login",
    });
  });

  it("offers nothing where the app has no windowless host to install", async () => {
    const loginItem = fakeLoginItem();
    const settings = createBackgroundHostSettings({ service: undefined, loginItem });

    await expect(settings.change({ openAtLogin: true })).resolves.toEqual({
      status: "unsupported",
    });
    expect(loginItem.write).not.toHaveBeenCalled();
  });

  it("accepts only the two switches as booleans", () => {
    expect(decodeBackgroundHostChange({ backgroundService: true })).toEqual({
      backgroundService: true,
    });
    expect(decodeBackgroundHostChange({})).toBeUndefined();
    expect(decodeBackgroundHostChange({ backgroundService: "yes" })).toBeUndefined();
    expect(decodeBackgroundHostChange({ executable: "/tmp/x" })).toBeUndefined();
    expect(() => decodeBackgroundHostState({ status: "available" })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  decodeAndroidEmulatorId,
  decodeAndroidEmulatorRecord,
  decodeAndroidEmulatorRequest,
  decodeAndroidSdkDiscovery,
} from "./androidToolchain";

describe("AndroidEmulatorId", () => {
  it("accepts an AVD name and refuses a path", () => {
    expect(decodeAndroidEmulatorId("Pixel_8_API_34")).toBe("Pixel_8_API_34");
    expect(() => decodeAndroidEmulatorId("../escape")).toThrow();
    expect(() => decodeAndroidEmulatorId("Pixel 8")).toThrow();
  });
});

describe("AndroidSdkDiscovery", () => {
  it("decodes an unavailable SDK honestly", () => {
    const sdk = decodeAndroidSdkDiscovery({
      sdkId: "00000000-0000-4000-8000-000000000001",
      available: false,
      discoveredAt: "2026-09-20T12:00:00.000Z",
    });
    expect(sdk.available).toBe(false);
  });
});

describe("AndroidEmulatorRecord", () => {
  it("decodes a booted AVD with its adb serial", () => {
    const record = decodeAndroidEmulatorRecord({
      emulatorId: "Pixel_8_API_34",
      name: "Pixel 8",
      apiLevel: "34",
      state: "booted",
      serial: "emulator-5554",
    });
    expect(record.state).toBe("booted");
    expect(record.serial).toBe("emulator-5554");
  });
});

describe("AndroidEmulatorRequest", () => {
  const base = {
    actionId: "10000000-0000-4000-8000-000000000001",
    correlationId: "10000000-0000-4000-8000-000000000002",
    authority: {
      hostId: "10000000-0000-4000-8000-000000000003",
      mode: "code",
      projectId: "10000000-0000-4000-8000-000000000004",
      providerInstanceId: "10000000-0000-4000-8000-000000000007",
      extension: { kind: "core" },
    },
    threadId: "10000000-0000-4000-8000-000000000008",
    checkoutId: "10000000-0000-4000-8000-000000000009",
    emulatorId: "Pixel_8_API_34",
    timeoutMs: 30_000,
    approval: { kind: "approved", approvalId: "10000000-0000-4000-8000-000000000011" },
    requestedBy: {
      kind: "local-user",
      actorId: "10000000-0000-4000-8000-000000000012",
    },
  };

  it("decodes Allow input, tap, and install only with the fields each needs", () => {
    expect(decodeAndroidEmulatorRequest({ ...base, kind: "open-input" }).kind).toBe("open-input");
    expect(
      decodeAndroidEmulatorRequest({ ...base, kind: "tap", point: { x: 12, y: 40 } }).point,
    ).toEqual({ x: 12, y: 40 });
    expect(
      decodeAndroidEmulatorRequest({
        ...base,
        kind: "install",
        apkPath: "app/build/outputs/apk/debug/app-debug.apk",
      }).apkPath,
    ).toBe("app/build/outputs/apk/debug/app-debug.apk");
    expect(() =>
      decodeAndroidEmulatorRequest({ ...base, kind: "open-input", requestedBy: undefined }),
    ).toThrow();
    expect(() => decodeAndroidEmulatorRequest({ ...base, kind: "tap" })).toThrow();
    expect(() =>
      decodeAndroidEmulatorRequest({ ...base, kind: "install", apkPath: "/tmp/app.apk" }),
    ).toThrow();
  });

  it("decodes Rotate only with an orientation and the person who asked", () => {
    const rotate = { ...base, kind: "rotate", orientation: "landscape" };
    expect(decodeAndroidEmulatorRequest(rotate).orientation).toBe("landscape");
    expect(() => decodeAndroidEmulatorRequest({ ...rotate, orientation: undefined })).toThrow();
    expect(() => decodeAndroidEmulatorRequest({ ...rotate, requestedBy: undefined })).toThrow();
    expect(() => decodeAndroidEmulatorRequest({ ...rotate, orientation: "upside-down" })).toThrow();
  });

  it("decodes Open URL only with an http(s) address and the person who asked", () => {
    const openUrl = { ...base, kind: "open-url", url: "https://example.com/welcome" };
    expect(decodeAndroidEmulatorRequest(openUrl).url).toBe("https://example.com/welcome");
    expect(() => decodeAndroidEmulatorRequest({ ...openUrl, url: undefined })).toThrow();
    expect(() => decodeAndroidEmulatorRequest({ ...openUrl, requestedBy: undefined })).toThrow();
    expect(() =>
      decodeAndroidEmulatorRequest({ ...openUrl, url: "content://contacts/people/1" }),
    ).toThrow();
  });

  it("decodes screen recording only with the person who asked", () => {
    for (const kind of ["start-recording", "stop-recording"]) {
      expect(decodeAndroidEmulatorRequest({ ...base, kind }).kind).toBe(kind);
      expect(() =>
        decodeAndroidEmulatorRequest({ ...base, kind, requestedBy: undefined }),
      ).toThrow();
    }
  });
});

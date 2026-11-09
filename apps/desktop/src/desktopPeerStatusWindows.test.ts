import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  bindEndpoint: vi.fn(() => true),
  start: vi.fn(),
  status: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:module", async (original) => {
  const actual = await original<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const require = actual.createRequire(url);
      return (id: string) =>
        id.endsWith("/native/octant-desktop-peer-windows.node") ? fixture : require(id);
    },
  };
});
import { loadDesktopPeerStatus } from "./desktopPeerStatus";
it("loads only the fixed packaged Windows peer resource after native profile binding accepts", () => {
  const windows = { profileId: "11111111-1111-4111-8111-111111111111", version: "1.0.0" };
  expect(
    loadDesktopPeerStatus({ packaged: true, platform: "win32", resourcesPath: "/r", windows }),
  ).toBe(fixture);
  expect(fixture.bindEndpoint).toHaveBeenCalledWith(windows.profileId, windows.version);
  fixture.bindEndpoint.mockReturnValue(false);
  expect(
    loadDesktopPeerStatus({ packaged: true, platform: "win32", resourcesPath: "/r", windows }),
  ).toBeUndefined();
  fixture.bindEndpoint.mockClear();
  expect(
    loadDesktopPeerStatus({ packaged: false, platform: "win32", resourcesPath: "/r", windows }),
  ).toBeUndefined();
  expect(
    loadDesktopPeerStatus({ packaged: true, platform: "win32", resourcesPath: "/r" }),
  ).toBeUndefined();
  expect(fixture.bindEndpoint).not.toHaveBeenCalled();
});

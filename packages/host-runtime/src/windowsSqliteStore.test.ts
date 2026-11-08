import { describe, expect, it, vi } from "vitest";
import { createWindowsSqliteStores, type WindowsSqliteStoreNative } from "./windowsSqliteStore";
import type { WindowsHostProfilePaths } from "./windowsHostProfile";
const paths: WindowsHostProfilePaths = {
  platform: "win32",
  profile: "octant",
  profileId: "11111111-1111-4111-8111-111111111111",
  rootDirectory: "C:\\owned\\Octant\\hosts\\octant",
  dataDirectory: "C:\\owned\\Octant\\hosts\\octant\\data",
  configDirectory: "C:\\owned\\Octant\\hosts\\octant\\config",
  stateDirectory: "C:\\owned\\Octant\\hosts\\octant\\state",
  logsDirectory: "C:\\owned\\Octant\\hosts\\octant\\logs",
};
const extension = "C:\\owned\\octant-windows-host-owner.node";
function fixture(
  databasePath = paths.dataDirectory + "\\octant.sqlite3",
): WindowsSqliteStoreNative {
  return {
    apiVersion: 1,
    frameBytes: 16384,
    openProfile: vi.fn(),
    prepare: vi.fn(),
    claim: vi.fn(),
    poll: vi.fn(),
    reply: vi.fn(),
    close: vi.fn(),
    lookup: vi.fn(),
    beginRequest: vi.fn(),
    pollRequest: vi.fn(),
    closeRequest: vi.fn(),
    openSqliteStore: vi.fn(() => ({
      status: "ready",
      dataDirectory: paths.dataDirectory,
      databasePath,
      extensionPath: extension,
      lease: 1,
    })),
    closeSqliteStore: vi.fn(() => ({ status: "closed" })),
  };
}
describe("Windows SQLite connection admission", () => {
  it("binds the actual SQLite initializer and retires its opaque native lease exactly once", () => {
    const native = fixture();
    const file = createWindowsSqliteStores(native, paths)?.main();
    if (file?.status !== "ready") throw Error("Expected admitted fixture.");
    const loadExtension = vi.fn();
    expect(file.initialize({ loadExtension })).toEqual({ status: "ready" });
    expect(loadExtension).toHaveBeenCalledWith(extension);
    expect(native.openSqliteStore).toHaveBeenCalledWith(
      paths.profile,
      paths.profileId,
      paths.dataDirectory,
      "main",
    );
    expect(file.close()).toEqual({ status: "closed" });
    expect(file.close()).toEqual({ status: "closed" });
    expect(native.closeSqliteStore).toHaveBeenCalledTimes(1);
    expect(native.closeSqliteStore).toHaveBeenCalledWith(1);
    expect(file.initialize({ loadExtension })).toEqual({ status: "refused" });
    expect(loadExtension).toHaveBeenCalledTimes(1);
  });
  it("closes an admitted native lease when its returned store path does not match the fixed profile", () => {
    const native = fixture("C:\\other\\store.sqlite3");
    expect(createWindowsSqliteStores(native, paths)?.main()).toEqual({ status: "refused" });
    expect(native.closeSqliteStore).toHaveBeenCalledWith(1);
  });
  it("refuses a failed actual-handle initializer while retaining explicit cleanup", () => {
    const native = fixture();
    const file = createWindowsSqliteStores(native, paths)?.main();
    if (file?.status !== "ready") throw Error("Expected admitted fixture.");
    expect(
      file.initialize({
        loadExtension: () => {
          throw Error("Fixture refusal");
        },
      }),
    ).toEqual({ status: "refused" });
    expect(file.close()).toEqual({ status: "closed" });
    expect(native.closeSqliteStore).toHaveBeenCalledTimes(1);
  });
});

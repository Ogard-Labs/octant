import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  O_NOFOLLOW_ANY_DARWIN,
  openCandidateDarwin,
  openCandidateLinux,
  procFdPath,
} from "./projectIcon";

/** The Linux strategy cannot run on every machine, so its steps are checked against a fake open. */
function fakeOpen(failAt?: number) {
  const calls: Array<{ path: string; flags: number }> = [];
  const handles: Array<{ fd: number; close: ReturnType<typeof vi.fn> }> = [];
  const openFile = async (path: string, flags: number): Promise<FileHandle> => {
    if (calls.length === failAt) throw new Error("ELOOP");
    calls.push({ path, flags });
    const handle = { fd: 100 + handles.length, close: vi.fn(async () => undefined) };
    handles.push(handle);
    return handle as unknown as FileHandle;
  };
  return { calls, handles, openFile };
}

describe("Project icon open strategies", () => {
  it("opens the macOS path in one step that refuses a link in any component", async () => {
    const { calls, openFile } = fakeOpen();

    await openCandidateDarwin("/real/root", "public/favicon.svg", openFile);

    expect(calls).toEqual([
      {
        path: "/real/root/public/favicon.svg",
        flags: constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY_DARWIN,
      },
    ]);
    expect(O_NOFOLLOW_ANY_DARWIN).toBe(0x20000000);
  });

  it("builds each Linux step relative to the handle already held", () => {
    expect(procFdPath(7, "public")).toBe("/proc/self/fd/7/public");
  });

  it("walks the Linux path one handle at a time and closes every handle it leaves behind", async () => {
    const { calls, handles, openFile } = fakeOpen();

    const final = await openCandidateLinux("/real/root", "public/favicon.svg", openFile);

    expect(calls.map((call) => call.path)).toEqual([
      "/real/root",
      "/proc/self/fd/100/public",
      "/proc/self/fd/101/favicon.svg",
    ]);
    const directory = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    expect(calls[0]?.flags).toBe(directory);
    expect(calls[1]?.flags).toBe(directory);
    expect(calls[2]?.flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(handles[0]?.close).toHaveBeenCalledOnce();
    expect(handles[1]?.close).toHaveBeenCalledOnce();
    expect(handles[2]?.close).not.toHaveBeenCalled();
    expect(final.fd).toBe(102);
  });

  it("closes the handle it holds when a step is refused", async () => {
    const { handles, openFile } = fakeOpen(2);

    await expect(openCandidateLinux("/real/root", "public/favicon.svg", openFile)).rejects.toThrow(
      "ELOOP",
    );

    expect(handles).toHaveLength(2);
    expect(handles[1]?.close).toHaveBeenCalledOnce();
  });
});

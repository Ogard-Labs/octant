import { afterEach, describe, expect, it, vi } from "vitest";
import { readProcessGroupWitnesses } from "./nodeOwnedProcessReceipt";

const observation = vi.hoisted(() => ({
  stdout: "",
  error: undefined as Error | undefined,
  stat: "",
  command: vi.fn(),
  read: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async (...args: ReadonlyArray<unknown>) => {
        observation.command(...args);
        if (observation.error !== undefined) throw observation.error;
        return { stdout: observation.stdout };
      },
    }),
  };
});

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: string) => {
      observation.read(path);
      return path.endsWith("boot_id") ? "boot-a\n" : observation.stat;
    },
  };
});

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.restoreAllMocks();
  observation.error = undefined;
  observation.command.mockClear();
  observation.read.mockClear();
});

function onPlatform(value: "darwin" | "linux"): void {
  Object.defineProperty(process, "platform", { value });
  vi.spyOn(process, "kill").mockReturnValue(true);
  observation.stdout = value === "darwin" ? "4322 4321 Tue Nov 3 10:00:00 2026\n" : "4322\n";
  observation.stat = `4322 (fixture) S 1 4321 ${Array.from({ length: 16 }, () => "0").join(" ")} 123`;
}

describe("bounded process group observation", () => {
  it.each(["darwin", "linux"] as const)(
    "reads only the selected group's identity metadata on %s",
    async (value) => {
      onPlatform(value);
      await expect(readProcessGroupWitnesses(4321)).resolves.toEqual([
        { pid: 4322, processIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
      ]);
      expect(observation.command).toHaveBeenCalledWith(
        value === "darwin" ? "/bin/ps" : "/usr/bin/pgrep",
        value === "darwin" ? ["-g", "4321", "-o", "pid=,pgid=,lstart="] : ["-g", "4321"],
        { timeout: 1_000, maxBuffer: value === "darwin" ? 32_768 : 4_096 },
      );
      expect(observation.read.mock.calls.map((call) => call[0])).toEqual(
        value === "darwin" ? [] : ["/proc/sys/kernel/random/boot_id", "/proc/4322/stat"],
      );
    },
  );

  it.each(["darwin", "linux"] as const)(
    "refuses an unavailable, failed, or overflowing %s observer while the group still exists",
    async (value) => {
      onPlatform(value);
      for (const code of ["ENOENT", "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", 1, 2]) {
        observation.error = Object.assign(new Error("observation unavailable"), { code });
        await expect(readProcessGroupWitnesses(4321)).rejects.toThrow("observation unavailable");
      }
    },
  );

  it.each(["darwin", "linux"] as const)(
    "reports absence only when the %s group is proven gone",
    async (value) => {
      onPlatform(value);
      observation.error = Object.assign(new Error("no matches"), { code: 1 });
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      await expect(readProcessGroupWitnesses(4321)).resolves.toEqual([]);
    },
  );

  it.each(["darwin", "linux"] as const)(
    "refuses to omit members beyond the %s observation bound",
    async (value) => {
      onPlatform(value);
      observation.stdout = Array.from({ length: 257 }, () =>
        value === "darwin" ? "4322 4321 Tue Nov 3 10:00:00 2026" : "4322",
      ).join("\n");
      await expect(readProcessGroupWitnesses(4321)).rejects.toThrow(
        "Too many owned process group members",
      );
    },
  );

  it("refuses an unexpected BSD group instead of treating a PID as ownership", async () => {
    onPlatform("darwin");
    observation.stdout = "4322 9999 Tue Nov 3 10:00:00 2026";
    await expect(readProcessGroupWitnesses(4321)).rejects.toThrow(
      "membership could not be observed",
    );
  });

  it("drops a Linux member that left the selected group between enumeration and identity observation", async () => {
    onPlatform("linux");
    observation.stat = observation.stat.replace("S 1 4321", "S 1 9999");
    await expect(readProcessGroupWitnesses(4321)).resolves.toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { createServerResourceReader, parseServerResourceOutput } from "./serverResources";
import type { ServerCall } from "./serverConnection";

const output = (stat2Busy: number) =>
  [
    "#octant:stat1",
    "cpu  100 0 100 800 0 0 0 0 0 0",
    "#octant:stat2",
    `cpu  ${100 + stat2Busy} 0 100 ${800 + 100 - stat2Busy} 0 0 0 0 0 0`,
    "#octant:cores",
    "4",
    "#octant:mem",
    "MemTotal:       8000000 kB",
    "MemFree:        1000000 kB",
    "MemAvailable:   2000000 kB",
    "#octant:net",
    "  eth0: 1000 1 0 0 0 0 0 0 400 1 0 0 0 0 0 0",
    "#octant:diskstats",
    "   8 0 sda 10 0 100 0 5 0 40 0 0 0 0",
    "#octant:df",
    "/dev/sda1 1000000 400000 600000 40% /srv",
    "#octant:gpu",
    "37",
    "#octant:battery",
    "",
  ].join("\n");

describe("server resources", () => {
  it("reads load from a Linux server's /proc output and reports no battery when none is present", () => {
    const reading = parseServerResourceOutput(output(50));
    expect(reading?.cores).toBe(4);
    expect(reading?.cpuPercent).toBeCloseTo(50, 0);
    expect(reading?.memory).toEqual({ usedBytes: 6_000_000 * 1024, totalBytes: 8_000_000 * 1024 });
    expect(reading?.disk).toEqual({ usedBytes: 400_000 * 1024, freeBytes: 600_000 * 1024 });
    expect(reading?.gpuPercent).toBe(37);
    expect(reading?.battery).toBeUndefined();
  });

  it("says a server is unsupported when its output is not a /proc reading", () => {
    expect(parseServerResourceOutput("Darwin")).toBeUndefined();
  });

  it("answers a snapshot over the Project's connection and keeps the failure as a value when the server is unreachable", async () => {
    let reachable = true;
    const read = createServerResourceReader({
      connection: {
        run: async (): Promise<ServerCall> =>
          reachable
            ? {
                status: "ran",
                exitCode: 0,
                output: Buffer.from(output(50)),
                truncated: false,
                errorOutput: "",
              }
            : { status: "unreachable", message: "connection refused" },
      },
      address: () => ({ server: { alias: "box", user: "me" }, folder: "/srv" }),
      now: () => 0,
    });
    const first = await read();
    expect(first.status === "ready" && first.snapshot.gpu).toEqual({ percent: 37 });
    reachable = false;
    const failed = await createServerResourceReader({
      connection: {
        run: async (): Promise<ServerCall> => ({ status: "unreachable", message: "refused" }),
      },
      address: () => ({ server: { alias: "box", user: "me" }, folder: "/srv" }),
    })();
    expect(failed.status).toBe("unavailable");
  });
});

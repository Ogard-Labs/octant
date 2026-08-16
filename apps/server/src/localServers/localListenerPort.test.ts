import { MAX_LOCAL_SERVER_LISTENERS } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createLiveLocalListenerPort,
  createLsofWorkingDirectoryResolver,
  createPsProcessTableReader,
  LISTENER_CWD_SCAN_CONCURRENCY,
  LISTENER_ENRICHMENT_DEADLINE_MS,
  parseListenAddress,
  parseLsofCwd,
  parseLsofFields,
  parsePsTable,
  walkLineage,
  type LocalListenerObservation,
  type LocalListenerPort,
  type PsTableEntry,
} from "./localListenerPort";

/** Unwrap a successful scan so a listener assertion cannot pass on a failed one. */
async function observed(port: LocalListenerPort, signal?: AbortSignal) {
  const observation: LocalListenerObservation = await port.observe(signal);
  expect(observation.status).toBe("observed");
  return observation.status === "observed" ? observation.listeners : [];
}

const lsofOutput = [
  "p4213",
  "cnode",
  "u501",
  "n127.0.0.1:5173",
  "p91",
  "csshd",
  "u0",
  "n*:22",
  "p777",
  "cpostgres",
  "u502",
  "n127.0.0.1:5432",
].join("\n");

describe("local listener observation", () => {
  it("parses lsof field records and classifies ownership by uid", () => {
    const listeners = parseLsofFields(lsofOutput, 501);
    expect(listeners).toEqual([
      {
        pid: 4213,
        port: 5173,
        processName: "node",
        ownership: "current-user",
        bindAddress: "127.0.0.1",
      },
      { pid: 91, port: 22, processName: "sshd", ownership: "root", bindAddress: "*" },
      {
        pid: 777,
        port: 5432,
        processName: "postgres",
        ownership: "other-user",
        bindAddress: "127.0.0.1",
      },
    ]);
  });

  it("drops records it cannot read completely", () => {
    expect(parseLsofFields("p4213\nn127.0.0.1:5173", 501)).toEqual([]);
    expect(parseLsofFields("pnotapid\ncnode\nu501\nn127.0.0.1:5173", 501)).toEqual([]);
  });

  it("parses loopback, wildcard, and IPv6 listen addresses", () => {
    expect(parseListenAddress("127.0.0.1:5173")).toEqual({ host: "127.0.0.1", port: 5173 });
    expect(parseListenAddress("*:3000")).toEqual({ host: "*", port: 3000 });
    expect(parseListenAddress("[::1]:8080")).toEqual({ host: "::1", port: 8080 });
    expect(parseListenAddress("127.0.0.1:notaport")).toBeUndefined();
    expect(parseListenAddress("127.0.0.1:99999")).toBeUndefined();
  });

  it("keeps a multi-word command title and extracts its first word as the command hint", () => {
    const listeners = parseLsofFields(
      ["p8102", "cnext-server (v15.1.0)", "u501", "n127.0.0.1:3000"].join("\n"),
      501,
    );
    expect(listeners).toEqual([
      {
        pid: 8102,
        port: 3000,
        processName: "next-server (v15.1.0)",
        commandName: "next-server",
        ownership: "current-user",
        bindAddress: "127.0.0.1",
      },
    ]);
  });

  it("scopes the kernel query to the current user and asks for untruncated command names", async () => {
    const execute = vi.fn(async () => lsofOutput);
    await createLiveLocalListenerPort({ execute, currentUid: 501 }).observe();
    expect(execute).toHaveBeenCalledWith(
      "lsof",
      ["-nP", "+c", "0", "-a", "-u", "501", "-iTCP", "-sTCP:LISTEN", "-FpcnLu"],
      undefined,
    );
  });

  it("reports discovery as unavailable when the host tool cannot be run", async () => {
    const port = createLiveLocalListenerPort({
      execute: async () => {
        throw new Error("lsof: command not found");
      },
      currentUid: 501,
    });
    // A host that could not look has not established that nothing is running.
    expect(await port.observe()).toEqual({ status: "unavailable" });
  });

  it("reports a quiet host as an observed empty scan, not as unavailable", async () => {
    const port = createLiveLocalListenerPort({ execute: async () => "", currentUid: 501 });
    expect(await port.observe()).toEqual({ status: "observed", listeners: [] });
  });

  it("enriches each listener with cwd and lineage when the host can read them", async () => {
    const port = createLiveLocalListenerPort({
      execute: async () => "p4213\ncnode\nu501\nn127.0.0.1:5173",
      currentUid: 501,
      resolveWorkingDirectory: async () => "/Users/example/code/octant",
      readProcessTable: async () =>
        new Map([
          [4213, { parentPid: 310, commandName: "node" }],
          [310, { parentPid: 1, commandName: "Visual Studio Code" }],
        ]),
    });
    expect(await observed(port)).toEqual([
      {
        pid: 4213,
        port: 5173,
        processName: "node",
        ownership: "current-user",
        bindAddress: "127.0.0.1",
        workingDirectory: "/Users/example/code/octant",
        lineage: ["Visual Studio Code"],
      },
    ]);
  });

  it("reads one process table per scan rather than one per pid", async () => {
    const psCalls = vi.fn();
    const execute = vi.fn(async (command: string, args: ReadonlyArray<string>) => {
      if (command === "lsof" && args.includes("-iTCP")) {
        return [
          "p4213",
          "cnode",
          "u501",
          "n127.0.0.1:5173",
          "p4214",
          "cnode",
          "u501",
          "n127.0.0.1:5174",
          "p4215",
          "cnode",
          "u501",
          "n127.0.0.1:5175",
        ].join("\n");
      }
      if (command === "lsof") return "";
      psCalls();
      return " 4213     1 node\n 4214     1 node\n 4215     1 node";
    });

    const listeners = await observed(createLiveLocalListenerPort({ execute, currentUid: 501 }));
    expect(listeners).toHaveLength(3);
    expect(psCalls).toHaveBeenCalledTimes(1);
  });

  it("overlaps working-directory lookups without exceeding the concurrency cap", async () => {
    const pidCount = LISTENER_CWD_SCAN_CONCURRENCY * 3;
    const lsof = Array.from({ length: pidCount }, (_, index) =>
      ["p" + String(5000 + index), "cnode", "u501", "n127.0.0.1:" + String(6000 + index)].join(
        "\n",
      ),
    ).join("\n");

    let inFlight = 0;
    let peakInFlight = 0;
    const resolveWorkingDirectory = vi.fn(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return "/Users/example/code/octant";
    });

    const listeners = await observed(
      createLiveLocalListenerPort({
        execute: async (command) => (command === "lsof" ? lsof : ""),
        currentUid: 501,
        resolveWorkingDirectory,
        readProcessTable: async () => new Map(),
      }),
    );

    expect(listeners).toHaveLength(pidCount);
    expect(resolveWorkingDirectory).toHaveBeenCalledTimes(pidCount);
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(LISTENER_CWD_SCAN_CONCURRENCY);
  });

  it("queries the working directory only of the listeners that survive the budget", async () => {
    const overflow = MAX_LOCAL_SERVER_LISTENERS + 25;
    const lsof = Array.from({ length: overflow }, (_, index) =>
      ["p" + String(9000 + index), "cnode", "u501", "n127.0.0.1:" + String(10_000 + index)].join(
        "\n",
      ),
    ).join("\n");
    const queriedPids: number[] = [];
    const execute = vi.fn(async (command: string, args: ReadonlyArray<string>) => {
      if (command === "lsof" && args.includes("-iTCP")) return lsof;
      if (command === "lsof" && args.includes("cwd")) {
        queriedPids.push(Number(args[3]));
        return "";
      }
      return "";
    });

    // Truncation is still an observation: the host looked and saw these.
    const listeners = await observed(createLiveLocalListenerPort({ execute, currentUid: 501 }));
    expect(listeners).toHaveLength(MAX_LOCAL_SERVER_LISTENERS);
    expect(queriedPids).toHaveLength(MAX_LOCAL_SERVER_LISTENERS);
    expect(Math.max(...queriedPids)).toBe(9000 + MAX_LOCAL_SERVER_LISTENERS - 1);
  });

  it("stops issuing host queries once the caller aborts the scan", async () => {
    const controller = new AbortController();
    const resolveWorkingDirectory = vi.fn(async () => {
      controller.abort();
      return undefined;
    });
    const lsof = Array.from({ length: LISTENER_CWD_SCAN_CONCURRENCY * 4 }, (_, index) =>
      ["p" + String(7000 + index), "cnode", "u501", "n127.0.0.1:" + String(8000 + index)].join(
        "\n",
      ),
    ).join("\n");

    await observed(
      createLiveLocalListenerPort({
        execute: async (command) => (command === "lsof" ? lsof : ""),
        currentUid: 501,
        resolveWorkingDirectory,
        readProcessTable: async () => new Map(),
      }),
      controller.signal,
    );

    expect(resolveWorkingDirectory.mock.calls.length).toBeLessThanOrEqual(
      LISTENER_CWD_SCAN_CONCURRENCY,
    );
  });

  it("reports what it has at the enrichment deadline instead of waiting on wedged pids", async () => {
    vi.useFakeTimers();
    try {
      const port = createLiveLocalListenerPort({
        execute: async () => "p4213\ncnode\nu501\nn127.0.0.1:5173",
        currentUid: 501,
        resolveWorkingDirectory: () => new Promise<string | undefined>(() => {}),
        readProcessTable: () => new Promise<ReadonlyMap<number, PsTableEntry>>(() => {}),
      });

      const scan = port.observe();
      await vi.advanceTimersByTimeAsync(LISTENER_ENRICHMENT_DEADLINE_MS);

      // Still an observation — the host saw this listener; it only ran out of
      // budget to corroborate it, which is no corroboration, never a guess.
      expect(await scan).toEqual({
        status: "observed",
        listeners: [
          {
            pid: 4213,
            port: 5173,
            processName: "node",
            ownership: "current-user",
            bindAddress: "127.0.0.1",
          },
        ],
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps every resolved fact on a fast scan and leaves no deadline timer running", async () => {
    vi.useFakeTimers();
    try {
      const port = createLiveLocalListenerPort({
        execute: async () => "p4213\ncnode\nu501\nn127.0.0.1:5173",
        currentUid: 501,
        resolveWorkingDirectory: async () => "/Users/example/code/octant",
        readProcessTable: async () =>
          new Map([
            [4213, { parentPid: 310, commandName: "node" }],
            [310, { parentPid: 1, commandName: "Visual Studio Code" }],
          ]),
      });

      expect(await observed(port)).toEqual([
        {
          pid: 4213,
          port: 5173,
          processName: "node",
          ownership: "current-user",
          bindAddress: "127.0.0.1",
          workingDirectory: "/Users/example/code/octant",
          lineage: ["Visual Studio Code"],
        },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles an aborted scan without waiting for the deadline or leaking its listener", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const lsof = Array.from({ length: LISTENER_CWD_SCAN_CONCURRENCY * 2 }, (_, index) =>
        ["p" + String(7000 + index), "cnode", "u501", "n127.0.0.1:" + String(8000 + index)].join(
          "\n",
        ),
      ).join("\n");
      const port = createLiveLocalListenerPort({
        execute: async () => lsof,
        currentUid: 501,
        resolveWorkingDirectory: () => new Promise<string | undefined>(() => {}),
        readProcessTable: () => new Promise<ReadonlyMap<number, PsTableEntry>>(() => {}),
      });

      const scan = port.observe(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();

      // No timer advance: the abort itself must end the scan.
      expect((await scan).status).toBe("observed");
      expect(vi.getTimerCount()).toBe(0);
      expect(removed).toHaveBeenCalledTimes(added.mock.calls.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves cwd and lineage through the default host resolvers when none are injected", async () => {
    const execute = vi.fn(async (command: string, args: ReadonlyArray<string>) => {
      if (command === "lsof" && args.includes("-iTCP")) {
        return "p4213\ncnode\nu501\nn127.0.0.1:5173";
      }
      if (command === "lsof" && args.includes("cwd")) {
        expect(args).toEqual(["-nP", "-a", "-p", "4213", "-d", "cwd", "-Fn"]);
        return "p4213\nfcwd\nn/Users/example/code/octant";
      }
      if (command === "ps") {
        expect(args).toEqual(["-axo", "pid=,ppid=,comm="]);
        return [
          "    1     0 /sbin/launchd",
          "  310     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
          " 4213   310 node",
        ].join("\n");
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const port = createLiveLocalListenerPort({ execute, currentUid: 501 });
    expect(await observed(port)).toEqual([
      {
        pid: 4213,
        port: 5173,
        processName: "node",
        ownership: "current-user",
        bindAddress: "127.0.0.1",
        workingDirectory: "/Users/example/code/octant",
        lineage: ["/Applications/Visual Studio Code.app/Contents/MacOS/Electron"],
      },
    ]);
  });

  it("resolves each pid's facts once even when it holds several ports", async () => {
    const cwdCalls = vi.fn(async () => "p4213\nfcwd\nn/Users/example/code/octant");
    const execute = vi.fn(async (command: string, args: ReadonlyArray<string>) => {
      if (command === "lsof" && args.includes("-iTCP")) {
        return "p4213\ncnode\nu501\nn127.0.0.1:5173\nn127.0.0.1:5174";
      }
      if (command === "lsof" && args.includes("cwd")) return cwdCalls();
      return " 4213     1 node";
    });
    const listeners = await observed(createLiveLocalListenerPort({ execute, currentUid: 501 }));
    expect(listeners.map((listener) => listener.port)).toEqual([5173, 5174]);
    expect(cwdCalls).toHaveBeenCalledTimes(1);
  });

  it("fails closed to no corroboration when the host resolvers error", async () => {
    const execute = vi.fn(async (command: string, args: ReadonlyArray<string>) => {
      if (command === "lsof" && args.includes("-iTCP")) {
        return "p4213\ncnode\nu501\nn127.0.0.1:5173";
      }
      throw new Error("Operation not permitted");
    });
    const port = createLiveLocalListenerPort({ execute, currentUid: 501 });
    // No cwd, no lineage — the classifier will omit this uncorroborated node
    // rather than the port inventing facts that would have listed it.
    expect(await observed(port)).toEqual([
      {
        pid: 4213,
        port: 5173,
        processName: "node",
        ownership: "current-user",
        bindAddress: "127.0.0.1",
      },
    ]);
  });
});

describe("working directory resolution", () => {
  it("reads the cwd path from the lsof cwd record only", () => {
    expect(parseLsofCwd("p4213\nfcwd\nn/Users/example/code/octant")).toBe(
      "/Users/example/code/octant",
    );
    expect(parseLsofCwd("p4213\nftxt\nn/usr/local/bin/node")).toBeUndefined();
    expect(parseLsofCwd("p4213\nfcwd\nnnot-an-absolute-path")).toBeUndefined();
    expect(parseLsofCwd("")).toBeUndefined();
  });

  it("resolves undefined instead of guessing when the host query fails", async () => {
    const resolve = createLsofWorkingDirectoryResolver(async () => {
      throw new Error("lsof: command not found");
    });
    expect(await resolve(4213)).toBeUndefined();
    expect(await createLsofWorkingDirectoryResolver(async () => "garbage")(4213)).toBeUndefined();
    expect(await createLsofWorkingDirectoryResolver(async () => "")(-1)).toBeUndefined();
  });
});

describe("process table reads", () => {
  const table = parsePsTable(
    [
      "    1     0 /sbin/launchd",
      "  310     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "  411   310 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
      " 4213   411 node",
      "not a row",
    ].join("\n"),
  );

  it("walks ancestors nearest first and stops at launchd", () => {
    expect(walkLineage(table, 4213)).toEqual([
      "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    ]);
    expect(walkLineage(table, 310)).toEqual([]);
    expect(walkLineage(table, 99999)).toEqual([]);
  });

  it("bounds a cyclic ppid table instead of looping", () => {
    const cyclic = parsePsTable(["  100   200 a", "  200   100 b"].join("\n"));
    expect(walkLineage(cyclic, 100)).toEqual(["b"]);
  });

  it("reads an empty table instead of guessing when ps fails", async () => {
    const read = createPsProcessTableReader(async () => {
      throw new Error("ps failed");
    });
    expect(await read()).toEqual(new Map());
    // No table means no corroboration, never an invented ancestry.
    expect(walkLineage(await read(), 4213)).toEqual([]);
    expect(await createPsProcessTableReader(async () => "garbage")()).toEqual(new Map());
  });

  it("asks ps for the whole table once and parses it", async () => {
    const execute = vi.fn(async (command: string, args: ReadonlyArray<string>) => {
      expect(command).toBe("ps");
      expect(args).toEqual(["-axo", "pid=,ppid=,comm="]);
      return " 4213     1 node";
    });
    expect(await createPsProcessTableReader(execute)()).toEqual(
      new Map([[4213, { parentPid: 1, commandName: "node" }]]),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { MAX_TERMINAL_TRANSCRIPT_BYTES, TerminalService } from "./terminalService";

describe("TerminalService", () => {
  it("launches with allowlisted environment plus launch-only credential references", async () => {
    const process = fakeProcess();
    const port = { start: vi.fn(() => process) };
    const service = new TerminalService({
      port,
      inheritedEnvironment: { PATH: "/usr/bin", HOME: "/private/home", AWS_SECRET: "ambient" },
      credentials: { resolve: vi.fn(async (reference) => `resolved-${reference}`) },
    });

    await service.launch({
      terminalId: "terminal-1",
      shell: "/bin/zsh",
      cwd: "/private/repo",
      stateScope: "repo_test",
      columns: 100,
      rows: 30,
      credentialReferences: [{ environmentName: "OCTANT_API_TOKEN", reference: "provider:a" }],
    });

    expect(port.start).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: "/bin/zsh",
        cwd: "/private/repo",
        stateScope: "repo_test",
        environment: {
          PATH: "/usr/bin",
          HOME: "/private/home",
          OCTANT_API_TOKEN: "resolved-provider:a",
        },
      }),
    );
  });

  it("fails the launch when the ownership receipt cannot be persisted", async () => {
    const process = fakeProcess();
    process.receiptReady = Promise.reject(new Error("receipt unavailable"));
    const service = new TerminalService({
      port: { start: () => process },
      inheritedEnvironment: {},
      credentials: { resolve: async () => "" },
    });

    await expect(
      service.launch({
        terminalId: "terminal-1",
        shell: "/bin/zsh",
        cwd: "/repo",
        stateScope: "repo_test",
        columns: 80,
        rows: 24,
        credentialReferences: [],
      }),
    ).rejects.toThrow("receipt unavailable");
    expect(process.close).toHaveBeenCalledOnce();
    expect(() => service.attach("terminal-1")).toThrow("Terminal does not exist");
  });

  it("records a PTY exit that occurs while receipt persistence is pending", async () => {
    const process = fakeProcess();
    let resolveReceipt!: () => void;
    process.receiptReady = new Promise<void>((resolve) => {
      resolveReceipt = resolve;
    });
    const service = new TerminalService({
      port: { start: () => process },
      inheritedEnvironment: {},
      credentials: { resolve: async () => "" },
    });

    const launch = service.launch({
      terminalId: "terminal-1",
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      columns: 80,
      rows: 24,
      credentialReferences: [],
    });
    await Promise.resolve();
    process.emitExit({ exitCode: 17 });
    resolveReceipt();

    await expect(launch).resolves.toMatchObject({
      status: "exited",
      canRerun: true,
      exitCode: 17,
    });
  });

  it("retains bounded redacted 64 KiB chunks with an explicit truncation marker", async () => {
    const process = fakeProcess();
    const service = new TerminalService({
      port: { start: () => process },
      inheritedEnvironment: {},
      credentials: { resolve: async () => "private-token" },
    });
    await service.launch({
      terminalId: "terminal-1",
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      columns: 80,
      rows: 24,
      credentialReferences: [{ environmentName: "TOKEN", reference: "one" }],
    });

    process.emitData(`${"x".repeat(MAX_TERMINAL_TRANSCRIPT_BYTES + 70_000)}private-token`);
    const snapshot = service.attach("terminal-1");

    expect(snapshot.transcript.byteLength).toBeLessThanOrEqual(MAX_TERMINAL_TRANSCRIPT_BYTES);
    expect(snapshot.transcript.chunks.every((chunk) => Buffer.byteLength(chunk) <= 64 * 1024)).toBe(
      true,
    );
    expect(snapshot.transcript.truncated).toBe(true);
    expect(snapshot.transcript.chunks.join("")).toContain("[Octant terminal output truncated]");
    expect(snapshot.transcript.chunks.join("")).not.toContain("private-token");
  });

  it("redacts credentials split across arbitrary PTY output callbacks", async () => {
    const process = fakeProcess();
    const service = new TerminalService({
      port: { start: () => process },
      inheritedEnvironment: {},
      credentials: { resolve: async () => "private-token" },
    });
    await service.launch({
      terminalId: "terminal-1",
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      columns: 80,
      rows: 24,
      credentialReferences: [{ environmentName: "TOKEN", reference: "one" }],
    });

    process.emitData("private-");
    process.emitData("token");

    expect(service.attach("terminal-1").transcript.chunks.join("")).toBe("[REDACTED]");
    expect(process.pause).toHaveBeenCalledTimes(2);
    expect(process.resume).toHaveBeenCalledTimes(2);
  });

  it("publishes debounced redacted snapshots to terminal output observers", async () => {
    vi.useFakeTimers();
    try {
      const process = fakeProcess();
      const service = new TerminalService({
        port: { start: () => process },
        inheritedEnvironment: {},
        credentials: { resolve: async () => "private-token" },
      });
      await service.launch({
        terminalId: "terminal-1",
        shell: "/bin/zsh",
        cwd: "/repo",
        stateScope: "repo_test",
        columns: 80,
        rows: 24,
        credentialReferences: [{ environmentName: "TOKEN", reference: "one" }],
      });
      const observer = vi.fn();
      service.observe("terminal-1", observer);

      process.emitData("result private-");
      process.emitData("token\n");
      await vi.advanceTimersByTimeAsync(50);

      expect(observer).toHaveBeenCalledOnce();
      expect(observer.mock.calls[0]?.[0]).toMatchObject({
        text: "result [REDACTED]\n",
        replace: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes output buffered after the launch snapshot when the observer attaches", async () => {
    vi.useFakeTimers();
    try {
      const process = fakeProcess();
      const service = new TerminalService({
        port: { start: () => process },
        inheritedEnvironment: {},
        credentials: { resolve: async () => "" },
      });
      await service.launch({
        terminalId: "terminal-1",
        shell: "/bin/zsh",
        cwd: "/repo",
        stateScope: "repo_test",
        columns: 80,
        rows: 24,
        credentialReferences: [],
      });

      process.emitData("ready before observer\n");
      const observer = vi.fn();
      service.observe("terminal-1", observer);
      await vi.advanceTimersByTimeAsync(50);

      expect(observer).toHaveBeenCalledOnce();
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({ text: "ready before observer\n", replace: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("withholds unresolved credential prefixes from live output", async () => {
    vi.useFakeTimers();
    try {
      const process = fakeProcess();
      const service = new TerminalService({
        port: { start: () => process },
        inheritedEnvironment: {},
        credentials: { resolve: async () => "private-token" },
      });
      await service.launch({
        terminalId: "terminal-1",
        shell: "/bin/zsh",
        cwd: "/repo",
        stateScope: "repo_test",
        columns: 80,
        rows: 24,
        credentialReferences: [{ environmentName: "TOKEN", reference: "one" }],
      });
      const observer = vi.fn();
      service.observe("terminal-1", observer);

      process.emitData("private-");
      await vi.advanceTimersByTimeAsync(50);
      expect(observer).not.toHaveBeenCalled();

      process.emitData("token");
      await vi.advanceTimersByTimeAsync(50);
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({ text: "[REDACTED]", replace: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reapplies the transcript ceiling after expanding credential redaction", async () => {
    const process = fakeProcess();
    const service = new TerminalService({
      port: { start: () => process },
      inheritedEnvironment: {},
      credentials: { resolve: async () => "x" },
    });
    await service.launch({
      terminalId: "terminal-1",
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      columns: 80,
      rows: 24,
      credentialReferences: [{ environmentName: "TOKEN", reference: "one" }],
    });

    process.emitData("x".repeat(MAX_TERMINAL_TRANSCRIPT_BYTES));

    const snapshot = service.attach("terminal-1");
    expect(snapshot.transcript.byteLength).toBeLessThanOrEqual(MAX_TERMINAL_TRANSCRIPT_BYTES);
    expect(snapshot.transcript.truncated).toBe(true);
    expect(snapshot.transcript.chunks.join("")).not.toContain("x");
  });

  it("reattaches to one live PTY, coalesces resize, and restores restart evidence without rerunning", async () => {
    const process = fakeProcess();
    const port = { start: vi.fn(() => process) };
    const service = new TerminalService({
      port,
      inheritedEnvironment: {},
      credentials: { resolve: async () => "" },
    });
    await service.launch({
      terminalId: "terminal-1",
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      columns: 80,
      rows: 24,
      credentialReferences: [],
    });
    service.resize("terminal-1", 100, 30);
    service.resize("terminal-1", 120, 40);
    await Promise.resolve();

    expect(service.attach("terminal-1").status).toBe("running");
    expect(port.start).toHaveBeenCalledOnce();
    expect(process.resize).toHaveBeenCalledOnce();
    expect(process.resize).toHaveBeenCalledWith(120, 40);

    const restored = new TerminalService({
      port,
      inheritedEnvironment: {},
      credentials: { resolve: async () => "" },
      restored: [{ terminalId: "old", transcript: ["before restart"], exitCode: 1 }],
    });
    expect(restored.attach("old")).toMatchObject({
      status: "interrupted",
      canRerun: true,
      exitCode: 1,
    });
    expect(port.start).toHaveBeenCalledOnce();
  });

  it("contains a resize that races a native PTY exit", async () => {
    const process = fakeProcess();
    process.resize.mockImplementation(() => {
      throw new Error("pty already closed");
    });
    const service = new TerminalService({
      port: { start: () => process },
      inheritedEnvironment: {},
      credentials: { resolve: async () => "" },
    });
    await service.launch({
      terminalId: "terminal-1",
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      columns: 80,
      rows: 24,
      credentialReferences: [],
    });

    service.resize("terminal-1", 120, 40);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(process.resize).toHaveBeenCalledOnce();
    expect(service.attach("terminal-1").status).toBe("running");
  });

  it("reuses a stopped terminal slot only after an explicit relaunch", async () => {
    const firstProcess = fakeProcess();
    const secondProcess = fakeProcess();
    const port = {
      start: vi.fn().mockReturnValueOnce(firstProcess).mockReturnValueOnce(secondProcess),
    };
    const service = new TerminalService({
      port,
      inheritedEnvironment: {},
      credentials: { resolve: async () => "" },
    });
    const request = {
      terminalId: "terminal-1",
      shell: "/bin/zsh",
      cwd: "/repo",
      stateScope: "repo_test",
      columns: 80,
      rows: 24,
      credentialReferences: [],
    } as const;

    await service.launch(request);
    firstProcess.emitExit({ exitCode: 0 });
    await expect(service.launch(request)).resolves.toMatchObject({ status: "running" });

    expect(port.start).toHaveBeenCalledTimes(2);
  });

  it("closes every live terminal during server shutdown and leaves exited terminals alone", async () => {
    const first = fakeProcess();
    const second = fakeProcess();
    const port = { start: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) };
    const service = new TerminalService({
      port,
      inheritedEnvironment: {},
      credentials: { resolve: async () => "" },
    });
    for (const terminalId of ["terminal-1", "terminal-2"]) {
      await service.launch({
        terminalId,
        shell: "/bin/zsh",
        cwd: "/repo",
        stateScope: "repo_test",
        columns: 80,
        rows: 24,
        credentialReferences: [],
      });
    }

    await service.closeAll();
    await service.closeAll();

    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(service.attach("terminal-1").status).toBe("interrupted");
    expect(service.attach("terminal-2").status).toBe("interrupted");
  });
});

function fakeProcess() {
  let data: (value: string) => void = () => undefined;
  let exit: (event: { exitCode: number; signal?: number }) => void = () => undefined;
  return {
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(async () => undefined),
    onData: vi.fn((listener: (value: string) => void) => {
      data = listener;
      return () => undefined;
    }),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exit = listener;
      return () => undefined;
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    receiptReady: Promise.resolve(),
    emitData: (value: string) => data(value),
    emitExit: (event: { exitCode: number; signal?: number }) => exit(event),
  };
}

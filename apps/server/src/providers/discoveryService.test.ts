import { describe, expect, it, vi } from "vitest";
import {
  makeDiscoveryService,
  type DiscoveryExecPort,
  type DiscoveryFsPort,
} from "./discoveryService";

function makeFakeFs(
  existingPaths: Map<string, { file: boolean; symlink?: boolean; target?: string }>,
): DiscoveryFsPort {
  return {
    async access(path: string, _mode: number) {
      if (!existingPaths.has(path)) throw new Error("ENOENT");
    },
    async lstat(path: string) {
      const entry = existingPaths.get(path);
      if (entry === undefined) throw new Error("ENOENT");
      return {
        isSymbolicLink: () => entry.symlink === true,
        isFile: () => entry.file,
      };
    },
    async realpath(path: string) {
      const entry = existingPaths.get(path);
      if (entry === undefined) throw new Error("ENOENT");
      if (entry.symlink === true && entry.target !== undefined) return entry.target;
      return path;
    },
  };
}

function makeFakeExec(
  responses: Map<string, { stdout: string; stderr: string }>,
): DiscoveryExecPort {
  return async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    const response = responses.get(key);
    if (response === undefined) throw new Error(`exec failed: ${key}`);
    return response;
  };
}

const baseEnvironment = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/Users/test",
};

describe("discoveryService", () => {
  it("discovers an installed codex binary on PATH", async () => {
    const fs = makeFakeFs(new Map([["/usr/local/bin/codex", { file: true }]]));
    const exec = makeFakeExec(
      new Map([
        ["/usr/local/bin/codex --version", { stdout: "codex-cli 0.1.2507100955\n", stderr: "" }],
        ["/usr/local/bin/codex account read --json", { stdout: "{}", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: baseEnvironment,
      now: () => 1753430400000,
      hostId: "local",
    });

    const snapshot = await service.scan();
    expect(snapshot.status).toBe("completed");
    expect(snapshot.hostId).toBe("local");
    const codex = snapshot.candidates.find((c) => c.driverKind === "codex");
    expect(codex).toBeDefined();
    expect(codex!.binaryPath).toBe("/usr/local/bin/codex");
    expect(codex!.version).toBe("codex-cli 0.1.2507100955");
    expect(codex!.readiness).toBe("ready");
  });

  it("discovers user-installed runtimes when a Finder launch PATH omits home bins", async () => {
    const fs = makeFakeFs(
      new Map([
        ["/Users/test/.bun/bin/omp", { file: true }],
        ["/Users/test/.kimi-code/bin/kimi", { file: true }],
      ]),
    );
    const exec = makeFakeExec(
      new Map([
        ["/Users/test/.bun/bin/omp --version", { stdout: "omp 1.0.0\n", stderr: "" }],
        ["/Users/test/.kimi-code/bin/kimi --version", { stdout: "kimi 2.0.0\n", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();

    expect(snapshot.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          driverKind: "oh-my-pi",
          binaryPath: "/Users/test/.bun/bin/omp",
          pathSummary: "~/.bun/bin/omp",
        }),
        expect.objectContaining({
          driverKind: "kimi-code",
          binaryPath: "/Users/test/.kimi-code/bin/kimi",
          pathSummary: "~/.kimi-code/bin/kimi",
        }),
      ]),
    );
  });

  it("does not expose inherited provider credentials or arbitrary secrets to discovery probes", async () => {
    const fs = makeFakeFs(new Map([["/usr/local/bin/codex", { file: true }]]));
    const exec = vi.fn<DiscoveryExecPort>(async (_file, args) => ({
      stdout: args[0] === "--version" ? "codex-cli 1.0.0\n" : "{}",
      stderr: "",
    }));
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/Users/test",
        USER: "test",
        LANG: "en_US.UTF-8",
        AWS_ACCESS_KEY_ID: "secret",
        AWS_SESSION_TOKEN: "secret",
        AZURE_OPENAI_API_KEY: "secret",
        GOOGLE_API_KEY: "secret",
        MISTRAL_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
        ARBITRARY_SECRET: "secret",
      },
      now: () => 1753430400000,
    });

    await service.scan();

    expect(exec).toHaveBeenCalled();
    for (const [, , options] of exec.mock.calls) {
      expect(options.env).toEqual(
        expect.objectContaining({
          HOME: "/Users/test",
          LANG: "en_US.UTF-8",
          PATH: "/usr/local/bin:/usr/bin",
          USER: "test",
        }),
      );
      expect(options.env).not.toHaveProperty("AWS_ACCESS_KEY_ID");
      expect(options.env).not.toHaveProperty("AWS_SESSION_TOKEN");
      expect(options.env).not.toHaveProperty("AZURE_OPENAI_API_KEY");
      expect(options.env).not.toHaveProperty("GOOGLE_API_KEY");
      expect(options.env).not.toHaveProperty("MISTRAL_API_KEY");
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env).not.toHaveProperty("ARBITRARY_SECRET");
    }
  });

  it("reports unauthenticated when auth probe fails", async () => {
    const fs = makeFakeFs(new Map([["/usr/local/bin/codex", { file: true }]]));
    const exec = makeFakeExec(
      new Map([
        ["/usr/local/bin/codex --version", { stdout: "codex-cli 0.1.0\n", stderr: "" }],
        // auth probe not in map => throws
      ]),
    );
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: baseEnvironment,
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    const codex = snapshot.candidates.find((c) => c.driverKind === "codex");
    expect(codex).toBeDefined();
    expect(codex!.readiness).toBe("unauthenticated");
  });

  it("reports unknown readiness when no auth probe is defined", async () => {
    const fs = makeFakeFs(new Map([["/usr/local/bin/claude", { file: true }]]));
    const exec = makeFakeExec(
      new Map([["/usr/local/bin/claude --version", { stdout: "1.0.33\n", stderr: "" }]]),
    );
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: baseEnvironment,
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    const claude = snapshot.candidates.find((c) => c.driverKind === "claude");
    expect(claude).toBeDefined();
    expect(claude!.readiness).toBe("unknown");
  });

  it("resolves symlinks to canonical paths", async () => {
    const fs = makeFakeFs(
      new Map([
        ["/usr/local/bin/codex", { file: false, symlink: true, target: "/opt/codex/bin/codex" }],
        ["/opt/codex/bin/codex", { file: true }],
      ]),
    );
    const exec = makeFakeExec(
      new Map([
        ["/opt/codex/bin/codex --version", { stdout: "codex-cli 0.1.0\n", stderr: "" }],
        ["/opt/codex/bin/codex account read --json", { stdout: "{}", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: baseEnvironment,
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    const codex = snapshot.candidates.find((c) => c.driverKind === "codex");
    expect(codex).toBeDefined();
    expect(codex!.binaryPath).toBe("/opt/codex/bin/codex");
  });

  it("rejects non-executable files", async () => {
    const fs = makeFakeFs(new Map([["/usr/local/bin/codex", { file: true }]]));
    // Override access to fail for codex
    const failingFs: DiscoveryFsPort = {
      access: async () => {
        throw new Error("EACCES");
      },
      lstat: fs.lstat,
      realpath: fs.realpath,
    };
    const exec = makeFakeExec(new Map());
    const service = makeDiscoveryService({
      exec,
      fs: failingFs,
      environment: baseEnvironment,
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    expect(snapshot.candidates).toHaveLength(0);
  });

  it("rejects directories", async () => {
    const fs = makeFakeFs(new Map([["/usr/local/bin/codex", { file: false }]]));
    const exec = makeFakeExec(new Map());
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: baseEnvironment,
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    expect(snapshot.candidates.find((c) => c.driverKind === "codex")).toBeUndefined();
  });

  it("deduplicates candidates by canonical path", async () => {
    // Same binary found via PATH and approved location
    const fs = makeFakeFs(new Map([["/usr/local/bin/codex", { file: true }]]));
    const exec = makeFakeExec(
      new Map([
        ["/usr/local/bin/codex --version", { stdout: "codex-cli 0.1.0\n", stderr: "" }],
        ["/usr/local/bin/codex account read --json", { stdout: "{}", stderr: "" }],
      ]),
    );
    // /usr/local/bin is both in PATH and approved locations for codex
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: { PATH: "/usr/local/bin", HOME: "/Users/test" },
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    const codexCandidates = snapshot.candidates.filter((c) => c.driverKind === "codex");
    expect(codexCandidates).toHaveLength(1);
  });

  it("sanitizes PATH by rejecting relative and shell-metacharacter entries", async () => {
    const fs = makeFakeFs(new Map());
    const exec = makeFakeExec(new Map());
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: { PATH: "relative:$(evil):/usr/local/bin:/usr/bin", HOME: "/Users/test" },
      now: () => 1753430400000,
    });

    // Should not throw, just skip bad entries
    const snapshot = await service.scan();
    expect(snapshot.status).toBe("completed");
  });

  it("respects abort signal", async () => {
    const fs = makeFakeFs(new Map([["/usr/local/bin/codex", { file: true }]]));
    const exec = makeFakeExec(
      new Map([
        ["/usr/local/bin/codex --version", { stdout: "codex-cli 0.1.0\n", stderr: "" }],
        ["/usr/local/bin/codex account read --json", { stdout: "{}", stderr: "" }],
      ]),
    );
    const controller = new AbortController();
    controller.abort();
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: baseEnvironment,
      now: () => 1753430400000,
    });

    const snapshot = await service.scan(controller.signal);
    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.candidates).toHaveLength(0);
  });

  it("reports partial status when time budget is exceeded", async () => {
    let callCount = 0;
    const fs = makeFakeFs(
      new Map([
        ["/usr/local/bin/codex", { file: true }],
        ["/usr/local/bin/claude", { file: true }],
      ]),
    );
    const exec = makeFakeExec(
      new Map([
        ["/usr/local/bin/codex --version", { stdout: "codex-cli 0.1.0\n", stderr: "" }],
        ["/usr/local/bin/codex account read --json", { stdout: "{}", stderr: "" }],
        ["/usr/local/bin/claude --version", { stdout: "1.0.0\n", stderr: "" }],
      ]),
    );
    // Simulate time passing beyond budget after first descriptor
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: baseEnvironment,
      now: () => {
        callCount++;
        // After a few calls, exceed the 10s budget
        return callCount > 3 ? 1753430400000 + 11_000 : 1753430400000;
      },
    });

    const snapshot = await service.scan();
    expect(snapshot.status).toBe("partial");
  });

  it("does not discover direct HTTP endpoint providers", async () => {
    const fs = makeFakeFs(new Map());
    const exec = makeFakeExec(new Map());
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: baseEnvironment,
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    const httpKinds = snapshot.candidates.filter(
      (c) =>
        c.driverKind === "openai-compatible" ||
        c.driverKind === "anthropic-compatible" ||
        c.driverKind === "azure-foundry",
    );
    expect(httpKinds).toHaveLength(0);
  });

  it("summarizes home-relative paths with tilde", async () => {
    const fs = makeFakeFs(new Map([["/Users/test/.local/bin/codex", { file: true }]]));
    const exec = makeFakeExec(
      new Map([
        ["/Users/test/.local/bin/codex --version", { stdout: "codex-cli 0.1.0\n", stderr: "" }],
        ["/Users/test/.local/bin/codex account read --json", { stdout: "{}", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: { PATH: "/Users/test/.local/bin", HOME: "/Users/test" },
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    const codex = snapshot.candidates.find((c) => c.driverKind === "codex");
    expect(codex).toBeDefined();
    expect(codex!.pathSummary).toBe("~/.local/bin/codex");
  });

  it("discovers multiple providers in a single scan", async () => {
    const fs = makeFakeFs(
      new Map([
        ["/usr/local/bin/codex", { file: true }],
        ["/usr/local/bin/claude", { file: true }],
        ["/usr/local/bin/opencode", { file: true }],
      ]),
    );
    const exec = makeFakeExec(
      new Map([
        ["/usr/local/bin/codex --version", { stdout: "codex-cli 0.1.0\n", stderr: "" }],
        ["/usr/local/bin/codex account read --json", { stdout: "{}", stderr: "" }],
        ["/usr/local/bin/claude --version", { stdout: "1.0.33\n", stderr: "" }],
        ["/usr/local/bin/opencode --version", { stdout: "opencode 1.18.0\n", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      exec,
      fs,
      environment: baseEnvironment,
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    expect(snapshot.candidates.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.candidates.find((c) => c.driverKind === "codex")).toBeDefined();
    expect(snapshot.candidates.find((c) => c.driverKind === "claude")).toBeDefined();
    expect(snapshot.candidates.find((c) => c.driverKind === "opencode")).toBeDefined();
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DiscoverySnapshot, ProviderDriverKind } from "@octant/contracts";
import {
  MAX_ALIAS_FILE_BYTES,
  makeDiscoveryService,
  readDiscoveryText,
  type DiscoveryExecPort,
  type DiscoveryFsPort,
} from "./discoveryService";
import type { SeatbeltConfinementPort } from "../process/seatbeltProfile";

/**
 * These cases assert what the scan finds and what it hands a candidate, not
 * the profile. The live builder refuses on a host without `sandbox-exec`, and
 * a wrapped command would no longer match the fake exec's key.
 */
const passthroughConfinement: SeatbeltConfinementPort = {
  prepare: (input) => ({ command: input.executable, args: input.args }),
};

function makeFakeFs(
  existingPaths: Map<string, { file: boolean; symlink?: boolean; target?: string }>,
  files: Map<string, string> = new Map(),
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
    async readFile(path: string, maxBytes: number) {
      const content = files.get(path);
      if (content === undefined) return { kind: "unavailable" };
      if (Buffer.byteLength(content, "utf8") > maxBytes) return { kind: "too-large" };
      return { kind: "ok", content };
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

async function withTempDir(run: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "octant-alias-"));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
        ["/usr/local/bin/codex login status", { stdout: "Logged in", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
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
    expect(codex!.discoveredPath).toBeUndefined();
    expect(codex!.version).toBe("codex-cli 0.1.2507100955");
    expect(codex!.readiness).toBe("ready");
    expect(codexCoverage(snapshot)?.directories).toContain("/usr/local/bin");
  });

  it("discovers a provider whose executable is declared by a safe bash alias", async () => {
    const fs = makeFakeFs(
      new Map([["/Users/test/tools/grok-build", { file: true }]]),
      new Map([["/Users/test/.bash_aliases", "alias grok='/Users/test/tools/grok-build'\n"]]),
    );
    const exec = vi.fn<DiscoveryExecPort>(
      makeFakeExec(
        new Map([
          ["/Users/test/tools/grok-build --version", { stdout: "grok 1.0.5\n", stderr: "" }],
        ]),
      ),
    );
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs,
      environment: { PATH: "/usr/bin", HOME: "/Users/test" },
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    expect(snapshot.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          driverKind: "grok",
          binaryPath: "/Users/test/tools/grok-build",
          version: "grok 1.0.5",
        }),
      ]),
    );
  });

  it("uses aliases from the active shell without allowing another shell to replace them", async () => {
    const fs = makeFakeFs(
      new Map([["/Users/test/tools/grok-build", { file: true }]]),
      new Map([
        ["/Users/test/.bash_aliases", "alias grok='/Users/test/tools/grok-build'\n"],
        ["/Users/test/.zshrc", "alias grok='/Users/test/tools/not-grok'\n"],
      ]),
    );
    const exec = vi.fn<DiscoveryExecPort>(
      makeFakeExec(
        new Map([
          ["/Users/test/tools/grok-build --version", { stdout: "grok 1.0.5\n", stderr: "" }],
        ]),
      ),
    );

    const snapshot = await makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs,
      environment: { PATH: "/usr/bin", HOME: "/Users/test", SHELL: "/bin/bash" },
      now: () => 1753430400000,
    }).scan();

    expect(
      snapshot.candidates.some(
        (candidate) => candidate.binaryPath === "/Users/test/tools/grok-build",
      ),
    ).toBe(true);
    expect(exec).not.toHaveBeenCalledWith(
      "/Users/test/tools/not-grok",
      expect.anything(),
      expect.anything(),
    );
  });

  it("skips conflicting aliases when the active shell cannot be identified", async () => {
    const fs = makeFakeFs(
      new Map([
        ["/Users/test/tools/bash-grok", { file: true }],
        ["/Users/test/tools/zsh-grok", { file: true }],
      ]),
      new Map([
        ["/Users/test/.bashrc", "alias grok='/Users/test/tools/bash-grok'\n"],
        ["/Users/test/.zshrc", "alias grok='/Users/test/tools/zsh-grok'\n"],
      ]),
    );
    const exec = vi.fn<DiscoveryExecPort>();

    const snapshot = await makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs,
      environment: { PATH: "/usr/bin", HOME: "/Users/test" },
      now: () => 1753430400000,
    }).scan();

    expect(snapshot.candidates.some((candidate) => candidate.driverKind === "grok")).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not discover a provider from an alias file that exceeds the byte budget", async () => {
    const alias = "alias grok='/Users/test/tools/grok-build'\n";
    const content = `${"é".repeat(MAX_ALIAS_FILE_BYTES / 2 + 1)}${alias}`;
    expect(content.length).toBeLessThan(MAX_ALIAS_FILE_BYTES);
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(MAX_ALIAS_FILE_BYTES);

    const fs = makeFakeFs(
      new Map([["/Users/test/tools/grok-build", { file: true }]]),
      new Map([["/Users/test/.bash_aliases", content]]),
    );
    const readFile = vi.fn(fs.readFile);
    const exec = vi.fn<DiscoveryExecPort>();
    const snapshot = await makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs: { ...fs, readFile },
      environment: { PATH: "/usr/bin", HOME: "/Users/test", SHELL: "/bin/bash" },
      now: () => 1753430400000,
    }).scan();

    expect(snapshot.candidates.some((candidate) => candidate.driverKind === "grok")).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalled();
    for (const [, maxBytes] of readFile.mock.calls) {
      expect(maxBytes).toBe(MAX_ALIAS_FILE_BYTES);
    }
  });

  it("still discovers a safe alias that fills the byte budget exactly", async () => {
    const alias = "alias grok='/Users/test/tools/grok-build'\n";
    const padBytes = MAX_ALIAS_FILE_BYTES - Buffer.byteLength(alias, "utf8") - 1;
    const content = `${"#".repeat(padBytes)}\n${alias}`;
    expect(Buffer.byteLength(content, "utf8")).toBe(MAX_ALIAS_FILE_BYTES);

    const fs = makeFakeFs(
      new Map([["/Users/test/tools/grok-build", { file: true }]]),
      new Map([["/Users/test/.bash_aliases", content]]),
    );
    const exec = vi.fn<DiscoveryExecPort>(
      makeFakeExec(
        new Map([
          ["/Users/test/tools/grok-build --version", { stdout: "grok 1.0.5\n", stderr: "" }],
        ]),
      ),
    );
    const snapshot = await makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs,
      environment: { PATH: "/usr/bin", HOME: "/Users/test", SHELL: "/bin/bash" },
      now: () => 1753430400000,
    }).scan();

    expect(
      snapshot.candidates.some(
        (candidate) => candidate.binaryPath === "/Users/test/tools/grok-build",
      ),
    ).toBe(true);
  });

  it("ignores aliases that would require shell evaluation", async () => {
    const fs = makeFakeFs(
      new Map([["/Users/test/tools/grok-build", { file: true }]]),
      new Map([
        ["/Users/test/.bash_aliases", "alias grok='/Users/test/tools/grok-build --unsafe'\n"],
      ]),
    );
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec: makeFakeExec(new Map()),
      fs,
      environment: { PATH: "/usr/bin", HOME: "/Users/test" },
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    expect(snapshot.candidates.some((candidate) => candidate.driverKind === "grok")).toBe(false);
  });

  it("discovers the beta OpenCode executable from the approved user bin", async () => {
    const fs = makeFakeFs(new Map([["/Users/test/.local/bin/opencode2", { file: true }]]));
    const exec = makeFakeExec(
      new Map([
        [
          "/Users/test/.local/bin/opencode2 --version",
          { stdout: "opencode2 v0.0.0-beta-18721\n", stderr: "" },
        ],
      ]),
    );
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs,
      environment: { PATH: "/usr/bin", HOME: "/Users/test" },
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    expect(snapshot.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          driverKind: "opencode",
          displayName: "OpenCode 2 preview",
          binaryPath: "/Users/test/.local/bin/opencode2",
          version: "opencode2 v0.0.0-beta-18721",
          readiness: "unknown",
          pathSummary: "~/.local/bin/opencode2",
        }),
      ]),
    );
  });

  it("orders OpenCode 2 before the legacy runtime when both are installed", async () => {
    const fs = makeFakeFs(
      new Map([
        ["/usr/local/bin/opencode2", { file: true }],
        ["/usr/local/bin/opencode", { file: true }],
      ]),
    );
    const exec = makeFakeExec(
      new Map([
        [
          "/usr/local/bin/opencode2 --version",
          { stdout: "opencode2 v0.0.0-beta-19425\n", stderr: "" },
        ],
        ["/usr/local/bin/opencode --version", { stdout: "1.18.21\n", stderr: "" }],
      ]),
    );
    const snapshot = await makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs,
      environment: { PATH: "/usr/local/bin", HOME: "/Users/test" },
      now: () => 1753430400000,
    }).scan();

    const openCodeCandidates = snapshot.candidates.filter(
      (candidate) => candidate.driverKind === "opencode",
    );
    expect(openCodeCandidates.map((candidate) => candidate.displayName)).toEqual([
      "OpenCode 2 preview",
      "OpenCode CLI",
    ]);
  });

  it("discovers user-installed runtimes when a Finder launch PATH omits home bins", async () => {
    const fs = makeFakeFs(
      new Map([
        ["/Users/test/.bun/bin/omp", { file: true }],
        ["/Users/test/.kimi-code/bin/kimi", { file: true }],
        ["/Users/test/.grok/bin/grok", { file: true }],
      ]),
    );
    const exec = makeFakeExec(
      new Map([
        ["/Users/test/.bun/bin/omp --version", { stdout: "omp 1.0.0\n", stderr: "" }],
        ["/Users/test/.kimi-code/bin/kimi --version", { stdout: "kimi 2.0.0\n", stderr: "" }],
        ["/Users/test/.grok/bin/grok --version", { stdout: "grok 1.0.4 (0a1b2c3d)\n", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
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
        expect.objectContaining({
          driverKind: "grok",
          binaryPath: "/Users/test/.grok/bin/grok",
          pathSummary: "~/.grok/bin/grok",
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
      versionProbeConfinement: passthroughConfinement,
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
        CODEX_HOME: "/Users/test/.codex",
        CLAUDE_CONFIG_DIR: "/Users/test/.claude",
        XDG_CONFIG_HOME: "/Users/test/.config",
      },
      now: () => 1753430400000,
    });

    await service.scan();

    expect(exec).toHaveBeenCalled();
    for (const [, , options] of exec.mock.calls) {
      expect(options.env).toEqual(
        expect.objectContaining({
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
    // The version read is confined and answers out of its own scratch, so it
    // never learns where the user's home is; the readiness read still needs it.
    const [versionCall, readinessCall] = exec.mock.calls;
    expect(versionCall?.[2].env?.HOME).not.toBe("/Users/test");
    expect(versionCall?.[2].env?.HOME).toBe(versionCall?.[2].cwd);
    expect(readinessCall?.[2].env?.HOME).toBe("/Users/test");
    // A config-home variable would point the confined read at real provider
    // state it cannot open, so the read drops them and falls back to its HOME.
    for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
      expect(versionCall?.[2].env).not.toHaveProperty(name);
    }
    expect(readinessCall?.[2].env?.CODEX_HOME).toBe("/Users/test/.codex");
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
      versionProbeConfinement: passthroughConfinement,
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
      versionProbeConfinement: passthroughConfinement,
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

  it("keeps the symlink spelling a user configures while binaryPath stays canonical", async () => {
    const fs = makeFakeFs(
      new Map([
        ["/usr/local/bin/codex", { file: false, symlink: true, target: "/opt/codex/bin/codex" }],
        ["/opt/codex/bin/codex", { file: true }],
      ]),
    );
    const exec = makeFakeExec(
      new Map([
        ["/opt/codex/bin/codex --version", { stdout: "codex-cli 0.1.0\n", stderr: "" }],
        ["/opt/codex/bin/codex login status", { stdout: "Logged in", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs,
      environment: baseEnvironment,
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    const codex = snapshot.candidates.find((c) => c.driverKind === "codex");
    expect(codex).toBeDefined();
    expect(codex!.binaryPath).toBe("/opt/codex/bin/codex");
    expect(codex!.discoveredPath).toBe("/usr/local/bin/codex");
    expect(codexCoverage(snapshot)?.directories).toContain("/usr/local/bin");
  });

  it("keeps one candidate per discovered launcher path when two link to the same executable", async () => {
    const fs = makeFakeFs(
      new Map([
        ["/usr/local/bin/codex", { file: false, symlink: true, target: "/opt/codex/bin/codex" }],
        ["/opt/homebrew/bin/codex", { file: false, symlink: true, target: "/opt/codex/bin/codex" }],
        ["/opt/codex/bin/codex", { file: true }],
      ]),
    );
    const exec = makeFakeExec(
      new Map([
        ["/opt/codex/bin/codex --version", { stdout: "codex-cli 0.1.0\n", stderr: "" }],
        ["/opt/codex/bin/codex login status", { stdout: "Logged in", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs,
      environment: { PATH: "/usr/local/bin:/opt/homebrew/bin", HOME: "/Users/test" },
      now: () => 1753430400000,
    });

    const snapshot = await service.scan();
    const codexCandidates = snapshot.candidates.filter(
      (candidate) => candidate.driverKind === "codex",
    );
    expect(codexCandidates).toHaveLength(2);
    expect(codexCandidates.map((candidate) => candidate.discoveredPath).sort()).toEqual([
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ]);
    expect(
      codexCandidates.every((candidate) => candidate.binaryPath === "/opt/codex/bin/codex"),
    ).toBe(true);
  });

  it("records only directories a driver scan actually visited before timing out", async () => {
    let probes = 0;
    const fs = makeFakeFs(
      new Map([
        ["/usr/local/bin/codex", { file: true }],
        ["/usr/bin/codex", { file: true }],
      ]),
    );
    const exec = vi.fn<DiscoveryExecPort>(async (file, args) => {
      probes += 1;
      const key = `${file} ${args.join(" ")}`;
      if (key === "/usr/local/bin/codex --version") {
        return { stdout: "codex-cli 0.1.0\n", stderr: "" };
      }
      if (key === "/usr/local/bin/codex login status") {
        return { stdout: "Logged in", stderr: "" };
      }
      throw new Error("unexpected probe");
    });
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs,
      environment: { PATH: "/usr/local/bin:/usr/bin", HOME: "/Users/test" },
      now: () => (probes >= 2 ? 1753430400000 + 11_000 : 1753430400000),
    });

    const snapshot = await service.scan();
    expect(codexCoverage(snapshot)?.directories).toEqual(["/usr/local/bin"]);
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
      versionProbeConfinement: passthroughConfinement,
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
      versionProbeConfinement: passthroughConfinement,
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
        ["/usr/local/bin/codex login status", { stdout: "Logged in", stderr: "" }],
      ]),
    );
    // /usr/local/bin is both in PATH and approved locations for codex
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
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
      versionProbeConfinement: passthroughConfinement,
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
        ["/usr/local/bin/codex login status", { stdout: "Logged in", stderr: "" }],
      ]),
    );
    const controller = new AbortController();
    controller.abort();
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
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
        ["/usr/local/bin/codex login status", { stdout: "Logged in", stderr: "" }],
        ["/usr/local/bin/claude --version", { stdout: "1.0.0\n", stderr: "" }],
      ]),
    );
    // Simulate time passing beyond budget after first descriptor
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
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
      versionProbeConfinement: passthroughConfinement,
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
        ["/Users/test/.local/bin/codex login status", { stdout: "Logged in", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
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
        ["/usr/local/bin/codex login status", { stdout: "Logged in", stderr: "" }],
        ["/usr/local/bin/claude --version", { stdout: "1.0.33\n", stderr: "" }],
        ["/usr/local/bin/opencode --version", { stdout: "opencode 1.18.0\n", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
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

  it("does not discover a runtime whose provider-driver plugin is not admitted", async () => {
    const fs = makeFakeFs(
      new Map([
        ["/usr/local/bin/codex", { file: true }],
        ["/usr/local/bin/claude", { file: true }],
      ]),
    );
    const exec = makeFakeExec(
      new Map([
        ["/usr/local/bin/codex --version", { stdout: "codex-cli 0.1.0\n", stderr: "" }],
        ["/usr/local/bin/codex login status", { stdout: "Logged in", stderr: "" }],
        ["/usr/local/bin/claude --version", { stdout: "claude 1.0.0\n", stderr: "" }],
      ]),
    );
    const service = makeDiscoveryService({
      versionProbeConfinement: passthroughConfinement,
      exec,
      fs,
      environment: baseEnvironment,
      now: () => 1753430400000,
      hostId: "local",
      admittedDriverKinds: new Set<ProviderDriverKind>(["codex"]),
    });

    const snapshot = await service.scan();
    expect(snapshot.candidates.map((candidate) => candidate.driverKind)).toEqual(["codex"]);
  });

  it("reads only up to the alias byte budget from a regular home file", async () => {
    await withTempDir(async (home) => {
      const path = join(home, ".zshrc");
      writeFileSync(path, `${"a".repeat(40)}alias grok='/usr/bin/grok'\n`);
      await expect(readDiscoveryText(path, 32)).resolves.toEqual({ kind: "too-large" });
      writeFileSync(path, "alias grok='/usr/bin/grok'\n");
      await expect(readDiscoveryText(path, 32)).resolves.toEqual({
        kind: "ok",
        content: "alias grok='/usr/bin/grok'\n",
      });
    });
  });

  it("rejects a file whose UTF-8 bytes exceed the budget even when string length does not", async () => {
    await withTempDir(async (home) => {
      const path = join(home, ".bashrc");
      const content = `${"é".repeat(20)}alias grok='/usr/bin/grok'\n`;
      writeFileSync(path, content);
      expect(content.length).toBeLessThan(48);
      expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(48);
      await expect(readDiscoveryText(path, 48)).resolves.toEqual({ kind: "too-large" });
    });
  });

  it("reads a safe alias through a symlink to a regular file and skips an oversized target", async () => {
    await withTempDir(async (home) => {
      const target = join(home, "real-zshrc");
      const link = join(home, ".zshrc");
      writeFileSync(target, "alias grok='/usr/bin/grok'\n");
      symlinkSync(target, link);
      await expect(readDiscoveryText(link, 64)).resolves.toEqual({
        kind: "ok",
        content: "alias grok='/usr/bin/grok'\n",
      });
      writeFileSync(target, `${"a".repeat(80)}alias grok='/usr/bin/grok'\n`);
      await expect(readDiscoveryText(link, 64)).resolves.toEqual({ kind: "too-large" });
    });
  });

  it("skips directories, missing paths, and FIFOs without blocking the scan", async () => {
    await withTempDir(async (home) => {
      const directory = join(home, ".bashrc");
      mkdirSync(directory);
      await expect(readDiscoveryText(directory, 64)).resolves.toEqual({ kind: "unavailable" });
      await expect(readDiscoveryText(join(home, ".missing"), 64)).resolves.toEqual({
        kind: "unavailable",
      });

      if (process.platform === "win32") return;
      const fifo = join(home, ".zshrc");
      execFileSync("mkfifo", [fifo], { stdio: "ignore" });
      const startedAt = Date.now();
      const fifoResult = await Promise.race([
        readDiscoveryText(fifo, 64),
        new Promise<{ kind: "blocked" }>((resolve) => {
          setTimeout(() => resolve({ kind: "blocked" }), 1_000);
        }),
      ]);
      expect(fifoResult).toEqual({ kind: "unavailable" });
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      const fifoTarget = join(home, "alias-fifo");
      const fifoLink = join(home, ".bash_aliases");
      execFileSync("mkfifo", [fifoTarget], { stdio: "ignore" });
      symlinkSync(fifoTarget, fifoLink);
      const linkStartedAt = Date.now();
      const linkResult = await Promise.race([
        readDiscoveryText(fifoLink, 64),
        new Promise<{ kind: "blocked" }>((resolve) => {
          setTimeout(() => resolve({ kind: "blocked" }), 1_000);
        }),
      ]);
      expect(linkResult).toEqual({ kind: "unavailable" });
      expect(Date.now() - linkStartedAt).toBeLessThan(1_000);
    });
  });
});

function codexCoverage(snapshot: DiscoverySnapshot) {
  return snapshot.searchedDirectories?.find((entry) => entry.driverKind === "codex");
}

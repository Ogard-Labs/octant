import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import {
  makeOhMyPiProcessLive,
  ohMyPiProbeArguments,
  ohMyPiProcessEnvironment,
  sanitizeOhMyPiEnvironment,
} from "./ohMyPiProcess";

describe("Oh My Pi process probe", () => {
  it("prepends the binary directory and approved home bins so env-shebang runtimes resolve", () => {
    const environment = ohMyPiProcessEnvironment(
      "/Users/test/.bun/bin/omp",
      { HOME: "/Users/test", PATH: ["/usr/bin", "/bin"].join(delimiter) },
      "/tmp/omp-home",
    );

    expect(environment.PATH).toBe(
      [
        "/Users/test/.bun/bin",
        "/Users/test/.local/bin",
        "/Users/test/.kimi-code/bin",
        "/Users/test/.grok/bin",
        "/usr/bin",
        "/bin",
      ].join(delimiter),
    );
  });

  it("keeps probe args fail-closed without tools/extensions/skills/session", () => {
    expect(ohMyPiProbeArguments()).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-tools",
      "--no-lsp",
      "--profile",
      "octant-oh-my-pi-probe",
    ]);
  });

  it("sanitizes environment without leaking host secrets into the probe", () => {
    const env = sanitizeOhMyPiEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/Users/someone",
        OPENAI_API_KEY: "secret",
        OCTANT_DESKTOP_BRIDGE_SECRET: "bridge",
        LANG: "en_US.UTF-8",
      },
      "/tmp/octant-omp-home",
    );
    expect(env.HOME).toBe("/tmp/octant-omp-home");
    expect(env.OMP_HOME).toBe("/tmp/octant-omp-home");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("OCTANT_DESKTOP_BRIDGE_SECRET");
  });

  it("rejects relative binaries before spawn", async () => {
    const processPort = makeOhMyPiProcessLive();
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        processPort.startProbe({
          binaryPath: "omp",
          managedHome: "/tmp/octant-omp",
          supportedVersion: "17.2.1",
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("waits for ownership persistence before awaiting the ready frame", async () => {
    const root = mkdtempSync(join(tmpdir(), "octant-omp-"));
    const binaryPath = join(root, "omp");
    writeFileSync(
      binaryPath,
      '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then printf "17.2.1\\n"; exit 0; fi\nprintf \'{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1]}\\n\'\ncat >/dev/null\n',
    );
    chmodSync(binaryPath, 0o755);
    let releaseOwnership!: () => void;
    const ownershipReady = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const receipt = { ready: Promise.resolve(), remove: async () => undefined };
    let settled = false;
    let ownershipStarted = false;
    const connectionPromise = Effect.runPromise(
      Effect.scoped(
        makeOhMyPiProcessLive({
          versionTimeoutMs: 2_000,
          readyTimeoutMs: 2_000,
          shutdownTimeoutMs: 100,
        }).startProbe({
          binaryPath,
          managedHome: root,
          supportedVersion: "17.2.1",
          onProcessStarted: async () => {
            ownershipStarted = true;
            await ownershipReady;
            return receipt;
          },
        }),
      ),
    );
    void connectionPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await vi.waitFor(() => expect(ownershipStarted).toBe(true), { timeout: 5_000 });
      expect(settled).toBe(false);
      releaseOwnership();
      await expect(connectionPromise).resolves.toMatchObject({
        protocolVersion: 1,
      });
    } finally {
      releaseOwnership();
      await connectionPromise.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

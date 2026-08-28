import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makePiConfinementLive, piArguments, sanitizePiEnvironment } from "./piProcess";

const roots: string[] = [];

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-pi-")));
  roots.push(base);
  const root = join(base, "project");
  const home = join(base, "managed");
  const binary = join(base, "pi");
  const auth = join(base, "auth.json");
  const models = join(base, "models.json");
  const sandbox = join(base, "sandbox-exec");
  const bwrap = join(base, "bwrap");
  mkdirSync(root);
  writeFileSync(binary, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(sandbox, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(bwrap, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(auth, "private", { mode: 0o600 });
  writeFileSync(models, '{"providers":[]}', { mode: 0o600 });
  chmodSync(binary, 0o700);
  return { base, root, home, binary, auth, models, sandbox, bwrap };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Pi process boundary", () => {
  it("writes isolated configuration, links provider-owned auth, and loads only the Octant bridge", async () => {
    const f = fixture();
    const confinement = makePiConfinementLive({
      platform: "darwin",
      sandboxPath: f.sandbox,
      credentialPath: f.auth,
      modelsPath: f.models,
      temporaryDirectory: f.base,
    });
    const launch = await Effect.runPromise(
      confinement.prepare({
        binaryPath: f.binary,
        root: f.root,
        piHome: f.home,
        sessionDirectory: join(f.home, "sessions"),
        sessionId: "session-1",
        mode: "code",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment(
          {
            PATH: "/usr/bin",
            ANTHROPIC_API_KEY: "provider-owned",
            AIROUTER_API_KEY: "airouter-owned",
            NODE_OPTIONS: "--inspect",
          },
          f.home,
        ),
      }),
    );

    expect(launch.command).toBe(f.sandbox);
    expect(launch.args[1]).toContain("(allow process-fork)");
    expect(launch.args).toContain("--extension");
    expect(launch.args).toContain("bash,edit,write,read,grep,find,ls");
    expect(launch.args).toContain("--no-extensions");
    expect(launch.args).toContain("--no-skills");
    expect(launch.args).toContain("--no-context-files");
    expect(launch.args).toContain("--session-id");
    expect(launch.args).toContain("session-1");
    expect(launch.environment.ANTHROPIC_API_KEY).toBe("provider-owned");
    expect(launch.environment.AIROUTER_API_KEY).toBe("airouter-owned");
    expect(launch.environment.NODE_OPTIONS).toBeUndefined();
    expect(launch.environment.PI_TELEMETRY).toBe("0");
    expect(launch.environment.PI_SKIP_VERSION_CHECK).toBe("1");
    expect(launch.environment.PI_CODING_AGENT_DIR).toBe(f.home);

    const auth = join(f.home, "auth.json");
    expect(lstatSync(auth).isSymbolicLink()).toBe(true);
    expect(readFileSync(auth, "utf8")).toBe("private");
    const models = join(f.home, "models.json");
    expect(lstatSync(models).isSymbolicLink()).toBe(true);
    expect(readFileSync(models, "utf8")).toBe('{"providers":[]}');
    const settings = JSON.parse(readFileSync(join(f.home, "settings.json"), "utf8"));
    expect(settings).toEqual({ defaultProjectTrust: "never", enableInstallTelemetry: false });
    const bridge = readFileSync(join(f.home, "octant-approval-bridge.ts"), "utf8");
    expect(bridge).toMatch(/tool_call/);
    expect(bridge).toMatch(/ctx\.ui\.confirm/);
    expect(bridge).toMatch(/OCTANT_PI_APPROVALS/);
    expect(bridge).not.toMatch(/install|registerTool|registerCommand/);
  });

  it("maps modes to the minimum Pi tools and keeps full access genuine", async () => {
    expect(piArguments("/bridge.ts", "/sessions", "chat-1", "chat", "approval-gated")).toContain(
      "--no-tools",
    );
    expect(piArguments("/bridge.ts", "/sessions", "plan-1", "code", "plan")).toEqual(
      expect.arrayContaining(["--tools", "read,grep,find,ls"]),
    );
    expect(piArguments("/bridge.ts", "/sessions", "full-1", "code", "full-access")).toEqual(
      expect.arrayContaining(["--tools", "bash,edit,write,read,grep,find,ls"]),
    );

    const f = fixture();
    const launch = await Effect.runPromise(
      makePiConfinementLive({
        platform: "darwin",
        sandboxPath: f.sandbox,
        temporaryDirectory: f.base,
      }).prepare({
        binaryPath: f.binary,
        root: f.root,
        piHome: f.home,
        sessionDirectory: join(f.home, "sessions"),
        sessionId: "full-1",
        mode: "code",
        executionPolicy: "full-access",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, f.home),
      }),
    );
    expect(launch.command).toBe(f.binary);
    expect(launch.args[0]).toBe("--mode");
    expect(launch.environment.OCTANT_PI_APPROVALS).toBe("disabled");
    expect(existsSync(join(f.home, "octant-approval-bridge.ts"))).toBe(true);

    const plan = fixture();
    const planLaunch = await Effect.runPromise(
      makePiConfinementLive({
        platform: "darwin",
        sandboxPath: plan.sandbox,
        temporaryDirectory: plan.base,
      }).prepare({
        binaryPath: plan.binary,
        root: plan.root,
        piHome: plan.home,
        sessionDirectory: join(plan.home, "sessions"),
        sessionId: "plan-1",
        mode: "code",
        executionPolicy: "plan",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, plan.home),
      }),
    );
    expect(planLaunch.args[1]).not.toContain("(allow process-fork)");
  });

  it("fails closed for non-macOS bounded modes and pre-existing provider-owned targets", async () => {
    const f = fixture();
    const occupied = join(f.home, "auth.json");
    mkdirSync(f.home, { recursive: true });
    symlinkSync(f.binary, occupied);
    await expect(
      Effect.runPromise(
        makePiConfinementLive({
          platform: "darwin",
          sandboxPath: f.sandbox,
          credentialPath: f.auth,
          modelsPath: f.models,
          temporaryDirectory: f.base,
        }).prepare({
          binaryPath: f.binary,
          root: f.root,
          piHome: f.home,
          sessionDirectory: join(f.home, "sessions"),
          sessionId: "x",
          mode: "code",
          executionPolicy: "plan",
          environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, f.home),
        }),
      ),
    ).rejects.toThrow(/invalid-configuration/);

    const occupiedModels = fixture();
    mkdirSync(occupiedModels.home, { recursive: true });
    writeFileSync(join(occupiedModels.home, "models.json"), "occupied", { mode: 0o600 });
    await expect(
      Effect.runPromise(
        makePiConfinementLive({
          platform: "darwin",
          sandboxPath: occupiedModels.sandbox,
          modelsPath: occupiedModels.models,
          temporaryDirectory: occupiedModels.base,
        }).prepare({
          binaryPath: occupiedModels.binary,
          root: occupiedModels.root,
          piHome: occupiedModels.home,
          sessionDirectory: join(occupiedModels.home, "sessions"),
          sessionId: "x",
          mode: "code",
          executionPolicy: "plan",
          environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, occupiedModels.home),
        }),
      ),
    ).rejects.toThrow(/invalid-configuration/);

    const other = fixture();
    const linux = await Effect.runPromise(
      makePiConfinementLive({
        platform: "linux",
        sandboxPath: other.bwrap,
        temporaryDirectory: other.base,
      }).prepare({
        binaryPath: other.binary,
        root: other.root,
        piHome: other.home,
        sessionDirectory: join(other.home, "sessions"),
        sessionId: "x",
        mode: "code",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, other.home),
      }),
    );
    expect(linux.command).toBe(other.bwrap);
    expect(linux.args).toContain("--unshare-all");
    expect(linux.args).toContain("--");
    expect(linux.args).toContain(other.binary);
  });
});

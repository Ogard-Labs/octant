import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInstanceId, UtcTimestamp } from "@octant/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  AntigravityStatusLineBridge,
  antigravityStatusLineLimits,
  buildInteractiveAgyLaunchScript,
  canonicalAntigravityWindowId,
  makeAntigravityStatusLineUsageFacts,
  parseAntigravityStatusLinePayload,
} from "./antigravityStatusLineUsage";

const instanceId = "11111111-1111-4111-8111-111111111111" as ProviderInstanceId;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "octant-agy-statusline-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("antigravity status-line usage", () => {
  it("maps documented Antigravity bucket IDs to canonical scope:window names", () => {
    expect(canonicalAntigravityWindowId("gemini-5h")).toBe("gemini:five_hour");
    expect(canonicalAntigravityWindowId("gemini-weekly")).toBe("gemini:seven_day");
    expect(canonicalAntigravityWindowId("3p-5h")).toBe("claude_gpt:five_hour");
    expect(canonicalAntigravityWindowId("3p-weekly")).toBe("claude_gpt:seven_day");
    expect(canonicalAntigravityWindowId("claude-gpt-5h")).toBe("claude_gpt:five_hour");
  });

  it("parses live payloads, ignores epoch-0 resets, strips sensitive fields, and orders Gemini before partner buckets", () => {
    const now = new Date("2026-11-26T11:00:00.000Z");
    const reading = parseAntigravityStatusLinePayload(
      JSON.stringify({
        cwd: "/Users/secret/project",
        session_id: "conv-123",
        email: "person@example.com",
        plan_tier: "Google AI Ultra",
        quota: {
          "3p-weekly": { remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
          "3p-5h": { remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
          "gemini-weekly": { remaining_fraction: 0.98, reset_time: "2026-12-03T07:54:29Z" },
          "gemini-5h": { remaining_fraction: 0.96, reset_time: "2026-11-26T12:54:29Z" },
          "disabled-bucket": { remaining_fraction: 0.5, disabled: true },
        },
      }),
      now,
    );

    expect(reading).toEqual({
      recordedAt: "2026-11-26T11:00:00.000Z",
      planTier: "Google AI Ultra",
      buckets: [
        {
          id: "gemini-5h",
          remainingFraction: 0.96,
          resetsAt: "2026-11-26T12:54:29.000Z",
        },
        {
          id: "gemini-weekly",
          remainingFraction: 0.98,
          resetsAt: "2026-12-03T07:54:29.000Z",
        },
        { id: "3p-5h", remainingFraction: 1 },
        { id: "3p-weekly", remainingFraction: 1 },
      ],
    });
    expect(JSON.stringify(reading)).not.toContain("/Users/secret");
    expect(JSON.stringify(reading)).not.toContain("person@example.com");
    expect(JSON.stringify(reading)).not.toContain("conv-123");

    const limits = antigravityStatusLineLimits(
      instanceId,
      reading!,
      "2026-11-26T11:05:00.000Z" as UtcTimestamp,
    );
    expect(limits?.scope).toBe("account");
    expect(limits?.quota).toBe("unknown");
    expect(limits?.rateLimitWindows?.map((w) => w.window)).toEqual([
      "gemini:five_hour",
      "gemini:seven_day",
      "claude_gpt:five_hour",
      "claude_gpt:seven_day",
    ]);
    expect(limits?.rateLimitWindows?.[0]?.utilization).toBeCloseTo(0.04, 6);
    expect(limits?.rateLimitWindows?.[2]?.resetsAt).toBeUndefined();
  });

  it("keeps aggregate quota unknown when one model-family bucket is exhausted so unrelated models are not blocked", () => {
    const now = new Date("2026-11-26T11:00:00.000Z");
    const reading = parseAntigravityStatusLinePayload(
      JSON.stringify({
        quota: {
          "gemini-5h": { reset_time: "2026-11-26T12:00:00Z" },
          "gemini-weekly": { remaining_fraction: 0.5, reset_time: "2026-12-01T00:00:00Z" },
        },
      }),
      now,
    );
    expect(reading?.buckets[0]?.remainingFraction).toBe(0);

    const active = antigravityStatusLineLimits(
      instanceId,
      reading!,
      "2026-11-26T11:30:00.000Z" as UtcTimestamp,
    );
    expect(active?.quota).toBe("unknown");
    expect(active?.rateLimitWindows?.[0]?.status).toBe("exhausted");
    expect(active?.rateLimitWindows).toHaveLength(2);

    const after5hReset = antigravityStatusLineLimits(
      instanceId,
      reading!,
      "2026-11-26T12:05:00.000Z" as UtcTimestamp,
    );
    expect(after5hReset?.quota).toBe("unknown");
    expect(after5hReset?.rateLimitWindows?.map((w) => w.window)).toEqual(["gemini:seven_day"]);
  });

  it("reversibly installs into settings.json, chains an active command, executes the bridge script, and restores cleanly", () => {
    const root = makeTempDir();
    const dataDir = join(root, "octant-data");
    const configDir = join(root, "antigravity-cli");
    const settingsPath = join(configDir, "settings.json");

    const bridge = new AntigravityStatusLineBridge({
      dataDirectory: dataDir,
      configDirectory: configDir,
      nodeExecutable: process.execPath,
    });

    // Seed an existing active statusLine (e.g., a user-configured script) and unrelated settings.
    writeFileSync(join(root, "chained.sh"), "#!/bin/sh\ncat >/dev/null\nprintf 'CHAINED_OK'\n", {
      mode: 0o755,
    });
    const chainedCommand = `'${join(root, "chained.sh")}'`;
    const seedSettings = {
      theme: "dark",
      statusLine: { type: "command", command: chainedCommand, enabled: true },
    };
    const origDir = makeTempDir();
    const bridge2 = new AntigravityStatusLineBridge({
      dataDirectory: dataDir,
      configDirectory: origDir,
      nodeExecutable: process.execPath,
    });
    writeFileSync(join(origDir, "settings.json"), JSON.stringify(seedSettings));

    const connected = bridge2.connect();
    expect(connected.connected).toBe(true);

    const edited = JSON.parse(readFileSync(join(origDir, "settings.json"), "utf8")) as {
      theme: string;
      statusLine: Record<string, unknown>;
    };
    expect(edited.theme).toBe("dark");
    expect(edited.statusLine.enabled).toBe(true);
    expect(edited.statusLine.command).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(edited.statusLine.command).toContain("antigravity-statusline-bridge.mjs");

    // Execute the installed bridge script directly, simulating `agy` piping statusLine JSON.
    const samplePayload = JSON.stringify({
      cwd: "/private/should-not-save",
      plan_tier: "Google AI Ultra",
      quota: {
        "gemini-5h": { remaining_fraction: 0.91, reset_time: "2026-11-26T15:00:00Z" },
      },
    });
    const run = spawnSync(process.execPath, [bridge2.scriptPath], {
      input: samplePayload,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("CHAINED_OK");

    const stored = bridge2.readReading();
    expect(stored?.planTier).toBe("Google AI Ultra");
    expect(stored?.buckets[0]?.remainingFraction).toBe(0.91);
    expect(statSync(bridge2.readingPath).mode & 0o777).toBe(0o600);

    // Disconnect restores the original statusLine command verbatim.
    const disconnected = bridge2.disconnect();
    expect(disconnected.restored).toBe(true);
    expect(disconnected.status.connected).toBe(false);
    const restored = JSON.parse(readFileSync(join(origDir, "settings.json"), "utf8"));
    expect(restored).toEqual(seedSettings);

    // Fresh config folder (no prior statusLine) enables stack_with_default and deletes statusLine on disconnect.
    expect(bridge.connect().connected).toBe(true);
    const freshSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      statusLine?: Record<string, unknown>;
    };
    expect(freshSettings.statusLine?.stack_with_default).toBe(true);
    expect(bridge.disconnect().restored).toBe(true);
    const afterFreshDisconnect = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      statusLine?: unknown;
    };
    expect(afterFreshDisconnect.statusLine).toBeUndefined();
  });

  it("leaves later user-edited statusLine commands untouched on disconnect and skips chaining disabled commands", () => {
    const root = makeTempDir();
    const dataDir = join(root, "octant-data");
    const configDir = join(root, "antigravity-cli");
    const bridge = new AntigravityStatusLineBridge({
      dataDirectory: dataDir,
      configDirectory: configDir,
      nodeExecutable: process.execPath,
    });
    bridge.connect();

    // Simulate a disabled statusLine before connect on another directory.
    const disabledDir = join(root, "disabled-cli");
    const disabledBridge = new AntigravityStatusLineBridge({
      dataDirectory: join(root, "disabled-data"),
      configDirectory: disabledDir,
      nodeExecutable: process.execPath,
    });
    const initialDisabled = {
      statusLine: { type: "command", command: "echo should-not-run", enabled: false },
    };
    mkdirSync(disabledDir, { recursive: true });
    writeFileSync(join(disabledDir, "settings.json"), JSON.stringify(initialDisabled));
    disabledBridge.connect();
    const disabledSettings = JSON.parse(
      readFileSync(join(disabledDir, "settings.json"), "utf8"),
    ) as { statusLine: Record<string, unknown> };
    expect(disabledSettings.statusLine.stack_with_default).toBe(true);
    const runDisabled = spawnSync(process.execPath, [disabledBridge.scriptPath], {
      input: JSON.stringify({ quota: { "gemini-5h": { remaining_fraction: 0.8 } } }),
      encoding: "utf8",
    });
    expect(runDisabled.stdout).toBe("");
    expect(disabledBridge.disconnect().restored).toBe(true);
    expect(JSON.parse(readFileSync(join(disabledDir, "settings.json"), "utf8"))).toEqual(
      initialDisabled,
    );

    // If user later replaces statusLine.command, disconnect keeps their command.
    writeFileSync(
      bridge.settingsPath,
      JSON.stringify({
        statusLine: { type: "command", command: "echo user-owned", enabled: true },
      }),
    );
    const result = bridge.disconnect();
    expect(result.restored).toBe(false);
    expect(
      (JSON.parse(readFileSync(bridge.settingsPath, "utf8")) as { statusLine: { command: string } })
        .statusLine.command,
    ).toBe("echo user-owned");
  });

  it("reports plan-limits-do-not-apply for api-key and agent-platform and reads passive snapshots for personal sign-in", async () => {
    const root = makeTempDir();
    const bridge = new AntigravityStatusLineBridge({
      dataDirectory: join(root, "data"),
      configDirectory: join(root, "config"),
      clock: () => "2026-11-26T11:05:00.000Z",
    });

    const apiKeyFacts = makeAntigravityStatusLineUsageFacts({
      instanceId,
      authentication: "api-key",
      bridge,
    });
    expect(apiKeyFacts.limitsCapture).toBeUndefined();
    const apiKeyResult = await Effect.runPromise(
      Effect.scoped(Effect.either(apiKeyFacts.observeServiceLimits({ instanceId }))),
    );
    expect(apiKeyResult._tag).toBe("Left");
    if (apiKeyResult._tag === "Left") expect(apiKeyResult.left.category).toBe("unsupported");

    const personalFacts = makeAntigravityStatusLineUsageFacts({
      instanceId,
      authentication: "provider-owned",
      bridge,
    });
    expect(personalFacts.limitsCapture?.status().connected).toBe(false);
    const beforeReading = await Effect.runPromise(
      Effect.scoped(Effect.either(personalFacts.observeServiceLimits({ instanceId }))),
    );
    expect(beforeReading._tag).toBe("Left");
    if (beforeReading._tag === "Left") expect(beforeReading.left.category).toBe("unavailable");

    // Write a sanitized reading as the bridge script would.
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(
      bridge.readingPath,
      JSON.stringify({
        recordedAt: "2026-11-26T11:00:00.000Z",
        planTier: "Google AI Ultra",
        buckets: [
          {
            id: "gemini-5h",
            remainingFraction: 0.95,
            resetsAt: "2026-11-26T15:00:00.000Z",
          },
        ],
      }),
    );
    const afterReading = await Effect.runPromise(
      Effect.scoped(Effect.either(personalFacts.observeServiceLimits({ instanceId }))),
    );
    expect(afterReading._tag).toBe("Right");
    if (afterReading._tag === "Right") {
      expect(afterReading.right.rateLimitWindows?.[0]?.window).toBe("gemini:five_hour");
      expect(afterReading.right.rateLimitWindows?.[0]?.utilization).toBeCloseTo(0.05, 6);
    }
  });

  it("preserves symlinked settings.json, refuses cross-profile overwrite, falls back to reset_in_seconds in bridge script, and keeps Disconnect available after sign-in switch", () => {
    const root = makeTempDir();
    const dotfilesDir = join(root, "dotfiles");
    const configDir = join(root, "antigravity-cli");
    mkdirSync(dotfilesDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const targetSettings = join(dotfilesDir, "settings.json");
    writeFileSync(targetSettings, JSON.stringify({ theme: "light" }));
    const linkSettings = join(configDir, "settings.json");
    symlinkSync(targetSettings, linkSettings);

    const primaryBridge = new AntigravityStatusLineBridge({
      dataDirectory: join(root, "primary-data"),
      configDirectory: configDir,
      nodeExecutable: process.execPath,
    });
    expect(primaryBridge.connect().connected).toBe(true);
    expect(lstatSync(linkSettings).isSymbolicLink()).toBe(true);

    // Second host profile refuses to wrap the first host's bridge as an original command.
    const secondaryBridge = new AntigravityStatusLineBridge({
      dataDirectory: join(root, "secondary-data"),
      configDirectory: configDir,
      nodeExecutable: process.execPath,
    });
    expect(() => secondaryBridge.connect()).toThrow(/another Octant host profile/i);

    // Installed bridge script falls back to reset_in_seconds on malformed nonblank reset_time.
    const runMalformedReset = spawnSync(process.execPath, [primaryBridge.scriptPath], {
      input: JSON.stringify({
        quota: {
          "gemini-5h": {
            remaining_fraction: 0.75,
            reset_time: "not-a-timestamp",
            reset_in_seconds: 1800,
          },
        },
      }),
      encoding: "utf8",
    });
    expect(runMalformedReset.status).toBe(0);
    expect(primaryBridge.readReading()?.buckets[0]?.resetsAt).toBeDefined();

    // Switching sign-in to api-key while connected still exposes Disconnect (without triggerRefresh).
    const switchedFacts = makeAntigravityStatusLineUsageFacts({
      instanceId,
      authentication: "api-key",
      bridge: primaryBridge,
    });
    expect(switchedFacts.limitsCapture?.status().connected).toBe(true);
    expect(switchedFacts.limitsCapture?.triggerRefresh).toBeUndefined();

    // Disconnect restores target file and preserves the symlink itself.
    expect(primaryBridge.disconnect().restored).toBe(true);
    expect(lstatSync(linkSettings).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(targetSettings, "utf8"))).toEqual({ theme: "light" });
  });

  it("builds an interactive agy launch script without headless print flags", () => {
    const explicit = buildInteractiveAgyLaunchScript("/Users/tester/.local/bin/agy");
    expect(explicit).toContain('rm -f -- "$0"');
    expect(explicit).toContain("exec '/Users/tester/.local/bin/agy'");
    expect(explicit).not.toContain(" -p");
    expect(explicit).not.toContain("--print");

    const quoted = buildInteractiveAgyLaunchScript("/opt/my's/agy");
    expect(quoted).toContain("exec '/opt/my'\\''s/agy'");
  });
});

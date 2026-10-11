import { describe, expect, it } from "vitest";

import {
  snapshotClaudeHostEnvironment,
  withClaudeAccountDirectory,
} from "./claudeAccountDirectory";

describe("withClaudeAccountDirectory", () => {
  it("keeps a concurrent host snapshot off an isolated overlay", async () => {
    const hostConfig = process.env.CLAUDE_CONFIG_DIR;
    const hostSecure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    let releaseOverlay: (() => void) | undefined;
    const overlayHeld = new Promise<void>((resolve) => {
      void withClaudeAccountDirectory("/Users/example/.claude-accounts/work", async () => {
        resolve();
        await new Promise<void>((hold) => {
          releaseOverlay = hold;
        });
      });
    });
    await overlayHeld;
    expect(process.env.CLAUDE_CONFIG_DIR).toBe("/Users/example/.claude-accounts/work");
    expect(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
      "/Users/example/.claude-accounts/work",
    );

    const snapshotPromise = snapshotClaudeHostEnvironment();
    const defaultLookup = withClaudeAccountDirectory(undefined, async () => ({
      config: process.env.CLAUDE_CONFIG_DIR,
      secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
    }));
    releaseOverlay?.();

    const snapshot = await snapshotPromise;
    const defaultEnv = await defaultLookup;
    expect(snapshot.CLAUDE_CONFIG_DIR).toBe(hostConfig);
    expect(snapshot.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(hostSecure);
    expect(defaultEnv).toEqual({ config: hostConfig, secure: hostSecure });
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(hostConfig);
    expect(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(hostSecure);
  });
});

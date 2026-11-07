import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTurnMetricsRecord } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { digestPrompt, openPromptDigester, openPromptDigestKey } from "./promptDigest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "octant-digest-"));
  directories.push(directory);
  return directory;
};

const keyA = new Uint8Array(32).fill(1);
const keyB = new Uint8Array(32).fill(2);

describe("prompt digest", () => {
  it("digests the same prompt alike whatever its whitespace, and a different key differently", () => {
    const digest = digestPrompt(keyA, "Explain the  diff.");
    expect(digestPrompt(keyA, "  Explain the diff.\n")).toBe(digest);
    expect(digestPrompt(keyA, "Explain\tthe\n\ndiff.")).toBe(digest);
    expect(digestPrompt(keyA, "Explain the diff!")).not.toBe(digest);
    expect(digestPrompt(keyB, "Explain the diff.")).not.toBe(digest);
    expect(digest).not.toContain("Explain");
    expect(
      decodeTurnMetricsRecord({
        threadId: "62000000-0000-4000-8000-000000000001",
        mode: "chat",
        providerInstanceId: "62000000-0000-4000-8000-000000000002",
        modelId: "model-a",
        stopReason: "end-of-turn",
        metrics: { precision: "unavailable", wallMs: 1 },
        promptDigest: digest,
        startedAt: "2026-10-06T12:00:00.000Z",
        endedAt: "2026-10-06T12:00:01.000Z",
      }).promptDigest,
    ).toBe(digest);
  });

  it("makes one private key on first use and reads the same key afterwards", () => {
    const path = join(scratch(), "state", "prompt-digest.key");
    const first = openPromptDigestKey(path);
    if (first === undefined) throw new Error("the key was not made");
    expect(first.length).toBe(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(openPromptDigestKey(path)).toEqual(first);
    expect(openPromptDigester(path)?.("hello")).toBe(digestPrompt(first, "hello"));
  });

  it("records no digest when the key file is unusable", () => {
    const path = join(scratch(), "prompt-digest.key");
    writeFileSync(path, "not a key");
    expect(openPromptDigestKey(path)).toBeUndefined();
    expect(openPromptDigester(path)).toBeUndefined();
  });
});

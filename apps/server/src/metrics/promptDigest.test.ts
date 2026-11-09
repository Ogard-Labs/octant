import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeTurnMetricsRecord } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { withPromptDigest } from "./turnEnd";
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

  it("replaces a short or empty key file a crash left, so digests are not off forever", () => {
    const directory = scratch();
    for (const leftover of ["", "abc123"]) {
      const path = join(directory, "prompt-digest.key");
      writeFileSync(path, leftover);
      const key = openPromptDigestKey(path);
      expect(key?.length).toBe(32);
      expect(openPromptDigestKey(path)).toEqual(key);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(directory)).toEqual(["prompt-digest.key"]);
  });

  it("keeps an existing key and leaves no temporary file behind", () => {
    const directory = scratch();
    const path = join(directory, "prompt-digest.key");
    const first = openPromptDigestKey(path);
    expect(openPromptDigestKey(path)).toEqual(first);
    expect(readdirSync(directory)).toEqual(["prompt-digest.key"]);
  });

  it("records no digest when the key cannot be stored", () => {
    const directory = scratch();
    const blocker = join(directory, "blocker");
    writeFileSync(blocker, "a file where a folder is needed");
    expect(openPromptDigester(join(blocker, "prompt-digest.key"))).toBeUndefined();
  });

  it("digests only a thread's first turn", () => {
    const turn = { stopReason: "end-of-turn", startedAt: "a", endedAt: "b" } as never;
    const digest = (text: string) => `digest:${text}`;
    expect(withPromptDigest(turn, digest, "Explain.", { firstTurn: true })).toMatchObject({
      promptDigest: "digest:Explain.",
    });
    expect(withPromptDigest(turn, digest, "continue", { firstTurn: false })).toBe(turn);
    expect(withPromptDigest(turn, undefined, "Explain.", { firstTurn: true })).toBe(turn);
  });
});

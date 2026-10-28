import { MAX_THREAD_PUBLISHED_SNAPSHOT_BYTES } from "@octant/contracts";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readClaudePublishedSnapshot } from "./claudePublishedSnapshot";

describe("a published page's snapshot", () => {
  it("keeps a Markdown file's text, and nothing of a file too large, binary, or reached through a link", async () => {
    const folder = await mkdtemp(join(tmpdir(), "octant-published-snapshot-"));
    const notes = join(folder, "notes.md");
    await writeFile(notes, "# Notes\n\nShipped.");
    await expect(readClaudePublishedSnapshot(notes)).resolves.toEqual({
      format: "markdown",
      content: "# Notes\n\nShipped.",
    });

    const large = join(folder, "large.html");
    await writeFile(large, "a".repeat(MAX_THREAD_PUBLISHED_SNAPSHOT_BYTES + 1));
    await expect(readClaudePublishedSnapshot(large)).resolves.toBeUndefined();

    const binary = join(folder, "binary.html");
    await writeFile(binary, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    await expect(readClaudePublishedSnapshot(binary)).resolves.toBeUndefined();

    const linked = join(folder, "linked.md");
    await symlink(notes, linked);
    await expect(readClaudePublishedSnapshot(linked)).resolves.toBeUndefined();
  });
});

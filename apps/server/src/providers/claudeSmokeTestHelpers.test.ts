import {
  chmod,
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  claudeSdkProcessIdsFromListing,
  runClaudeSmokeCleanupSteps,
  sameClaudeConfigurationSnapshots,
  snapshotClaudeConfigurationMetadata,
  withTimeout,
} from "./claudeSmokeTestHelpers";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map(async (root) => {
      temporaryRoots.delete(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("Claude smoke timeout and cleanup bounds", () => {
  it("rejects without awaiting an operation that never settles after cancellation", async () => {
    const startedAt = Date.now();

    await expect(
      withTimeout(new Promise<never>(() => undefined), 5, async () => undefined),
    ).rejects.toThrow("timed out");
    expect(Date.now() - startedAt).toBeLessThan(250);
  }, 500);

  it("attempts later residue checks after an earlier cleanup failure", async () => {
    const attempts: string[] = [];

    await expect(
      runClaudeSmokeCleanupSteps([
        {
          label: "repository",
          run: async () => {
            attempts.push("repository");
            throw new Error("private path detail");
          },
        },
        {
          label: "config-directories",
          run: async () => {
            attempts.push("config-directories");
            throw new Error("second private detail");
          },
        },
        {
          label: "processes",
          run: async () => {
            attempts.push("processes");
          },
        },
      ]),
    ).rejects.toThrow("Installed Claude cleanup failed: repository, config-directories.");
    expect(attempts).toEqual(["repository", "config-directories", "processes"]);
  });

  it("bounds a hanging close and still attempts later cleanup", async () => {
    const attempts: string[] = [];
    const cleanup = runClaudeSmokeCleanupSteps([
      {
        label: "connections",
        timeoutMs: 10,
        run: () => {
          attempts.push("connections");
          return new Promise<void>(() => undefined);
        },
      },
      {
        label: "registry",
        run: async () => {
          attempts.push("registry");
        },
      },
    ]);

    const result = await Promise.race([
      cleanup.then(
        () => "passed",
        () => "failed",
      ),
      new Promise<"deadline">((resolvePromise) => {
        setTimeout(() => resolvePromise("deadline"), 250);
      }),
    ]);

    expect(result).toBe("failed");
    expect(attempts).toEqual(["connections", "registry"]);
  });
});

describe("Claude configuration metadata snapshots", () => {
  it.each([
    "nested create",
    "nested delete",
    "nested rename",
    "nested content-size change",
    "nested timestamp change",
    "nested metadata change",
  ] as const)("detects %s without reading file contents", async (mutation) => {
    const root = await mkdtemp(join(tmpdir(), "octant-claude-metadata-"));
    temporaryRoots.add(root);
    const nested = join(root, "one", "two");
    await mkdir(nested, { recursive: true });
    const original = join(nested, "original.json");
    if (mutation !== "nested create") await writeFile(original, "before", "utf8");
    const before = await snapshotClaudeConfigurationMetadata([root]);

    if (mutation === "nested create") {
      await writeFile(original, "created", "utf8");
    } else if (mutation === "nested delete") {
      await unlink(original);
    } else if (mutation === "nested rename") {
      await rename(original, join(nested, "renamed.json"));
    } else if (mutation === "nested content-size change") {
      await writeFile(original, "after-with-a-different-size", "utf8");
    } else if (mutation === "nested timestamp change") {
      const changed = new Date(Date.now() + 5_000);
      await utimes(original, changed, changed);
    } else {
      await chmod(original, 0o600);
    }

    const after = await snapshotClaudeConfigurationMetadata([root]);
    expect(sameClaudeConfigurationSnapshots(before, after)).toBe(false);
  });

  it("records symlinks without following their targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-claude-metadata-"));
    const external = await mkdtemp(join(tmpdir(), "octant-claude-external-"));
    temporaryRoots.add(root);
    temporaryRoots.add(external);
    const externalFile = join(external, "outside.json");
    await writeFile(externalFile, "before", "utf8");
    await symlink(external, join(root, "external-link"));
    const before = await snapshotClaudeConfigurationMetadata([root]);

    await writeFile(externalFile, "after-with-a-different-size", "utf8");

    const after = await snapshotClaudeConfigurationMetadata([root]);
    expect(sameClaudeConfigurationSnapshots(before, after)).toBe(true);
  });
});

describe("Claude process residue parsing", () => {
  it("finds a matching survivor after more than 16 KiB of unrelated processes", () => {
    const listing = `${"unrelated-process\n".repeat(1_100)} 4242 /opt/homebrew/bin/claude --output-format stream-json\n`;

    expect(claudeSdkProcessIdsFromListing(listing)).toContain(4242);
  });
});

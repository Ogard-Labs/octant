import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationFileArrivalTrigger } from "@octant/contracts";
import { liveWorkFilesystem, type WorkFilesystemPort } from "../work/workFilesystemPort";
import { applyProtectedFilesChoice, currentProtectedFilesChoice } from "../process/secretGuard";
import { prepareAutomationFileSource, scanAutomationFileSource } from "./automationFileSourceScan";

const trigger: AutomationFileArrivalTrigger = {
  kind: "file-arrival",
  directory: "Inbox",
  includeExtensions: ["txt"],
  excludeDirectories: ["processed"],
  settleSeconds: 2,
  automaticStartLimit: 8,
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(filesystem: WorkFilesystemPort = liveWorkFilesystem) {
  const path = await mkdtemp(join(tmpdir(), "octant-arrivals-"));
  roots.push(path);
  await mkdir(join(path, "Inbox"));
  const controller = new AbortController();
  let current = true;
  const request = {
    filesystem,
    canonicalRoot: path,
    bindingIdentity: "host/project/version/binding",
    trigger,
    signal: controller.signal,
    current: () => current,
  };
  const root = await prepareAutomationFileSource(request);
  return {
    path,
    root,
    controller,
    revoke: () => {
      current = false;
    },
    scan: () => scanAutomationFileSource({ ...request, root }),
  };
}

describe("confined file-arrival observations", () => {
  it("hashes the complete selected regular-file set without excluded, hidden or linked files", async () => {
    const source = await setup();
    await mkdir(join(source.path, "Inbox/processed"));
    await mkdir(join(source.path, "Inbox/nested"));
    await writeFile(join(source.path, "Inbox/z.TXT"), "one");
    await writeFile(join(source.path, "Inbox/nested/a.txt"), "two");
    await writeFile(join(source.path, "Inbox/processed/out.txt"), "excluded");
    await writeFile(join(source.path, "Inbox/.secret.txt"), "hidden");
    await writeFile(join(source.path, "outside.txt"), "outside");
    await symlink(join(source.path, "outside.txt"), join(source.path, "Inbox/link.txt"));
    await writeFile(join(source.path, "Inbox/no.pdf"), "unmatched");
    const result = await source.scan();
    expect(result.snapshot.map((file) => file.path)).toEqual(["nested/a.txt", "z.TXT"]);
    expect(result.snapshot[1]?.digest).toBe(createHash("sha256").update("one").digest("hex"));
    expect((await source.scan()).digest).toBe(result.digest);
  });
  it("observes atomic replacement by content and detects content reversion", async () => {
    const source = await setup();
    await writeFile(join(source.path, "Inbox/a.txt"), "first");
    const first = await source.scan();
    await writeFile(join(source.path, "temporary"), "later");
    await rename(join(source.path, "temporary"), join(source.path, "Inbox/a.txt"));
    expect((await source.scan()).digest).not.toBe(first.digest);
    await writeFile(join(source.path, "Inbox/a.txt"), "first");
    expect((await source.scan()).digest).toBe(first.digest);
  });
  it("refuses replacement of the captured input directory", async () => {
    const source = await setup();
    await rename(join(source.path, "Inbox"), join(source.path, "old"));
    await mkdir(join(source.path, "Inbox"));
    await writeFile(join(source.path, "Inbox/a.txt"), "replacement");
    await expect(source.scan()).rejects.toMatchObject({ reason: "source-changed" });
  });
  it("never follows an escaping input-directory link during preparation", async () => {
    const source = await setup();
    await rm(join(source.path, "Inbox"), { recursive: true });
    await symlink(tmpdir(), join(source.path, "Inbox"));
    await expect(
      prepareAutomationFileSource({
        filesystem: liveWorkFilesystem,
        canonicalRoot: source.path,
        bindingIdentity: "binding",
        trigger,
        current: () => true,
        signal: source.controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "source-unavailable" });
  });
  it.each(["abort", "revoke"])("refuses a late completed read after %s", async (action) => {
    let release: (() => void) | undefined;
    let reading: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const filesystem: WorkFilesystemPort = {
      ...liveWorkFilesystem,
      openFile: async (path) => {
        const file = await liveWorkFilesystem.openFile(path);
        return {
          ...file,
          read: async (maximum) => {
            reading?.();
            await held;
            return file.read(maximum);
          },
        };
      },
    };
    const source = await setup(filesystem);
    await writeFile(join(source.path, "Inbox/a.txt"), "held");
    const scan = source.scan();
    await started;
    if (action === "abort") source.controller.abort();
    else source.revoke();
    release?.();
    await expect(scan).rejects.toMatchObject({ reason: "authority-changed" });
  });
  it("refuses a whole scan beyond the matching-file cap instead of advancing a partial baseline", async () => {
    const source = await setup();
    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        writeFile(join(source.path, `Inbox/${index}.txt`), ""),
      ),
    );
    await expect(source.scan()).rejects.toMatchObject({ reason: "source-limit" });
  });
  it("applies the entry cap to excluded/unmatched work too", async () => {
    const source = await setup({
      ...liveWorkFilesystem,
      openDirectory: async (path) => {
        const directory = await liveWorkFilesystem.openDirectory(path);
        return {
          ...directory,
          read: async () => Array.from({ length: 4097 }, (_, index) => ({ name: `${index}.pdf` })),
        };
      },
    });
    await expect(source.scan()).rejects.toMatchObject({ reason: "source-limit" });
  });
  it("refuses a swapped file before reading its replacement", async () => {
    let replaced = false;
    const filesystem: WorkFilesystemPort = {
      ...liveWorkFilesystem,
      openFile: async (path) => {
        if (!replaced) {
          replaced = true;
          await rename(path, `${path}.old`);
          await writeFile(path, "foreign");
        }
        return liveWorkFilesystem.openFile(path);
      },
    };
    const source = await setup(filesystem);
    await writeFile(join(source.path, "Inbox/a.txt"), "original");
    await expect(source.scan()).rejects.toMatchObject({ reason: "source-unavailable" });
  });
  it("uses the person's existing protected-file rule for a nonhidden input without reading or reporting it", async () => {
    const opened: string[] = [];
    const source = await setup({
      ...liveWorkFilesystem,
      openFile: async (path) => {
        opened.push(path);
        return liveWorkFilesystem.openFile(path);
      },
    });
    const secret = join(source.path, "Inbox/credentials.txt");
    await writeFile(secret, "never hash these bytes");
    await writeFile(join(source.path, "Inbox/notes.txt"), "permitted");
    const previous = currentProtectedFilesChoice();
    applyProtectedFilesChoice({ ...previous, added: [...previous.added, secret] });
    try {
      const result = await source.scan();
      expect(result.snapshot.map((file) => file.path)).toEqual(["notes.txt"]);
      expect(opened).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("credentials");
    } finally {
      applyProtectedFilesChoice(previous);
    }
  });
  it("blocks unsupported nonhidden names instead of publishing a truncated baseline", async () => {
    const source = await setup();
    await writeFile(join(source.path, "Inbox/not:supported.txt"), "input");
    await expect(source.scan()).rejects.toMatchObject({ reason: "source-limit" });
  });
});

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectRootError, ProjectRootPort } from "./projectRootPort";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("ProjectRootPort", () => {
  it("canonicalizes Work symlinks and rejects files and missing roots without disclosing paths", async () => {
    const root = temporaryDirectory();
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    writeFileSync(join(root, "file"), "data");
    const port = new ProjectRootPort();

    expect(await port.validate("work", link)).toEqual({ canonicalRoot: realpathSync(target) });
    for (const candidate of [join(root, "file"), join(root, "missing")]) {
      const error = await port.validate("work", candidate).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        name: "ProjectRootError",
        message: "The selected Project root is unavailable.",
      });
      expect(String(error)).not.toContain(candidate);
    }
  });

  it("accepts any directory as a Code root, including plain folders and nested paths", async () => {
    const root = temporaryDirectory();
    const plain = join(root, "plain");
    const nested = join(plain, "nested");
    mkdirSync(nested, { recursive: true });
    const port = new ProjectRootPort();

    expect(await port.validate("code", plain)).toEqual({ canonicalRoot: realpathSync(plain) });
    expect(await port.validate("code", nested)).toEqual({ canonicalRoot: realpathSync(nested) });
    await expect(port.validate("code", join(root, "missing"))).rejects.toBeInstanceOf(
      ProjectRootError,
    );
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-root-"));
  directories.push(directory);
  return directory;
}

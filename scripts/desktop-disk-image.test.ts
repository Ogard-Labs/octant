import { mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDesktopDiskImage,
  createDiskImageArgv,
  diskImageFileName,
  DISK_IMAGE_VOLUME_NAME,
} from "./desktop-disk-image";

const repositoryRoot = resolve(import.meta.dirname, "..");
const credentials = { identity: "Developer ID", notaryProfile: "profile", teamId: "TEAM" };

describe("the first-install disk image", () => {
  it("is named next to the zip and always carries the volume name the layout refers to", () => {
    expect(diskImageFileName("Octant", "1.2.3")).toBe("Octant-1.2.3-darwin-arm64.dmg");
    expect(createDiskImageArgv({ stagingPath: "/s", imagePath: "/o.dmg" })).toEqual(
      expect.arrayContaining([
        "-volname",
        DISK_IMAGE_VOLUME_NAME,
        "-fs",
        "HFS+",
        "-format",
        "UDZO",
      ]),
    );
  });

  it("stages the app, an Applications link, the picture and the layout, then cleans up", async () => {
    const out = await mkdtemp(join(tmpdir(), "octant-dmg-test-"));
    try {
      const staged: string[] = [];
      const commands: string[][] = [];
      const outcome = await buildDesktopDiskImage({
        repositoryRoot,
        appPath: join(out, "Octant.app"),
        imagePath: join(out, "Octant-1.0.0-darwin-arm64.dmg"),
        credentials: undefined,
        run: async (argv) => {
          commands.push([...argv]);
          if (argv[1] === "create") {
            const source = argv[argv.indexOf("-srcfolder") + 1] ?? "";
            staged.push(
              String(await readlink(join(source, "Applications"))),
              String((await stat(join(source, ".background/background.tiff"))).size > 0),
              String((await readFile(join(source, ".DS_Store"))).length > 0),
            );
            await writeFile(join(out, "staging-path"), source);
          }
        },
        runForOutput: async () => {
          throw new Error("an unsigned image is not notarized");
        },
      });
      expect(outcome).toEqual({
        kind: "built",
        imagePath: join(out, "Octant-1.0.0-darwin-arm64.dmg"),
        signed: false,
      });
      expect(staged).toEqual(["/Applications", "true", "true"]);
      expect(commands.map((argv) => argv[1])).toEqual([
        join(out, "Octant.app"),
        "create",
        "verify",
      ]);
      const stagingPath = await readFile(join(out, "staging-path"), "utf8");
      await expect(stat(stagingPath)).rejects.toThrow();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("signs, notarizes and staples the image only when credentials are given", async () => {
    const out = await mkdtemp(join(tmpdir(), "octant-dmg-test-"));
    try {
      const commands: string[] = [];
      const outcome = await buildDesktopDiskImage({
        repositoryRoot,
        appPath: join(out, "Octant.app"),
        imagePath: join(out, "Octant.dmg"),
        credentials,
        run: async (argv) => void commands.push(`${argv[0]} ${argv[1] ?? ""}`.trim()),
        runForOutput: async (argv) => {
          commands.push(`${argv[0]} ${argv[1] ?? ""}`.trim());
          return {
            exitCode: 0,
            stdout: JSON.stringify({ id: "id", status: "Accepted" }),
            stderr: "",
          };
        },
      });
      expect(outcome).toMatchObject({ kind: "built", signed: true });
      expect(commands.slice(-3)).toEqual([
        "/usr/bin/codesign --force",
        "/usr/bin/xcrun notarytool",
        "/usr/bin/xcrun stapler",
      ]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("refuses to ship an image the notary service did not accept", async () => {
    const out = await mkdtemp(join(tmpdir(), "octant-dmg-test-"));
    try {
      await expect(
        buildDesktopDiskImage({
          repositoryRoot,
          appPath: join(out, "Octant.app"),
          imagePath: join(out, "Octant.dmg"),
          credentials,
          run: async () => undefined,
          runForOutput: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({ id: "id", status: "Invalid" }),
            stderr: "",
          }),
        }),
      ).rejects.toThrow(/Invalid for the disk image/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("skips a bundle the layout was not made for", async () => {
    const outcome = await buildDesktopDiskImage({
      repositoryRoot,
      appPath: "/out/Octant Nightly.app",
      imagePath: "/out/x.dmg",
      credentials: undefined,
      run: async () => {
        throw new Error("nothing runs for a skipped image");
      },
      runForOutput: async () => {
        throw new Error("nothing runs for a skipped image");
      },
    });
    expect(outcome.kind).toBe("skipped");
  });
});

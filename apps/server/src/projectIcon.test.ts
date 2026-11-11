import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProjectIcon, MAX_PROJECT_ICON_BYTES } from "./projectIcon";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16]);

const created: string[] = [];

async function folder(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "octant-icon-")));
  created.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Project icon lookup", () => {
  it("finds the favicon inside the Project's folder", async () => {
    const root = await folder();
    await mkdir(join(root, "public"));
    await writeFile(join(root, "public", "favicon.svg"), SVG);

    const found = await findProjectIcon(root);

    expect(found.status).toBe("found");
    if (found.status === "found") {
      expect(found.mediaType).toBe("image/svg+xml");
      expect(new TextDecoder().decode(found.bytes)).toBe(SVG);
      expect(found.etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    }
  });

  it("prefers the earlier well-known path when several exist", async () => {
    const root = await folder();
    await writeFile(join(root, "favicon.ico"), ICO);
    await writeFile(join(root, "icon.png"), PNG);

    const found = await findProjectIcon(root);

    expect(found.status === "found" && found.mediaType).toBe("image/x-icon");
  });

  it("answers none for a folder without an icon", async () => {
    expect(await findProjectIcon(await folder())).toEqual({ status: "none" });
  });

  it("answers none for a folder that no longer exists", async () => {
    expect(await findProjectIcon(join(tmpdir(), "octant-icon-missing-folder"))).toEqual({
      status: "none",
    });
  });

  it("refuses an icon that is a link to a file outside the folder", async () => {
    const root = await folder();
    const outside = await folder();
    await writeFile(join(outside, "secret.svg"), SVG);
    await symlink(join(outside, "secret.svg"), join(root, "favicon.svg"));

    expect(await findProjectIcon(root)).toEqual({ status: "none" });
  });

  it("refuses a well-known directory that is a link out of the folder", async () => {
    const root = await folder();
    const outside = await folder();
    await writeFile(join(outside, "favicon.svg"), SVG);
    await symlink(outside, join(root, "public"));

    expect(await findProjectIcon(root)).toEqual({ status: "none" });
  });

  it("refuses an icon reached through a link even when the link stays inside the folder", async () => {
    const root = await folder();
    await mkdir(join(root, "brand"));
    await writeFile(join(root, "brand", "mark.svg"), SVG);
    await symlink(join(root, "brand", "mark.svg"), join(root, "favicon.svg"));
    await symlink(join(root, "brand"), join(root, "static"));
    await writeFile(join(root, "brand", "favicon.svg"), SVG);

    expect(await findProjectIcon(root)).toEqual({ status: "none" });
  });

  it("gives no icon on a platform without a no-follow open", async () => {
    const root = await folder();
    await writeFile(join(root, "favicon.svg"), SVG);

    expect(await findProjectIcon(root, "win32")).toEqual({ status: "none" });
  });

  it.skipIf(process.platform !== "darwin")(
    "refuses a link at any depth through the macOS no-follow-any open",
    async () => {
      const root = await folder();
      await mkdir(join(root, "real"));
      await writeFile(join(root, "real", "favicon.svg"), SVG);
      await symlink(join(root, "real"), join(root, "public"));

      expect(await findProjectIcon(root, "darwin")).toEqual({ status: "none" });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "refuses a link at any depth when walking from the root by handle",
    async () => {
      const root = await folder();
      const outside = await folder();
      await writeFile(join(outside, "favicon.svg"), SVG);
      await symlink(outside, join(root, "public"));
      await writeFile(join(root, "icon.png"), PNG);
      await symlink(join(root, "icon.png"), join(root, "favicon.png"));

      const found = await findProjectIcon(root, "linux");

      expect(found.status === "found" && found.mediaType).toBe("image/png");
      expect(await findProjectIcon(await folder(), "linux")).toEqual({ status: "none" });
    },
  );

  it("refuses an icon larger than the cap and falls through to the next candidate", async () => {
    const root = await folder();
    await writeFile(join(root, "favicon.svg"), SVG + " ".repeat(MAX_PROJECT_ICON_BYTES));
    await writeFile(join(root, "icon.png"), PNG);

    const found = await findProjectIcon(root);

    expect(found.status === "found" && found.mediaType).toBe("image/png");
  });

  it("refuses files whose bytes do not match their extension", async () => {
    const root = await folder();
    await writeFile(join(root, "favicon.png"), "not a png");
    await writeFile(join(root, "favicon.ico"), PNG);
    await writeFile(join(root, "favicon.svg"), "<html><script>alert(1)</script></html>");

    expect(await findProjectIcon(root)).toEqual({ status: "none" });
  });

  it("refuses a directory named like an icon", async () => {
    const root = await folder();
    await mkdir(join(root, "favicon.svg"));

    expect(await findProjectIcon(root)).toEqual({ status: "none" });
  });

  it("refuses a named pipe that is called like an icon without waiting on it", async () => {
    const root = await folder();
    execFileSync("mkfifo", [join(root, "favicon.svg")]);
    await writeFile(join(root, "icon.png"), PNG);

    const found = await findProjectIcon(root);

    expect(found.status === "found" && found.mediaType).toBe("image/png");
  });

  it("accepts an SVG that opens with an XML declaration and a comment", async () => {
    const root = await folder();
    await writeFile(join(root, "logo.svg"), `<?xml version="1.0"?>\n<!-- mark -->\n${SVG}`);

    expect((await findProjectIcon(root)).status).toBe("found");
  });
});

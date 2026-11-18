import { mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProjectId } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PROJECT_ICON_BYTES } from "./projectIcon";
import { ProjectCustomIconStore } from "./projectIconStore";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000b01");

const created: string[] = [];

async function store() {
  const dataDirectory = await realpath(await mkdtemp(join(tmpdir(), "octant-custom-icon-")));
  created.push(dataDirectory);
  return { dataDirectory, icons: new ProjectCustomIconStore({ dataDirectory }) };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("chosen Project icon store", () => {
  it("keeps its own copy of the chosen picture and serves it back", async () => {
    const { icons } = await store();

    const result = await icons.write(projectId, new TextEncoder().encode(SVG), "image/svg+xml");
    const read = await icons.read(projectId);

    expect(result).toEqual({ status: "stored" });
    expect(read.status).toBe("found");
    if (read.status === "found") {
      expect(read.mediaType).toBe("image/svg+xml");
      expect(new TextDecoder().decode(read.bytes)).toBe(SVG);
    }
  });

  it("replaces the earlier icon of another type instead of keeping two", async () => {
    const { dataDirectory, icons } = await store();
    await icons.write(projectId, new TextEncoder().encode(SVG), "image/svg+xml");

    await icons.write(projectId, PNG, "image/png");

    const read = await icons.read(projectId);
    expect(read.status === "found" && read.mediaType).toBe("image/png");
    expect(await readdir(join(dataDirectory, "project-icons"))).toEqual([
      `${String(projectId)}.png`,
    ]);
  });

  it("gives no icon after the chosen one is removed", async () => {
    const { icons } = await store();
    await icons.write(projectId, PNG, "image/png");

    await icons.remove(projectId);

    expect(await icons.read(projectId)).toEqual({ status: "none" });
  });

  it("refuses a file whose first bytes do not match the type it claims", async () => {
    const { icons } = await store();

    const result = await icons.write(projectId, new TextEncoder().encode("hello"), "image/png");

    expect(result).toMatchObject({ status: "refused", reason: "not-an-image" });
    expect(await icons.read(projectId)).toEqual({ status: "none" });
  });

  it("refuses a type that is not a PNG, SVG or ICO", async () => {
    const { icons } = await store();

    expect(await icons.write(projectId, PNG, "image/jpeg")).toMatchObject({
      status: "refused",
      reason: "unsupported-type",
    });
    expect(await icons.write(projectId, PNG, null)).toMatchObject({ reason: "unsupported-type" });
  });

  it("refuses an empty file and one larger than 256 KB", async () => {
    const { icons } = await store();

    expect(await icons.write(projectId, new Uint8Array(0), "image/png")).toMatchObject({
      reason: "empty",
    });
    expect(
      await icons.write(projectId, new Uint8Array(MAX_PROJECT_ICON_BYTES + 1), "image/png"),
    ).toMatchObject({ reason: "too-large" });
  });

  it("does not serve a link planted where the copy should be", async () => {
    const { dataDirectory, icons } = await store();
    await icons.write(projectId, PNG, "image/png");
    await icons.remove(projectId);
    const outside = join(dataDirectory, "outside.png");
    await writeFile(outside, PNG);
    await icons.write(decodeProjectId("00000000-0000-4000-8000-000000000b02"), PNG, "image/png");
    await rm(join(dataDirectory, "project-icons", "00000000-0000-4000-8000-000000000b02.png"));
    await symlink(
      outside,
      join(dataDirectory, "project-icons", "00000000-0000-4000-8000-000000000b02.png"),
    );

    expect(await icons.read(decodeProjectId("00000000-0000-4000-8000-000000000b02"))).toEqual({
      status: "none",
    });
  });
});

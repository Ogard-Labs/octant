import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { createDesignSystemRouteHandler } from "./designSystemRoutes";
import { DesignSystemFiles } from "./designSystems/designSystemFiles";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000902");
const chatProjectId = decodeProjectId("00000000-0000-4000-8000-000000000903");

let root: string;
let outside: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "octant-design-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "octant-outside-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function route() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createDesignSystemRouteHandler({
    files: new DesignSystemFiles(),
    projects: {
      bootstrap: async () =>
        ({
          active: [
            { id: projectId, type: "code", name: "Acme", binding: { canonicalRoot: root } },
            { id: chatProjectId, type: "chat", name: "Notes" },
          ],
        }) as never,
    },
    windowAuthorityStore: store,
    now: () => 0,
  });
}

function get(path: string) {
  return route()(
    new Request(`http://127.0.0.1${path}`, {
      headers: { "x-octant-window-capability": capability },
    }),
  );
}

function save(body: Record<string, unknown>) {
  return route()(
    new Request("http://127.0.0.1/api/design-systems/file", {
      method: "POST",
      headers: { "x-octant-window-capability": capability, "content-type": "application/json" },
      body: JSON.stringify({ projectId, folder: root, ...body }),
    }),
  );
}

describe("design system routes", () => {
  it("lists every DESIGN.md in the Project, the top-level one first and primary", async () => {
    await writeFile(
      join(root, "DESIGN.md"),
      "---\nname: Acme\ncolors:\n  primary: '#123456'\n---\n",
    );
    await mkdir(join(root, "apps", "site"), { recursive: true });
    await writeFile(join(root, "apps", "site", "DESIGN.md"), "# Site\n");
    await mkdir(join(root, "node_modules", "kit"), { recursive: true });
    await writeFile(join(root, "node_modules", "kit", "DESIGN.md"), "# Someone else's\n");

    const response = await get(`/api/design-systems?projectId=${projectId}`);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      systems: [
        { folder: root, path: "DESIGN.md", name: "Acme", tokenCount: 1, primary: true },
        { folder: root, path: "apps/site/DESIGN.md", name: "Site", tokenCount: 0, primary: false },
      ],
      truncated: false,
    });
  });

  it("creates a design system, then saves only over the revision it was edited from", async () => {
    const created = await (await save({ path: "DESIGN.md", text: "# One\n" }))?.json();
    expect(created.status).toBe("saved");
    expect(await readFile(join(root, "DESIGN.md"), "utf8")).toBe("# One\n");

    expect(await (await save({ path: "DESIGN.md", text: "# Again\n" }))?.json()).toEqual({
      status: "refused",
      reason: "exists",
    });

    const saved = await (
      await save({ path: "DESIGN.md", text: "# Two\n", baseRevision: created.document.revision })
    )?.json();
    expect(saved.document.reading.name).toBe("Two");

    // Someone else changed the file after this window read it.
    expect(
      await (
        await save({
          path: "DESIGN.md",
          text: "# Three\n",
          baseRevision: created.document.revision,
        })
      )?.json(),
    ).toEqual({ status: "refused", reason: "stale" });
    expect(await readFile(join(root, "DESIGN.md"), "utf8")).toBe("# Two\n");
  });

  it("never writes through a linked directory or into a folder the Project does not lend", async () => {
    await symlink(outside, join(root, "linked"));
    expect(await (await save({ path: "linked/DESIGN.md", text: "# X\n" }))?.json()).toEqual({
      status: "refused",
      reason: "folder-unavailable",
    });
    expect(
      await (await save({ folder: outside, path: "DESIGN.md", text: "# X\n" }))?.json(),
    ).toEqual({ status: "refused", reason: "folder-unavailable" });
    await expect(readFile(join(outside, "DESIGN.md"), "utf8")).rejects.toThrow();
  });

  it("refuses a path that is not a DESIGN.md or climbs out of its folder", async () => {
    expect((await save({ path: "notes.md", text: "x" }))?.status).toBe(400);
    expect((await save({ path: "../DESIGN.md", text: "x" }))?.status).toBe(400);
    expect(
      (
        await get(
          `/api/design-systems/file?projectId=${projectId}&folder=${root}&path=../DESIGN.md`,
        )
      )?.status,
    ).toBe(400);
  });

  it("offers nothing for a Chat Project, which has no folder", async () => {
    expect((await get(`/api/design-systems?projectId=${chatProjectId}`))?.status).toBe(404);
  });

  it("refuses a request without the window's capability", async () => {
    const response = await route()(
      new Request(`http://127.0.0.1/api/design-systems?projectId=${projectId}`),
    );
    expect(response?.status).toBe(401);
  });
});

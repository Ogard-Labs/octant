import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { createDesignSystemRouteHandler } from "./designSystemRoutes";
import { classifyProductAction } from "./authenticatedProductRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createRemoteRoutePolicy } from "./remoteRoutePolicy";
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

function route(designSystem?: unknown) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createDesignSystemRouteHandler({
    files: new DesignSystemFiles(),
    projects: {
      bootstrap: async () =>
        ({
          active: [
            {
              id: projectId,
              type: "code",
              name: "Acme",
              binding: { canonicalRoot: root },
              ...(designSystem === undefined ? {} : { designSystem }),
            },
            { id: chatProjectId, type: "chat", name: "Notes" },
          ],
        }) as never,
    },
    windowAuthorityStore: store,
    now: () => 0,
  });
}

function get(path: string, designSystem?: unknown) {
  return route(designSystem)(
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

  it("follows the design system a person chose, says when it is missing, and can be off", async () => {
    await writeFile(join(root, "DESIGN.md"), "# Acme\n");
    await mkdir(join(root, "apps", "site"), { recursive: true });
    await writeFile(join(root, "apps", "site", "DESIGN.md"), "# Site\n");
    const listed = async (choice: unknown) =>
      (await (await get(`/api/design-systems?projectId=${projectId}`, choice))?.json()) as {
        systems: Array<{ path: string; primary: boolean }>;
        choiceMissing?: boolean;
      };

    const site = await listed({ kind: "file", folder: root, path: "apps/site/DESIGN.md" });
    expect(site.systems.filter((system) => system.primary).map((system) => system.path)).toEqual([
      "apps/site/DESIGN.md",
    ]);
    const gone = await listed({ kind: "file", folder: root, path: "gone/DESIGN.md" });
    expect(gone.choiceMissing).toBe(true);
    expect(gone.systems.some((system) => system.primary)).toBe(false);
    const off = await listed({ kind: "none" });
    expect(off.systems.some((system) => system.primary)).toBe(false);
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

  it("refuses the second of two saves made at once from the same revision", async () => {
    // One handler, as the host has: its file service orders saves of one file.
    const shared = route();
    const post = (body: Record<string, unknown>) =>
      shared(
        new Request("http://127.0.0.1/api/design-systems/file", {
          method: "POST",
          headers: {
            "x-octant-window-capability": capability,
            "content-type": "application/json",
          },
          body: JSON.stringify({ projectId, folder: root, path: "DESIGN.md", ...body }),
        }),
      );
    const created = await (await post({ text: "# One\n" }))?.json();
    const base = created.document.revision;
    const [first, second] = await Promise.all([
      post({ text: "# From window A\n", baseRevision: base }),
      post({ text: "# From window B\n", baseRevision: base }),
    ]);
    const results = [await first?.json(), await second?.json()].map((result) =>
      result.status === "saved" ? "saved" : result.reason,
    );
    expect(results.sort()).toEqual(["saved", "stale"]);
    expect(["# From window A\n", "# From window B\n"]).toContain(
      await readFile(join(root, "DESIGN.md"), "utf8"),
    );
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

  it("lists and saves a design system for a device the host's own person paired, and for no other device", async () => {
    const deviceId = "55000000-0000-4000-8000-000000000901";
    const fromDevice = (
      admittedBy: "host-person" | "hub-roster" | undefined,
      init?: RequestInit,
    ) => {
      const request = new Request(
        init === undefined
          ? `http://127.0.0.1/api/design-systems?projectId=${projectId}`
          : "http://127.0.0.1/api/design-systems/file",
        init,
      );
      bindPrincipalRouteContext(request, {
        principal: {
          kind: "remote-device",
          hostId: "11111111-1111-4111-8111-111111111111",
          deviceId,
          credentialGeneration: 1,
          origin: "https://remote.example",
          protocolVersion: 1,
          capabilityDigest: "a".repeat(64),
          sessionId: "55000000-0000-4000-8000-0000000009aa",
          ...(admittedBy === undefined ? {} : { admittedBy }),
        } as never,
        scopeId: deviceId as never,
      });
      return route()(request);
    };
    const saving = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        folder: root,
        path: "DESIGN.md",
        text: "---\nname: Acme\n---\n",
      }),
    };
    for (const admittedBy of ["hub-roster", undefined] as const) {
      expect((await fromDevice(admittedBy))?.status).toBe(403);
      expect((await fromDevice(admittedBy, saving))?.status).toBe(403);
    }
    await expect(readFile(join(root, "DESIGN.md"), "utf8")).rejects.toThrow();

    expect((await fromDevice("host-person", saving))?.status).toBe(200);
    expect(await readFile(join(root, "DESIGN.md"), "utf8")).toContain("name: Acme");
    const listed = await fromDevice("host-person");
    expect(listed?.status).toBe(200);

    // The private listener forwards both paths with the Project named in the
    // query; the product dispatch holds every other device to the catalogue,
    // which names no action for them.
    const origin = "https://octant.example:8443";
    const policy = createRemoteRoutePolicy({ origin });
    for (const [path, method] of [
      [`/api/design-systems?projectId=${projectId}`, "GET"],
      ["/api/design-systems/file", "POST"],
    ] as const) {
      const forwarded = new Request(`${origin}${path}`, {
        method,
        headers: {
          host: "octant.example:8443",
          origin,
          "sec-fetch-site": "same-origin",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
      });
      expect(policy.inspect(forwarded).kind).toBe("allow");
      expect(classifyProductAction(forwarded)).toBeUndefined();
    }
  });

  it("refuses a request without the window's capability", async () => {
    const response = await route()(
      new Request(`http://127.0.0.1/api/design-systems?projectId=${projectId}`),
    );
    expect(response?.status).toBe(401);
  });
});

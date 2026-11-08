import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { decodeProjectId, decodeWindowId, decodeWorkThreadId } from "@octant/contracts";
import { ServerProject } from "@octant/contracts/server-projects";
import { createServerWorkFileListing } from "./serverWorkFiles";
import { serverWorkBindingRevisionId } from "./serverWorkThreads";
import { ServerCodeFiles } from "./serverCodeFiles";
import { decodeCodeCheckoutId, decodeCodeThreadId } from "@octant/contracts/code";
import { listServerDirectory } from "./serverDirectoryListing";

const project = Schema.decodeUnknownSync(ServerProject)({
  id: "11111111-1111-4111-8111-111111111112",
  serverId: "11111111-1111-4111-8111-111111111113",
  name: "Server notes",
  folder: "/srv/notes",
  mode: "work",
  boundAt: "2026-11-08T12:00:00.000Z",
});
function fixture() {
  let active = true,
    registered = true,
    held = true,
    allowed = true;
  let bound = project;
  const threadId = decodeWorkThreadId("22222222-2222-4222-8222-222222222223");
  const thread = () => ({
    id: threadId,
    projectId: project.id,
    lifecycle: active ? ("active" as const) : ("archived" as const),
    bindingRevisionId: serverWorkBindingRevisionId(project),
  });
  const run = vi.fn(async () => ({
    status: "ran" as const,
    exitCode: 0,
    truncated: false,
    errorOutput: "",
    output: Buffer.from("/srv/notes\0df12:server.md\0dsub\0f8:sub/note.txt\0"),
  }));
  const reader = createServerWorkFileListing({
    store: {
      project: () => (held ? bound : undefined),
      workProject: () => (held ? bound : undefined),
      addressOf: () =>
        registered
          ? {
              kind: "address" as const,
              server: { alias: "owned-server", user: "fixture" },
              folder: bound.folder,
            }
          : { kind: "refused" as const, reason: "server-not-registered" as const },
    },
    connection: { run },
    thread,
    canOpen: async () => allowed,
    clock: () => "2026-11-08T12:00:00.000Z",
  });
  const input = {
    windowId: decodeWindowId("33333333-3333-4333-8333-333333333333"),
    threadId,
    projectId: project.id,
    signal: new AbortController().signal,
    current: () => true,
  };
  return {
    reader,
    input,
    run,
    remove: () => {
      held = false;
    },
    unregister: () => {
      registered = false;
    },
    archive: () => {
      active = false;
    },
    revoke: () => {
      allowed = false;
    },
    rebind: () => {
      bound = { ...project, folder: "/srv/other" };
    },
  };
}

describe("server Work file listings", () => {
  it("returns only bounded server metadata without previews or output attribution", async () => {
    const f = fixture();
    const result = await f.reader.list(f.input);
    expect(result.status).toBe("listed");
    if (result.status !== "listed") throw Error("Expected a server listing.");
    expect(result.listing.entries).toEqual([
      { kind: "file", path: "server.md", byteLength: 12, origin: "untouched" },
      { kind: "directory", path: "sub" },
      { kind: "file", path: "sub/note.txt", byteLength: 8, origin: "untouched" },
    ]);
    expect(result.listing.previewHostId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("/srv/notes");
  });

  it.each(["remove", "unregister", "archive", "revoke", "rebind"] as const)(
    "refuses before SSH after %s",
    async (change) => {
      const f = fixture();
      f[change]();
      expect((await f.reader.list(f.input)).status).toBe("failed");
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it.each(["remove", "unregister", "archive", "revoke", "rebind"] as const)(
    "withholds names when %s occurs during SSH",
    async (change) => {
      const f = fixture();
      f.run.mockImplementationOnce(async () => {
        f[change]();
        return {
          status: "ran",
          exitCode: 0,
          truncated: false,
          errorOutput: "",
          output: Buffer.from("/srv/notes\0df12:private-name.md\0"),
        };
      });
      const result = await f.reader.list(f.input);
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("private-name");
    },
  );

  it("refuses a different Project, traversal and cancellation without making a remote call", async () => {
    const f = fixture();
    expect(
      (
        await f.reader.list({
          ...f.input,
          projectId: decodeProjectId("99999999-9999-4999-8999-999999999999"),
        })
      ).status,
    ).toBe("failed");
    for (const directory of ["../outside", "/etc"]) {
      expect((await f.reader.list({ ...f.input, directory })).status).toBe("failed");
    }
    expect((await f.reader.list({ ...f.input, current: () => false })).status).toBe("failed");
    const controller = new AbortController();
    controller.abort();
    expect((await f.reader.list({ ...f.input, signal: controller.signal })).status).toBe("failed");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("caps entries and preserves transport truncation", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({
      status: "ran",
      exitCode: 0,
      truncated: true,
      errorOutput: "",
      output: Buffer.from(
        "/srv/notes\0d" +
          Array.from({ length: 1001 }, (_, i) => "f1:note-" + i + ".txt\0").join(""),
      ),
    });
    const result = await f.reader.list(f.input);
    expect(result.status).toBe("listed");
    if (result.status !== "listed") throw Error("Expected a bounded listing.");
    expect(result.listing.entries).toHaveLength(1000);
    expect(result.listing.truncated).toBe(true);
  });

  it("drops an incomplete last name instead of inventing a file after output truncation", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({
      status: "ran",
      exitCode: 0,
      truncated: true,
      errorOutput: "",
      output: Buffer.from("/srv/notes\0df12:complete.md\0f99:unfinished"),
    });
    const result = await f.reader.list(f.input);
    expect(result.status).toBe("listed");
    if (result.status !== "listed") throw Error("Expected a partial listing.");
    expect(result.listing.entries.map((entry) => entry.path)).toEqual(["complete.md"]);
    expect(result.listing.truncated).toBe(true);
  });

  it("counts depth from the requested folder while keeping Project-relative names", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({
      status: "ran",
      exitCode: 0,
      truncated: false,
      errorOutput: "",
      output: Buffer.from(
        "/srv/notes/sub/deep\0df12:sub/deep/note.md\0f8:other.md\0f1:sub/deep/too/far.md\0",
      ),
    });
    expect(
      await listServerDirectory(
        {
          connection: { run: f.run },
          server: () => ({ alias: "fixture", user: "fixture" }),
          root: project.folder,
          maxDepth: 1,
          maxEntries: 1000,
        },
        { directory: "sub/deep" },
      ),
    ).toEqual({
      status: "listed",
      entries: [{ kind: "file", path: "sub/deep/note.md", byteLength: 12 }],
      truncated: true,
    });
  });

  it("withholds names when the caller cancels during the remote read", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.run.mockImplementationOnce(async () => {
      controller.abort();
      return {
        status: "ran",
        exitCode: 0,
        truncated: false,
        errorOutput: "",
        output: Buffer.from("/srv/notes\0df12:cancelled.md\0"),
      };
    });
    const result = await f.reader.list({ ...f.input, signal: controller.signal });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("cancelled.md");
  });

  it("preserves the Code listing not-found response for a missing remote folder", async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({
      status: "ran",
      exitCode: 0,
      truncated: false,
      errorOutput: "",
      output: Buffer.from("m"),
    });
    const reader = new ServerCodeFiles({
      connection: { run: f.run },
      server: () => ({ alias: "fixture", user: "fixture" }),
      root: project.folder,
      clock: () => "2026-11-08T12:00:00.000Z",
    });
    expect(
      await reader.list({
        threadId: decodeCodeThreadId("44444444-4444-4444-8444-444444444444"),
        checkoutId: decodeCodeCheckoutId("55555555-5555-4555-8555-555555555555"),
      }),
    ).toMatchObject({ status: "failed", failure: { category: "not-found" } });
  });
});

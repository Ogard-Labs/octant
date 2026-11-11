import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createProjectIconReader, type ProjectIconLookup } from "./projectIcon";

describe("Project icon reader", () => {
  const windowId = decodeWindowId("00000000-0000-4000-8000-000000000a01");
  const codeId = decodeProjectId("00000000-0000-4000-8000-000000000a02");
  const chatId = decodeProjectId("00000000-0000-4000-8000-000000000a03");
  const unknownId = decodeProjectId("00000000-0000-4000-8000-000000000a04");
  const hit: ProjectIconLookup = {
    status: "found",
    bytes: new Uint8Array(new ArrayBuffer(1)),
    mediaType: "image/png",
    etag: '"1-1"',
  };

  function reader() {
    const find = vi.fn(async (_root: string) => hit);
    const projects = {
      bootstrap: vi.fn(async () => ({
        active: [
          { id: codeId, type: "code", binding: { canonicalRoot: "/opaque/code" } },
          { id: chatId, type: "chat" },
        ],
      })),
    };
    return { find, read: createProjectIconReader({ projects: projects as never, find }).read };
  }

  it("looks in the folder of a Project the window can reach", async () => {
    const { find, read } = reader();
    expect(await read(windowId, codeId)).toBe(hit);
    expect(find).toHaveBeenCalledWith("/opaque/code");
  });

  it("gives a Chat Project no icon because it has no folder", async () => {
    const { find, read } = reader();
    expect(await read(windowId, chatId)).toEqual({ status: "none" });
    expect(find).not.toHaveBeenCalled();
  });

  it("gives a Project the window does not know no icon", async () => {
    const { find, read } = reader();
    expect(await read(windowId, unknownId)).toEqual({ status: "none" });
    expect(find).not.toHaveBeenCalled();
  });
});

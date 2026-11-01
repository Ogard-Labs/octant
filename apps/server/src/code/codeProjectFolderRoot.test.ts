import { describe, expect, it, vi } from "vitest";
import { withProjectExtraFolders } from "./codeProjectFolderRoot";

const main = {
  fileId: "main-file" as never,
  rootPath: "/work/main",
  rootIdentity: { device: "1", inode: "1" },
};

function resolverFor(folders: ReadonlyArray<string>) {
  const resolve = vi.fn(async () => main as never);
  return {
    resolve,
    place: withProjectExtraFolders({
      resolve,
      extraFolders: () => folders,
      probePath: "package.json" as never,
      fileId: (threadId, checkoutId, path) => `${threadId}:${checkoutId}:${path}` as never,
      statIdentity: async () => ({ device: "2", inode: "2" }),
    }),
  };
}

const scope = "window" as never;
const thread = { id: "thread" } as never;
const checkout = { id: "checkout" } as never;

describe("withProjectExtraFolders", () => {
  it("places a file in an extra folder under that folder after the checkout resolves", async () => {
    const { place, resolve } = resolverFor(["/work/extra"]);

    const placed = await place(scope, thread, checkout, "/work/extra/src/a.ts" as never);

    expect(placed).toMatchObject({ rootPath: "/work/extra", relativePath: "src/a.ts" });
    expect(resolve).toHaveBeenCalledWith(scope, thread, checkout, "package.json");
  });

  it("places the extra folder itself as a root with no inner path", async () => {
    const { place } = resolverFor(["/work/extra/"]);

    const placed = await place(scope, thread, checkout, "/work/extra" as never);

    expect(placed).toMatchObject({ rootPath: "/work/extra/", folderRoot: true });
    expect(placed).not.toHaveProperty("relativePath");
  });

  it("refuses an absolute path outside every extra folder and a checkout the main authority refuses", async () => {
    const { place, resolve } = resolverFor(["/work/extra"]);

    expect(await place(scope, thread, checkout, "/work/beside/a.ts" as never)).toBeUndefined();
    expect(await place(scope, thread, checkout, "/work/extra-two/a.ts" as never)).toBeUndefined();

    resolve.mockResolvedValueOnce(undefined as never);
    expect(await place(scope, thread, checkout, "/work/extra/a.ts" as never)).toBeUndefined();
  });
});

import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLookTool, LOOK_TOOL_NAME, lookToolForThread } from "./lookTool";

const described = {
  kind: "described" as const,
  text: "A red error under the password field.",
  describedBy: { model: "Haiku 5.5", provider: "Anthropic" },
};

async function folderWithImage() {
  const root = await mkdtemp(join(tmpdir(), "octant-look-"));
  await mkdir(join(root, "shots"));
  await writeFile(join(root, "shots", "login.png"), new Uint8Array([137, 80, 78, 71]));
  const outside = await mkdtemp(join(tmpdir(), "octant-look-outside-"));
  await writeFile(join(outside, "secret.png"), new Uint8Array([1, 2, 3]));
  await symlink(join(outside, "secret.png"), join(root, "shots", "escape.png"));
  return root;
}

const call = (tools: ReturnType<typeof createLookTool>, input: unknown) =>
  tools.execute({ name: LOOK_TOOL_NAME, inputJson: JSON.stringify(input) });

describe("look", () => {
  it("describes an image file inside the thread's folder and names who described it", async () => {
    const folder = await folderWithImage();
    const describe = vi.fn(async () => described);
    const tools = createLookTool({ describe, folder });
    const outcome = await call(tools, { image: "shots/login.png", question: "Any errors?" });
    expect(outcome).toEqual({
      result: {
        image: "login.png",
        described_by: "Haiku 5.5 (Anthropic)",
        description: "A red error under the password field.",
      },
    });
    expect(describe).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "Any errors?",
        image: expect.objectContaining({ name: "login.png", mediaType: "image/png" }),
      }),
    );
  });

  it("refuses .., absolute paths, URLs, and a link that leads out of the folder, reading nothing", async () => {
    const folder = await folderWithImage();
    const describe = vi.fn(async () => described);
    const tools = createLookTool({ describe, folder });
    for (const image of [
      "../outside.png",
      "shots/../../etc/x.png",
      "/etc/passwd.png",
      "https://example.com/a.png",
      "file:///etc/a.png",
      "shots/escape.png",
      "shots/missing.png",
    ]) {
      const outcome = await call(tools, { image });
      expect(outcome.isError, image).toBe(true);
    }
    expect(describe).not.toHaveBeenCalled();
  });

  it("bounds the question and takes nothing but image and question", async () => {
    const tools = createLookTool({ describe: vi.fn(async () => described), folder: "/nowhere" });
    expect((await call(tools, { image: "a.png", question: "x".repeat(501) })).isError).toBe(true);
    expect((await call(tools, { image: "a.png", url: "https://x" })).isError).toBe(true);
  });

  it("looks at an image the thread itself attached, by its id, without a folder", async () => {
    const describe = vi.fn(async () => described);
    const tools = createLookTool({
      describe,
      attachment: async (id) =>
        id === "attachment-1"
          ? { name: "shot.png", mediaType: "image/png", bytes: new Uint8Array([1]) }
          : undefined,
    });
    expect((await call(tools, { image: "attachment-1" })).isError).toBeUndefined();
    expect((await call(tools, { image: "attachment-2" })).isError).toBe(true);
  });

  it("is offered only to a model that cannot read images while Sees images can take one", () => {
    const describer = (available: boolean) => ({
      available: () =>
        available
          ? { kind: "available" as const, describedBy: described.describedBy }
          : { kind: "refused" as const, reason: "Luna can't read images." },
      describe: vi.fn(async () => described),
    });
    const offered = (readsImages: boolean, available: boolean) =>
      lookToolForThread({
        describer: describer(available),
        threadId: "thread-1",
        threadType: "code-thread",
        threadModel: "Luna",
        readsImages,
        uuid: () => "id",
      })?.definitions.map((definition) => definition.name);
    expect(offered(false, true)).toEqual([LOOK_TOOL_NAME]);
    expect(offered(true, true)).toBeUndefined();
    expect(offered(false, false)).toBeUndefined();
  });
});

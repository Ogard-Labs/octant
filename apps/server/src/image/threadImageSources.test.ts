import { mkdtemp, mkdir, realpath, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeBrowserCapture,
  decodeBrowserThreadId,
  MAX_GENERATED_IMAGE_BYTES,
} from "@octant/contracts";
import { expect, it, vi } from "vitest";
import { applyProtectedFilesChoice, currentProtectedFilesChoice } from "../process/secretGuard";
import { attachedImageSources, workspaceImageSources } from "./threadImageSourcePorts";
import {
  describeImageSources,
  parseImageSourceRequests,
  readImageSources,
} from "./threadImageSources";

const threadId = decodeBrowserThreadId("a3000000-0000-4000-8000-000000000001");
const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

it("confines a reference to the turn's folder and refuses a file that changes scope before approval", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "octant-references-")));
  try {
    const folder = join(base, "checkout");
    await mkdir(folder);
    await writeFile(join(folder, "logo.png"), png);
    await writeFile(join(base, "outside.png"), png);
    await symlink(join(base, "outside.png"), join(folder, "link.png"));
    let activeRoot: string | undefined = folder;
    const files = workspaceImageSources({
      threadId,
      browserCaptures: { list: () => [], read: async () => undefined },
      root: async () => activeRoot,
    });
    expect(
      parseImageSourceRequests([{ kind: "file", relativePath: "../outside.png" }]),
    ).toHaveProperty("error");
    expect(
      parseImageSourceRequests([{ kind: "file", relativePath: join(base, "outside.png") }]),
    ).toHaveProperty("error");
    await expect(files.file?.("link.png")).resolves.toBeUndefined();
    const source = await files.file?.("logo.png");
    await expect(source?.read()).resolves.toEqual(png);
    await symlink("logo.png", join(folder, "inside.png"));
    const linked = await files.file?.("inside.png");
    await unlink(join(folder, "inside.png"));
    await symlink(join(base, "outside.png"), join(folder, "inside.png"));
    await expect(linked?.read()).resolves.toBeUndefined();
    await writeFile(join(folder, "logo.png"), new Uint8Array(png.length));
    await utimes(join(folder, "logo.png"), 0, 0);
    await expect(source?.read()).resolves.toBeUndefined();
    const changed = await files.file?.("logo.png");
    activeRoot = undefined;
    await expect(changed?.read()).resolves.toBeUndefined();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

it("refuses a protected reference before approval and again before reading it", async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "octant-references-")));
  const previous = currentProtectedFilesChoice();
  try {
    const photo = join(folder, "photo.png");
    await writeFile(photo, png);
    await symlink("photo.png", join(folder, "alias.png"));
    const files = workspaceImageSources({
      threadId,
      browserCaptures: { list: () => [], read: async () => undefined },
      root: async () => folder,
    });
    const source = await files.file?.("alias.png");
    await expect(source?.read()).resolves.toEqual(png);
    applyProtectedFilesChoice({ ...previous, added: [...previous.added, photo] });
    await expect(files.file?.("photo.png")).resolves.toBeUndefined();
    await expect(files.file?.("alias.png")).resolves.toBeUndefined();
    await expect(source?.read()).resolves.toBeUndefined();
  } finally {
    applyProtectedFilesChoice(previous);
    await rm(folder, { recursive: true, force: true });
  }
});

it("labels a signed-in screenshot using only its hostname without reading it, and refuses recordings", async () => {
  const capture = decodeBrowserCapture({
    captureId: "a3000000-0000-4000-8000-000000000002",
    threadId,
    url: "https://example.test/account?private=1",
    origin: "https://example.test",
    hash: "a".repeat(64),
    size: png.length,
    mime: "image/png",
    capturedAt: "2026-11-20T12:00:00.000Z",
    profile: { kind: "personal" },
  });
  let screenshot = true;
  const read = vi.fn(async () => ({ capture, bytes: png }));
  const sources = workspaceImageSources({
    threadId,
    root: async () => undefined,
    browserCaptures: {
      list: (owner) =>
        owner !== threadId
          ? []
          : [
              screenshot
                ? capture
                : {
                    ...capture,
                    recording: { frames: 4, durationMs: 1_000 },
                  },
            ],
      read,
    },
  });
  const source = sources.browserCapture?.(capture.captureId);
  expect(source).toMatchObject({ label: "Browser screenshot of example.test", signedIn: true });
  expect(read).not.toHaveBeenCalled();
  await expect(source?.read()).resolves.toEqual(png);
  expect(read).toHaveBeenCalledWith(threadId, capture.captureId);
  screenshot = false;
  expect(sources.browserCapture?.(capture.captureId)).toBeUndefined();
});

it("checks the expanded count and recorded size before reading, then sniffs rather than trusting the label", async () => {
  const read = vi.fn(async () => Uint8Array.of(1, 2, 3));
  const photo = { label: "your attached photo sample.png", size: 3, read };
  const describe = (attachments: Parameters<typeof describeImageSources>[1]) =>
    describeImageSources([{ kind: "attachment" }], attachments, () => undefined);
  await expect(describe({ latestAttachments: () => Array(5).fill(photo) })).resolves.toHaveProperty(
    "error",
  );
  await expect(
    describe({
      latestAttachments: () => [{ ...photo, size: MAX_GENERATED_IMAGE_BYTES + 1 }],
    }),
  ).resolves.toHaveProperty("error");
  const described = await describe({ latestAttachments: () => [photo] });
  expect(read).not.toHaveBeenCalled();
  if ("error" in described) throw new Error(described.error);
  await expect(readImageSources(described)).resolves.toEqual({
    error: "A reference is not a PNG, JPEG, WebP or GIF image.",
  });
});

it("resolves a named upload by its file name, not by a suffix of a longer one", async () => {
  const read = vi.fn(async () => png);
  const upload = (displayName: string) => ({
    displayName,
    mediaType: "image/png",
    byteLength: 3,
  });
  const attachments = attachedImageSources([upload("logo.png"), upload("new logo.png")], () =>
    read(),
  );
  const described = await describeImageSources(
    [{ kind: "attachment", name: "logo.png" }],
    { latestAttachments: () => attachments },
    () => undefined,
  );
  if ("error" in described) throw new Error(described.error);
  expect(described).toHaveLength(1);
  expect(described[0]?.source.label).toBe("your attached photo logo.png");
});

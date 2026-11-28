import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_DESIGN_ASSET_MAX_BYTES,
  CanvasDesignAssetId,
  decodeBrowserCaptureId,
  decodeImageArtifactId,
  type CanvasDesignBlock,
} from "@octant/contracts";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import {
  readCanvasDesignAssetFile,
  resolveCanvasDesignAssets,
  resolveCanvasShareImages,
  type CanvasDesignAssetPorts,
} from "./canvasDesignAssets";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const decodeCanvasDesignAssetId = Schema.decodeUnknownSync(CanvasDesignAssetId);
const imageId = decodeImageArtifactId("11111111-1111-4111-8111-111111111111");
const projectId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "octant-design-assets-root-"));
  outside = await mkdtemp(join(tmpdir(), "octant-design-assets-outside-"));
  await mkdir(join(root, "screens"));
  await writeFile(join(root, "screens", "home.png"), PNG);
  await writeFile(join(root, "screens", "logo.svg"), SVG);
  await writeFile(join(root, "notes.txt"), "not an image");
  await writeFile(join(outside, "secret.png"), PNG);
  await symlink(join(outside, "secret.png"), join(root, "screens", "escape.png"));
  await symlink(join(root, "screens", "home.png"), join(root, "inside.png"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function filePorts(
  generated: CanvasDesignAssetPorts["generatedImage"] = async () => ({
    status: "unavailable",
    reason: "missing",
  }),
  browserCapture: CanvasDesignAssetPorts["browserCapture"] = async () => ({
    status: "unavailable",
    reason: "missing",
  }),
): CanvasDesignAssetPorts & { readonly projectFile: ReturnType<typeof vi.fn> } {
  const projectFile = vi.fn(async (input: Parameters<CanvasDesignAssetPorts["projectFile"]>[0]) =>
    readCanvasDesignAssetFile({
      filesystem: liveWorkFilesystem,
      root,
      path: input.path,
      maximumBytes: input.maximumBytes,
    }),
  );
  return { generatedImage: generated, browserCapture, projectFile };
}

function design(assets: NonNullable<CanvasDesignBlock["assets"]>) {
  return { assets };
}

const file = (assetId: string, path: string) =>
  ({ assetId, source: { kind: "project-file", path } }) as NonNullable<
    CanvasDesignBlock["assets"]
  >[number];

describe("resolveCanvasDesignAssets", () => {
  it("resolves a Project screenshot by id in Work and Code", async () => {
    for (const mode of ["work", "code"] as const) {
      const ports = filePorts();
      const resolved = await resolveCanvasDesignAssets(
        design([file("home", "screens/home.png"), file("linked", "inside.png")]),
        { mode, projectId: projectId as never, threadId: threadId as never },
        ports,
      );
      expect(resolved).toEqual([
        {
          assetId: "home",
          status: "resolved",
          mediaType: "image/png",
          data: Buffer.from(PNG).toString("base64"),
        },
        {
          assetId: "linked",
          status: "resolved",
          mediaType: "image/png",
          data: Buffer.from(PNG).toString("base64"),
        },
      ]);
      expect(ports.projectFile).toHaveBeenCalledWith(
        expect.objectContaining({ mode, projectId, threadId, path: "screens/home.png" }),
      );
    }
  });

  it("refuses a Project path in a Chat Canvas without reading anything", async () => {
    const ports = filePorts();
    const resolved = await resolveCanvasDesignAssets(
      design([file("home", "screens/home.png")]),
      { mode: "chat", projectId: projectId as never, threadId: threadId as never },
      ports,
    );
    expect(resolved).toEqual([{ assetId: "home", status: "unavailable", reason: "refused" }]);
    expect(ports.projectFile).not.toHaveBeenCalled();
  });

  describe("captured pages", () => {
    const captureId = decodeBrowserCaptureId("55555555-5555-4555-8555-555555555555");
    const shot = design([
      {
        assetId: decodeCanvasDesignAssetId("before"),
        source: { kind: "browser-capture", captureId },
      },
    ]);

    it("draws the screenshot a Work or Code thread kept, asked for by that thread alone", async () => {
      for (const mode of ["work", "code"] as const) {
        const capture = vi.fn(async (_input: { readonly threadId: string }) => ({
          status: "read" as const,
          bytes: PNG,
        }));
        const resolved = await resolveCanvasDesignAssets(
          shot,
          { mode, projectId: projectId as never, threadId: threadId as never },
          filePorts(undefined, capture),
        );
        expect(resolved[0]).toMatchObject({ assetId: "before", status: "resolved" });
        expect(capture).toHaveBeenCalledWith(expect.objectContaining({ captureId, threadId }));
      }
    });

    it("refuses a capture in a Chat Canvas without asking for it", async () => {
      const capture = vi.fn(async () => ({ status: "read" as const, bytes: PNG }));
      const resolved = await resolveCanvasDesignAssets(
        shot,
        { mode: "chat", projectId: null, threadId: threadId as never },
        filePorts(undefined, capture),
      );
      expect(resolved).toEqual([{ assetId: "before", status: "unavailable", reason: "refused" }]);
      expect(capture).not.toHaveBeenCalled();
    });

    it("reports a capture the thread does not hold as missing so the design keeps its other assets", async () => {
      const resolved = await resolveCanvasDesignAssets(
        design([...(shot.assets ?? []), file("home", "screens/home.png")]),
        { mode: "work", projectId: projectId as never, threadId: threadId as never },
        filePorts(),
      );
      expect(resolved.map((entry) => entry.status)).toEqual(["unavailable", "resolved"]);
      expect(resolved[0]).toEqual({ assetId: "before", status: "unavailable", reason: "missing" });
    });
  });

  it("draws a generated image in a Chat Canvas only when its Project says so", async () => {
    const generated = vi.fn(async (input: { readonly projectId: string | null }) =>
      input.projectId === projectId
        ? ({ status: "read", bytes: PNG } as const)
        : ({ status: "unavailable", reason: "refused" } as const),
    );
    const block = design([
      { assetId: decodeCanvasDesignAssetId("hero"), source: { kind: "generated-image", imageId } },
    ]);
    const ours = await resolveCanvasDesignAssets(
      block,
      { mode: "chat", projectId: projectId as never, threadId: threadId as never },
      filePorts(generated),
    );
    expect(ours[0]).toMatchObject({ assetId: "hero", status: "resolved" });
    const theirs = await resolveCanvasDesignAssets(
      block,
      {
        mode: "chat",
        projectId: "44444444-4444-4444-8444-444444444444" as never,
        threadId: threadId as never,
      },
      filePorts(generated),
    );
    expect(theirs).toEqual([{ assetId: "hero", status: "unavailable", reason: "refused" }]);
  });

  it("asks for a generated image by thread, not Project, in a Canvas owned by its thread, and refuses a file path there", async () => {
    const generated = vi.fn(async (_input: { readonly projectId: string | null }) => ({
      status: "read" as const,
      bytes: PNG,
    }));
    const resolved = await resolveCanvasDesignAssets(
      design([
        {
          assetId: decodeCanvasDesignAssetId("hero"),
          source: { kind: "generated-image", imageId },
        },
        file("home", "screens/home.png"),
      ]),
      { mode: "chat", projectId: null, threadId: threadId as never },
      filePorts(generated),
    );
    expect(generated).toHaveBeenCalledWith(
      expect.objectContaining({ imageId, projectId: null, threadId }),
    );
    expect(resolved).toEqual([
      expect.objectContaining({ assetId: "hero", status: "resolved" }),
      { assetId: "home", status: "unavailable", reason: "refused" },
    ]);
  });

  it("refuses traversal, an absolute path, and a symlink out of the folder, and never returns the bytes", async () => {
    const resolved = await resolveCanvasDesignAssets(
      design([
        file("up", "../secret.png"),
        file("deep", "screens/../../secret.png"),
        file("absolute", join(outside, "secret.png")),
        file("link", "screens/escape.png"),
        file("dir", "screens"),
      ]),
      { mode: "work", projectId: projectId as never, threadId: threadId as never },
      filePorts(),
    );
    expect(resolved).toEqual(
      ["up", "deep", "absolute", "link", "dir"].map((assetId) => ({
        assetId,
        status: "unavailable",
        reason: "refused",
      })),
    );
    expect(JSON.stringify(resolved)).not.toContain(Buffer.from(PNG).toString("base64"));
  });

  it("reports a missing file, a non-image, an SVG, and an oversize image as values", async () => {
    await writeFile(join(root, "huge.png"), new Uint8Array(CANVAS_DESIGN_ASSET_MAX_BYTES + 1));
    const resolved = await resolveCanvasDesignAssets(
      design([
        file("gone", "screens/gone.png"),
        file("text", "notes.txt"),
        file("svg", "screens/logo.svg"),
        file("huge", "huge.png"),
      ]),
      { mode: "code", projectId: projectId as never, threadId: threadId as never },
      filePorts(),
    );
    expect(resolved).toEqual([
      { assetId: "gone", status: "unavailable", reason: "missing" },
      { assetId: "text", status: "unavailable", reason: "not-an-image" },
      { assetId: "svg", status: "unavailable", reason: "not-an-image" },
      { assetId: "huge", status: "unavailable", reason: "too-large" },
    ]);
  });

  it("stops at the design's budget once earlier images have spent it", async () => {
    const big = new Uint8Array(CANVAS_DESIGN_ASSET_MAX_BYTES);
    big.set(PNG);
    await writeFile(join(root, "a.png"), big);
    await writeFile(join(root, "b.png"), big);
    const resolved = await resolveCanvasDesignAssets(
      design([file("a", "a.png"), file("b", "b.png"), file("small", "screens/home.png")]),
      { mode: "work", projectId: projectId as never, threadId: threadId as never },
      filePorts(),
    );
    expect(resolved.map((entry) => entry.status)).toEqual(["resolved", "unavailable", "resolved"]);
    expect(resolved[1]).toEqual({ assetId: "b", status: "unavailable", reason: "design-budget" });
  });

  it("compares Project files against recorded digests, withholds changed bytes, and leaves generated images and captures untouched", async () => {
    const pngB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
    const shaA = createHash("sha256").update(PNG).digest("hex");
    const captureId = decodeBrowserCaptureId("55555555-5555-4555-8555-555555555555");
    const block = design([
      file("kept", "screens/home.png"),
      file("changed", "screens/changed.png"),
      file("appeared", "screens/appeared.png"),
      {
        assetId: decodeCanvasDesignAssetId("hero"),
        source: { kind: "generated-image", imageId },
      },
      {
        assetId: decodeCanvasDesignAssetId("before"),
        source: { kind: "browser-capture", captureId },
      },
    ]);
    await writeFile(join(root, "screens", "changed.png"), pngB);
    await writeFile(join(root, "screens", "appeared.png"), pngB);
    const ports = filePorts(
      async () => ({ status: "read", bytes: PNG }),
      async () => ({ status: "read", bytes: PNG }),
    );
    const recorded = new Map([
      [
        "kept",
        {
          blockId: "phone" as never,
          assetId: "kept" as never,
          status: "recorded" as const,
          sha256: shaA,
        },
      ],
      [
        "changed",
        {
          blockId: "phone" as never,
          assetId: "changed" as never,
          status: "recorded" as const,
          sha256: shaA,
        },
      ],
      [
        "appeared",
        {
          blockId: "phone" as never,
          assetId: "appeared" as never,
          status: "unavailable" as const,
        },
      ],
    ]);

    const compared = await resolveCanvasDesignAssets(
      block,
      { mode: "work", projectId: projectId as never, threadId: threadId as never },
      ports,
      { mode: "compare", recorded },
    );
    expect(compared).toEqual([
      {
        assetId: "kept",
        status: "resolved",
        mediaType: "image/png",
        data: Buffer.from(PNG).toString("base64"),
      },
      { assetId: "changed", status: "unavailable", reason: "changed" },
      { assetId: "appeared", status: "unavailable", reason: "changed" },
      {
        assetId: "hero",
        status: "resolved",
        mediaType: "image/png",
        data: Buffer.from(PNG).toString("base64"),
      },
      {
        assetId: "before",
        status: "resolved",
        mediaType: "image/png",
        data: Buffer.from(PNG).toString("base64"),
      },
    ]);
    expect(JSON.stringify(compared)).not.toContain(Buffer.from(pngB).toString("base64"));

    // Restoring identical bytes draws the image again.
    await writeFile(join(root, "screens", "changed.png"), PNG);
    const restored = await resolveCanvasDesignAssets(
      design([file("changed", "screens/changed.png")]),
      { mode: "work", projectId: projectId as never, threadId: threadId as never },
      ports,
      { mode: "compare", recorded },
    );
    expect(restored[0]).toMatchObject({ assetId: "changed", status: "resolved" });

    // Older clients that do not ask for marks get `missing` instead of `changed`.
    await writeFile(join(root, "screens", "changed.png"), pngB);
    const legacy = await resolveCanvasDesignAssets(
      design([file("changed", "screens/changed.png")]),
      { mode: "work", projectId: projectId as never, threadId: threadId as never },
      ports,
      { mode: "compare", recorded, clientSupportsMarks: false },
    );
    expect(legacy).toEqual([{ assetId: "changed", status: "unavailable", reason: "missing" }]);

    // Unrecorded versions draw live Project files with `mark: "unrecorded"`,
    // while leaving generated images and Browser captures unmarked, and omit
    // the mark for older clients.
    const unrecorded = await resolveCanvasDesignAssets(
      design([
        file("kept", "screens/home.png"),
        {
          assetId: decodeCanvasDesignAssetId("hero"),
          source: { kind: "generated-image", imageId },
        },
        {
          assetId: decodeCanvasDesignAssetId("before"),
          source: { kind: "browser-capture", captureId },
        },
      ]),
      { mode: "work", projectId: projectId as never, threadId: threadId as never },
      ports,
      { mode: "compare" },
    );
    expect(unrecorded[0]).toMatchObject({ assetId: "kept", status: "resolved", mark: "unrecorded" });
    expect(unrecorded[1]).not.toHaveProperty("mark");
    expect(unrecorded[2]).not.toHaveProperty("mark");

    const unrecordedLegacy = await resolveCanvasDesignAssets(
      design([file("kept", "screens/home.png")]),
      { mode: "work", projectId: projectId as never, threadId: threadId as never },
      ports,
      { mode: "compare", clientSupportsMarks: false },
    );
    expect(unrecordedLegacy[0]).toMatchObject({ assetId: "kept", status: "resolved" });
    expect(unrecordedLegacy[0]).not.toHaveProperty("mark");
  });
});

describe("resolveCanvasShareImages", () => {
  it("reads every image a version shows, once each, under its provenance, as sniffed rasters with their digest", async () => {
    const svgId = decodeImageArtifactId("44444444-4444-4444-8444-444444444444");
    const generated = vi.fn(
      async (input: Parameters<CanvasDesignAssetPorts["generatedImage"]>[0]) =>
        String(input.imageId) === String(imageId)
          ? ({ status: "read", bytes: PNG } as const)
          : ({ status: "read", bytes: SVG } as const),
    );
    const ports = filePorts(generated);
    const resolved = await resolveCanvasShareImages(
      {
        provenance: { mode: "work", projectId, threadId } as never,
        blocks: [
          {
            blockId: "cover",
            schemaVersion: 30,
            kind: "image",
            generatedImageId: imageId,
            alt: "Cover",
          },
          {
            blockId: "logo",
            schemaVersion: 30,
            kind: "image",
            generatedImageId: svgId,
            alt: "Logo",
          },
          {
            blockId: "phone",
            schemaVersion: 30,
            kind: "design",
            title: "Phone",
            size: "phone",
            frames: [
              {
                frameId: "home",
                title: "Home",
                html: '<img src="octant-asset:hero" alt=""><img src="octant-asset:shot" alt="">',
              },
            ],
            assets: [
              { assetId: "hero", source: { kind: "generated-image", imageId } },
              file("shot", "screens/home.png"),
              // Declared and named nowhere, so never read.
              file("unused", "screens/escape.png"),
            ],
          },
        ] as never,
      },
      ports,
    );
    const png = {
      mediaType: "image/png",
      data: Buffer.from(PNG).toString("base64"),
      byteLength: PNG.byteLength,
      sha256: createHash("sha256").update(PNG).digest("hex"),
    };
    // The SVG is not a raster image and is left out.
    expect([...resolved.entries()]).toEqual([
      [`generated-image:${String(imageId)}`, png],
      ["project-file:screens/home.png", png],
    ]);
    // The same image shown twice is read once, and a file through the Work
    // confinement sequence under the thread's folder.
    expect(generated).toHaveBeenCalledTimes(2);
    expect(generated).toHaveBeenCalledWith(
      expect.objectContaining({ imageId, projectId, threadId }),
    );
    expect(ports.projectFile).toHaveBeenCalledTimes(1);
  });
});

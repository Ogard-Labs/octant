import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_DESIGN_ASSET_MAX_BYTES,
  CanvasDesignAssetId,
  decodeImageArtifactId,
  type CanvasDesignBlock,
} from "@octant/contracts";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import {
  readCanvasDesignAssetFile,
  resolveCanvasDesignAssets,
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
): CanvasDesignAssetPorts & { readonly projectFile: ReturnType<typeof vi.fn> } {
  const projectFile = vi.fn(async (input: Parameters<CanvasDesignAssetPorts["projectFile"]>[0]) =>
    readCanvasDesignAssetFile({
      filesystem: liveWorkFilesystem,
      root,
      path: input.path,
      maximumBytes: input.maximumBytes,
    }),
  );
  return { generatedImage: generated, projectFile };
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

  it("answers a captured-page asset as refused without reading anything until captures resolve", async () => {
    const ports = filePorts();
    const capture = {
      assetId: "shot",
      source: { kind: "browser-capture", captureId: "44444444-4444-4444-8444-444444444444" },
    } as NonNullable<CanvasDesignBlock["assets"]>[number];
    const resolved = await resolveCanvasDesignAssets(
      design([capture]),
      { mode: "work", projectId: projectId as never, threadId: threadId as never },
      ports,
    );
    expect(resolved).toEqual([{ assetId: "shot", status: "unavailable", reason: "refused" }]);
    expect(ports.projectFile).not.toHaveBeenCalled();
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
});

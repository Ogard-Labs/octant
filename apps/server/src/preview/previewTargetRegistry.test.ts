import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodePreviewOpaqueRef,
  decodePreviewTargetId,
  type PreviewHostId,
  type PreviewTargetId,
} from "@octant/contracts/previews";
import {
  PreviewTargetRegistry,
  type PreviewTargetResolutionFailure,
} from "./previewTargetRegistry";

const projectRoot = mkdtempSync(join(tmpdir(), "preview-registry-"));
const targetId = decodePreviewTargetId("11111111-1111-4111-8111-111111111111") as PreviewTargetId;
const hostId = "33333333-3333-4333-8333-333333333333" as PreviewHostId;

function ref(value: string) {
  return decodePreviewOpaqueRef(value);
}

beforeEach(() => {
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(projectRoot, { recursive: true });
});

describe("PreviewTargetRegistry.resolve", () => {
  it("resolves a registered file target to its confined absolute path", () => {
    const filePath = join(projectRoot, "notes.txt");
    writeFileSync(filePath, "hello");
    const registry = new PreviewTargetRegistry({
      projectRoot,
      hostId,
      records: [
        {
          targetId,
          kind: "file",
          opaqueRef: ref("notes.txt"),
          relativePath: "notes.txt",
        },
      ],
    });

    const result = registry.resolve(targetId);
    expect(result).toEqual({ ok: true, absolutePath: realpathSync(filePath) });
  });

  it("fails with not-found when the target id is unknown", () => {
    const registry = new PreviewTargetRegistry({ projectRoot, hostId, records: [] });
    const other = decodePreviewTargetId("22222222-2222-4222-8222-222222222222") as PreviewTargetId;
    expect(registry.resolve(other)).toEqual<PreviewTargetResolutionFailure>({
      ok: false,
      code: "not-found",
    });
  });

  it("fails with unavailable when the resolved path no longer exists", () => {
    const registry = new PreviewTargetRegistry({
      projectRoot,
      hostId,
      records: [
        {
          targetId,
          kind: "file",
          opaqueRef: ref("gone.txt"),
          relativePath: "gone.txt",
        },
      ],
    });
    expect(registry.resolve(targetId)).toEqual<PreviewTargetResolutionFailure>({
      ok: false,
      code: "unavailable",
    });
  });

  it("fails with containment-violation when the relative path escapes the project root", () => {
    const registry = new PreviewTargetRegistry({
      projectRoot,
      hostId,
      records: [
        {
          targetId,
          kind: "file",
          opaqueRef: ref("evil"),
          relativePath: "../../../etc/passwd",
        },
      ],
    });
    expect(registry.resolve(targetId)).toEqual<PreviewTargetResolutionFailure>({
      ok: false,
      code: "containment-violation",
    });
  });

  it("fails with containment-violation when a symlink inside the root points outside", () => {
    const outside = mkdtempSync(join(tmpdir(), "preview-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(outside, join(projectRoot, "link"));
      const registry = new PreviewTargetRegistry({
        projectRoot,
        hostId,
        records: [
          {
            targetId,
            kind: "file",
            opaqueRef: ref("link"),
            relativePath: "link/secret.txt",
          },
        ],
      });
      expect(registry.resolve(targetId)).toEqual<PreviewTargetResolutionFailure>({
        ok: false,
        code: "containment-violation",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("resolves a target whose intermediate directory is a symlink that stays within the root", () => {
    mkdirSync(join(projectRoot, "real"));
    writeFileSync(join(projectRoot, "real", "doc.md"), "# hi");
    symlinkSync(join(projectRoot, "real"), join(projectRoot, "alias"));
    const registry = new PreviewTargetRegistry({
      projectRoot,
      hostId,
      records: [
        {
          targetId,
          kind: "file",
          opaqueRef: ref("alias"),
          relativePath: "alias/doc.md",
        },
      ],
    });
    const result = registry.resolve(targetId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absolutePath).toBe(realpathSync(join(projectRoot, "real", "doc.md")));
    }
  });
});

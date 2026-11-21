import {
  decodeCodeRelativePath,
  type CodeThreadView,
  type ImageGenerationSaveResult,
  type WindowId,
} from "@octant/contracts";
import { canonicalizeWorkRelativePath } from "@octant/domain";
import type { CodeFileRootAuthorityPort } from "../code/codeService";
import { writeConfinedWorkFile } from "../work/workConfinedWrite";
import { liveWorkFilesystem, type WorkFilesystemPort } from "../work/workFilesystemPort";
import { WorkResolutionService } from "../work/workResolutionService";

export async function saveGeneratedCodeImage(
  input: {
    readonly windowId: WindowId;
    readonly view: CodeThreadView;
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  },
  roots: CodeFileRootAuthorityPort,
): Promise<ImageGenerationSaveResult> {
  const { thread, checkout } = input.view;
  if (thread.executionPolicy === "plan") {
    return { status: "refused", reason: "Plan mode cannot save images." };
  }
  let relativePath;
  try {
    relativePath = decodeCodeRelativePath(canonicalizeWorkRelativePath(input.relativePath));
  } catch {
    return { status: "refused", reason: "The save path is outside the checkout." };
  }
  const root = await roots.resolve(input.windowId, thread, checkout, relativePath);
  if (root?.current === undefined) {
    return { status: "refused", reason: "The Code checkout is unavailable." };
  }
  return await saveGeneratedImageUnder({
    root: root.rootPath,
    relativePath,
    bytes: input.bytes,
    current: root.current,
  });
}

/**
 * Writes a generated image as a new file under `root`, through the Work
 * confinement sequence: the path is resolved for create inside the root, then
 * written exclusively through the parent it proved, so a path that escapes
 * the root, a symlinked component, or an existing file is refused rather than
 * followed or overwritten. A person's Save and an agent's save both use it.
 */
export async function saveGeneratedImageUnder(
  input: {
    readonly root: string;
    readonly relativePath: string;
    readonly bytes: Uint8Array;
    readonly current?: () => boolean;
  },
  filesystem: WorkFilesystemPort = liveWorkFilesystem,
): Promise<ImageGenerationSaveResult> {
  try {
    const resolution = await new WorkResolutionService(filesystem).resolveForCreate({
      binding: {
        canonicalRoot: input.root,
        knownCanonicalRoot: input.root,
        availability: "available",
        bindingSuperseded: false,
      },
      relativePath: canonicalizeWorkRelativePath(input.relativePath),
    });
    if (resolution.status !== "resolved-for-create") {
      return { status: "refused", reason: "The save path is outside the Project." };
    }
    if (input.current?.() === false) {
      return { status: "refused", reason: "The save folder is unavailable." };
    }
    const written = await writeConfinedWorkFile({
      filesystem,
      canonicalPath: resolution.absolutePath,
      allowCreate: true,
      parent: {
        absolutePath: resolution.parentAbsolute,
        identity: resolution.parentIdentity,
        remaining: resolution.remaining,
      },
      bytes: input.bytes,
    });
    return written
      ? { status: "saved", relativePath: resolution.relativePath }
      : { status: "failed", reason: "The image could not be saved." };
  } catch {
    return { status: "failed", reason: "The image could not be saved." };
  }
}

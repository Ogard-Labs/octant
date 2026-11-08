import type { ImageGenerationSaveResult } from "@octant/contracts";
import { canonicalizeWorkRelativePath } from "@octant/domain";
import { writeConfinedWorkFile } from "../work/workConfinedWrite";
import { liveWorkFilesystem, type WorkFilesystemPort } from "../work/workFilesystemPort";
import { WorkResolutionService } from "../work/workResolutionService";

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

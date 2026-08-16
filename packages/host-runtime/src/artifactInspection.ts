import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  type HeadlessArtifactManifest,
} from "./artifactManifest";

// Static and startup inspection of a headless artifact. Inspection reads only
// artifact-internal facts (manifest, component bytes, native-module loadability)
// and never opens the live store, so it is safe to run before ownership.

export type HeadlessArtifactComponentMismatchReason =
  | "missing"
  | "not-a-file"
  | "digest-mismatch"
  | "length-mismatch"
  | "version-mismatch";

export type HeadlessArtifactInspectionRejection =
  | { readonly code: "malformed-manifest"; readonly detail: string }
  | {
      readonly code: "wrong-platform";
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly code: "wrong-architecture";
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly code: "incompatible-wire-version";
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly code: "incompatible-store-version";
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly code: "component-mismatch";
      readonly component: string;
      readonly reason: HeadlessArtifactComponentMismatchReason;
    }
  | { readonly code: "native-module-failure"; readonly component: string };

export type HeadlessArtifactInspectionResult =
  | { readonly ok: true; readonly manifest: HeadlessArtifactManifest }
  | { readonly ok: false; readonly rejection: HeadlessArtifactInspectionRejection };

export interface HeadlessArtifactRuntimeFacts {
  readonly platform: string;
  readonly arch: string;
  readonly wireVersion: string;
  /** Latest store schema version this runtime supports; omit to skip the check. */
  readonly storeVersion?: number;
}

export interface InspectHeadlessArtifactOptions {
  readonly artifactRoot: string;
  readonly runtime: HeadlessArtifactRuntimeFacts;
  /**
   * Loads one native module for the current process target. Callers must skip
   * the probe (omit this) when inspecting a cross-target artifact that cannot
   * be loaded on the inspecting host.
   */
  readonly loadNativeModule?: (absolutePath: string) => void | Promise<void>;
}

const VERSIONED_ROLES = new Set(["server", "cli", "web-assets"]);

export async function inspectHeadlessArtifact(
  options: InspectHeadlessArtifactOptions,
): Promise<HeadlessArtifactInspectionResult> {
  let manifest: HeadlessArtifactManifest;
  try {
    manifest = decodeHeadlessArtifactManifest(
      await readFile(join(options.artifactRoot, HEADLESS_ARTIFACT_MANIFEST_FILENAME), "utf8"),
    );
  } catch (error) {
    return reject({
      code: "malformed-manifest",
      detail:
        error instanceof Error && error.name === "HeadlessArtifactManifestError"
          ? error.message
          : "Octant artifact manifest is unreadable.",
    });
  }
  if (manifest.target.platform !== options.runtime.platform) {
    return reject({
      code: "wrong-platform",
      expected: manifest.target.platform,
      actual: options.runtime.platform,
    });
  }
  if (manifest.target.arch !== options.runtime.arch) {
    return reject({
      code: "wrong-architecture",
      expected: manifest.target.arch,
      actual: options.runtime.arch,
    });
  }
  if (manifest.wireVersion !== options.runtime.wireVersion) {
    return reject({
      code: "incompatible-wire-version",
      expected: manifest.wireVersion,
      actual: options.runtime.wireVersion,
    });
  }
  if (
    options.runtime.storeVersion !== undefined &&
    manifest.storeVersion !== options.runtime.storeVersion
  ) {
    return reject({
      code: "incompatible-store-version",
      expected: manifest.storeVersion,
      actual: options.runtime.storeVersion,
    });
  }

  for (const component of manifest.components) {
    const absolutePath = join(options.artifactRoot, component.path);
    const mismatch = await verifyComponentFile(
      absolutePath,
      component.sha256,
      component.byteLength,
    );
    if (mismatch !== undefined) {
      return reject({ code: "component-mismatch", component: component.path, reason: mismatch });
    }
    if (VERSIONED_ROLES.has(component.role) && component.version !== manifest.artifactVersion) {
      return reject({
        code: "component-mismatch",
        component: component.path,
        reason: "version-mismatch",
      });
    }
  }

  if (options.loadNativeModule !== undefined) {
    for (const component of manifest.components) {
      if (component.role !== "native-module") continue;
      try {
        await options.loadNativeModule(join(options.artifactRoot, component.path));
      } catch {
        return reject({ code: "native-module-failure", component: component.path });
      }
    }
  }

  return { ok: true, manifest };
}

async function verifyComponentFile(
  absolutePath: string,
  expectedSha256: string,
  expectedByteLength: number,
): Promise<HeadlessArtifactComponentMismatchReason | undefined> {
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch {
    return "missing";
  }
  // Component-wise canonical verification: a symlinked or non-regular entry is
  // never followed, so a replacement race cannot smuggle bytes from outside
  // the verified artifact tree.
  if (metadata.isSymbolicLink() || !metadata.isFile()) return "not-a-file";
  if (metadata.size !== expectedByteLength) return "length-mismatch";
  let contents: Buffer;
  try {
    contents = await readFile(absolutePath);
  } catch {
    return "missing";
  }
  if (contents.byteLength !== expectedByteLength) return "length-mismatch";
  if (createHash("sha256").update(contents).digest("hex") !== expectedSha256) {
    return "digest-mismatch";
  }
  return undefined;
}

function reject(rejection: HeadlessArtifactInspectionRejection): HeadlessArtifactInspectionResult {
  return { ok: false, rejection };
}

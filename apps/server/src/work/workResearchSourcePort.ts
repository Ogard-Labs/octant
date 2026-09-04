import { createHash } from "node:crypto";
import { Schema } from "effect";
import { UtcTimestamp } from "@octant/contracts/events";
import { ContentSha256, type PreviewSourceVersion } from "@octant/contracts/previews";
import {
  MAX_WORK_RESEARCH_SOURCE_BYTES,
  type WorkSourceKind,
} from "@octant/contracts/work-research";
import type { ProjectId } from "@octant/contracts/projects";
import {
  canonicalizeWorkRelativePath,
  classifyExcerptSupport,
  WorkConfinementRejected,
} from "@octant/domain";
import { readConfinedWorkFile } from "./workConfinedRead";
import { joinWorkPath, resolveContainedWorkPath } from "./workPathConfinement";
import type { WorkFilesystemPort } from "./workFilesystemPort";
import type { WorkResearchSourcePort } from "./workResearchService";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeSha256 = Schema.decodeUnknownSync(ContentSha256);
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Work reads are bounded; a larger source is treated as unobservable, and
 * therefore also unverifiable for an excerpt. The same ceiling bounds both, so
 * excerpt verification never reads more of a Project than freshness already
 * did. The bound is the shared contract constant so the renderer can refuse an
 * oversized pick before reading it without keeping a second copy that can drift.
 */
const DEFAULT_MAX_SOURCE_BYTES = MAX_WORK_RESEARCH_SOURCE_BYTES;

export interface WorkResearchSourcePortOptions {
  readonly filesystem: WorkFilesystemPort;
  /** Canonical bound root for an authorized Work Project, or undefined. */
  readonly resolveProjectRoot: (projectId: ProjectId) => string | undefined;
  readonly maxSourceBytes?: number;
}

/**
 * Read-only freshness observation and excerpt verification for Work research
 * sources.
 *
 * Only `file` sources are observable: Work confines knowledge work to one
 * approved folder and grants no network or mail egress, so `web`,
 * `mail-export`, and `user-reference` refs cannot be verified here. Returning
 * `undefined` for them is not a stub — `WorkResearchService` classifies an
 * unobservable source as `unavailable` and rejects the command as
 * `unsupported`, which is the honest outcome for a source this host cannot
 * re-read.
 *
 * Every observation re-runs the same confinement sequence the artifact
 * resolution service uses — canonicalize the relative path, reject a symlink
 * whose target escapes, then realpath the candidate and re-check containment —
 * so a research brief can never widen authority beyond the approved folder.
 *
 * Excerpt verification reads through that identical sequence and ceiling, then
 * decodes strict UTF-8 and answers only `excerpt-present`, `excerpt-absent`, or
 * `unverifiable`. The bytes and the decoded text stay inside this module: the
 * service learns whether the source supports the excerpt, never what else the
 * file says.
 */
export function createWorkResearchSourcePort(
  options: WorkResearchSourcePortOptions,
): WorkResearchSourcePort {
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;

  /**
   * Read the confined bytes for one source ref, or `undefined` when this host
   * must not or cannot read them. Every read re-runs the full containment
   * sequence and the byte ceiling, so both the freshness observation and the
   * excerpt check are bounded by the same authority.
   */
  async function readConfinedSource(input: {
    readonly projectId: ProjectId;
    readonly sourceKind: WorkSourceKind;
    readonly sourceRef: string;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array | undefined> {
    if (!isObservableKind(input.sourceKind)) return undefined;
    const canonicalRoot = options.resolveProjectRoot(input.projectId);
    if (canonicalRoot === undefined) return undefined;

    let relativePath: string;
    try {
      relativePath = canonicalizeWorkRelativePath(input.sourceRef);
    } catch (error) {
      if (error instanceof WorkConfinementRejected) return undefined;
      throw error;
    }

    const absolutePath = joinWorkPath(canonicalRoot, relativePath);
    try {
      const resolved = await resolveContainedWorkPath(
        options.filesystem,
        canonicalRoot,
        absolutePath,
      );
      if (resolved === undefined) return undefined;
      if (!resolved.stat.isFile || resolved.stat.size > maxSourceBytes) return undefined;
      if (input.signal?.aborted === true) return undefined;

      // The canonical path is handed to the confined read once and never
      // resolved again, so a name made to mean something else after the checks
      // above is refused rather than followed. Both callers derive everything
      // they report from this one buffer.
      return await readConfinedWorkFile({
        filesystem: options.filesystem,
        canonicalPath: resolved.canonical,
        expected: resolved.stat,
        maximumBytes: maxSourceBytes,
      });
    } catch {
      // A missing, unreadable, or racing source is unobservable, never fresh.
      return undefined;
    }
  }

  return {
    async observeSourceVersion(input) {
      const bytes = await readConfinedSource(input);
      if (bytes === undefined) return undefined;
      return { sourceVersion: computeSourceVersion(bytes) };
    },

    async verifySourceExcerpt(input) {
      const bytes = await readConfinedSource(input);
      if (bytes === undefined) return { outcome: "unverifiable" };
      const text = decodeUtf8Text(bytes);
      // A source this host cannot decode as text supports no excerpt: refusing
      // is the only honest answer, never a silently accepted claim.
      if (text === undefined) return { outcome: "unverifiable" };
      const sourceVersion = computeSourceVersion(bytes);
      return classifyExcerptSupport({ sourceText: text, excerpt: input.excerpt }) === "present"
        ? { outcome: "excerpt-present", sourceVersion }
        : { outcome: "excerpt-absent", sourceVersion };
    },
  };
}

/**
 * Decode the read bytes as strict UTF-8 text, mirroring the Code file service:
 * invalid UTF-8 or an embedded NUL means binary, not text. The decoded string
 * never leaves this module.
 */
function decodeUtf8Text(bytes: Uint8Array): string | undefined {
  try {
    const text = fatalDecoder.decode(bytes);
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}

function isObservableKind(kind: WorkSourceKind): boolean {
  return kind === "file";
}

function computeSourceVersion(bytes: Uint8Array): PreviewSourceVersion {
  return {
    contentSha256: decodeSha256(createHash("sha256").update(bytes).digest("hex")),
    byteSize: bytes.byteLength,
    observedAt: decodeTimestamp(new Date().toISOString()),
  };
}

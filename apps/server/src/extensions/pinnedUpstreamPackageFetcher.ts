import type { ExtensionSource } from "@octant/contracts/extensions";
import { readBoundedResponseBody } from "./boundedResponseBody";
import type { ExtensionArchiveEntry } from "./packageInspector";

/**
 * Reference to a pinned upstream Git package: owner, repository, package path,
 * and exact commit SHA. The commit must be a full or abbreviated SHA — branch
 * names, tags, and other mutable refs are rejected so the fetched bytes are
 * content-addressed.
 */
export interface PinnedUpstreamPackageReference {
  readonly owner: string;
  readonly repository: string;
  readonly packagePath: string;
  readonly commit: string;
}

export interface PinnedUpstreamFetchLimits {
  readonly maximumFiles: number;
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
  readonly maximumTreeEntries: number;
  readonly concurrency: number;
}

export const DEFAULT_PINNED_UPSTREAM_FETCH_LIMITS: PinnedUpstreamFetchLimits = {
  maximumFiles: 256,
  maximumFileBytes: 4 * 1_024 * 1_024,
  maximumTotalBytes: 32 * 1_024 * 1_024,
  maximumTreeEntries: 8_192,
  concurrency: 8,
};

export class PinnedUpstreamFetchError extends Error {
  override readonly name = "PinnedUpstreamFetchError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PinnedUpstreamPackageFetchResult {
  readonly format: "directory";
  readonly source: ExtensionSource;
  readonly entries: ReadonlyArray<ExtensionArchiveEntry>;
  readonly archiveBytes: number;
  readonly manifest: unknown;
}

export interface PinnedUpstreamFetchInput {
  readonly reference: PinnedUpstreamPackageReference;
  readonly source: ExtensionSource;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly fetch?: typeof globalThis.fetch;
  readonly limits?: Partial<PinnedUpstreamFetchLimits>;
  readonly signal?: AbortSignal;
}

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/;
const repoPattern = /^[A-Za-z0-9_.-]{1,100}$/;
const commitPattern = /^[a-f0-9]{7,40}$/;
const MAX_TREE_RESPONSE_BYTES = 16 * 1_024 * 1_024;
const TREE_RESPONSE_OVERSIZE_MESSAGE = "Upstream tree response exceeds the size limit.";

/**
 * Fetch the complete, exact pinned upstream package closure from the GitHub
 * tree API at the pinned commit. Returns manifest-relative archive entries
 * (paths stripped of the package prefix) with exact blob bytes.
 *
 * Fails closed on unavailable, truncated, malformed, path-unsafe, oversized,
 * or network responses. No partial, stale, or locally invented bytes are
 * returned.
 */
export async function fetchPinnedUpstreamPackage(
  input: PinnedUpstreamFetchInput,
): Promise<PinnedUpstreamPackageFetchResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const limits: PinnedUpstreamFetchLimits = {
    ...DEFAULT_PINNED_UPSTREAM_FETCH_LIMITS,
    ...input.limits,
  };
  const { reference, source, signal } = input;

  validateReference(reference);

  const treeUrl = `https://api.github.com/repos/${reference.owner}/${reference.repository}/git/trees/${reference.commit}?recursive=1`;
  const treeResponse = await fetchImpl(treeUrl, ...(signal ? [{ signal }] : []));
  if (!treeResponse.ok) {
    throw new PinnedUpstreamFetchError("unavailable", "Upstream tree is unavailable.");
  }
  let tree: unknown;
  try {
    const treeBytes = await readBoundedResponseBody(
      treeResponse,
      MAX_TREE_RESPONSE_BYTES,
      TREE_RESPONSE_OVERSIZE_MESSAGE,
    );
    tree = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(treeBytes)) as unknown;
  } catch (error) {
    const oversize = error instanceof Error && error.message === TREE_RESPONSE_OVERSIZE_MESSAGE;
    throw new PinnedUpstreamFetchError(
      oversize ? "oversize" : "unavailable",
      oversize ? TREE_RESPONSE_OVERSIZE_MESSAGE : "Upstream tree response is malformed.",
    );
  }
  if (!isRecord(tree) || !Array.isArray(tree.tree)) {
    throw new PinnedUpstreamFetchError("unavailable", "Upstream tree response is malformed.");
  }
  if (tree.truncated === true) {
    throw new PinnedUpstreamFetchError("tree-truncated", "Upstream tree is truncated.");
  }
  if (tree.tree.length > limits.maximumTreeEntries) {
    throw new PinnedUpstreamFetchError("oversize", "Upstream tree exceeds the entry limit.");
  }

  const prefix = reference.packagePath.endsWith("/")
    ? reference.packagePath
    : `${reference.packagePath}/`;

  const candidates: Array<{
    readonly fullPath: string;
    readonly relativePath: string;
    readonly size: number;
  }> = [];
  for (const entry of tree.tree) {
    if (!isRecord(entry) || entry.type !== "blob" || typeof entry.path !== "string") continue;
    const fullPath = entry.path;
    if (!fullPath.startsWith(prefix)) continue;
    const relativePath = fullPath.slice(prefix.length);
    if (relativePath.length === 0 || isUnsafeRelativePath(relativePath)) continue;
    const size = typeof entry.size === "number" ? entry.size : 0;
    if (size > limits.maximumFileBytes) {
      throw new PinnedUpstreamFetchError("oversize", "Package file exceeds the size limit.");
    }
    candidates.push({ fullPath, relativePath, size });
  }

  if (candidates.length === 0) {
    throw new PinnedUpstreamFetchError("manifest-missing", "Plugin manifest is missing.");
  }
  if (candidates.length > limits.maximumFiles) {
    throw new PinnedUpstreamFetchError("oversize", "Package exceeds the file count limit.");
  }
  const projectedTotal = candidates.reduce((total, candidate) => total + candidate.size, 0);
  if (projectedTotal > limits.maximumTotalBytes) {
    throw new PinnedUpstreamFetchError("oversize", "Package exceeds the total size limit.");
  }

  const rawPrefix = `https://raw.githubusercontent.com/${reference.owner}/${reference.repository}/${reference.commit}/`;
  const entries: Array<ExtensionArchiveEntry & { readonly content: Uint8Array }> = [];
  let runningTotal = 0;

  for (let index = 0; index < candidates.length; index += limits.concurrency) {
    const batch = candidates.slice(index, index + limits.concurrency);
    const settled = await Promise.all(
      batch.map(async (candidate) => {
        const response = await fetchImpl(
          `${rawPrefix}${candidate.fullPath}`,
          ...(signal ? [{ signal }] : []),
        );
        if (!response.ok) {
          throw new PinnedUpstreamFetchError("unavailable", "Upstream blob is unavailable.");
        }
        let content: Uint8Array;
        try {
          content = await readBoundedResponseBody(
            response,
            limits.maximumFileBytes,
            "Package file exceeds the size limit.",
          );
        } catch {
          throw new PinnedUpstreamFetchError("oversize", "Package file exceeds the size limit.");
        }
        return { path: candidate.relativePath, content };
      }),
    );
    for (const result of settled) {
      runningTotal += result.content.byteLength;
      if (runningTotal > limits.maximumTotalBytes) {
        throw new PinnedUpstreamFetchError("oversize", "Package exceeds the total size limit.");
      }
      entries.push({ path: result.path, kind: "file", content: result.content });
    }
  }

  const agentPluginsManifest = entries.find((entry) => entry.path === "plugin.json");
  const codexManifest = entries.find((entry) => entry.path === ".codex-plugin/plugin.json");
  if (agentPluginsManifest === undefined && codexManifest === undefined) {
    throw new PinnedUpstreamFetchError("manifest-missing", "Plugin manifest is missing.");
  }
  let manifest: unknown | undefined;
  if (agentPluginsManifest?.content !== undefined) {
    const candidate = tryParseManifest(agentPluginsManifest.content);
    if (candidate !== undefined && isAgentPluginsSchema(candidate)) {
      manifest = candidate;
    }
  }
  // Prefer Agent Plugins when root plugin.json declares the portable schema.
  // Otherwise parse the Codex-compatible manifest independently so an
  // unrelated or malformed root file cannot mask a valid package.
  if (manifest === undefined && codexManifest?.content !== undefined) {
    manifest = tryParseManifest(codexManifest.content);
  }
  if (manifest === undefined) {
    throw new PinnedUpstreamFetchError("manifest-invalid", "Plugin manifest is invalid.");
  }

  return {
    format: "directory",
    source,
    entries: [...entries].sort((left, right) => left.path.localeCompare(right.path)),
    archiveBytes: runningTotal,
    manifest,
  };
}

function tryParseManifest(content: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)) as unknown;
  } catch {
    return undefined;
  }
}

function isAgentPluginsSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { $schema?: unknown }).$schema ===
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
  );
}

function validateReference(reference: PinnedUpstreamPackageReference): void {
  if (
    typeof reference.owner !== "string" ||
    !ownerPattern.test(reference.owner) ||
    reference.owner.includes("/")
  ) {
    throw new PinnedUpstreamFetchError("invalid", "Upstream owner is invalid.");
  }
  if (typeof reference.repository !== "string" || !repoPattern.test(reference.repository)) {
    throw new PinnedUpstreamFetchError("invalid", "Upstream repository is invalid.");
  }
  if (typeof reference.commit !== "string" || !commitPattern.test(reference.commit)) {
    throw new PinnedUpstreamFetchError("invalid", "Upstream commit must be a SHA.");
  }
  if (
    typeof reference.packagePath !== "string" ||
    reference.packagePath.length === 0 ||
    reference.packagePath.startsWith("/") ||
    reference.packagePath.includes("\\") ||
    reference.packagePath.includes("\0")
  ) {
    throw new PinnedUpstreamFetchError("invalid", "Upstream package path is invalid.");
  }
  const segments = reference.packagePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new PinnedUpstreamFetchError("invalid", "Upstream package path is invalid.");
  }
}

function isUnsafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return true;
  }
  const segments = path.split("/");
  return segments.some(
    (segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      [...segment].some((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

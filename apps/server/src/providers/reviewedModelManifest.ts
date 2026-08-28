import { readBoundedResponseBody } from "../extensions/boundedResponseBody";

/**
 * Reviewed context limits for one model, keyed by the model identifier a
 * provider reports. The manifest is advisory: it only fills limits a provider
 * does not report itself, and it never widens a limit a provider states.
 */
export interface ReviewedModelEntry {
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly reasoning: "included" | "separate" | "unknown";
}

/**
 * Canonical location of the reviewed manifest: a path on a branch of a public
 * repository. The branch names where to look; the commit it resolves to names
 * exactly which bytes were read, so classification tracks commits instead of
 * released app versions.
 */
export interface ReviewedModelManifestReference {
  readonly owner: string;
  readonly repository: string;
  readonly ref: string;
  readonly path: string;
}

export const CANONICAL_REVIEWED_MODEL_MANIFEST: ReviewedModelManifestReference = {
  owner: "Ogard-Labs",
  repository: "octant",
  ref: "main",
  path: "docs/reviewed-model-manifest.json",
};

export type ReviewedModelManifestRefresh =
  | {
      readonly status: "refreshed";
      readonly commit: string;
      readonly models: ReadonlyArray<ReviewedModelEntry>;
    }
  | { readonly status: "unchanged"; readonly commit: string }
  | {
      readonly status: "refuses";
      readonly reason: "unavailable" | "unreadable" | "oversize";
    };

const MAX_MANIFEST_BYTES = 512 * 1_024;
const OVERSIZE_MESSAGE = "Reviewed model manifest exceeds the size limit.";
const commitPattern = /^[a-f0-9]{40}$/;

/**
 * Read the reviewed manifest at the current tip commit of its canonical branch.
 * A caller that already holds a commit gets `unchanged` and does no second
 * request, so a refresh costs one request while the branch does not move.
 * Every network, decoding, and size failure is refused rather than thrown, and
 * a refused refresh leaves the previously known manifest in place.
 */
export async function refreshReviewedModelManifest(input: {
  readonly reference: ReviewedModelManifestReference;
  readonly knownCommit?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<ReviewedModelManifestRefresh> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const { reference } = input;
  const init = input.signal === undefined ? {} : { signal: input.signal };

  let commit: string;
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${reference.owner}/${reference.repository}/commits/${reference.ref}`,
      { ...init, headers: { accept: "application/vnd.github.sha" } },
    );
    if (!response.ok) return { status: "refuses", reason: "unavailable" };
    commit = (await response.text()).trim();
  } catch {
    return { status: "refuses", reason: "unavailable" };
  }
  if (!commitPattern.test(commit)) return { status: "refuses", reason: "unreadable" };
  if (input.knownCommit !== undefined && input.knownCommit === commit) {
    return { status: "unchanged", commit };
  }

  let text: string;
  try {
    const response = await fetchImpl(
      `https://raw.githubusercontent.com/${reference.owner}/${reference.repository}/${commit}/${reference.path}`,
      init,
    );
    if (!response.ok) return { status: "refuses", reason: "unavailable" };
    const bytes = await readBoundedResponseBody(response, MAX_MANIFEST_BYTES, OVERSIZE_MESSAGE);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const oversize = error instanceof Error && error.message === OVERSIZE_MESSAGE;
    return { status: "refuses", reason: oversize ? "oversize" : "unavailable" };
  }

  const models = decodeReviewedModelEntries(text);
  if (models === undefined) return { status: "refuses", reason: "unreadable" };
  return { status: "refreshed", commit, models };
}

function decodeReviewedModelEntries(text: string): ReadonlyArray<ReviewedModelEntry> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return undefined;
  const entries: ReviewedModelEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed.models) {
    if (!isRecord(candidate)) return undefined;
    const { modelId, contextWindow, maxOutput, reasoning } = candidate;
    if (typeof modelId !== "string" || modelId.length === 0) return undefined;
    if (!isPositiveSafeInteger(contextWindow) || !isPositiveSafeInteger(maxOutput))
      return undefined;
    if (maxOutput > contextWindow) return undefined;
    if (reasoning !== undefined && !isReasoning(reasoning)) return undefined;
    if (seen.has(modelId)) return undefined;
    seen.add(modelId);
    entries.push({
      modelId,
      contextWindow,
      maxOutput,
      reasoning: reasoning === undefined ? "unknown" : reasoning,
    });
  }
  return entries;
}

/**
 * Holds the last reviewed manifest a refresh accepted. Empty until a refresh
 * succeeds, so a host that never reaches the canonical remote keeps behaving
 * exactly as it did before.
 */
export class ReviewedModelManifest {
  #commit: string | undefined;
  #byModelId = new Map<string, ReviewedModelEntry>();

  commit(): string | undefined {
    return this.#commit;
  }

  entry(modelId: string): ReviewedModelEntry | undefined {
    return this.#byModelId.get(modelId);
  }

  accept(refresh: ReviewedModelManifestRefresh): void {
    if (refresh.status !== "refreshed") return;
    this.#commit = refresh.commit;
    this.#byModelId = new Map(refresh.models.map((entry) => [entry.modelId, entry]));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isReasoning(value: unknown): value is ReviewedModelEntry["reasoning"] {
  return value === "included" || value === "separate" || value === "unknown";
}

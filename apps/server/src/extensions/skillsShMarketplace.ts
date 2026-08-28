import type { ExtensionSource } from "@octant/contracts/extensions";
import type { SkillMarketplaceEntry } from "@octant/contracts/extension-rpc";
import type { ResolvedExtensionPackage } from "./packageInspector";
import type { SkillMarketplacePort } from "./standaloneSkillService";
import { readBoundedResponseBody } from "./boundedResponseBody";
import { MARKETPLACE_FETCH_USER_AGENT, withMarketplaceRequest } from "./marketplaceRequestSignal";
import {
  SKILLS_SH_CATALOG_ID,
  buildStandaloneSkillPackage,
  decodeSkillCatalogEntryId,
  encodeSkillCatalogEntryId,
  isUnsafeSkillRelativePath,
  parseSkillMarkdown,
  skillSearchEntry,
} from "./skillPackageBuilder";

const DEFAULT_SEARCH_URL = "https://skills.sh/api/search";
const DEFAULT_LIMIT = 25;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_RESPONSE_BYTES = 1024 * 1024;
const MAX_GITHUB_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_GITHUB_TRAVERSAL_DEPTH = 8;
const MAX_GITHUB_TRAVERSAL_ENTRIES = 1_024;
const MAX_GITHUB_TRAVERSAL_REQUESTS = 64;
const MAX_GITHUB_TREE_ENTRIES = 8_192;
const MAX_IDENTITY_CACHE_ENTRIES = 64;
const GITHUB_RAW_HOST = "raw.githubusercontent.com";
const GITHUB_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

interface SkillsShSearchHit {
  readonly id: string;
  readonly skillId: string;
  readonly name: string;
  readonly installs?: number;
  readonly source: string;
}

export interface SkillsShMarketplaceOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly searchUrl?: string;
  readonly appVersion?: string;
  readonly platform?: NodeJS.Platform;
}

/**
 * skills.sh registry adapter: search via the public API, resolve skill trees
 * from GitHub into standalone skill-instruction packages.
 *
 * Downloads are restricted to `raw.githubusercontent.com/{owner}/{repo}/...`
 * for the skill's declared repository. Repo-root walks are not attempted.
 */
export class SkillsShMarketplace implements SkillMarketplacePort {
  readonly #fetch: typeof globalThis.fetch;
  readonly #searchUrl: string;
  readonly #appVersion: string;
  readonly #platform: NodeJS.Platform;
  readonly #cache = new Map<
    string,
    {
      readonly owner: string;
      readonly repo: string;
      readonly skillId: string;
      readonly name: string;
    }
  >();

  constructor(options: SkillsShMarketplaceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#searchUrl = options.searchUrl ?? DEFAULT_SEARCH_URL;
    this.#appVersion = options.appVersion ?? "1.0.0";
    this.#platform = options.platform ?? process.platform;
  }

  async search(
    query: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly entries: ReadonlyArray<SkillMarketplaceEntry>;
    readonly nextCursor?: string;
  }> {
    return withMarketplaceRequest(signal, (boundedSignal) =>
      this.#search(query, cursor, boundedSignal),
    );
  }

  async #search(
    query: string,
    _cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    readonly entries: ReadonlyArray<SkillMarketplaceEntry>;
    readonly nextCursor?: string;
  }> {
    const trimmed = query.trim();
    if (trimmed === "") return { entries: [] };
    const url = new URL(this.#searchUrl);
    url.searchParams.set("q", trimmed);
    url.searchParams.set("limit", String(DEFAULT_LIMIT));
    const response = await this.#fetch(url.toString(), {
      headers: { accept: "application/json", "user-agent": MARKETPLACE_FETCH_USER_AGENT },
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new Error("skills.sh search is unavailable.");
    }
    const body = await parseBoundedJson<{ skills?: unknown }>(
      response,
      MAX_SEARCH_RESPONSE_BYTES,
      "skills.sh search response exceeds size limits.",
      "skills.sh search response is invalid.",
    );
    const hits = Array.isArray(body.skills) ? body.skills : [];
    const entries: SkillMarketplaceEntry[] = [];
    for (const hit of hits) {
      const parsed = parseHit(hit);
      if (parsed === undefined) continue;
      let entryId: string;
      try {
        entryId = encodeSkillCatalogEntryId(parsed);
      } catch {
        // Oversized / irreversible identities are skipped rather than hashed.
        continue;
      }
      const skillName = publicSkillName(parsed.skillId);
      if (skillName === undefined) continue;
      this.#cache.delete(entryId);
      this.#cache.set(entryId, parsed);
      while (this.#cache.size > MAX_IDENTITY_CACHE_ENTRIES) {
        const oldest = this.#cache.keys().next().value;
        if (oldest === undefined) break;
        this.#cache.delete(oldest);
      }
      const source = {
        kind: "catalog" as const,
        catalogId: SKILLS_SH_CATALOG_ID as never,
        entryId: entryId as never,
      };
      entries.push(
        skillSearchEntry({
          source,
          skillName,
          displayName: parsed.name,
          description: `skills.sh · ${parsed.owner}/${parsed.repo}`,
          publisher: parsed.owner,
          canonicalUrl: `https://skills.sh/${parsed.owner}/${parsed.repo}/${parsed.skillId}`,
        }),
      );
    }
    return { entries };
  }

  async resolve(source: ExtensionSource, signal?: AbortSignal): Promise<ResolvedExtensionPackage> {
    return withMarketplaceRequest(signal, (boundedSignal) => this.#resolve(source, boundedSignal));
  }

  async #resolve(source: ExtensionSource, signal: AbortSignal): Promise<ResolvedExtensionPackage> {
    if (source.kind !== "catalog" || source.catalogId !== SKILLS_SH_CATALOG_ID) {
      throw new Error("skills.sh marketplace cannot resolve this source.");
    }
    const cached = this.#cache.get(source.entryId);
    const decoded = cached ?? decodeSkillCatalogEntryId(source.entryId);
    if (decoded === undefined) {
      throw new Error("skills.sh skill identity is unavailable.");
    }
    const identity = {
      owner: decoded.owner,
      repo: decoded.repo,
      skillId: decoded.skillId,
      name: cached?.name ?? decoded.skillId,
    };
    // Search identity comes from skills.sh, but installable bytes must come
    // from the repository that receives the provenance attribution. A registry
    // snapshot hash is not an immutable GitHub revision or repository proof.
    const commit = await this.#resolveGithubCommit(identity.owner, identity.repo, signal);
    const files = await this.#fetchSkillTree(
      identity.owner,
      identity.repo,
      identity.skillId,
      commit,
      signal,
    );
    const packageLicense = await this.#fetchRepositoryLicense(
      identity.owner,
      identity.repo,
      commit,
      signal,
    ).catch(() => undefined);
    const skillMarkdown = files.find((file) => file.path === "SKILL.md");
    if (skillMarkdown === undefined) {
      throw new Error("skills.sh skill is missing SKILL.md.");
    }
    const markdown = new TextDecoder().decode(skillMarkdown.content);
    const extras = files
      .filter((file) => file.path !== "SKILL.md" && !file.path.endsWith("/SKILL.md"))
      .map((file) => ({
        path: file.path.replace(/^skills\/[^/]+\//, "").replace(/^\.\//, ""),
        content: file.content,
      }))
      .filter((file) => !isUnsafeSkillRelativePath(file.path));
    return buildStandaloneSkillPackage({
      source,
      slug: identity.skillId,
      displayName: identity.name,
      publisher: identity.owner,
      canonicalUrl: `https://github.com/${identity.owner}/${identity.repo}/tree/${commit}`,
      ...(packageLicense === undefined ? {} : { packageLicense }),
      skills: [
        {
          directoryName: identity.skillId,
          markdown,
          extraFiles: extras,
        },
      ],
      appVersion: this.#appVersion,
      platform: this.#platform,
    });
  }

  async #fetchRepositoryLicense(
    owner: string,
    repo: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.#fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/license?ref=${encodeURIComponent(commit)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": MARKETPLACE_FETCH_USER_AGENT,
        },
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok) throw new Error("GitHub license metadata is unavailable.");
    const payload = await parseBoundedJson<{ license?: { spdx_id?: unknown } }>(
      response,
      MAX_GITHUB_API_RESPONSE_BYTES,
      "GitHub license metadata exceeds size limits.",
      "GitHub license metadata is unavailable.",
    );
    const spdxId = payload.license?.spdx_id;
    if (
      typeof spdxId !== "string" ||
      spdxId.trim() === "" ||
      spdxId === "NOASSERTION" ||
      spdxId === "OTHER" ||
      !/^[A-Za-z0-9-.+]+$/.test(spdxId)
    ) {
      throw new Error("GitHub license metadata is unavailable.");
    }
    return spdxId;
  }

  async #resolveGithubCommit(owner: string, repo: string, signal?: AbortSignal): Promise<string> {
    const response = await this.#fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/HEAD`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": MARKETPLACE_FETCH_USER_AGENT,
        },
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok) throw new Error("GitHub skill revision is unavailable.");
    const payload = await parseBoundedJson<{ readonly sha?: unknown }>(
      response,
      MAX_GITHUB_API_RESPONSE_BYTES,
      "GitHub skill revision exceeds size limits.",
      "GitHub skill revision is invalid.",
    );
    if (typeof payload.sha !== "string" || !GITHUB_COMMIT_PATTERN.test(payload.sha)) {
      throw new Error("GitHub skill revision is invalid.");
    }
    return payload.sha.toLowerCase();
  }

  async #fetchSkillTree(
    owner: string,
    repo: string,
    skillId: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<{ readonly path: string; readonly content: Uint8Array }>> {
    // Do not walk the repository root — only skill-scoped paths.
    const candidates = [`skills/${skillId}`, skillId];
    for (const candidate of candidates) {
      const files = await this.#listGithubFiles(
        owner,
        repo,
        commit,
        candidate,
        candidate,
        { requests: 0, entries: 0 },
        0,
        signal,
      );
      if (files.some((file) => file.path === "SKILL.md")) {
        return files;
      }
    }
    const discovered = await this.#discoverGithubSkillRoot(owner, repo, skillId, commit, signal);
    if (discovered !== undefined) {
      const files = await this.#listGithubFiles(
        owner,
        repo,
        commit,
        discovered,
        discovered,
        { requests: 0, entries: 0 },
        0,
        signal,
      );
      if (files.some((file) => file.path === "SKILL.md")) {
        return files;
      }
    }
    throw new Error("skills.sh skill files could not be fetched.");
  }

  async #discoverGithubSkillRoot(
    owner: string,
    repo: string,
    skillId: string,
    commit: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const response = await this.#fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${commit}?recursive=1`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": MARKETPLACE_FETCH_USER_AGENT,
        },
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!response.ok) throw new Error("GitHub skill source is unavailable.");
    const payload = await parseBoundedJson<{
      readonly truncated?: unknown;
      readonly tree?: unknown;
    }>(
      response,
      MAX_GITHUB_API_RESPONSE_BYTES,
      "GitHub skill source exceeds size limits.",
      "GitHub skill source is invalid.",
    );
    if (
      payload.truncated === true ||
      !Array.isArray(payload.tree) ||
      payload.tree.length > MAX_GITHUB_TREE_ENTRIES
    ) {
      throw new Error("GitHub skill source exceeds discovery limits.");
    }
    const candidates = payload.tree
      .flatMap((entry) => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          (entry as { type?: unknown }).type !== "blob" ||
          typeof (entry as { path?: unknown }).path !== "string"
        ) {
          return [];
        }
        const path = (entry as { path: string }).path;
        const size = (entry as { size?: unknown }).size;
        if (
          isUnsafeSkillRelativePath(path) ||
          !path.endsWith("/SKILL.md") ||
          (typeof size === "number" && size > MAX_FILE_BYTES) ||
          path.split("/").length > MAX_GITHUB_TRAVERSAL_DEPTH + 1
        ) {
          return [];
        }
        return [{ path }];
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    if (candidates.length > MAX_GITHUB_TRAVERSAL_REQUESTS) {
      throw new Error("GitHub skill source exceeds discovery limits.");
    }
    for (const candidate of candidates) {
      const { path } = candidate;
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      try {
        const content = await this.#download(
          `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${encodedPath}`,
          owner,
          repo,
          signal,
        );
        const directory = path.split("/").at(-2) ?? skillId;
        const parsed = parseSkillMarkdown(
          new TextDecoder("utf-8", { fatal: true }).decode(content),
          directory,
          "unreported",
        );
        if (parsed.name === skillId) {
          return path.slice(0, -"/SKILL.md".length);
        }
      } catch {
        // Invalid sibling skills cannot prevent discovery of a valid match.
      }
    }
    return undefined;
  }

  async #listGithubFiles(
    owner: string,
    repo: string,
    commit: string,
    path: string,
    rootPath: string,
    traversal: { requests: number; entries: number },
    depth = 0,
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; content: Uint8Array }>> {
    if (path === "" || isUnsafeSkillRelativePath(path)) {
      return [];
    }
    traversal.requests += 1;
    if (depth > MAX_GITHUB_TRAVERSAL_DEPTH || traversal.requests > MAX_GITHUB_TRAVERSAL_REQUESTS) {
      throw new Error("Skill package exceeds the traversal limit.");
    }
    const apiPath = `/${path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await this.#fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${apiPath}?ref=${encodeURIComponent(commit)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": MARKETPLACE_FETCH_USER_AGENT,
        },
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (response.status === 404) return [];
    if (!response.ok) throw new Error("GitHub skill source is unavailable.");
    const payload = await parseBoundedJson<unknown>(
      response,
      MAX_GITHUB_API_RESPONSE_BYTES,
      "GitHub skill source exceeds size limits.",
      "GitHub skill source is invalid.",
    );
    if (Array.isArray(payload)) {
      traversal.entries += payload.length;
      if (traversal.entries > MAX_GITHUB_TRAVERSAL_ENTRIES) {
        throw new Error("Skill package exceeds the traversal limit.");
      }
      const files: Array<{ path: string; content: Uint8Array }> = [];
      let total = 0;
      for (const entry of payload) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          typeof (entry as { type?: unknown }).type !== "string" ||
          typeof (entry as { name?: unknown }).name !== "string" ||
          typeof (entry as { path?: unknown }).path !== "string"
        ) {
          continue;
        }
        const item = entry as {
          type: string;
          name: string;
          path: string;
          download_url?: string | null;
          size?: number;
        };
        if (item.type === "dir") {
          if (isUnsafeSkillRelativePath(item.path)) continue;
          const nested = await this.#listGithubFiles(
            owner,
            repo,
            commit,
            item.path,
            rootPath,
            traversal,
            depth + 1,
            signal,
          );
          for (const file of nested) {
            total += file.content.byteLength;
            if (total > MAX_TOTAL_BYTES) throw new Error("Skill package exceeds size limits.");
            files.push(file);
          }
          continue;
        }
        if (item.type !== "file") continue;
        if ((item.size ?? 0) > MAX_FILE_BYTES) {
          throw new Error("Skill file exceeds size limits.");
        }
        if (
          item.download_url !== undefined &&
          item.download_url !== null &&
          (typeof item.download_url !== "string" ||
            !isAllowedGithubRawUrl(item.download_url, owner, repo))
        ) {
          throw new Error("Skill download host is not allowed.");
        }
        const content = await this.#download(
          githubRawUrl(owner, repo, commit, item.path),
          owner,
          repo,
          signal,
        );
        total += content.byteLength;
        if (total > MAX_TOTAL_BYTES) throw new Error("Skill package exceeds size limits.");
        const relative =
          item.path === rootPath
            ? item.name
            : item.path.startsWith(`${rootPath}/`)
              ? item.path.slice(rootPath.length + 1)
              : item.name;
        if (isUnsafeSkillRelativePath(relative)) {
          throw new Error("Skill package contains an unsafe path.");
        }
        files.push({ path: relative, content });
      }
      return files;
    }
    if (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { type?: unknown }).type === "file" &&
      typeof (payload as { name?: unknown }).name === "string" &&
      typeof (payload as { path?: unknown }).path === "string"
    ) {
      const file = payload as {
        name: string;
        path: string;
        download_url?: string | null;
        size?: number;
      };
      if (file.name !== "SKILL.md") return [];
      if ((file.size ?? 0) > MAX_FILE_BYTES) {
        throw new Error("Skill file exceeds size limits.");
      }
      if (
        file.download_url !== undefined &&
        file.download_url !== null &&
        !isAllowedGithubRawUrl(file.download_url, owner, repo)
      ) {
        throw new Error("Skill download host is not allowed.");
      }
      return [
        {
          path: "SKILL.md",
          content: await this.#download(
            githubRawUrl(owner, repo, commit, file.path),
            owner,
            repo,
            signal,
          ),
        },
      ];
    }
    return [];
  }

  async #download(
    url: string,
    owner: string,
    repo: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!isAllowedGithubRawUrl(url, owner, repo)) {
      throw new Error("Skill download host is not allowed.");
    }
    const response = await this.#fetch(url, {
      headers: { "user-agent": MARKETPLACE_FETCH_USER_AGENT },
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new Error("Skill file download failed.");
    return readBoundedResponseBody(response, MAX_FILE_BYTES, "Skill file exceeds size limits.");
  }
}

function githubRawUrl(owner: string, repo: string, commit: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${encodedPath}`;
}

async function parseBoundedJson<T>(
  response: Response,
  maximumBytes: number,
  oversizeMessage: string,
  invalidMessage: string,
): Promise<T> {
  const body = await readBoundedResponseBody(response, maximumBytes, oversizeMessage);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as T;
  } catch {
    throw new Error(invalidMessage);
  }
}

export function isAllowedGithubRawUrl(url: string, owner: string, repo: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname.toLowerCase() !== GITHUB_RAW_HOST) return false;
  if (parsed.username || parsed.password) return false;
  const expectedPrefix = `/${owner}/${repo}/`;
  if (!parsed.pathname.startsWith(expectedPrefix)) return false;
  if (parsed.pathname.includes("..") || parsed.pathname.includes("//")) return false;
  return true;
}

function parseHit(value: unknown):
  | {
      readonly owner: string;
      readonly repo: string;
      readonly skillId: string;
      readonly name: string;
    }
  | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const hit = value as SkillsShSearchHit;
  if (
    typeof hit.id !== "string" ||
    typeof hit.skillId !== "string" ||
    typeof hit.name !== "string" ||
    typeof hit.source !== "string"
  ) {
    return undefined;
  }
  const cleaned = hit.source
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const sourceParts = cleaned.split("/");
  if (sourceParts.length !== 2) return undefined;
  const [owner, repo] = sourceParts;
  if (!owner || !repo) return undefined;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
  return { owner, repo, skillId: hit.skillId, name: hit.name };
}

function publicSkillName(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) && normalized.length <= 64
    ? normalized
    : undefined;
}

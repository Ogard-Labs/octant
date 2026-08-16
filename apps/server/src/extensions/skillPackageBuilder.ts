import { createHash } from "node:crypto";
import type { ExtensionSource } from "@octant/contracts/extensions";
import type { SkillMarketplaceEntry } from "@octant/contracts/extension-rpc";
import { parse as parseYaml } from "yaml";
import {
  calculateExtensionPackageDigest,
  type ExtensionArchiveEntry,
  type ResolvedExtensionPackage,
} from "./packageInspector";

const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export const SKILLS_SH_CATALOG_ID = "skills-sh";
export const NPM_SKILLS_CATALOG_ID = "npm";

export interface ParsedSkillMarkdown {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly license: string;
}

/**
 * Encode owner/repo/skillId into an ExtensionCatalogEntryId-safe token.
 * Uses reversible, lowercase base32 so distinct GitHub identities cannot
 * collide after punctuation normalization while ordinary identities fit the
 * 96-character catalog contract. Oversized identities are rejected.
 *
 * Format: `s` + base32(utf8(`owner\nrepo\nskillId`))
 */
export function encodeSkillCatalogEntryId(parts: {
  readonly owner: string;
  readonly repo: string;
  readonly skillId: string;
}): string {
  for (const part of [parts.owner, parts.repo, parts.skillId]) {
    if (typeof part !== "string" || part.trim() === "" || part.includes("\n")) {
      throw new Error("skills.sh skill identity is invalid.");
    }
  }
  const payload = `${parts.owner}\n${parts.repo}\n${parts.skillId}`;
  const id = `s${encodeCompactCatalogIdentity(payload)}`;
  if (id.length > 96 || !/^[a-z][a-z0-9]*$/.test(id)) {
    throw new Error("skills.sh skill identity is too long for catalog identity.");
  }
  return id;
}

export function decodeSkillCatalogEntryId(
  entryId: string,
): { readonly owner: string; readonly repo: string; readonly skillId: string } | undefined {
  if (!/^s[a-z2-7]+$/.test(entryId)) return undefined;
  let decoded: string;
  try {
    decoded = decodeCompactCatalogIdentity(entryId.slice(1)) ?? "";
    if (`s${encodeCompactCatalogIdentity(decoded)}` !== entryId) return undefined;
  } catch {
    return undefined;
  }
  const parts = decoded.split("\n");
  if (parts.length !== 3) return undefined;
  const [owner, repo, skillId] = parts;
  if (!owner || !repo || !skillId) return undefined;
  if (![owner, repo, skillId].every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) {
    return undefined;
  }
  return { owner, repo, skillId };
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function encodeCompactCatalogIdentity(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function decodeCompactCatalogIdentity(value: string): string | undefined {
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) return undefined;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    return undefined;
  }
  const decoded = Buffer.from(output).toString("utf8");
  return encodeCompactCatalogIdentity(decoded) === value ? decoded : undefined;
}

export function isUnsafeSkillRelativePath(path: string): boolean {
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

export function parseSkillMarkdown(
  content: string,
  fallbackName: string,
  fallbackLicense?: string,
): ParsedSkillMarkdown {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (match === null) {
    throw new Error("Skill document must begin with YAML frontmatter.");
  }
  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const metadata = parseSkillFrontmatter(frontmatter);
  const name = readFrontmatterString(metadata, "name") ?? fallbackName;
  const description = readFrontmatterString(metadata, "description");
  const license = readFrontmatterString(metadata, "license") ?? fallbackLicense;
  if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error("Skill name is invalid.");
  }
  if (description === undefined || description.trim() === "") {
    throw new Error("Skill description is required.");
  }
  if (license === undefined || license.trim() === "") {
    throw new Error("Skill license metadata is required.");
  }
  return {
    name,
    description: description.slice(0, 2048),
    body,
    license: license.slice(0, 256),
  };
}

export function buildStandaloneSkillPackage(input: {
  readonly source: ExtensionSource;
  /** Stable lifecycle identity when resolution metadata pins an immutable release. */
  readonly lifecycleSource?: ExtensionSource;
  readonly slug: string;
  readonly displayName: string;
  readonly version?: string;
  readonly publisher?: string;
  readonly canonicalUrl?: string;
  readonly packageLicense?: string;
  readonly skills: ReadonlyArray<{
    readonly directoryName: string;
    readonly markdown: string;
    readonly extraFiles?: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array }>;
  }>;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
}): ResolvedExtensionPackage {
  const entries: ExtensionArchiveEntry[] = [{ path: "skills", kind: "directory" }];
  const components: Array<Record<string, unknown>> = [];
  let license: { kind: "spdx"; identifier: string } | { kind: "custom"; label: string } | undefined;

  for (const skill of input.skills) {
    const parsed = parseSkillMarkdown(skill.markdown, skill.directoryName, input.packageLicense);
    const componentId = skillComponentId(parsed.name);
    const skillDir = `skills/${parsed.name}`;
    const skillPath = `${skillDir}/SKILL.md`;
    entries.push({ path: skillDir, kind: "directory" });
    entries.push({
      path: skillPath,
      kind: "file",
      content: new TextEncoder().encode(skill.markdown),
    });
    for (const extra of skill.extraFiles ?? []) {
      const relative = extra.path.replace(/^\/+/, "");
      if (isUnsafeSkillRelativePath(relative)) continue;
      entries.push({
        path: `${skillDir}/${relative}`,
        kind: "file",
        content: extra.content,
      });
    }
    components.push({
      id: componentId,
      kind: "skill-instructions",
      skillName: parsed.name,
      displayName: parsed.name,
      description: parsed.description,
      declaredCapabilities: ["instructions"],
      contentReference: skillPath,
    });
    if (license === undefined) {
      license = /^[A-Za-z0-9-.+]+$/.test(parsed.license)
        ? { kind: "spdx", identifier: parsed.license }
        : { kind: "custom", label: parsed.license.slice(0, 256) };
    }
  }

  if (components.length === 0) {
    throw new Error("Skill package does not contain any skills.");
  }
  if (license === undefined) {
    throw new Error("Skill license metadata is required.");
  }

  const lifecycleSource = input.lifecycleSource ?? input.source;
  const extensionId = stableUuid(`skill-extension:${sourceKey(lifecycleSource)}`);
  const packageId = stableUuid(`skill-package:${sourceKey(lifecycleSource)}`);
  const version = input.version !== undefined && semverOk(input.version) ? input.version : "0.0.0";
  if (input.canonicalUrl === undefined || input.publisher === undefined) {
    throw new Error("Skill provenance metadata is required.");
  }
  const manifestInput = {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: extensionSlug(input.slug),
    displayName: input.displayName.slice(0, 128),
    version,
    digest: `sha256:${"0".repeat(64)}`,
    source: input.source,
    provenance: {
      canonicalUrl: input.canonicalUrl,
      publisher: input.publisher.slice(0, 256),
      reviewed: false,
    },
    license,
    compatibility: {
      platforms: ["macos", "linux", "windows"],
      modes: ["chat", "work", "code"],
      providerFamilies: [],
    },
    declaredCapabilities: ["instructions"],
    components,
  };
  const digest = calculateExtensionPackageDigest(manifestInput, entries);
  const manifest = { ...manifestInput, digest };
  return {
    format: "directory",
    archiveBytes: entries.reduce((total, entry) => total + (entry.content?.byteLength ?? 0), 0),
    manifest,
    entries,
    expectedDigest: digest,
    appVersion: input.appVersion,
    platform: input.platform,
  };
}

function skillComponentId(name: string): string {
  if (/^[a-z]/.test(name)) return name;
  return `skill-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

function extensionSlug(slug: string): string {
  if (/^[a-z][a-z0-9-]{0,63}$/.test(slug)) return slug;
  return `skill-${createHash("sha256").update(slug).digest("hex").slice(0, 16)}`;
}

export function provisionalSkillDigest(seed: string): `sha256:${string}` {
  const hex = createHash("sha256").update(`octant.skill-provisional:${seed}`).digest("hex");
  return `sha256:${hex}`;
}

export function skillSearchEntry(input: {
  readonly source: Extract<ExtensionSource, { readonly kind: "catalog" }>;
  readonly skillName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly publisher?: string;
  readonly canonicalUrl?: string;
  readonly version?: string;
}): SkillMarketplaceEntry {
  const digest = provisionalSkillDigest(`${input.source.catalogId}:${input.source.entryId}`);
  return {
    skill: {
      qualifiedId:
        `catalog:${input.source.catalogId}~${input.source.entryId}:${input.skillName}:${digest}` as never,
      name: input.skillName as never,
      sourceKind: "catalog",
      digest: digest as never,
      available: true,
    },
    source: input.source,
    version: (input.version !== undefined && semverOk(input.version)
      ? input.version
      : "0.0.0") as never,
    displayName: input.displayName.slice(0, 128),
    ...(input.description === undefined ? {} : { description: input.description.slice(0, 2048) }),
    provenance: {
      ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: input.canonicalUrl }),
      ...(input.publisher === undefined ? {} : { publisher: input.publisher.slice(0, 256) }),
      reviewed: false,
    },
  };
}

function parseSkillFrontmatter(frontmatter: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter, { maxAliasCount: 0 });
  } catch {
    throw new Error("Skill frontmatter must be valid YAML.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Skill frontmatter must be a YAML mapping.");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function readFrontmatterString(metadata: Readonly<Record<string, unknown>>, key: string) {
  const raw = metadata[key];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length === 0 ? undefined : value;
}

function sourceKey(source: ExtensionSource): string {
  return source.kind === "catalog"
    ? `catalog:${source.catalogId}:${source.entryId}`
    : `${source.kind}:${source.sourceRef}`;
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function semverOk(version: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    version,
  );
}

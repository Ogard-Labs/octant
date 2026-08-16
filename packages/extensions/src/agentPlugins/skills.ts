import type { AgentPluginsDiagnostic } from "./constants";
import { parse } from "yaml";

const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface AgentPluginsPackageEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "hardlink" | "other";
  readonly content?: Uint8Array;
  readonly linkTarget?: string;
}

export interface DiscoveredAgentSkill {
  readonly name: string;
  readonly directory: string;
  readonly skillMdPath: string;
  readonly description: string;
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

export interface SkillDiscoveryResult {
  readonly skills: ReadonlyArray<DiscoveredAgentSkill>;
  readonly diagnostics: ReadonlyArray<AgentPluginsDiagnostic>;
  /** True when skills/ exists but is not a directory (component type invalid). */
  readonly componentInvalid: boolean;
}

/**
 * Discover skills from the fixed `skills/` location.
 * Immediate children with a regular SKILL.md are candidates. Invalid skills are
 * skipped. Missing skills/ is valid absence. Wrong filesystem kind invalidates
 * only the skills component type.
 */
export function discoverAgentPluginSkills(
  entries: ReadonlyArray<AgentPluginsPackageEntry>,
): SkillDiscoveryResult {
  const diagnostics: AgentPluginsDiagnostic[] = [];
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  const skillsDir = byPath.get("skills");
  const hasSkillsPrefix = entries.some(
    (entry) => entry.path === "skills" || entry.path.startsWith("skills/"),
  );

  if (!hasSkillsPrefix) {
    return { skills: [], diagnostics, componentInvalid: false };
  }

  // If an explicit `skills` entry exists and is not a directory, component invalid.
  if (skillsDir !== undefined && skillsDir.kind !== "directory") {
    // Allow a missing directory entry when children exist (archives often omit dirs).
    if (
      skillsDir.kind !== "file" &&
      skillsDir.kind !== "symlink" &&
      skillsDir.kind !== "hardlink"
    ) {
      // "other" still invalid
    }
    if (
      skillsDir.kind === "file" ||
      skillsDir.kind === "symlink" ||
      skillsDir.kind === "hardlink"
    ) {
      diagnostics.push({
        code: "skills-location-invalid",
        severity: "error",
        message: "skills/ exists but is not a directory; skills component type is invalid.",
        path: "skills",
      });
      return { skills: [], diagnostics, componentInvalid: true };
    }
  }

  // Collect immediate child directory names that have skills/<name>/SKILL.md
  const candidates = new Map<string, AgentPluginsPackageEntry>();
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.path.startsWith("skills/")) continue;
    const rest = entry.path.slice("skills/".length);
    const parts = rest.split("/");
    if (parts.length !== 2 || parts[1] !== "SKILL.md") continue;
    const name = parts[0]!;
    if (name.length === 0 || name === "." || name === "..") continue;
    candidates.set(name, entry);
  }

  const skills: DiscoveredAgentSkill[] = [];
  for (const [directoryName, entry] of [...candidates.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    try {
      if (entry.content === undefined) {
        throw new Error("SKILL.md content is missing.");
      }
      // Symlink SKILL.md is not a regular file for discovery purposes when kind is symlink.
      if (entry.kind !== "file") {
        throw new Error("SKILL.md must be a regular file.");
      }
      const text = new TextDecoder().decode(entry.content);
      const parsed = parseSkillMd(text, directoryName);
      skills.push({
        name: parsed.name,
        directory: directoryName,
        skillMdPath: entry.path,
        description: parsed.description,
        body: parsed.body,
        frontmatter: parsed.frontmatter,
      });
    } catch (error) {
      diagnostics.push({
        code: "skill-skipped",
        severity: "warning",
        message:
          error instanceof Error
            ? `Skipping skill "${directoryName}": ${error.message}`
            : `Skipping skill "${directoryName}".`,
        path: entry.path,
      });
    }
  }

  return { skills, diagnostics, componentInvalid: false };
}

function parseSkillMd(
  text: string,
  directoryName: string,
): {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new Error("SKILL.md must begin with YAML frontmatter.");
  }
  const frontmatter = parseYamlFrontmatter(match[1]!);
  const body = match[2] ?? "";

  const name = frontmatter.name;
  if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error("SKILL.md name is invalid.");
  }
  if (name !== directoryName) {
    throw new Error("SKILL.md name must match the parent directory name.");
  }
  const description = frontmatter.description;
  if (typeof description !== "string" || description.length < 1 || description.length > 1024) {
    throw new Error("SKILL.md description is invalid.");
  }
  return { name, description, body, frontmatter };
}

function parseYamlFrontmatter(source: string): Record<string, unknown> {
  const value = parse(source, { maxAliasCount: 0, prettyErrors: false });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("SKILL.md frontmatter must be a YAML map.");
  }
  return value as Record<string, unknown>;
}

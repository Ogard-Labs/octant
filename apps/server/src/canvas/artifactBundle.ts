import type { CanvasDefinition, CanvasVersion } from "@octant/contracts/canvas";
import { MAX_ARTIFACT_BUNDLE_BYTES } from "@octant/contracts/artifact-mirror";
import { escapeXml, renderArtifactSidecarSvg } from "./artifactRender";

/**
 * The files one artifact becomes.
 *
 * The bundle is the artifact in a form another tool can read; the sidecars are
 * the artifact in a form a person can read. None of them is the artifact — that
 * is the journal — and none of them is ever read back without being asked for.
 *
 * Diff-friendliness is a property of the writing, not a happy accident: keys go
 * out in a fixed order, indentation is stable, and the file ends with a
 * newline, so a revision that changed one sentence shows one changed line.
 */

export const ARTIFACT_BUNDLE_FORMAT = "octant.artifact-bundle/1" as const;

export interface ArtifactBundleFiles {
  readonly bundle: string;
  readonly markdown: string;
  readonly svg: string;
}

export interface ArtifactBundleHeader {
  readonly format: typeof ARTIFACT_BUNDLE_FORMAT;
  readonly canvasId: string;
  readonly versionId: string;
  readonly sequence: number;
  readonly title: string;
  readonly mode: string;
  readonly projectId: string;
  readonly hostId: string;
  readonly createdAt: string;
}

/**
 * Build the files for one version.
 *
 * The header repeats identity the definition already carries. That redundancy
 * is the point: a file that travels somewhere else still says which artifact,
 * which version, and which host it came from, and the re-import path checks it
 * before believing a word of the rest.
 */
export function buildArtifactBundle(version: CanvasVersion): ArtifactBundleFiles {
  const provenance = version.definition.provenance;
  const header: ArtifactBundleHeader = {
    format: ARTIFACT_BUNDLE_FORMAT,
    canvasId: String(version.canvasId),
    versionId: String(version.versionId),
    sequence: version.sequence,
    title: version.definition.title,
    mode: provenance.mode,
    projectId: String(provenance.projectId),
    hostId: String(provenance.hostId),
    createdAt: String(version.createdAt),
  };
  return {
    bundle: `${JSON.stringify({ octant: header, definition: version.definition }, null, 2)}\n`,
    markdown: buildMarkdown(header, version.definition),
    svg: renderArtifactSidecarSvg(version.definition),
  };
}

/**
 * What a bundle file says it is.
 *
 * Returns nothing for anything that is not a well-formed bundle of the expected
 * format — a truncated file, another tool's JSON, or a bundle from a version of
 * the format this host does not know. A caller that gets `undefined` refuses;
 * it never falls back to guessing.
 */
export function readArtifactBundle(
  text: string,
): { readonly header: ArtifactBundleHeader; readonly definition: unknown } | undefined {
  if (Buffer.byteLength(text, "utf8") > MAX_ARTIFACT_BUNDLE_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const octant = (parsed as { readonly octant?: unknown }).octant;
  const definition = (parsed as { readonly definition?: unknown }).definition;
  if (typeof octant !== "object" || octant === null || definition === undefined) return undefined;
  const header = octant as Partial<ArtifactBundleHeader>;
  if (
    header.format !== ARTIFACT_BUNDLE_FORMAT ||
    typeof header.canvasId !== "string" ||
    typeof header.versionId !== "string"
  ) {
    return undefined;
  }
  return { header: header as ArtifactBundleHeader, definition };
}

/**
 * The readable sidecar.
 *
 * Front matter carries the identity, so a Markdown tool that understands it can
 * still trace the file home, and one that does not simply shows a header block.
 * The body is a plain reading of the blocks — it is not round-trippable, and it
 * does not pretend to be: the bundle is what re-import reads.
 */
function buildMarkdown(header: ArtifactBundleHeader, definition: CanvasDefinition): string {
  const frontMatter = [
    "---",
    `octant_format: ${ARTIFACT_BUNDLE_FORMAT}`,
    `canvas_id: ${header.canvasId}`,
    `version_id: ${header.versionId}`,
    `sequence: ${String(header.sequence)}`,
    `mode: ${header.mode}`,
    `project_id: ${header.projectId}`,
    `created_at: ${header.createdAt}`,
    `title: ${quoteYaml(header.title)}`,
    "---",
    "",
  ];
  const body = definition.blocks.flatMap((block) => {
    switch (block.kind) {
      case "heading":
        return [`${"#".repeat(Math.min(6, block.level + 1))} ${block.text}`, ""];
      case "rich-text":
        return [block.text, ""];
      case "summary":
        return [
          `**${block.title}**`,
          "",
          ...block.items.map((item) => `- ${summaryItemText(item)}`),
          "",
        ];
      case "callout":
        return [`> ${block.text.replaceAll("\n", "\n> ")}`, ""];
      case "code-excerpt":
        return ["```" + String(block.language), block.code, "```", ""];
      case "pseudocode":
        return ["```", block.code, "```", ""];
      case "metric":
        return [`- **${block.label}:** ${String(block.value)}`, ""];
      case "status":
        return [`- **${block.label}:** ${block.value}`, ""];
      case "link":
        return [`- [${block.label}](${block.href})`, ""];
      default:
        // A block this sidecar cannot write is named rather than dropped, so
        // the file never quietly claims to be the whole document.
        return [`_(${block.kind} — see the bundle)_`, ""];
    }
  });
  return [
    ...frontMatter,
    `# ${definition.title}`,
    "",
    ...body,
    "<!-- Written by Octant. The artifact lives in Octant's journal; editing this",
    "file changes nothing until you import it, which adds a new version. -->",
    "",
  ].join("\n");
}

/** One summary row, however this block shape names its text. */
function summaryItemText(item: Readonly<Record<string, unknown>>): string {
  const label = typeof item["label"] === "string" ? item["label"] : undefined;
  const value = typeof item["value"] === "string" ? item["value"] : undefined;
  if (label !== undefined && value !== undefined) return `**${label}:** ${value}`;
  return label ?? value ?? "";
}

function quoteYaml(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ")}"`;
}

/** Re-exported so a caller escaping artifact text has one place to get it. */
export { escapeXml };

// Both the host anchor validator and the renderer use the same hunk/line map.
export {
  parseUnifiedDiff,
  diffSourceLines,
  diffModelRowSources,
  type DiffFileChange,
  type DiffLineKind,
  type DiffLine,
  type DiffHunk,
  type ParsedDiffFile,
} from "@octant/domain";

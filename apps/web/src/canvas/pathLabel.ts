export interface PathLabelParts {
  /** The directory, including its trailing separator, or undefined for a bare name. */
  readonly directory: string | undefined;
  /** The file name at full ink. */
  readonly name: string;
}

/**
 * Splits a file label into the part that locates it and the part that names it.
 *
 * A path is read from the right: the file name is what identifies the file and
 * the directory is context, so the name keeps full ink and the directory is
 * dimmed. Both separators are accepted because a Canvas may show a Windows
 * path on a Windows host; the leading run of the label only counts as a
 * directory when a separator follows it.
 */
export function splitPathLabel(label: string): PathLabelParts {
  const trimmed = label.trim();
  if (trimmed.length === 0) return { directory: undefined, name: label };
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator <= 0 || separator === trimmed.length - 1) {
    return { directory: undefined, name: trimmed };
  }
  return {
    directory: trimmed.slice(0, separator + 1),
    name: trimmed.slice(separator + 1),
  };
}

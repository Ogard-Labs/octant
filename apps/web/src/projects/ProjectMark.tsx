import { Folder } from "lucide-react";
import type { CSSProperties } from "react";
import { ProjectIcon } from "./ProjectIcon";

/**
 * The two letters a Project's mark carries: the first letters of its first two
 * words, or the first two letters of a single word, in capitals. A name with no
 * letters at all yields none, and the mark draws a folder instead.
 */
export function projectMarkInitials(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) => [...word]);
  const first = words[0];
  if (first === undefined) return "";
  const second = words[1];
  const letters = second === undefined ? first.slice(0, 2) : [first[0] ?? "", second[0] ?? ""];
  return letters.join("").toLocaleUpperCase();
}

/** A stable hue in degrees for a Project: the same Project is the same colour on every row. */
export function projectMarkHue(key: string): number {
  let hash = 2166136261;
  for (const char of key) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  }
  return (hash >>> 0) % 360;
}

/**
 * A Project's mark on a row: its own icon when the host found one in the
 * folder, otherwise two initials on a small rounded square whose colour is
 * derived from the Project, so a Project is recognised across rows without
 * reading its name. A thread with no Project gets a neutral folder. The mark is
 * decoration; the Project's name is always beside it.
 */
export function ProjectMark(props: { readonly name: string; readonly projectId?: string }) {
  const initials = projectMarkInitials(props.name);
  const neutral = (
    <span aria-hidden="true" className="project-mark" data-neutral="true">
      <Folder aria-hidden="true" size={12} />
    </span>
  );
  if (props.projectId === undefined || initials === "") return neutral;
  const lettered = (
    <span
      aria-hidden="true"
      className="project-mark"
      style={{ "--project-mark-hue": projectMarkHue(props.projectId) } as CSSProperties}
    >
      <span className="project-mark__letters">{initials}</span>
    </span>
  );
  return <ProjectIcon fallback={lettered} projectId={props.projectId} size={16} />;
}

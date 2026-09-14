/**
 * File-name presentation shared by the Files dock tools.
 *
 * A dock 320px wide cannot show a whole nested file name, and an end ellipsis
 * cuts off the extension — the one part of a file name a person reads first.
 * The name is split into a head and a tail so CSS can let the head yield to an
 * ellipsis while the tail stays whole.
 */

export function splitFileNameTail(name: string): {
  readonly head: string;
  readonly tail: string;
} {
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file's name, not an extension, and a trailing
  // dot names nothing; both keep one part and truncate at the end.
  if (dot <= 0 || dot === name.length - 1) return { head: name, tail: "" };
  return { head: name.slice(0, dot), tail: name.slice(dot) };
}

export function pathBasename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function pathParent(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, -1).join("/");
}

/**
 * A file or folder name that keeps its beginning and its extension visible
 * while the middle yields to an ellipsis. The whole name stays in the DOM, so
 * copying and assistive technology still read it; the owning row carries the
 * full path as its accessible label and hover title.
 */
export function FileName(props: {
  readonly className?: string | undefined;
  readonly name: string;
}) {
  const { head, tail } = splitFileNameTail(props.name);
  return (
    <span className={props.className === undefined ? "file-name" : `file-name ${props.className}`}>
      <span className="file-name__head">{head}</span>
      {tail === "" ? null : <span className="file-name__tail">{tail}</span>}
    </span>
  );
}

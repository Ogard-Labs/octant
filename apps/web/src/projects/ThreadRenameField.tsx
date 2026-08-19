import { useEffect, useRef, useState } from "react";
import { OctantInput } from "../ui/base/OctantInput";

/**
 * The rename field for one thread.
 *
 * Enter commits and Escape abandons, and a blank title is abandoned rather than
 * committed — a thread with no name is harder to find than one still carrying
 * the name Octant gave it.
 *
 * Both thread lists rename in place, so the field lives beside the rows rather
 * than inside either one of them.
 */
export function ThreadRenameField(props: {
  readonly label?: string;
  readonly title: string;
  readonly onRename: (title: string) => void;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState(props.title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  const commit = (): void => {
    const next = value.trim();
    if (next === "" || next === props.title) {
      props.onCancel();
      return;
    }
    props.onRename(next);
  };
  return (
    <OctantInput
      aria-label={props.label ?? "Rename thread"}
      autoFocus
      className="sidebar-navigation__thread-rename"
      onBlur={commit}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        }
      }}
      ref={inputRef}
      value={value}
    />
  );
}

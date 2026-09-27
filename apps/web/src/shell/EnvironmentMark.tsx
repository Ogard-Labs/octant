import { Cloud, Laptop } from "lucide-react";

export interface EnvironmentMarkProps {
  readonly kind: "local" | "remote";
  /** The remote host's name, when this window knows it. */
  readonly label?: string;
}

/**
 * Where a thread runs, as the small tile that leads its pane's title. The
 * tile, not the glyph, is the mark: a later per-environment icon replaces the
 * glyph inside it and keeps the size, name, and place.
 */
export function EnvironmentMark(props: EnvironmentMarkProps) {
  const name =
    props.kind === "local" ? "Runs on this computer" : `Runs on ${props.label ?? "a remote host"}`;
  const Glyph = props.kind === "local" ? Laptop : Cloud;
  return (
    <span aria-label={name} className="environment-mark" role="img" title={name}>
      <Glyph aria-hidden="true" size={14} strokeWidth={1.8} />
    </span>
  );
}

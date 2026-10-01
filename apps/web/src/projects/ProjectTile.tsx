import type { ProjectColor } from "@octant/contracts/projects";
import type { OctantMenuItem } from "../ui/base/OctantMenu";

/**
 * Menu value for "no colour". A colour is optional on the Project, so the menu
 * needs a choice that clears it; no palette role can share the name.
 */
export const NO_PROJECT_COLOR = "none";

const PROJECT_COLOR_LABELS: Readonly<Record<ProjectColor, string>> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
};

const PROJECT_COLORS: ReadonlyArray<ProjectColor> = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
];

/** Menu value for a Project's colour, and the inverse for a value picked from a menu. */
export function projectColorMenuValue(color: ProjectColor | undefined): string {
  return color ?? NO_PROJECT_COLOR;
}

export function projectColorFromMenuValue(value: string): ProjectColor | null | undefined {
  if (value === NO_PROJECT_COLOR) return null;
  return PROJECT_COLORS.find((candidate) => candidate === value);
}

/** The colour dot is the existing view-colour hook, so a swatch follows the theme palette. */
function ColorDot(props: { readonly color?: ProjectColor }) {
  return (
    <span
      aria-hidden="true"
      className="project-tile__dot"
      {...(props.color === undefined ? {} : { "data-view-color": props.color })}
    />
  );
}

export const PROJECT_COLOR_MENU_ITEMS: ReadonlyArray<OctantMenuItem> = [
  { icon: <ColorDot />, label: "No colour", value: NO_PROJECT_COLOR },
  ...PROJECT_COLORS.map((color) => ({
    icon: <ColorDot color={color} />,
    label: PROJECT_COLOR_LABELS[color],
    value: color,
  })),
];

/**
 * A Project's identity: its first letter on a tile filled with the colour the
 * person picked, or a neutral tile when they have not picked one. The colour
 * says which Project this is; it never carries status.
 */
export function ProjectTile(props: {
  readonly project: { readonly color?: ProjectColor | undefined; readonly name: string };
}) {
  const initial = Array.from(props.project.name.trim())[0]?.toLocaleUpperCase() ?? "";
  return (
    <span
      aria-hidden="true"
      className="project-tile"
      data-project-color={props.project.color ?? "none"}
      {...(props.project.color === undefined ? {} : { "data-view-color": props.project.color })}
    >
      {initial}
    </span>
  );
}

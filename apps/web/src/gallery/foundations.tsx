import { Check, ChevronDown, Folder, GitBranch, Search } from "lucide-react";
import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Section, Specimen } from "./Specimen";

/** What an element measures in the browser, read after paint so a label cannot drift from it. */
function useComputed(read: (style: CSSStyleDeclaration) => string, key: unknown) {
  const [element, setElement] = useState<Element | null>(null);
  const [text, setText] = useState("");
  useLayoutEffect(() => {
    if (element !== null) setText(read(getComputedStyle(element)));
    // `read` is a module-level function at each call site; `key` re-reads on a mode or size change.
  }, [element, key]);
  return [setElement, text] as const;
}

/** Every role class `surface.css` defines, with a sample line each. */
const TYPE_ROLES: ReadonlyArray<{
  readonly className: string;
  readonly element: "h1" | "h2" | "p" | "span";
  readonly sample: string;
}> = [
  { className: "oct-title", element: "h1", sample: "A page about one thing" },
  { className: "oct-title oct-title--hero", element: "h1", sample: "What should we build?" },
  { className: "oct-page-title", element: "h2", sample: "Destination or Settings page title" },
  { className: "oct-section-label", element: "h2", sample: "Section label" },
  { className: "oct-row-label", element: "p", sample: "Row label and menu option" },
  {
    className: "oct-row-detail",
    element: "p",
    sample: "Row description and subtitle, one size above metadata",
  },
  { className: "oct-meta", element: "p", sample: "Metadata, counts, hints and shortcuts" },
  { className: "oct-meta oct-meta--mono", element: "p", sample: "src/gallery/Gallery.tsx" },
];

function TypeRole(props: {
  readonly role: (typeof TYPE_ROLES)[number];
  readonly sizeKey: unknown;
}) {
  const [ref, measured] = useComputed(
    (style) =>
      `${style.fontSize} / ${style.fontWeight} / lh ${style.lineHeight === "normal" ? "normal" : style.lineHeight} / ${style.fontFamily.split(",")[0]?.trim() ?? ""}`,
    props.sizeKey,
  );
  const Tag = props.role.element;
  return (
    <Specimen note={measured} props={`className="${props.role.className}"`} wide>
      <Tag className={props.role.className} ref={ref}>
        {props.role.sample}
      </Tag>
    </Specimen>
  );
}

export function TypeRoles(props: { readonly sizeKey: unknown }) {
  return (
    <Section
      caption="Every role class in surface.css, one line each, with the size, weight, leading and face the browser computed for it."
      id="type"
      title="Type roles"
    >
      {TYPE_ROLES.map((role) => (
        <TypeRole key={role.className} role={role} sizeKey={props.sizeKey} />
      ))}
    </Section>
  );
}

const COLOUR_ROLES: ReadonlyArray<{ readonly token: string; readonly use: string }> = [
  { token: "--oct-bg", use: "Page" },
  { token: "--oct-surface", use: "Workspace and card" },
  { token: "--oct-surface-warm", use: "Warm surface" },
  { token: "--oct-fg", use: "Primary ink" },
  { token: "--oct-muted", use: "Secondary ink" },
  { token: "--oct-meta", use: "Muted ink" },
  { token: "--oct-border", use: "Border" },
  { token: "--oct-selection", use: "Selection" },
  { token: "--oct-accent", use: "Accent" },
  { token: "--oct-accent-on", use: "Text on accent" },
  { token: "--oct-success", use: "Success" },
  { token: "--oct-warn", use: "Warning" },
  { token: "--oct-danger", use: "Danger" },
  { token: "--oct-success-fg", use: "Success text" },
  { token: "--oct-warn-fg", use: "Warning text" },
  { token: "--oct-danger-fg", use: "Danger text" },
  { token: "--oct-success-soft", use: "Success wash" },
  { token: "--oct-warn-soft", use: "Warning wash" },
  { token: "--oct-danger-soft", use: "Danger wash" },
  { token: "--oct-accent-soft", use: "Accent wash" },
  { token: "--oct-fg-soft", use: "Ink wash (pressed fill)" },
];

function Swatch(props: {
  readonly token: string;
  readonly use: string;
  readonly themeKey: unknown;
}) {
  const [ref, resolved] = useComputed((style) => style.backgroundColor, props.themeKey);
  return (
    <div className="gallery-swatch">
      <span
        className="gallery-swatch__chip"
        ref={ref}
        style={{ background: `var(${props.token})` } satisfies CSSProperties}
      />
      <span className="oct-row-label">{props.use}</span>
      <code className="oct-meta oct-meta--mono">{props.token}</code>
      <span className="oct-meta oct-meta--mono">{resolved}</span>
    </div>
  );
}

export function ColourRoles(props: { readonly themeKey: unknown }) {
  return (
    <Section
      caption="The semantic colour roles by token name, with the value each resolves to in the mode shown above."
      id="colour"
      title="Colour roles"
    >
      <div className="gallery-swatches">
        {COLOUR_ROLES.map((role) => (
          <Swatch key={role.token} themeKey={props.themeKey} {...role} />
        ))}
      </div>
    </Section>
  );
}

const SPACE_STEPS = [1, 2, 3, 4, 5, 6, 8, 12] as const;

function SpaceStep(props: { readonly step: number; readonly sizeKey: unknown }) {
  const [ref, width] = useComputed((style) => style.width, props.sizeKey);
  return (
    <Specimen props={`--oct-space-${String(props.step)}`} note={width}>
      <span
        className="gallery-space"
        ref={ref}
        style={{ width: `var(--oct-space-${String(props.step)})` }}
      />
    </Specimen>
  );
}

export function SpacingScale(props: { readonly sizeKey: unknown }) {
  return (
    <Section
      caption="The spacing tokens as bars of their own width; the width in pixels is measured from the bar."
      id="spacing"
      title="Spacing scale"
    >
      {SPACE_STEPS.map((step) => (
        <SpaceStep key={step} sizeKey={props.sizeKey} step={step} />
      ))}
    </Section>
  );
}

const RADII = ["sm", "md", "inset", "lg", "composer", "pill"] as const;

function Radius(props: { readonly name: string; readonly sizeKey: unknown }) {
  const [ref, radius] = useComputed((style) => style.borderTopLeftRadius, props.sizeKey);
  return (
    <Specimen props={`--oct-radius-${props.name}`} note={radius}>
      <span
        className="gallery-radius"
        ref={ref}
        style={{ borderRadius: `var(--oct-radius-${props.name})` }}
      />
    </Specimen>
  );
}

export function Radii(props: { readonly sizeKey: unknown }) {
  return (
    <Section
      caption="The radius tokens on one 64-pixel box; the radius shown is what the browser computed."
      id="radii"
      title="Radii"
    >
      {RADII.map((name) => (
        <Radius key={name} name={name} sizeKey={props.sizeKey} />
      ))}
    </Section>
  );
}

/** The steps `iconScaleContract.test.ts` allows an interface icon to be drawn at. */
const ICON_SIZES = [12, 14, 16, 20, 24] as const;
const STROKES = [1.5, 1.8] as const;

function IconSample(props: {
  readonly size: number;
  readonly stroke: number;
  readonly children: (p: { size: number; strokeWidth: number }) => ReactNode;
}) {
  return <>{props.children({ size: props.size, strokeWidth: props.stroke })}</>;
}

export function IconScale() {
  return (
    <Section
      caption="The five sizes the icon-scale contract allows, at the 1.5 stroke the shell buttons use and the 1.8 stroke most call sites still ask for."
      id="icons"
      title="Icon sizes and stroke"
    >
      {ICON_SIZES.map((size) => (
        <Specimen key={size} props={`size={${String(size)}} strokeWidth={1.5 | 1.8}`}>
          <span className="gallery-icons">
            {STROKES.map((stroke) => (
              <span className="gallery-icons__cell" key={stroke}>
                <IconSample size={size} stroke={stroke}>
                  {(p) => (
                    <>
                      <Folder aria-hidden="true" {...p} />
                      <GitBranch aria-hidden="true" {...p} />
                      <Search aria-hidden="true" {...p} />
                      <Check aria-hidden="true" {...p} />
                      <ChevronDown aria-hidden="true" {...p} />
                    </>
                  )}
                </IconSample>
                <span className="oct-meta">stroke {String(stroke)}</span>
              </span>
            ))}
          </span>
        </Specimen>
      ))}
    </Section>
  );
}

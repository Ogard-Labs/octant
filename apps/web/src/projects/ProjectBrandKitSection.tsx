import type { CanvasDesignBrand } from "@octant/contracts/canvas";
import type { ProjectSummary } from "@octant/contracts/projects";
import { designBrandTokenRefusal } from "@octant/domain";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";

export interface ProjectBrandKitSectionProps {
  readonly project: ProjectSummary;
  readonly onChange: (brandKit: CanvasDesignBrand) => Promise<boolean>;
  readonly disabled?: boolean;
}

const COLOR_HINT = "Hex, such as #RRGGBB";

/**
 * The tokens the kit classes draw from. A kit may hold others; they are kept
 * as they are when these are saved.
 */
const BRAND_KIT_FIELDS: ReadonlyArray<{
  readonly name: string;
  readonly label: string;
  readonly placeholder: string;
}> = [
  { name: "color-primary", label: "Primary colour", placeholder: COLOR_HINT },
  { name: "color-on-primary", label: "Text on primary", placeholder: COLOR_HINT },
  { name: "color-secondary", label: "Secondary colour", placeholder: COLOR_HINT },
  { name: "color-background", label: "Background", placeholder: COLOR_HINT },
  { name: "color-surface", label: "Surface", placeholder: COLOR_HINT },
  { name: "color-text", label: "Text", placeholder: COLOR_HINT },
  { name: "color-muted", label: "Muted text", placeholder: COLOR_HINT },
  { name: "color-border", label: "Border", placeholder: COLOR_HINT },
  { name: "font-body", label: "Body font", placeholder: "system-ui, sans-serif" },
  { name: "font-heading", label: "Heading font", placeholder: "georgia, serif" },
  { name: "font-mono", label: "Code font", placeholder: "ui-monospace, monospace" },
  { name: "radius-card", label: "Card radius", placeholder: "10px" },
  { name: "space-gutter", label: "Page gutter", placeholder: "24px" },
];

/** What the person typed, as the kit it would save: blanks left out, unlisted tokens kept. */
function draftKit(
  saved: CanvasDesignBrand,
  values: Readonly<Record<string, string>>,
): CanvasDesignBrand {
  const known = new Set(BRAND_KIT_FIELDS.map((field) => field.name));
  const kit: Record<string, string> = {};
  for (const [name, value] of Object.entries(saved)) {
    if (!known.has(name)) kit[name] = value;
  }
  for (const field of BRAND_KIT_FIELDS) {
    const value = (values[field.name] ?? "").trim();
    if (value.length > 0) kit[field.name] = value;
  }
  return kit;
}

function fieldValues(saved: CanvasDesignBrand): Readonly<Record<string, string>> {
  return Object.fromEntries(BRAND_KIT_FIELDS.map((field) => [field.name, saved[field.name] ?? ""]));
}

/** Two kits hold the same tokens, whatever order they were written in. */
function sameKit(a: CanvasDesignBrand, b: CanvasDesignBrand): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => a[name] === b[name]);
}

export function ProjectBrandKitSection(props: ProjectBrandKitSectionProps) {
  const saved: CanvasDesignBrand = props.project.brandKit ?? {};
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() => fieldValues(saved));
  // The kit the fields were last filled from. When another window saves a new
  // kit, the fields follow it; otherwise a save would send the stale draft
  // under the refreshed version and silently overwrite that window's change.
  const [filledFrom, setFilledFrom] = useState<CanvasDesignBrand>(saved);
  if (!sameKit(filledFrom, saved)) {
    setFilledFrom(saved);
    setValues(fieldValues(saved));
  }
  // Each command asserts the Project version it read, so a second save sent
  // before the first returns would be refused as a conflict.
  const [pending, setPending] = useState(false);
  const draft = draftKit(saved, values);
  const refusals = new Map<string, string>();
  for (const [name, value] of Object.entries(draft)) {
    const refusal = designBrandTokenRefusal(name, value);
    if (refusal !== undefined) refusals.set(name, refusal);
  }
  const disabled = props.disabled === true || pending;

  async function commit(next: CanvasDesignBrand): Promise<void> {
    setPending(true);
    try {
      await props.onChange(next);
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby={`brand-kit-${props.project.id}`}
      className="project-provider-policy project-brand-kit"
    >
      <div className="project-provider-policy__header">
        <div>
          <h2 id={`brand-kit-${props.project.id}`}>Brand kit</h2>
          <p>
            Set your colours and fonts once. Designs this Project makes can use them with the brand
            theme. Fonts are system faces or generic families; nothing is downloaded.
          </p>
        </div>
      </div>
      {BRAND_KIT_FIELDS.map((field) => {
        const refusal = refusals.get(field.name);
        return (
          <label className="project-provider-policy__mode" key={field.name}>
            <span>{field.label}</span>
            <OctantInput
              aria-invalid={refusal === undefined ? undefined : true}
              aria-label={field.label}
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setValues((current) => ({ ...current, [field.name]: value }));
              }}
              placeholder={field.placeholder}
              value={values[field.name] ?? ""}
            />
            {refusal === undefined ? null : <OctantFieldError>{refusal}</OctantFieldError>}
          </label>
        );
      })}
      <div>
        <OctantButton
          disabled={disabled || refusals.size > 0 || sameKit(draft, saved)}
          onClick={() => void commit(draft)}
          size="sm"
          type="button"
        >
          Save brand kit
        </OctantButton>
        <OctantButton
          disabled={disabled || Object.keys(saved).length === 0}
          onClick={() => {
            setValues(Object.fromEntries(BRAND_KIT_FIELDS.map((field) => [field.name, ""])));
            void commit({});
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Clear
        </OctantButton>
      </div>
    </section>
  );
}

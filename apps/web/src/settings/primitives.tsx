import { ChevronRight } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import type { SettingsScope } from "./registry";
import { OctantAlert } from "../ui/base/OctantAlert";

const SCOPE_LABELS: Readonly<Record<SettingsScope, string>> = {
  app: "This app",
  host: "Selected host",
  mode: "Mode",
  project: "Project",
  thread: "Thread",
};

export function scopeLabel(scope: SettingsScope): string {
  return SCOPE_LABELS[scope];
}

/**
 * The scope the whole page applies to, said once under its title. A row whose
 * scope matches it prints nothing: "This app" beside forty rows of one page
 * was the loudest text on it. A row that differs still says so.
 */
export const SettingsPageScope = createContext<SettingsScope | undefined>(undefined);

export interface ScopeIndicatorProps {
  readonly scope: SettingsScope;
  readonly id?: string;
}

/**
 * Surfaces the authority scope of a setting (app, host, mode, Project, or
 * thread) without exposing unsafe host details. Rendered as an accessible
 * badge so screen readers announce the scope alongside the control.
 */
export function ScopeIndicator({ scope, id }: ScopeIndicatorProps) {
  const label = scopeLabel(scope);
  return (
    <span
      aria-label={`Scope: ${label}`}
      className="settings-scope-indicator"
      {...(id === undefined ? {} : { id })}
    >
      {label}
    </span>
  );
}

export interface SettingRowProps {
  readonly settingId: string;
  readonly label: ReactNode;
  readonly htmlFor?: string;
  readonly description?: ReactNode;
  readonly scope: SettingsScope;
  readonly focused?: boolean;
  /**
   * The section label above this row already names it, so the row does not
   * print its own label a second time.
   */
  readonly labelledBySection?: boolean;
  readonly children: ReactNode;
}

/**
 * One setting row: label, optional description, scope indicator, and the
 * authoritative control in the `children` slot.
 *
 * The row is anchored by `data-setting-id` so deep links can target it. When
 * `focused` is true (a deep link landed here), the first focusable control is
 * focused and scrolled into view so keyboard and screen-reader users land on
 * the exact destination.
 */
export function SettingRow({
  settingId,
  label,
  htmlFor,
  description,
  scope,
  focused = false,
  labelledBySection = false,
  children,
}: SettingRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const pageScope = useContext(SettingsPageScope);

  useEffect(() => {
    if (!focused || rowRef.current === null) return;
    // Deep links must reveal their destination before moving keyboard focus.
    let ancestor = rowRef.current.parentElement;
    while (ancestor !== null) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    const control = rowRef.current.querySelector<HTMLElement>(
      ':is(button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])):not(:disabled):not([aria-disabled="true"])',
    );
    if (control !== null) {
      control.focus();
      control.scrollIntoView?.({ block: "center" });
    } else {
      rowRef.current.focus();
      rowRef.current.scrollIntoView?.({ block: "center" });
    }
  }, [focused]);

  return (
    <div
      aria-label={`${label} setting`}
      aria-describedby={`${settingId}-description`}
      className="setrow"
      data-focused={focused ? "true" : "false"}
      data-setting-id={settingId}
      data-testid="setting-row"
      ref={rowRef}
      role="group"
      tabIndex={-1}
    >
      {/* The label always exists — Settings search and deep links resolve
          against it, and a screen reader still needs it to say which setting
          the control belongs to. When the section heading is the same phrase,
          only the printing of it is dropped. */}
      {htmlFor === undefined ? (
        <span
          className="setrow-label"
          data-labelled-by-section={labelledBySection ? "true" : "false"}
        >
          {label}
        </span>
      ) : (
        <label
          className="setrow-label"
          data-labelled-by-section={labelledBySection ? "true" : "false"}
          htmlFor={htmlFor}
        >
          {label}
        </label>
      )}
      {/* The scope rides inside the hint line because .setrow declares exactly
          two rows; a third child in column 1 would land in an implicit track
          the control's `grid-row: 1 / -1` span does not cover. */}
      <p className="setrow-hint" id={`${settingId}-description`}>
        {description === undefined ? null : <span>{description} </span>}
        {pageScope === scope ? null : <ScopeIndicator scope={scope} />}
      </p>
      <div className="setrow-control">{children}</div>
    </div>
  );
}

export interface SettingGroupProps {
  readonly label: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}

/**
 * A labelled group of {@link SettingRow}s within a section.
 */
export function SettingGroup({ label, description, children }: SettingGroupProps) {
  return (
    <div className="setgroup" role="group" aria-label={label}>
      <div className="setgroup-head">{label}</div>
      {description === undefined ? null : <p className="setgroup-note">{description}</p>}
      {children}
    </div>
  );
}

/** One section as the "On this page" row names it. */
export interface SettingsOutlineEntry {
  readonly id: string;
  readonly title: string;
  readonly element: HTMLElement;
}

/**
 * Where a section reports itself so the page header can link to it. Sections
 * are rendered by dozens of components far below the shell, so each one
 * registers instead of the shell scanning the DOM: a section that mounts late
 * (the provider list after its first answer) joins the row without a
 * MutationObserver, and the row never names a section that is not drawn.
 */
export const SettingsOutlineRegistration = createContext<
  ((entry: SettingsOutlineEntry) => () => void) | undefined
>(undefined);

export interface SettingsSectionProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** A section may be only its label and description, as when a feature is unavailable. */
  readonly children?: ReactNode;
  /** The anchor the "On this page" link scrolls to; one is generated when absent. */
  readonly id?: string;
  readonly className?: string;
  /**
   * A destructive section. It sits last on its page and its card holds the
   * destructive row; the heading keeps its ink, so danger is carried by the
   * placement and the confirm control, not by a coloured label.
   */
  readonly tone?: "danger";
  /** Ghost actions that act on the whole section, on the label's own line. */
  readonly actions?: ReactNode;
  /**
   * The region's accessible name when it differs from the visible label: the
   * provider list is labelled "Configured providers" and named "Providers".
   */
  readonly ariaLabel?: string;
}

/**
 * The shared section of every Settings page: a label, an optional one-line
 * description in muted ink, then one grouped card that holds the rows. The
 * caller provides the rows, facts, or a specialist editor as children.
 */
export function SettingsSection({
  title,
  description,
  children,
  id,
  className,
  tone,
  actions,
  ariaLabel,
}: SettingsSectionProps) {
  const titleId = useId();
  const generatedId = useId();
  const anchorId = id ?? generatedId;
  const register = useContext(SettingsOutlineRegistration);
  const element = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (register === undefined || element.current === null) return;
    return register({ id: anchorId, title, element: element.current });
  }, [register, anchorId, title]);
  return (
    <section
      {...(ariaLabel === undefined ? { "aria-labelledby": titleId } : { "aria-label": ariaLabel })}
      className={`settings-card-section settings-card-section--open${
        className === undefined ? "" : ` ${className}`
      }`}
      data-tone={tone}
      id={anchorId}
      ref={element}
    >
      {actions === undefined ? (
        <h2 id={titleId}>{title}</h2>
      ) : (
        <div className="settings-section-head">
          <h2 id={titleId}>{title}</h2>
          <div className="settings-section-head__actions">{actions}</div>
        </div>
      )}
      {description === undefined ? null : <p className="settings-section-note">{description}</p>}
      {children}
    </section>
  );
}

/**
 * A section whose card holds free-form content (a form, a list of devices, a
 * map) rather than a list of {@link SettingRow}s. It is the same section as
 * {@link SettingsSection}, so it takes the same label, description, anchor, and
 * danger tone; only the card pads itself.
 */
export function SettingsPanel(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly id?: string;
  readonly tone?: "default" | "danger";
}) {
  return (
    <SettingsSection
      className="settings-panel"
      {...(props.description === undefined ? {} : { description: props.description })}
      {...(props.id === undefined ? {} : { id: props.id })}
      {...(props.tone === "danger" ? { tone: "danger" as const } : {})}
      title={props.title}
    >
      <div className="settings-panel__body">{props.children}</div>
    </SettingsSection>
  );
}

export function SettingsFactList(props: {
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: ReactNode }>;
}) {
  return (
    <dl className="settings-fact-list">
      {props.facts.map((fact) => (
        <div className="settings-fact-list__row" key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SettingsState(props: {
  readonly kind: "empty" | "loading" | "error" | "success";
  readonly children: ReactNode;
}) {
  if (props.kind === "error") {
    return (
      <OctantAlert className="settings-state settings-state--error" tone="danger">
        {props.children}
      </OctantAlert>
    );
  }
  return (
    <p className={`settings-state settings-state--${props.kind}`} role="status">
      {props.children}
    </p>
  );
}

/** Optional details keep their controls mounted so closing them preserves drafts. */
export function SettingsDisclosure(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly variant?: "section" | "inline";
  readonly className?: string;
  /** Opens on mount, for a deep link that lands on a control inside. */
  readonly defaultOpen?: boolean;
}) {
  const variant = props.variant ?? "section";
  return (
    <details
      {...(props.defaultOpen === true ? { open: true } : {})}
      className={[
        "settings-disclosure",
        variant === "section" ? "settings-disclosure--section" : "settings-disclosure--inline",
        props.className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <summary>
        {variant === "inline" ? <ChevronRight aria-hidden="true" size={12} /> : null}
        <span className="settings-disclosure__label">
          <span>{props.title}</span>
          {props.description === undefined ? null : (
            <span className="settings-disclosure__description">{props.description}</span>
          )}
        </span>
        {variant === "section" ? <ChevronRight aria-hidden="true" size={14} /> : null}
      </summary>
      <div className="settings-disclosure__body">{props.children}</div>
    </details>
  );
}

import { useEffect, useRef, type ReactNode } from "react";
import type { SettingsScope } from "./registry";

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
  description,
  scope,
  focused = false,
  labelledBySection = false,
  children,
}: SettingRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focused || rowRef.current === null) return;
    const control = rowRef.current.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (control !== null) {
      control.focus();
      control.scrollIntoView?.({ block: "center" });
    } else {
      rowRef.current.scrollIntoView?.({ block: "center" });
    }
  }, [focused]);

  return (
    <div
      className="setrow"
      data-focused={focused ? "true" : "false"}
      data-setting-id={settingId}
      data-testid="setting-row"
      ref={rowRef}
    >
      {/* The label always exists — Settings search and deep links resolve
          against it, and a screen reader still needs it to say which setting
          the control belongs to. When the section heading is the same phrase,
          only the printing of it is dropped. */}
      <span
        className="setrow-label"
        data-labelled-by-section={labelledBySection ? "true" : "false"}
      >
        {label}
      </span>
      {/* The scope rides inside the hint line because .setrow declares exactly
          two rows; a third child in column 1 would land in an implicit track
          the control's `grid-row: 1 / -1` span does not cover. */}
      <p className="setrow-hint" id={`${settingId}-description`}>
        {description === undefined ? null : <span>{description} </span>}
        <ScopeIndicator scope={scope} />
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

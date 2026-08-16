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
      className="settings-row"
      data-focused={focused ? "true" : "false"}
      data-setting-id={settingId}
      data-testid="setting-row"
      ref={rowRef}
    >
      <div className="settings-row__copy">
        <span className="settings-row__label">{label}</span>
        {description === undefined ? null : (
          <p className="settings-row__description" id={`${settingId}-description`}>
            {description}
          </p>
        )}
        <ScopeIndicator scope={scope} />
      </div>
      <div className="settings-row__control">{children}</div>
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
    <div className="settings-group" role="group" aria-label={label}>
      <div className="settings-group__heading">
        <span className="settings-group__label">{label}</span>
        {description === undefined ? null : (
          <p className="settings-group__description">{description}</p>
        )}
      </div>
      <div className="settings-group__rows">{children}</div>
    </div>
  );
}

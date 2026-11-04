import type { CodeRelativePath } from "@octant/contracts/code";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import type { CodeBreakpointUnresolvedReason, CodeDebugThreadState } from "./codeDebugWindowState";

const REASON: Readonly<Record<CodeBreakpointUnresolvedReason, string>> = {
  "not-checked": "Unresolved: this file has not been checked on the current Project and checkout.",
  changed: "Unresolved: the file's identity or contents changed. Line numbers have not moved.",
  missing: "Unresolved: this file is missing. Its saved line numbers have not moved.",
  unavailable: "Unresolved: this file could not be read. Recheck after restoring access.",
  unsaved:
    "Unresolved: this editor has unsaved changes. Save or discard them before using these locations.",
  unconfirmed:
    "Unresolved: a line was chosen in an unsaved or changed file. Review the current clean locations.",
  "line-missing":
    "Unresolved: a saved line is outside the current file. Remove that line or repair the file.",
  "project-changed":
    "Unresolved: this thread's Project changed. Review the current clean locations.",
};
/** Configuration only: no saved entry starts or attaches a session. */
export function BreakpointConfigurationList(props: {
  readonly state: CodeDebugThreadState;
  readonly pending: ReadonlySet<CodeRelativePath>;
  readonly onOpen?: (path: CodeRelativePath, line: number) => void;
  readonly onRemove: (path: CodeRelativePath, line: number) => void;
  readonly onRecheck: () => void;
  readonly onReaccept: (path: CodeRelativePath) => Promise<boolean>;
}) {
  if (props.state.breakpoints.size === 0 && props.state.persistenceWarning === undefined)
    return null;
  return (
    <section aria-label="Breakpoints" className="run-debug__breakpoints">
      <div className="run-debug__controls">
        <strong>Breakpoints</strong>
        <OctantButton type="button" variant="ghost" size="sm" onClick={props.onRecheck}>
          Recheck breakpoint files
        </OctantButton>
      </div>
      {props.state.persistenceWarning === undefined ? null : (
        <OctantAlert tone="warning">{props.state.persistenceWarning}</OctantAlert>
      )}
      <p className="run-debug__line">
        {props.state.breakpointFiles === undefined
          ? "Held in this window."
          : "Saved on this device for this window and checkout."}{" "}
        Unresolved locations are not sent to the debugger.
      </p>
      <ul className="run-debug__breakpoint-files">
        {[...props.state.breakpoints].map(([path, lines]) => {
          const file = props.state.breakpointFiles?.get(path);
          const verified = props.state.breakpointFiles === undefined || file?.status === "verified";
          const pending = props.pending.has(path);
          const canReaccept =
            file?.observed?.clean === true &&
            lines.every((line) => line <= (file.observed?.lineCount ?? 0));
          return (
            <li key={path}>
              <p className="run-debug__line" role="status">
                {pending
                  ? "Checking saved locations…"
                  : verified
                    ? "Verified"
                    : REASON[file?.reason ?? "not-checked"]}
              </p>
              <ul>
                {lines.map((line) => (
                  <li className="run-debug__breakpoint-row" key={line}>
                    {props.onOpen === undefined ? (
                      <span>
                        {path}:{line}
                      </span>
                    ) : (
                      <OctantButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => props.onOpen?.(path, line)}
                      >
                        {path}:{line}
                      </OctantButton>
                    )}
                    <OctantButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove breakpoint ${path}:${line}`}
                      onClick={() => props.onRemove(path, line)}
                    >
                      Remove
                    </OctantButton>
                  </li>
                ))}
              </ul>
              {verified ? null : (
                <OctantButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending || !canReaccept}
                  onClick={() => void props.onReaccept(path)}
                >
                  Use current locations in {path}
                </OctantButton>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

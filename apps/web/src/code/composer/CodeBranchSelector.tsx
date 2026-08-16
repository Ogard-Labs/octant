import type { CodeWorktreeRef } from "@octant/contracts/code";
import { Check, ChevronDown, GitBranch, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OctantSwitch } from "../../ui/base/OctantSwitch";

export interface CodeBranchSelectorProps {
  /** The currently selected base branch (short name, no remote prefix). */
  readonly branch: string;
  readonly startFromOrigin: boolean;
  readonly remoteName?: string;
  readonly refs?: ReadonlyArray<CodeWorktreeRef>;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  /** Called when the popup opens so the caller can lazily fetch refs. */
  readonly onOpen?: () => void;
  readonly onSelectRef: (ref: CodeWorktreeRef) => void;
  readonly onStartFromOriginChange?: (value: boolean) => void;
  readonly startFromOriginAvailable?: boolean;
}

/**
 * Branch / worktree source selector for new Code threads. Presentational and
 * controlled: the ref catalog is server-authoritative
 * (`list-code-worktree-refs`) and selection only updates composer state; the
 * authoritative fetch and worktree creation stay on the server.
 */
export function CodeBranchSelector(props: CodeBranchSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current === null) return;
      if (event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const refs = props.refs ?? [];
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "") return refs;
    return refs.filter((ref) => ref.name.toLowerCase().includes(trimmed));
  }, [props.refs, query]);

  const triggerLabel =
    props.startFromOrigin && props.remoteName !== undefined
      ? `From ${props.remoteName}/${props.branch}`
      : `From ${props.branch}`;

  return (
    <div
      className={`code-branch-selector${open ? " code-branch-selector--open" : ""}`}
      ref={rootRef}
    >
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Base branch"
        className="code-branch-selector__trigger window-no-drag"
        disabled={props.disabled}
        onClick={() => {
          setOpen((current) => {
            const next = !current;
            if (next) {
              setQuery("");
              props.onOpen?.();
            }
            return next;
          });
        }}
        type="button"
      >
        <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
        <span className="code-branch-selector__trigger-label">{triggerLabel}</span>
        <ChevronDown aria-hidden="true" className="code-branch-selector__chevron" size={12} />
      </button>
      {!open ? null : (
        <div
          aria-label="Choose base branch"
          className="code-branch-selector__menu"
          id={menuId}
          role="dialog"
        >
          <label className="code-branch-selector__search">
            <Search aria-hidden="true" size={13} />
            <input
              aria-label="Search refs"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search refs…"
              ref={searchRef}
              type="search"
              value={query}
            />
          </label>
          <div aria-label="Refs" className="code-branch-selector__list" role="listbox">
            {props.loading === true && (props.refs === undefined || props.refs.length === 0) ? (
              <p className="code-branch-selector__empty" role="status">
                Loading refs…
              </p>
            ) : filtered.length === 0 ? (
              <p className="code-branch-selector__empty" role="status">
                {props.refs === undefined || props.refs.length === 0
                  ? "No refs reported for this repository."
                  : "No refs match the search."}
              </p>
            ) : (
              filtered.map((ref) => {
                const selected =
                  ref.kind === "remote"
                    ? props.startFromOrigin &&
                      ref.name === `${props.remoteName ?? "origin"}/${props.branch}`
                    : !props.startFromOrigin && ref.name === props.branch;
                return (
                  <button
                    aria-selected={selected}
                    className="code-branch-selector__option"
                    key={`${ref.kind}:${ref.name}`}
                    onClick={() => {
                      props.onSelectRef(ref);
                      setOpen(false);
                    }}
                    role="option"
                    type="button"
                  >
                    <span className="code-branch-selector__option-name">{ref.name}</span>
                    <span className="code-branch-selector__option-meta">
                      {selected ? <Check aria-hidden="true" size={12} strokeWidth={2} /> : null}
                      {ref.isCurrent === true ? (
                        <span className="code-branch-selector__badge">current</span>
                      ) : ref.hasWorktree === true ? (
                        <span className="code-branch-selector__badge">worktree</span>
                      ) : ref.kind === "remote" ? (
                        <span className="code-branch-selector__badge">
                          {ref.remoteName ?? "remote"}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {props.onStartFromOriginChange !== undefined ? (
            <div className="code-branch-selector__footer">
              <span>Start from origin</span>
              <OctantSwitch
                checked={props.startFromOrigin && props.startFromOriginAvailable === true}
                disabled={props.startFromOriginAvailable !== true}
                label="Start from origin in selector"
                onCheckedChange={props.onStartFromOriginChange}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

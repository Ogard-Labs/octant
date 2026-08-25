import type { CodeWorktreeRef } from "@octant/contracts/code";
import { Check, ChevronDown, GitBranch, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { OctantSwitch } from "../../ui/base/OctantSwitch";
import { OctantBadge } from "../../ui/base/OctantBadge";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import { OctantPopover } from "../../ui/base/OctantPopover";

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
  const searchRef = useRef<HTMLInputElement>(null);

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
    <OctantPopover
      className="code-branch-selector__menu"
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          props.onOpen?.();
        }
      }}
      open={open}
      title="Choose base branch"
      trigger={
        <>
          <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
          <span className="code-branch-selector__trigger-label">{triggerLabel}</span>
          <ChevronDown aria-hidden="true" className="code-branch-selector__chevron" size={12} />
        </>
      }
      triggerClassName="code-branch-selector__trigger"
      triggerLabel="Base branch"
      {...(props.disabled === undefined ? {} : { triggerDisabled: props.disabled })}
    >
      <label className="code-branch-selector__search">
        <Search aria-hidden="true" size={14} />
        <OctantInput
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
              <OctantButton
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
                    <OctantBadge variant="secondary">current</OctantBadge>
                  ) : ref.hasWorktree === true ? (
                    <OctantBadge variant="secondary">worktree</OctantBadge>
                  ) : ref.kind === "remote" ? (
                    <OctantBadge variant="secondary">{ref.remoteName ?? "remote"}</OctantBadge>
                  ) : null}
                </span>
              </OctantButton>
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
    </OctantPopover>
  );
}

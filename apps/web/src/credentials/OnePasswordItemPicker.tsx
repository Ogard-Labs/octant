import { useEffect, useRef, useState } from "react";
import type {
  SecretStoreBrowseEntry,
  SecretStoreBrowseResult,
  SecretStoreBrowseStep,
} from "@octant/contracts/secret-stores";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";
import { PopupSkeletonRows } from "../ui/base/PopupSkeletonRows";
import { ChevronLeft, List } from "../ui/icons";

export type BrowseSecretItems = (
  step: SecretStoreBrowseStep,
  signal: AbortSignal,
) => Promise<SecretStoreBrowseResult>;

const PROBLEMS: Readonly<
  Record<Exclude<SecretStoreBrowseResult["status"], "listed"> | "failed", string>
> = {
  locked: "Unlock 1Password on this computer, then try again.",
  missing: "It is no longer there. Go back and pick another.",
  unavailable: "Octant could not list it. Try again, or type a reference.",
  "not-linked": "Link 1Password in Settings › Secret stores first.",
  changed: "The link to 1Password changed. Try again.",
  failed: "Octant could not list it. Try again, or type a reference.",
};

interface Place {
  readonly step: SecretStoreBrowseStep;
  /** What it lists, for its heading. */
  readonly title: string;
}

const START: Place = { step: { kind: "vaults" }, title: "Vaults" };

/** Picks a field of a 1Password item by name. Only names and addresses are shown. */
export function OnePasswordItemPicker(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly browse: BrowseSecretItems;
  readonly onPick: (reference: string) => void;
}) {
  const { browse } = props;
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<ReadonlyArray<Place>>([START]);
  const [filter, setFilter] = useState("");
  const [result, setResult] = useState<SecretStoreBrowseResult | { readonly status: "failed" }>();
  const [attempt, setAttempt] = useState(0);
  const place = path.at(-1) ?? START;
  // The caller may make a new function each render; a listing must not restart for it.
  const list = useRef(browse);
  list.current = browse;

  useEffect(() => {
    if (!open) return undefined;
    const abort = new AbortController();
    setResult(undefined);
    list
      .current(place.step, abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) setResult(next);
      })
      .catch(() => {
        if (!abort.signal.aborted) setResult({ status: "failed" });
      });
    return () => abort.abort();
  }, [open, place.step, attempt]);

  const go = (next: ReadonlyArray<Place>) => {
    setFilter("");
    setPath(next);
  };
  const pick = (entry: SecretStoreBrowseEntry) => {
    const { step } = place;
    switch (step.kind) {
      case "vaults":
        go([...path, { step: { kind: "items", vaultId: entry.id }, title: entry.label }]);
        return;
      case "items":
        go([
          ...path,
          {
            step: { kind: "fields", vaultId: step.vaultId, itemId: entry.id },
            title: entry.label,
          },
        ]);
        return;
      case "fields":
        if (entry.reference === undefined) return;
        setOpen(false);
        go([START]);
        props.onPick(entry.reference);
    }
  };
  const wanted = filter.trim().toLowerCase();
  const entries =
    result?.status === "listed"
      ? result.entries.filter(({ label }) => label.toLowerCase().includes(wanted))
      : [];

  return (
    <OctantPopover
      align="end"
      className="secret-item-picker"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) go([START]);
      }}
      title="Pick a 1Password item"
      trigger={<List size={12} aria-hidden="true" />}
      triggerClassName="thread-secret-card__reveal thread-secret-card__browse"
      triggerDisabled={props.disabled}
      triggerLabel={props.label}
    >
      <div className="secret-item-picker__head">
        {path.length > 1 ? (
          <OctantButton
            aria-label="Back"
            onClick={() => go(path.slice(0, -1))}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </OctantButton>
        ) : null}
        <span className="secret-item-picker__title">{place.title}</span>
      </div>
      <OctantInput
        aria-label={`Filter ${place.title}`}
        autoComplete="off"
        autoFocus
        key={path.length}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter"
        spellCheck={false}
        value={filter}
      />
      {result === undefined ? (
        <PopupSkeletonRows label="Reading 1Password…" />
      ) : result.status !== "listed" ? (
        <div className="secret-item-picker__problem" role="status">
          <p>{PROBLEMS[result.status]}</p>
          <OctantButton
            onClick={() => setAttempt((count) => count + 1)}
            size="xs"
            type="button"
            variant="outline"
          >
            Try again
          </OctantButton>
        </div>
      ) : (
        <>
          <ul className="secret-item-picker__list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <OctantButton
                  className="secret-item-picker__entry"
                  onClick={() => pick(entry)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <span>{entry.label}</span>
                </OctantButton>
              </li>
            ))}
          </ul>
          {entries.length === 0 || result.truncated ? (
            <p className="secret-item-picker__note" role="status">
              {entries.length > 0
                ? "Only the first are listed. Type a reference for another."
                : wanted !== "" && result.entries.length > 0
                  ? "Nothing matches."
                  : "Nothing is here."}
            </p>
          ) : null}
        </>
      )}
    </OctantPopover>
  );
}

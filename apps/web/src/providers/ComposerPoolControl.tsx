import type { MultiModelPool, MultiModelPoolCandidate } from "@octant/contracts/multi-model-pool";
import type {
  ComposerPoolCandidateView,
  ComposerPoolModel,
} from "@octant/domain/composer-pool-policy";
import { Layers } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ComposerPoolControlProps {
  /** Settings-derived pool projection; the control can only narrow it. */
  readonly model: ComposerPoolModel;
  /** Currently persisted thread pool, when multi-model routing is active. */
  readonly pool?: MultiModelPool | undefined;
  /**
   * Applies the narrowed pool, or `undefined` to restore the unchanged
   * single-model flow. Must resolve `true` only when the server accepted it.
   */
  readonly onApply: (pool: MultiModelPool | undefined) => Promise<boolean> | boolean;
  readonly disabled?: boolean;
}

function candidateKey(candidate: MultiModelPoolCandidate): string {
  return `${candidate.hostId}:${candidate.providerInstanceId}:${candidate.modelId}`;
}

function initialSelection(
  model: ComposerPoolModel,
  pool: MultiModelPool | undefined,
): ReadonlySet<string> {
  if (pool !== undefined) return new Set(pool.candidates.map(candidateKey));
  if (model.kind !== "ready") return new Set();
  return new Set(
    model.candidates
      .filter((view) => view.isCurrent && view.selectable)
      .map((view) => candidateKey(view.candidate)),
  );
}

export function ComposerPoolControl(props: ComposerPoolControlProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [mixedVendorAllowed, setMixedVendorAllowed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const statusId = useId();
  const applyHintId = useId();

  const active = props.pool !== undefined;

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function openEditor() {
    setSelectedKeys(initialSelection(props.model, props.pool));
    setMixedVendorAllowed(
      props.pool !== undefined &&
        props.model.kind === "ready" &&
        props.model.candidates.some(
          (view) =>
            view.requiresMixedVendor &&
            props.pool!.candidates.some(
              (candidate) => candidateKey(candidate) === candidateKey(view.candidate),
            ),
        ),
    );
    setQuery("");
    setError(undefined);
    setOpen(true);
  }

  const disabledReason =
    props.model.kind === "loading"
      ? "Loading eligible models…"
      : props.model.kind === "unavailable"
        ? props.model.reason
        : undefined;

  const status = active
    ? `Multi-model pool of ${props.pool!.candidates.length} models is active.`
    : disabledReason;

  const ready = props.model.kind === "ready" ? props.model : undefined;
  const visible =
    ready === undefined ? [] : ready.candidates.filter((view) => matchesQuery(view, query));
  const selectedCount = selectedKeys.size;

  function toggleCandidate(view: ComposerPoolCandidateView, checked: boolean) {
    setSelectedKeys((current) => {
      const next = new Set(current);
      const key = candidateKey(view.candidate);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }

  function withdrawMixedVendor() {
    setMixedVendorAllowed(false);
    // Cross-vendor selections lose their explicit consent, so they leave the
    // draft immediately rather than lingering silently.
    if (ready === undefined) return;
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const view of ready.candidates) {
        if (view.requiresMixedVendor) next.delete(candidateKey(view.candidate));
      }
      return next;
    });
  }

  async function apply(pool: MultiModelPool | undefined) {
    setApplying(true);
    setError(undefined);
    try {
      const accepted = await props.onApply(pool);
      if (accepted) {
        setOpen(false);
      } else {
        setError(
          pool === undefined
            ? "The single-model flow could not be restored. Try again."
            : "The pool could not be applied. Try again.",
        );
      }
    } catch {
      setError(
        pool === undefined
          ? "The single-model flow could not be restored. Try again."
          : "The pool could not be applied. Try again.",
      );
    } finally {
      setApplying(false);
    }
  }

  function applySelection() {
    if (ready === undefined) return;
    const candidates = ready.candidates
      .filter((view) => selectedKeys.has(candidateKey(view.candidate)))
      .map((view) => view.candidate);
    // The persisted pool grants routing among exactly these pinned candidates;
    // cross-vendor members were individually gated behind the explicit opt-in.
    void apply({
      candidates,
      mixedVendorEnabled: true,
      fallbackAllowed: true,
      higherCostFallbackAllowed: false,
    } as MultiModelPool);
  }

  return (
    <div className="composer-pool-control" ref={rootRef}>
      <button
        aria-describedby={statusId}
        aria-expanded={open}
        aria-label="Use multiple models"
        aria-pressed={active}
        className="composer-pool-control__trigger window-no-drag"
        disabled={props.disabled === true || disabledReason !== undefined}
        onClick={() => (open ? setOpen(false) : openEditor())}
        title={disabledReason}
        type="button"
      >
        <Layers aria-hidden="true" size={14} strokeWidth={1.7} />
        <span>{active ? `Pool · ${props.pool!.candidates.length}` : "Use multiple models"}</span>
      </button>
      <span
        className="composer-pool-control__status composer-pool-control__visually-hidden"
        id={statusId}
        role="status"
      >
        {status ?? ""}
      </span>
      {open && ready !== undefined ? (
        <div
          aria-label="Multi-model pool editor"
          className="composer-pool-control__editor"
          role="dialog"
        >
          <label className="composer-pool-control__search">
            <span className="composer-pool-control__visually-hidden">Search models</span>
            <OctantInput
              aria-label="Search models"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search models"
              type="search"
              value={query}
            />
          </label>
          <ul className="composer-pool-control__options">
            {visible.map((view) => {
              const key = candidateKey(view.candidate);
              const gatedByMixedVendor = view.requiresMixedVendor && !mixedVendorAllowed;
              const checkboxDisabled = !view.selectable || gatedByMixedVendor || applying;
              return (
                <li className="composer-pool-control__option" key={key}>
                  <label
                    className={`composer-pool-control__option-label${
                      checkboxDisabled ? " composer-pool-control__option-label--disabled" : ""
                    }`}
                  >
                    <input
                      aria-label={`${view.providerName} — ${view.modelName}`}
                      checked={selectedKeys.has(key)}
                      className="window-no-drag"
                      disabled={checkboxDisabled}
                      onChange={(event) => toggleCandidate(view, event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>
                      {view.providerName} — {view.modelName}
                      {view.isCurrent ? " (current)" : ""}
                    </span>
                  </label>
                  {view.unavailableReason === undefined ? null : (
                    <span className="composer-pool-control__option-reason">
                      {view.unavailableReason}
                    </span>
                  )}
                  {view.selectable && gatedByMixedVendor ? (
                    <span className="composer-pool-control__option-reason">
                      Requires the mixed-vendor opt-in.
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {ready.mixedVendorRequired ? (
            <div className="composer-pool-control__mixed-vendor">
              <label className="composer-pool-control__option-label">
                <input
                  aria-label="Allow mixed-vendor routing"
                  checked={mixedVendorAllowed}
                  className="window-no-drag"
                  disabled={applying}
                  onChange={(event) =>
                    event.currentTarget.checked
                      ? setMixedVendorAllowed(true)
                      : withdrawMixedVendor()
                  }
                  type="checkbox"
                />
                <span>Allow mixed-vendor routing</span>
              </label>
              <p className="composer-pool-control__disclosure">
                Models from other vendors can receive this thread&apos;s context when routing
                selects them. This never configures credentials or widens authority.
              </p>
            </div>
          ) : null}
          {error === undefined ? null : (
            <p className="composer-pool-control__error" role="alert">
              {error}
            </p>
          )}
          <div className="composer-pool-control__actions">
            <OctantButton
              aria-describedby={applyHintId}
              disabled={selectedCount < 2 || applying}
              onClick={applySelection}
              size="sm"
              type="button"
            >
              Apply pool
            </OctantButton>
            <span className="composer-pool-control__hint" id={applyHintId}>
              Select at least two eligible models to route across a pool.
            </span>
            {active ? (
              <OctantButton
                disabled={applying}
                onClick={() => void apply(undefined)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Use single model
              </OctantButton>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function matchesQuery(view: ComposerPoolCandidateView, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return true;
  return `${view.providerName} ${view.modelName} ${String(view.candidate.modelId)}`
    .toLowerCase()
    .includes(trimmed);
}

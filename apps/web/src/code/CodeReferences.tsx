import { useLayoutEffect, useRef } from "react";
import type { CodeLanguageReferencesOutcome } from "./useCodeLanguageServices";
import type { CodeLanguageDefinitionTarget } from "@octant/contracts/code-language";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

/** A bounded snapshot of the current file query; selecting a location only opens a file. */
export function CodeReferences(props: {
  readonly checkout: string;
  readonly busy: boolean;
  readonly result?: CodeLanguageReferencesOutcome;
  readonly onChoose: (
    target: Extract<CodeLanguageDefinitionTarget, { readonly kind: "checkout-location" }>,
  ) => void;
  readonly canOpen: (path: string) => boolean;
  readonly onRecheck: () => void;
  readonly onClose: () => void;
  readonly onReloadLanguage?: () => void;
  readonly onOpenExternal?: () => void;
}) {
  const result = props.result;
  const region = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    region.current?.focus();
  }, []);
  return (
    <section
      ref={region}
      tabIndex={-1}
      className="code-editor-pane__references"
      aria-label="References"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div className="code-editor-pane__reference-actions">
        <strong>References</strong>
        <OctantButton
          type="button"
          size="sm"
          variant="ghost"
          onClick={props.onRecheck}
          disabled={props.busy}
        >
          Recheck references
        </OctantButton>
        <OctantButton type="button" size="sm" variant="ghost" onClick={props.onClose}>
          Close references
        </OctantButton>
      </div>
      <p className="oct-meta">Checkout: {props.checkout}</p>
      {props.busy ? (
        <p role="status">Finding references…</p>
      ) : result?.status === "references" ? (
        <>
          <p role="status">
            {result.targets.length === 0
              ? "No references were found."
              : `${result.targets.length} reference${result.targets.length === 1 ? "" : "s"}${result.truncated ? " shown; more results were omitted" : ""}.`}
          </p>
          <p className="oct-meta">These locations are a snapshot. Recheck after changes.</p>
          <ul>
            {result.targets.map((target, index) =>
              target.kind === "outside-checkout" ? (
                <li key={`outside-${index}`}>
                  <span className="oct-meta">
                    A reference is{" "}
                    {target.label === "bundled-library"
                      ? "in the server's bundled library"
                      : "outside this checkout"}
                    ; its location is not exposed.
                  </span>
                </li>
              ) : (
                <li
                  key={`${target.path}:${target.range.start.line}:${target.range.start.character}:${index}`}
                >
                  {props.canOpen(target.path) ? (
                    <OctantButton
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Open ${target.path}:${target.range.start.line + 1}:${target.range.start.character + 1}`}
                      onClick={() => props.onChoose(target)}
                    >
                      <span className="oct-meta--mono">
                        {target.path}:{target.range.start.line + 1}:
                        {target.range.start.character + 1}
                      </span>
                    </OctantButton>
                  ) : (
                    <span className="oct-meta--mono">
                      {target.path}:{target.range.start.line + 1}:{target.range.start.character + 1}
                    </span>
                  )}
                </li>
              ),
            )}
          </ul>
        </>
      ) : result === undefined ? null : (
        <>
          <OctantAlert tone="warning">
            {result.status === "unsupported"
              ? result.support === "unknown"
                ? "The host has not reported references support for this file."
                : "This server does not offer references for this file."
              : result.message}
          </OctantAlert>
          {result.status === "unavailable" &&
          result.reloadLanguage === true &&
          props.onReloadLanguage !== undefined ? (
            <>
              <p className="oct-meta">
                Reload reconnects this file under its current tooling permissions. Recheck alone
                does not reopen it.
              </p>
              <OctantButton
                type="button"
                size="sm"
                variant="secondary"
                onClick={props.onReloadLanguage}
              >
                Reload language document
              </OctantButton>
            </>
          ) : null}
          {props.onOpenExternal === undefined ? null : (
            <OctantButton
              type="button"
              size="sm"
              variant="secondary"
              onClick={props.onOpenExternal}
            >
              Open externally
            </OctantButton>
          )}
        </>
      )}
    </section>
  );
}

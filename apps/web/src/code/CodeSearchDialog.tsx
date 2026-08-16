import { createCodeFileListingClient, type CodeFileListingClient } from "@octant/client-runtime";
import type {
  CodeCheckoutId,
  CodeSearchMatch,
  CodeRelativePath,
  CodeSearchScope,
  CodeThreadId,
} from "@octant/contracts";
import { CornerDownLeft, FileText, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isApplePlatform } from "../platform";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";

const RESULTS_ID = "code-search-results";

/** How long the box waits after a keystroke before asking the host to walk. */
const QUERY_SETTLE_MS = 180;

function optionId(index: number): string {
  return `code-search-option-${index}`;
}

/**
 * Report whether a keyboard event opens quick open by file name.
 *
 * `Cmd+P` on Apple hardware and `Ctrl+P` elsewhere. Shift must be absent so the
 * chord cannot collide with content search, and Alt must be absent so it cannot
 * collide with an Alt-qualified editor binding.
 */
export function isCodePathSearchEvent(event: globalThis.KeyboardEvent): boolean {
  if (event.shiftKey || event.altKey || event.key.toLowerCase() !== "p") return false;
  return isApplePlatform() ? event.metaKey : event.metaKey || event.ctrlKey;
}

/** Report whether a keyboard event opens search across file contents. */
export function isCodeContentSearchEvent(event: globalThis.KeyboardEvent): boolean {
  if (!event.shiftKey || event.altKey || event.key.toLowerCase() !== "f") return false;
  return isApplePlatform() ? event.metaKey : event.metaKey || event.ctrlKey;
}

export interface CodeSearchDialogProps {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  /** Injected in tests; otherwise built from the server URL and capability. */
  readonly client?: Pick<CodeFileListingClient, "search">;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  readonly onOpenFile: (relativePath: CodeRelativePath) => void;
}

/**
 * Quick open by file name (`Cmd/Ctrl+P`) and search across file contents
 * (`Cmd/Ctrl+Shift+F`) for the checkout bound to a Code thread.
 *
 * Both chords open the same dialog in different scopes, because they are the
 * same question about the same repository and switching between them mid-query
 * should not mean reopening anything. The host owns the walk, its confinement,
 * and its bounds; the renderer never filters a second time, so what is listed
 * is exactly what the host was willing to report.
 *
 * A truncated answer is said in words rather than implied by a short list —
 * search is the surface most likely to be run against a monorepo, and a
 * silently partial answer there reads as "this repository has no match".
 */
export function CodeSearchDialog(props: CodeSearchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [scope, setScope] = useState<CodeSearchScope | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [matches, setMatches] = useState<ReadonlyArray<CodeSearchMatch>>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();

  const client = useMemo(() => {
    if (props.client !== undefined) return props.client;
    if (props.serverUrl === undefined || props.windowCapability === undefined) return undefined;
    return createCodeFileListingClient({
      baseUrl: props.serverUrl,
      fetch: globalThis.fetch,
      windowCapability: props.windowCapability,
    });
  }, [props.client, props.serverUrl, props.windowCapability]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      const next = isCodePathSearchEvent(event)
        ? "path"
        : isCodeContentSearchEvent(event)
          ? "content"
          : undefined;
      if (next === undefined) return;
      event.preventDefault();
      // The same chord again closes; the other chord switches scope and keeps
      // what the user has typed, because the text is the question either way.
      if (scope === next) {
        setScope(undefined);
        return;
      }
      if (scope === undefined) {
        restoreFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setQuery("");
        setMatches([]);
        setTruncated(false);
        setErrorMessage(undefined);
      }
      setActiveIndex(0);
      setScope(next);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scope]);

  const trimmed = query.trim();
  const { threadId, checkoutId } = props;
  useEffect(() => {
    if (scope === undefined || client === undefined || trimmed === "") {
      setMatches([]);
      setTruncated(false);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    // Every keystroke would otherwise start a walk of the repository the next
    // keystroke makes obsolete.
    const timer = setTimeout(() => {
      setSearching(true);
      setErrorMessage(undefined);
      client
        .search({ threadId, checkoutId, scope, query: trimmed }, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.status === "failed") {
            setMatches([]);
            setTruncated(false);
            setErrorMessage(result.failure.message);
            return;
          }
          setMatches(result.search.matches);
          setTruncated(result.search.truncated);
          setActiveIndex(0);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setMatches([]);
          setTruncated(false);
          setErrorMessage(failureMessage(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, QUERY_SETTLE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [checkoutId, client, scope, threadId, trimmed]);

  if (scope === undefined) return null;

  const active = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1);
  const statusMessage =
    errorMessage !== undefined
      ? errorMessage
      : trimmed === ""
        ? scope === "path"
          ? "Type part of a file name."
          : "Type text to find inside the repository's files."
        : searching
          ? "Searching…"
          : matches.length === 0
            ? truncated
              ? // Saying only "no match" here would be a claim about the whole
                // repository that the host never made.
                "No match yet. Octant stopped before searching the whole repository."
              : "No match in this checkout."
            : `${matches.length} match${matches.length === 1 ? "" : "es"}${
                truncated ? ", and Octant stopped before searching the whole repository." : "."
              }`;

  function close(): void {
    setScope(undefined);
  }

  function open(match: CodeSearchMatch | undefined): void {
    if (match === undefined) return;
    setScope(undefined);
    props.onOpenFile(match.path);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (matches.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(active + 1 >= matches.length ? 0 : active + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(active <= 0 ? matches.length - 1 : active - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(matches.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      open(matches[active]);
    }
  }

  const label = scope === "path" ? "Go to file" : "Find in repository";
  return (
    <OctantDialog
      className="command-palette"
      initialFocus={inputRef}
      label={label}
      onClose={close}
      open
      popupId="code-search-dialog"
      restoreFocus={restoreFocusRef}
    >
      <div className="command-palette__field">
        <Search aria-hidden="true" size={14} strokeWidth={1.8} />
        <OctantInput
          {...(active >= 0 ? { "aria-activedescendant": optionId(active) } : {})}
          aria-controls={RESULTS_ID}
          aria-expanded={matches.length > 0}
          aria-label={label}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={scope === "path" ? "Go to file" : "Find in repository"}
          ref={inputRef}
          role="combobox"
          value={query}
        />
      </div>
      <p className="command-palette__scope" role="note">
        {scope === "path"
          ? "File names in the repository bound to this thread."
          : "Text inside the files of the repository bound to this thread."}
      </p>
      <p aria-atomic="true" aria-live="polite" className="command-palette__status" role="status">
        {statusMessage}
      </p>
      <div
        aria-label="Search results"
        className="command-palette__results"
        id={RESULTS_ID}
        role="listbox"
      >
        {matches.map((match, index) => (
          <div
            aria-selected={index === active}
            className="command-palette__result"
            data-active={index === active}
            id={optionId(index)}
            key={`${String(match.path)}:${match.scope === "content" ? match.line : 0}:${index}`}
            onClick={() => open(match)}
            onMouseMove={() => setActiveIndex(index)}
            role="option"
          >
            <span className="command-palette__result-title">
              <FileText aria-hidden="true" size={12} strokeWidth={1.8} />
              {match.scope === "content"
                ? `${String(match.path)}:${match.line}`
                : String(match.path)}
            </span>
            {match.scope === "content" ? (
              <span className="command-palette__result-detail">{match.preview}</span>
            ) : null}
            {index === active ? (
              <span className="command-palette__result-hint">
                <CornerDownLeft aria-hidden="true" size={12} strokeWidth={1.8} />
                <span>Enter</span>
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </OctantDialog>
  );
}

function failureMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Octant Code search is unavailable.";
}

import {
  CANVAS_HTML_IMPORT_MAX_BYTES,
  type CanvasHtmlImportDrop,
  type CanvasHtmlImportDropKind,
  type CanvasHtmlImportRequest,
  type CanvasHtmlImportResult,
} from "@octant/contracts/canvas-cards";
import { useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import type { CanvasCreationContext } from "./CreateCanvasDraft";

type Imported = Extract<CanvasHtmlImportResult, { readonly kind: "imported" }>;

export interface CanvasHtmlImportProps {
  readonly context: CanvasCreationContext;
  readonly onImport: (request: CanvasHtmlImportRequest) => Promise<CanvasHtmlImportResult>;
  /** After the host wrote the new Canvas; the summary stays so the person reads what was taken out. */
  readonly onImported?: (result: Imported) => void;
}

const DROP_LABEL: Record<CanvasHtmlImportDropKind, readonly [string, string]> = {
  "script-file": ["script file", "script files"],
  stylesheet: ["stylesheet", "stylesheets"],
  file: ["image, font, or media file", "images, fonts, or media files"],
  link: ["link out of the page", "links out of the page"],
  "embedded-document": ["embedded page", "embedded pages"],
  "form-target": ["form destination", "form destinations"],
  "page-setting": ["page setting", "page settings"],
  "svg-animation": ["SVG animation", "SVG animations"],
};

/**
 * Brings an HTML page into a new Canvas: a file the person chooses, or markup
 * they paste. The host decides everything that matters (the size bound, the
 * frame the page is drawn in, what is taken out, and whether this window may
 * create a Canvas at all); this form only reads the file and reports back.
 */
export function CanvasHtmlImport(props: CanvasHtmlImportProps) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<"file" | "paste">("file");
  const [file, setFile] = useState<File | undefined>(undefined);
  const [pasted, setPasted] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [imported, setImported] = useState<Imported | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const fileId = useId();
  const pasteId = useId();
  const titleId = useId();

  const reset = () => {
    setFile(undefined);
    setPasted("");
    setTitle("");
    setProblem(null);
    setImported(null);
    setPickerKey((key) => key + 1);
  };

  const ready = source === "file" ? file !== undefined : pasted.trim().length > 0;

  const submit = async () => {
    setProblem(null);
    if (source === "file" && file !== undefined && file.size > CANVAS_HTML_IMPORT_MAX_BYTES) {
      // Not worth reading into the window; the host refuses it the same way.
      setProblem(
        `This page is larger than ${String(CANVAS_HTML_IMPORT_MAX_BYTES / 1024)} KB, the most Octant imports.`,
      );
      return;
    }
    setBusy(true);
    try {
      const html = source === "file" ? await (file?.text() ?? Promise.resolve("")) : pasted;
      const typed = title.trim();
      const result = await props.onImport({
        schemaVersion: 1,
        kind: "canvas-html-import",
        requestId: crypto.randomUUID() as CanvasHtmlImportRequest["requestId"],
        hostId: props.context.hostId,
        mode: props.context.mode,
        workspace: props.context.workspace,
        originThreadId: props.context.originThreadId,
        requestedAuthority: props.context.requestedAuthority,
        source,
        html,
        ...(typed.length === 0 ? {} : { title: typed }),
        ...(source === "file" && file !== undefined && file.name.trim().length > 0
          ? { fileName: file.name }
          : {}),
      });
      if (result.kind === "imported") {
        setImported(result);
        props.onImported?.(result);
      } else {
        setProblem(result.message);
      }
    } catch {
      setProblem("The page could not be imported. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="canvas-html-import">
        <OctantButton
          data-testid="canvas-import-html-open"
          onClick={() => setOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          Import HTML…
        </OctantButton>
      </div>
    );
  }

  if (imported !== null) {
    return (
      <section
        aria-label="Imported page"
        className="canvas-html-import"
        data-testid="canvas-import-html-result"
      >
        <OctantAlert
          title={`“${imported.card.title}” is ready`}
          tone="success"
          action={
            <OctantButton onClick={reset} size="sm" type="button" variant="ghost">
              Import another
            </OctantButton>
          }
        >
          <p className="canvas-html-import__line">
            {imported.frame === "running"
              ? "It runs its own script, contained like any Canvas prototype: it starts when you open it in the sidebar, or when you press Run in the thread."
              : "It is drawn as a static page and runs no script."}
          </p>
        </OctantAlert>
        <DroppedSummary dropped={imported.dropped} />
      </section>
    );
  }

  return (
    <form
      aria-label="Import HTML"
      className="canvas-revise-form canvas-html-import"
      data-testid="canvas-import-html-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && ready) void submit();
      }}
    >
      <p className="canvas-html-import__heading">Import HTML</p>
      <p className="canvas-start-from__note">
        Bring a single HTML page, such as one an AI assistant made for you, into a new Canvas.
        Octant takes out anything it would load from the internet and tells you what it removed.
      </p>
      <OctantToggleGroup<"file" | "paste">
        aria-label="Page from"
        onValueChange={(value) => {
          const selected = value[0];
          if (selected !== undefined) setSource(selected);
        }}
        value={[source]}
      >
        <OctantToggleGroupItem value="file">File</OctantToggleGroupItem>
        <OctantToggleGroupItem value="paste">Paste</OctantToggleGroupItem>
      </OctantToggleGroup>
      {source === "file" ? (
        <>
          <label className="canvas-html-import__label" htmlFor={fileId}>
            HTML file
          </label>
          <OctantInput
            accept=".html,.htm,text/html"
            data-testid="canvas-import-html-file"
            disabled={busy}
            id={fileId}
            key={pickerKey}
            onChange={(event) => setFile(event.currentTarget.files?.[0])}
            type="file"
          />
        </>
      ) : (
        <>
          <label className="canvas-html-import__label" htmlFor={pasteId}>
            Page HTML
          </label>
          <OctantTextarea
            className="textarea canvas-html-import__paste"
            data-testid="canvas-import-html-paste"
            disabled={busy}
            id={pasteId}
            onChange={(event) => setPasted(event.target.value)}
            placeholder="<!doctype html>…"
            spellCheck={false}
            value={pasted}
          />
        </>
      )}
      <label className="canvas-html-import__label" htmlFor={titleId}>
        Title (optional)
      </label>
      <OctantInput
        className="input"
        disabled={busy}
        id={titleId}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={source === "file" && file !== undefined ? file.name : "Imported page"}
        value={title}
      />
      {problem === null ? null : (
        <OctantAlert testId="canvas-import-html-problem" tone="warning">
          {problem}
        </OctantAlert>
      )}
      <div className="canvas-html-import__actions">
        <OctantButton
          data-testid="canvas-import-html-submit"
          disabled={busy || !ready}
          size="sm"
          type="submit"
        >
          {busy ? "Importing…" : "Import"}
        </OctantButton>
        <OctantButton
          disabled={busy}
          onClick={() => {
            reset();
            setOpen(false);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </OctantButton>
      </div>
    </form>
  );
}

/** What the import took out, kind by kind, with a few of the addresses as text. */
function DroppedSummary(props: { readonly dropped: ReadonlyArray<CanvasHtmlImportDrop> }) {
  if (props.dropped.length === 0) {
    return (
      <p className="canvas-start-from__note" data-testid="canvas-import-html-dropped">
        Nothing needed to be taken out.
      </p>
    );
  }
  return (
    <div className="canvas-html-import__dropped" data-testid="canvas-import-html-dropped">
      <p className="canvas-start-from__note">
        Taken out, because a Canvas design loads nothing from the internet and links nowhere outside
        itself:
      </p>
      <ul className="canvas-html-import__drop-list">
        {props.dropped.map((drop) => {
          const [one, many] = DROP_LABEL[drop.kind];
          return (
            <li key={drop.kind}>
              <span className="canvas-html-import__drop-count">
                {drop.count} {drop.count === 1 ? one : many}
              </span>
              {drop.examples.length === 0 ? null : (
                <span className="canvas-html-import__drop-examples">
                  {drop.examples.join(", ")}
                  {drop.count > drop.examples.length ? ", …" : ""}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

import "../styles.css";
// The app loads this after styles.css; it holds rules Canvas blocks rely on,
// such as the checkbox tick a table's column control draws.
import "../styles/components.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Schema } from "effect";
import {
  CanvasBlockId,
  CanvasDesignAssetResolution,
  decodeCanvasDefinition,
  type CanvasDefinition,
} from "@octant/contracts/canvas";
import type { DesignAssetRuntime } from "./blocks/designDocument";
import { readDesignBridgeMessage, type DesignRunRuntime } from "./blocks/designRunningFrame";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { ThemeSettingsProvider } from "../theme/ThemeSettingsProvider";
import { CanvasDocument } from "./CanvasDocument";

/**
 * The page the host screenshots when an agent previews a Canvas.
 *
 * It draws the Canvas with the same renderer and stylesheet the thread uses, so
 * the picture an agent is shown is the one a person sees. The host writes the
 * document, the theme, and the placement into the page as inert JSON; nothing
 * here talks to the host. When the drawing has settled the page says so on the
 * root element, and the host takes the screenshot only then.
 */

interface CanvasPreviewInput {
  readonly definition: CanvasDefinition;
  readonly theme: "light" | "dark";
  readonly placement: "document" | "thread";
  readonly designAssets: DesignAssetRuntime;
  readonly designRun: DesignRunRuntime;
}

// The host resolved each design's images under the thread's authority before
// writing the page; the page only inlines them and still requests nothing.
const decodeDesignAssets = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      blockId: CanvasBlockId,
      assets: Schema.Array(CanvasDesignAssetResolution),
    }),
  ),
);

// The host built each running design's page and answers it at a path under
// this page's own origin, so a prototype runs here as it does for a reader:
// in a frame sandboxed to scripts alone, with its bridge reporting errors.
const decodeDesignPages = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      blockId: CanvasBlockId,
      path: Schema.String.pipe(Schema.pattern(/^\/design-page\/\d{1,3}$/)),
    }),
  ),
);

// The list the app draws under a prototype keeps its latest few errors. A
// preview is looking for what broke first, so the page records each running
// design's first errors itself, as its bridge reports them, where the host
// reads them. They are the same typed, bounded messages the app accepts, from
// that frame's own window.
const SCRIPT_ERRORS_PER_DESIGN = 8;
const scriptErrors = new Map<string, string[]>();
window.addEventListener("message", (event) => {
  const frames = document.querySelectorAll<HTMLIFrameElement>(
    "section.canvas-design[data-canvas-design] iframe",
  );
  for (const frame of frames) {
    if (frame.contentWindow === null || frame.contentWindow !== event.source) continue;
    const message = readDesignBridgeMessage(event, frame.contentWindow);
    const blockId = frame.closest("section.canvas-design")?.getAttribute("data-canvas-design");
    if (message?.type !== "error" || blockId === null || blockId === undefined) return;
    const kept = scriptErrors.get(blockId) ?? [];
    if (kept.length >= SCRIPT_ERRORS_PER_DESIGN) return;
    scriptErrors.set(blockId, [...kept, message.message]);
    document.documentElement.setAttribute(
      "data-canvas-preview-script-errors",
      JSON.stringify(Object.fromEntries(scriptErrors)),
    );
    return;
  }
});

type CanvasPreviewReading =
  | { readonly kind: "ready"; readonly input: CanvasPreviewInput }
  | { readonly kind: "refused" };

function readInput(): CanvasPreviewReading {
  const source = document.getElementById("canvas-preview-data")?.textContent;
  if (source === undefined || source === null) return { kind: "refused" };
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null) return { kind: "refused" };
    const record = parsed as {
      readonly definition?: unknown;
      readonly theme?: unknown;
      readonly placement?: unknown;
      readonly designAssets?: unknown;
      readonly designPages?: unknown;
    };
    // The host already validated this document; decoding it again keeps the
    // page from drawing anything the contract would not admit.
    const definition = decodeCanvasDefinition(record.definition);
    const theme = record.theme === "dark" ? "dark" : "light";
    const placement = record.placement === "thread" ? "thread" : "document";
    const resolved = decodeDesignAssets(record.designAssets ?? []);
    const designAssets: DesignAssetRuntime = {
      resolve: async (blockId) =>
        resolved.find((entry) => String(entry.blockId) === blockId)?.assets,
    };
    const pages = decodeDesignPages(record.designPages ?? []);
    const designRun: DesignRunRuntime = {
      start: async (blockId) => {
        const page = pages.find((entry) => String(entry.blockId) === blockId);
        return page === undefined
          ? { kind: "refused", reason: "This preview holds no page for that prototype." }
          : { kind: "ready", url: page.path };
      },
      // Nothing leaves the preview browser: the host answers this page's own
      // files and aborts every other request.
      contained: true,
      runsOnOpen: true,
    };
    return { kind: "ready", input: { definition, theme, placement, designAssets, designRun } };
  } catch {
    return { kind: "refused" };
  }
}

function markState(state: "ready" | "refused"): void {
  document.documentElement.dataset.canvasPreview = state;
}

function CanvasPreviewPage({ input }: { readonly input: CanvasPreviewInput }) {
  useEffect(() => {
    let cancelled = false;
    // Fonts swap the metrics every label is measured with, so the page is not
    // settled until they have loaded and one more frame has been laid out.
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) markState("ready");
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <ThemeSettingsProvider settings={{ ...DEFAULT_THEME_SETTINGS, mode: input.theme }}>
      <main className="canvas-preview-page">
        <CanvasDocument
          definition={input.definition}
          designAssetRuntime={input.designAssets}
          designRunRuntime={input.designRun}
          placement={input.placement}
        />
      </main>
    </ThemeSettingsProvider>
  );
}

const reading = readInput();
const rootElement = document.getElementById("root");
if (reading.kind === "refused" || rootElement === null) {
  markState("refused");
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <CanvasPreviewPage input={reading.input} />
    </StrictMode>,
  );
}

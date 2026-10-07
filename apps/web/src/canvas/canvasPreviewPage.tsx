import "../styles.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { decodeCanvasDefinition, type CanvasDefinition } from "@octant/contracts/canvas";
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
}

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
    };
    // The host already validated this document; decoding it again keeps the
    // page from drawing anything the contract would not admit.
    const definition = decodeCanvasDefinition(record.definition);
    const theme = record.theme === "dark" ? "dark" : "light";
    const placement = record.placement === "thread" ? "thread" : "document";
    return { kind: "ready", input: { definition, theme, placement } };
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
        <CanvasDocument definition={input.definition} placement={input.placement} />
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

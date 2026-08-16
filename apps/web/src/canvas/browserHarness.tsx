import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CanvasDocument } from "./CanvasDocument";
import { CanvasView } from "./CanvasView";
import { canvasFixture, hostileTextFixture, unsafeLinkFixture } from "./test-fixtures";

const root = document.getElementById("root");
if (!root) throw new Error("Canvas browser evidence root is missing");

createRoot(root).render(
  <StrictMode>
    <main>
      <section data-canvas-evidence="safe">
        <CanvasDocument definition={canvasFixture} />
      </section>
      <section data-canvas-evidence="hostile-text">
        <CanvasDocument definition={hostileTextFixture} />
      </section>
      <section data-canvas-evidence="unsafe">
        <CanvasView input={unsafeLinkFixture} />
      </section>
    </main>
  </StrictMode>,
);

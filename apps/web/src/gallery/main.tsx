import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { followInputModality } from "../lib/inputModality";
import { followSystemIncreasedContrast } from "../theme/increasedContrastAttribute";
import { Gallery } from "./Gallery";

// The gallery is reached only through the dev server's `component-gallery.html`,
// which the production build does not take as an input; this guard keeps the
// module inert if a bundler ever reaches it anyway.
if (import.meta.env.DEV) {
  const root = document.getElementById("root");
  if (!root) throw new Error("Octant root element is missing");
  followSystemIncreasedContrast();
  followInputModality();
  createRoot(root).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
}

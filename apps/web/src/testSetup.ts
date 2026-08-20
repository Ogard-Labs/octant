import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetTranscriptScrollMemory } from "./transcript/TranscriptWindow";

const transcriptWindowHeight = 480;
const transcriptRowHeight = 80;

function transcriptLayoutSize(element: HTMLElement, kind: "width" | "height"): number {
  if (element.hasAttribute("data-transcript-window")) {
    if (kind === "width") {
      const named = element.getAttribute("data-transcript-window-width");
      return named === null ? 800 : Number(named);
    }
    const named = element.getAttribute("data-transcript-window-height");
    return named === null ? transcriptWindowHeight : Number(named);
  }
  if (element.hasAttribute("data-transcript-row")) {
    if (kind === "width") return 760;
    const named = element.getAttribute("data-transcript-row-height");
    if (named !== null) return Number(named);
    const childHeight = element.firstElementChild?.getAttribute("data-row-height");
    return childHeight === null || childHeight === undefined
      ? transcriptRowHeight
      : Number(childHeight);
  }
  return 0;
}

Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return transcriptLayoutSize(this, "height");
  },
});

Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return transcriptLayoutSize(this, "width");
  },
});

Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get() {
    return transcriptLayoutSize(this, "height");
  },
});

Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get() {
    return transcriptLayoutSize(this, "width");
  },
});

Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get() {
    if (!this.hasAttribute("data-transcript-window")) {
      return transcriptLayoutSize(this, "height");
    }
    const sized = [...this.querySelectorAll("ol, [style]")].find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const height = Number.parseFloat(node.style.height);
      return Number.isFinite(height) && height > 0;
    });
    if (!(sized instanceof HTMLElement)) return transcriptWindowHeight;
    return Number.parseFloat(sized.style.height);
  },
});

afterEach(() => {
  resetTranscriptScrollMemory();
  cleanup();
});

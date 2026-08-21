import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { composerThreadDrafts } from "./composer/composerThreadDraftStore";
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
  if (
    element.hasAttribute("data-transcript-lead") ||
    element.hasAttribute("data-transcript-trail")
  ) {
    if (kind === "width") return 800;
    let height = 0;
    for (const child of element.children) {
      if (!(child instanceof HTMLElement)) continue;
      const named = child.getAttribute("data-row-height");
      height += named === null ? transcriptRowHeight : Number(named);
    }
    return height;
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
    const sized = this.querySelector("[data-transcript-list]");
    const listHeight =
      sized instanceof HTMLElement && Number.isFinite(Number.parseFloat(sized.style.height))
        ? Number.parseFloat(sized.style.height)
        : transcriptWindowHeight;
    let extra = 0;
    for (const node of this.querySelectorAll(
      "[data-transcript-lead] > *, [data-transcript-trail] > *",
    )) {
      if (!(node instanceof HTMLElement)) continue;
      const named = node.getAttribute("data-row-height");
      extra += named === null ? transcriptRowHeight : Number(named);
    }
    return listHeight + extra;
  },
});

afterEach(() => {
  cleanup();
  resetTranscriptScrollMemory();
  composerThreadDrafts.clearAll();
  globalThis.localStorage?.clear();
});

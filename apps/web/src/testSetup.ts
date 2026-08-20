import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { composerThreadDrafts } from "./composer/composerThreadDraftStore";

afterEach(() => {
  cleanup();
  composerThreadDrafts.clearAll();
  globalThis.localStorage?.clear();
});

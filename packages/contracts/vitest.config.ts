import { defineConfig } from "vitest/config";

// The first ICU call in a cold Windows worker (a time-zone check, a
// `localeCompare`) loads the ICU data. The hosted runner has taken 8 to 19 s
// over it, failing whichever trivial test happened to be first past Vitest's
// 5 s default; the same tests run in milliseconds once it is loaded.
export default defineConfig({ test: { testTimeout: 30_000 } });

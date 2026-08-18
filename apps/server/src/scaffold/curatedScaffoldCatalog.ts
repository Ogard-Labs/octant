import { decodeScaffoldEntry, type ScaffoldEntry } from "@octant/contracts/scaffolds";

/**
 * The scaffolds Octant offers out of the box.
 *
 * Every entry pins the exact generator it runs, so the same scaffold produces
 * the same starting point next year as it does today. Nothing here is fetched
 * or vendored at build time: the pin is the curation decision, and bumping it
 * is a reviewed change like any other.
 *
 * Dependencies are deliberately not installed by the scaffold. Writing a
 * project is one approval; downloading a dependency tree is another, and the
 * user takes it themselves in the thread's terminal once they can see what
 * they got.
 */
export const CURATED_SCAFFOLDS: ReadonlyArray<ScaffoldEntry> = [
  decodeScaffoldEntry({
    id: "web-app",
    displayName: "Web app",
    summary: "A TypeScript browser app with a dev server, bundler, and production build.",
    target: "web-app",
    generator: {
      kind: "pinned-package",
      runner: "bun",
      packageName: "create-vite",
      version: "9.1.2",
      presetArguments: ["--template", "react-ts"],
    },
    requiresTool: "bunx",
    produces: ["package.json", "index.html", "src/main.tsx", "tsconfig.json"],
  }),
  decodeScaffoldEntry({
    id: "cross-platform-app",
    displayName: "Cross-platform app",
    summary: "One TypeScript app that runs on iOS, Android, and the web.",
    target: "cross-platform-app",
    generator: {
      kind: "pinned-package",
      runner: "bun",
      packageName: "create-expo-app",
      version: "4.0.0",
      presetArguments: ["--yes", "--no-install"],
    },
    requiresTool: "bunx",
    produces: ["package.json", "app.json", "app/_layout.tsx"],
  }),
  decodeScaffoldEntry({
    id: "native-apple-app",
    displayName: "Native Swift package",
    summary: "A Swift package the Apple toolchain builds and tests directly.",
    target: "native-apple-app",
    generator: {
      kind: "toolchain",
      tool: "swift",
      presetArguments: ["package", "init", "--type", "executable"],
    },
    requiresTool: "swift",
    produces: ["Package.swift", "Sources", "Tests"],
  }),
];

/** The executables the curated entries need, with no duplicates. */
export function curatedScaffoldTools(
  entries: ReadonlyArray<ScaffoldEntry> = CURATED_SCAFFOLDS,
): ReadonlyArray<string> {
  return [...new Set(entries.map((entry) => entry.requiresTool))].sort();
}

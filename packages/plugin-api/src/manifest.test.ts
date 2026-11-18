import { describe, expect, it } from "vitest";
import {
  decodeExtensionPackageManifest,
  EXTENSION_DEBUG_LAUNCH_PLACEHOLDERS,
  ExtensionLanguageServerClass,
} from "./manifest";

const extensionId = "10000000-0000-4000-8000-000000000001";
const packageId = "20000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "board",
    displayName: "Thread board",
    version: "1.0.0",
    digest,
    source: { kind: "bundled", sourceRef: "app:board" },
    provenance: { reviewed: true },
    license: { kind: "unreported" },
    compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
    declaredCapabilities: [],
    components: [
      {
        id: "board",
        kind: "board",
        displayName: "Thread board",
        declaredCapabilities: [],
        entryPoint: "builtin:board",
      },
    ],
    ...overrides,
  };
}

describe("plugin-api manifest re-exports", () => {
  it("accepts the board component kind through the public package", () => {
    const decoded = decodeExtensionPackageManifest(manifest());
    expect(decoded.components[0]?.kind).toBe("board");
  });

  it("accepts the integration component kind and requires an entry point", () => {
    const decoded = decodeExtensionPackageManifest(
      manifest({
        slug: "github",
        declaredCapabilities: ["network", "credentials"],
        components: [
          {
            id: "integration",
            kind: "integration",
            displayName: "GitHub",
            declaredCapabilities: ["network", "credentials"],
            entryPoint: "builtin:github",
          },
        ],
      }),
    );
    expect(decoded.components[0]?.kind).toBe("integration");

    expect(() =>
      decodeExtensionPackageManifest(
        manifest({
          slug: "github",
          components: [
            {
              id: "integration",
              kind: "integration",
              displayName: "GitHub",
              declaredCapabilities: [],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("accepts a sidebar.destination contribution referencing a real component", () => {
    const decoded = decodeExtensionPackageManifest(
      manifest({
        contributions: [
          {
            point: "sidebar.destination",
            componentId: "board",
            destinationId: "thread-board",
            label: "Thread board",
            modes: ["code"],
          },
        ],
      }),
    );
    expect(decoded.contributions).toHaveLength(1);
  });

  it("rejects a contribution referencing a component that doesn't exist", () => {
    expect(() =>
      decodeExtensionPackageManifest(
        manifest({
          contributions: [
            {
              point: "sidebar.destination",
              componentId: "missing",
              destinationId: "thread-board",
              label: "Thread board",
              modes: ["code"],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("accepts a provider-driver component and requires an entry point", () => {
    const decoded = decodeExtensionPackageManifest(
      manifest({
        slug: "codex",
        components: [
          {
            id: "provider-driver",
            kind: "provider-driver",
            displayName: "Codex",
            declaredCapabilities: [],
            entryPoint: "builtin:provider-driver/codex",
          },
        ],
      }),
    );
    expect(decoded.components[0]?.kind).toBe("provider-driver");

    expect(() =>
      decodeExtensionPackageManifest(
        manifest({
          slug: "codex",
          components: [
            {
              id: "provider-driver",
              kind: "provider-driver",
              displayName: "Codex",
              declaredCapabilities: [],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("accepts appearance-pack and preview-viewer kinds without an entry point", () => {
    const decoded = decodeExtensionPackageManifest(
      manifest({
        slug: "appearance",
        components: [
          {
            id: "appearance-pack",
            kind: "appearance-pack",
            displayName: "Octant appearance",
            declaredCapabilities: [],
          },
          {
            id: "preview-viewers",
            kind: "preview-viewer",
            displayName: "Structured preview",
            declaredCapabilities: [],
          },
        ],
        contributions: [
          {
            point: "appearance.preset",
            componentId: "appearance-pack",
            presetId: "octant",
            label: "Octant",
          },
          {
            point: "preview.viewer",
            componentId: "preview-viewers",
            viewerId: "structured-documents",
            label: "Structured documents",
            kinds: ["pdf", "table", "workbook", "document", "slides"],
          },
        ],
      }),
    );
    expect(decoded.components.map((component) => component.kind)).toEqual([
      "appearance-pack",
      "preview-viewer",
    ]);
    expect(decoded.contributions?.map((contribution) => contribution.point)).toEqual([
      "appearance.preset",
      "preview.viewer",
    ]);
  });

  it("accepts a language-server component through the public package and refuses an unknown class", () => {
    const component = {
      id: "tsserver",
      kind: "language-server",
      displayName: "TypeScript",
      declaredCapabilities: [],
      entryPoint: "builtin:language-server/typescript",
      languageServer: { languages: ["typescript"], launchClass: "static" },
    };
    const decoded = decodeExtensionPackageManifest(
      manifest({ slug: "typescript-language", components: [component] }),
    );
    expect(decoded.components[0]?.languageServer?.launchClass).toBe("static");
    expect(ExtensionLanguageServerClass.literals).toEqual(["static", "repo-tooling"]);
    expect(() =>
      decodeExtensionPackageManifest(
        manifest({
          slug: "typescript-language",
          components: [
            { ...component, languageServer: { languages: ["typescript"], launchClass: "trusted" } },
          ],
        }),
      ),
    ).toThrow();
  });

  it("accepts a debug-adapter component through the public package and names the placeholders it fills", () => {
    const component = {
      id: "adapter",
      kind: "debug-adapter",
      displayName: "Node debugger",
      declaredCapabilities: [],
      entryPoint: "bin/adapter",
      debugAdapter: {
        runtimes: ["node"],
        launchArguments: { program: "{{program}}" },
        importTypes: ["node"],
        debugPorts: 0,
      },
    };
    const decoded = decodeExtensionPackageManifest(
      manifest({ slug: "node-debugger", components: [component] }),
    );
    expect(decoded.components[0]?.debugAdapter?.runtimes).toEqual(["node"]);
    expect(EXTENSION_DEBUG_LAUNCH_PLACEHOLDERS).toEqual([
      "{{program}}",
      "{{args}}",
      "{{cwd}}",
      "{{env}}",
      "{{stopOnEntry}}",
      "{{debugPort}}",
    ]);
  });

  describe("a theme component", () => {
    const theme = {
      supportedModes: ["dark"],
      tokens: { dark: { workspace: "#101418", "text-primary": "#f2f4f8" } },
    };
    const themeManifest = (component: Record<string, unknown>) =>
      manifest({
        slug: "harbor-night",
        compatibility: {
          platforms: ["macos", "linux"],
          modes: ["chat", "work", "code"],
          providerFamilies: [],
        },
        components: [
          {
            id: "harbor-night",
            kind: "theme",
            displayName: "Harbor night",
            declaredCapabilities: [],
            theme,
            ...component,
          },
        ],
      });

    it("accepts colours as data and nothing that runs", () => {
      const decoded = decodeExtensionPackageManifest(themeManifest({}));
      expect(decoded.components[0]?.theme?.tokens.dark?.workspace).toBe("#101418");
    });

    it("refuses a stylesheet, script or remote URL in place of a colour", () => {
      for (const value of [
        "url(https://example.com/x.png)",
        "javascript:alert(1)",
        "<script>",
        "var(--x)",
      ]) {
        expect(() =>
          decodeExtensionPackageManifest(
            themeManifest({ theme: { ...theme, tokens: { dark: { workspace: value } } } }),
          ),
        ).toThrow();
      }
    });

    it("refuses a field the theme schema does not name, such as a font, video or script", () => {
      for (const extra of [
        { fontUrl: "https://example.com/font.woff2" },
        { video: "intro.mp4" },
        { script: "theme.js" },
      ]) {
        expect(() =>
          decodeExtensionPackageManifest(themeManifest({ theme: { ...theme, ...extra } })),
        ).toThrow();
      }
    });

    it("refuses a theme that runs code, asks for a capability, or omits its colours", () => {
      expect(() =>
        decodeExtensionPackageManifest(themeManifest({ entryPoint: "theme.js" })),
      ).toThrow();
      expect(() =>
        decodeExtensionPackageManifest(
          manifest({
            ...themeManifest({ declaredCapabilities: ["network"] }),
            declaredCapabilities: ["network"],
          }),
        ),
      ).toThrow();
      expect(() => decodeExtensionPackageManifest(themeManifest({ theme: undefined }))).toThrow();
      expect(() =>
        decodeExtensionPackageManifest(
          themeManifest({ theme: { supportedModes: ["light"], tokens: theme.tokens } }),
        ),
      ).toThrow();
    });
  });

  describe("a ground component", () => {
    const ground = { characterSet: "·•●", characterDensity: 60 };
    const groundManifest = (component: Record<string, unknown>) =>
      manifest({
        slug: "night-dots",
        compatibility: {
          platforms: ["macos", "linux"],
          modes: ["chat", "work", "code"],
          providerFamilies: [],
        },
        components: [
          {
            id: "dots",
            kind: "ground",
            displayName: "Night dots",
            declaredCapabilities: [],
            ground,
            ...component,
          },
        ],
      });

    it("accepts character values as data and nothing that runs", () => {
      const decoded = decodeExtensionPackageManifest(
        groundManifest({ ground: { ...ground, characterPattern: "rings", characterSpeed: 0 } }),
      );
      expect(decoded.components[0]?.ground?.characterSet).toBe("·•●");
      expect(decoded.components[0]?.ground?.characterPattern).toBe("rings");
    });

    it("refuses a ground that runs code, reads content or asks for a capability", () => {
      expect(() =>
        decodeExtensionPackageManifest(groundManifest({ entryPoint: "ground.js" })),
      ).toThrow();
      expect(() =>
        decodeExtensionPackageManifest(groundManifest({ contentReference: "ground.md" })),
      ).toThrow();
      expect(() =>
        decodeExtensionPackageManifest(groundManifest({ configurationReference: "ground.json" })),
      ).toThrow();
      expect(() =>
        decodeExtensionPackageManifest(
          manifest({
            ...groundManifest({ declaredCapabilities: ["network"] }),
            declaredCapabilities: ["network"],
          }),
        ),
      ).toThrow();
    });

    it("refuses colours, images and any field the ground does not name", () => {
      for (const extra of [
        { color: "#ff0000" },
        { image: "dots.png" },
        { motion: "wave" },
        { script: "ground.js" },
      ]) {
        expect(() =>
          decodeExtensionPackageManifest(groundManifest({ ground: { ...ground, ...extra } })),
        ).toThrow();
      }
    });

    it("refuses an emoji set, an empty set, a speed past 100 and an unknown pattern", () => {
      for (const bad of [
        { characterSet: "🙂" },
        { characterSet: "" },
        { characterSpeed: 101 },
        { characterPattern: "spiral" },
      ]) {
        expect(() =>
          decodeExtensionPackageManifest(groundManifest({ ground: { ...ground, ...bad } })),
        ).toThrow();
      }
    });

    it("refuses a ground component without its values, and values on another kind", () => {
      expect(() => decodeExtensionPackageManifest(groundManifest({ ground: undefined }))).toThrow();
      expect(() =>
        decodeExtensionPackageManifest(groundManifest({ kind: "ui-surface" })),
      ).toThrow();
    });
  });

  it("rejects an unknown contribution point through the public package", () => {
    expect(() =>
      decodeExtensionPackageManifest(
        manifest({
          contributions: [
            {
              point: "marketplace.slot",
              componentId: "board",
            },
          ],
        }),
      ),
    ).toThrow();
  });
});

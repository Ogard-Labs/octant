import { describe, expect, it } from "vitest";
import {
  decodeExtensionActivationState,
  decodeExtensionComponentQualifiedId,
  decodeExtensionPackageManifest,
  decodeExtensionSelection,
} from "./extensions";

const extensionId = "10000000-0000-4000-8000-000000000001";
const packageId = "20000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;

function manifest() {
  return {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "build-tools",
    displayName: "Build Tools",
    version: "1.2.3",
    digest,
    source: { kind: "catalog", catalogId: "octant-curated", entryId: "build-tools" },
    provenance: {
      canonicalUrl: "https://example.com/build-tools",
      publisher: "Example Publisher",
      reviewed: true,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: {
      app: { minimum: "0.1.0", maximumExclusive: "2.0.0" },
      platforms: ["macos"],
      modes: ["code", "work"],
      providerFamilies: ["openai-compatible", "ollama"],
    },
    declaredCapabilities: ["filesystem", "mcp", "network"],
    primaryComponentId: "instructions",
    components: [
      {
        id: "instructions",
        kind: "skill-instructions",
        skillName: "3d-modeling",
        displayName: "Build guidance",
        declaredCapabilities: [],
      },
      {
        id: "server",
        kind: "mcp-server",
        displayName: "Build MCP",
        declaredCapabilities: ["mcp", "filesystem"],
        entryPoint: "entry-server",
      },
      {
        id: "remote-server",
        kind: "mcp-server",
        displayName: "Remote MCP",
        declaredCapabilities: ["mcp", "network"],
        configurationReference: "config-server",
      },
      {
        id: "build-project",
        kind: "mcp-tool",
        displayName: "Build project",
        declaredCapabilities: ["filesystem"],
        parentComponentId: "server",
      },
    ],
  };
}

function languageServerManifest(
  languageServer: Record<string, unknown> = {
    languages: ["typescript", "javascript"],
    launchClass: "static",
  },
) {
  return {
    ...manifest(),
    slug: "typescript-language",
    declaredCapabilities: [],
    primaryComponentId: "tsserver",
    compatibility: { platforms: ["macos", "linux"], modes: ["code"], providerFamilies: [] },
    components: [
      {
        id: "tsserver",
        kind: "language-server",
        displayName: "TypeScript",
        declaredCapabilities: [],
        entryPoint: "entry-tsserver",
        languageServer,
      },
    ],
  };
}

function debugAdapterDeclaration(overrides: Record<string, unknown> = {}) {
  return {
    runtimes: ["node"],
    launchArguments: {
      type: "node",
      program: "{{program}}",
      args: "{{args}}",
      cwd: "{{cwd}}",
      env: "{{env}}",
      stopOnEntry: "{{stopOnEntry}}",
      inspector: { port: "{{debugPort}}", host: "127.0.0.1" },
      skipFiles: ["<node_internals>/**"],
    },
    importTypes: ["node", "pwa-node"],
    debugPorts: 1,
    ...overrides,
  };
}

function debugAdapterManifest(debugAdapter: Record<string, unknown> = debugAdapterDeclaration()) {
  return {
    ...manifest(),
    slug: "node-debugger",
    declaredCapabilities: ["filesystem", "shell", "network"],
    primaryComponentId: "adapter",
    compatibility: { platforms: ["macos", "linux"], modes: ["code"], providerFamilies: [] },
    components: [
      {
        id: "adapter",
        kind: "debug-adapter",
        displayName: "Node debugger",
        declaredCapabilities: ["filesystem", "shell", "network"],
        entryPoint: "bin/node-debug-adapter",
        debugAdapter,
      },
    ],
  };
}

describe("extension package contracts", () => {
  it("strictly decodes a provider-neutral manifest", () => {
    const decoded = decodeExtensionPackageManifest(manifest());
    expect(decoded.extensionId).toBe(extensionId);
    expect(decoded.components).toHaveLength(4);
    expect(decoded.components[0]?.skillName).toBe("3d-modeling");
  });

  it("allows a supervised stdio MCP server to bind executable and configuration receipts", () => {
    const value = structuredClone(manifest()) as unknown as {
      components: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    value.components[1] = {
      ...value.components[1]!,
      configurationReference: "config-server",
    };

    expect(decodeExtensionPackageManifest(value).components[1]).toMatchObject({
      entryPoint: "entry-server",
      configurationReference: "config-server",
    });
  });

  it("qualifies components with the existing ToolExtensionId contract", () => {
    expect(decodeExtensionComponentQualifiedId(`${extensionId}/instructions`)).toBe(
      `${extensionId}/instructions`,
    );
    expect(
      decodeExtensionComponentQualifiedId("00000000-0000-0000-0000-000000000000/instructions"),
    ).toBe("00000000-0000-0000-0000-000000000000/instructions");
    expect(() =>
      decodeExtensionComponentQualifiedId("------------------------------------/instructions"),
    ).toThrow();
  });

  it("rejects SemVer prerelease numeric identifiers with leading zeroes", () => {
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        version: "1.0.0-01",
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        components: [
          {
            id: "server",
            kind: "mcp-server",
            skillName: "not-a-skill",
            displayName: "Server",
            declaredCapabilities: ["mcp"],
            entryPoint: "entry-server",
          },
        ],
      }),
    ).toThrow();
  });

  it("compares large SemVer numeric identifiers exactly", () => {
    expect(
      decodeExtensionPackageManifest({
        ...manifest(),
        compatibility: {
          ...manifest().compatibility,
          app: {
            minimum: "9007199254740992.0.0",
            maximumExclusive: "9007199254740993.0.0",
          },
        },
      }).compatibility.app,
    ).toEqual({
      minimum: "9007199254740992.0.0",
      maximumExclusive: "9007199254740993.0.0",
    });
    expect(
      decodeExtensionPackageManifest({
        ...manifest(),
        compatibility: {
          ...manifest().compatibility,
          app: {
            minimum: "1.0.0-9007199254740992",
            maximumExclusive: "1.0.0-9007199254740993",
          },
        },
      }).compatibility.app,
    ).toEqual({
      minimum: "1.0.0-9007199254740992",
      maximumExclusive: "1.0.0-9007199254740993",
    });
  });

  it("rejects unknown fields, malformed identity/version/digest, and incompatible components", () => {
    expect(() => decodeExtensionPackageManifest({ ...manifest(), credential: "secret" })).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({ ...manifest(), extensionId: "not-a-uuid" }),
    ).toThrow();
    expect(() => decodeExtensionPackageManifest({ ...manifest(), version: "latest" })).toThrow();
    expect(() => decodeExtensionPackageManifest({ ...manifest(), digest: "sha256:abc" })).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        compatibility: {
          ...manifest().compatibility,
          app: { minimum: "2.0.0", maximumExclusive: "1.0.0" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        components: [
          {
            id: "instructions",
            kind: "skill-instructions",
            displayName: "Build guidance",
            declaredCapabilities: [],
            entryPoint: "must-not-execute",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        components: [
          {
            id: "tool",
            kind: "mcp-tool",
            displayName: "Orphan tool",
            declaredCapabilities: ["mcp"],
            parentComponentId: "missing-server",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        components: [
          {
            id: "server",
            kind: "mcp-server",
            displayName: "Capability escalation",
            declaredCapabilities: ["shell"],
            entryPoint: "entry-server",
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts non-executable appearance-pack, preview-viewer, and ui-surface kinds", () => {
    const decoded = decodeExtensionPackageManifest({
      ...manifest(),
      declaredCapabilities: [],
      primaryComponentId: "appearance",
      components: [
        {
          id: "appearance",
          kind: "appearance-pack",
          displayName: "Octant appearance",
          declaredCapabilities: [],
        },
        {
          id: "preview",
          kind: "preview-viewer",
          displayName: "Structured preview",
          declaredCapabilities: [],
        },
        {
          id: "surface",
          kind: "ui-surface",
          displayName: "Workspace surface",
          declaredCapabilities: [],
        },
      ],
    });
    expect(decoded.components.map((component) => component.kind)).toEqual([
      "appearance-pack",
      "preview-viewer",
      "ui-surface",
    ]);
  });

  it("accepts an executable provider-driver and rejects one without an entry point", () => {
    const decoded = decodeExtensionPackageManifest({
      ...manifest(),
      slug: "codex",
      declaredCapabilities: [],
      primaryComponentId: "provider-driver",
      components: [
        {
          id: "provider-driver",
          kind: "provider-driver",
          displayName: "Codex CLI",
          declaredCapabilities: [],
          entryPoint: "builtin:provider-driver/codex",
        },
      ],
    });
    expect(decoded.components[0]?.kind).toBe("provider-driver");

    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        slug: "codex",
        declaredCapabilities: [],
        primaryComponentId: "provider-driver",
        components: [
          {
            id: "provider-driver",
            kind: "provider-driver",
            displayName: "Codex CLI",
            declaredCapabilities: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts a desktop-provider only as an executable component with an entry point", () => {
    const desktopProvider = (entryPoint?: string) =>
      decodeExtensionPackageManifest({
        ...manifest(),
        slug: "host-local-desktop",
        declaredCapabilities: ["computer-use"],
        primaryComponentId: "desktop-provider",
        components: [
          {
            id: "desktop-provider",
            kind: "desktop-provider",
            displayName: "Host-local desktop",
            declaredCapabilities: ["computer-use"],
            ...(entryPoint === undefined ? {} : { entryPoint }),
          },
        ],
      });
    expect(desktopProvider("builtin:desktop-provider/host-local").components[0]?.kind).toBe(
      "desktop-provider",
    );
    expect(() => desktopProvider()).toThrow();
  });

  it("accepts an executable language server that declares its languages and launch class", () => {
    const decoded = decodeExtensionPackageManifest(languageServerManifest());
    expect(decoded.components[0]).toMatchObject({
      kind: "language-server",
      entryPoint: "entry-tsserver",
      languageServer: { languages: ["typescript", "javascript"], launchClass: "static" },
    });
    expect(
      decodeExtensionPackageManifest(
        languageServerManifest({ languages: ["rust"], launchClass: "repo-tooling" }),
      ).components[0]?.languageServer?.launchClass,
    ).toBe("repo-tooling");
  });

  it("refuses a language server whose class, languages, or executable shape is not one Octant knows", () => {
    // The class decides confinement, so a class this host cannot enforce is
    // refused when the manifest is read rather than mapped to a nearby one.
    for (const declaration of [
      { languages: ["typescript"], launchClass: "unrestricted" },
      { languages: ["typescript"], launchClass: "static", network: "unrestricted" },
      { languages: [], launchClass: "static" },
      { languages: ["Type Script"], launchClass: "static" },
      { languages: ["typescript"] },
    ]) {
      expect(() =>
        decodeExtensionPackageManifest(languageServerManifest(declaration as never)),
      ).toThrow();
    }
    const [component] = languageServerManifest().components;
    expect(() =>
      decodeExtensionPackageManifest({
        ...languageServerManifest(),
        components: [{ ...component, entryPoint: undefined }],
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...languageServerManifest(),
        components: [{ ...component, languageServer: undefined }],
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        components: [
          {
            id: "server",
            kind: "mcp-server",
            displayName: "Build MCP",
            declaredCapabilities: ["mcp"],
            entryPoint: "entry-server",
            languageServer: { languages: ["typescript"], launchClass: "static" },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...languageServerManifest(),
        components: [{ ...component, kind: "debug-adapter" }],
      }),
    ).toThrow();
  });

  it("accepts an executable debug adapter whose launch body fills only whole placeholders", () => {
    const decoded = decodeExtensionPackageManifest(debugAdapterManifest());
    expect(decoded.components[0]).toMatchObject({
      kind: "debug-adapter",
      entryPoint: "bin/node-debug-adapter",
      debugAdapter: { runtimes: ["node"], importTypes: ["node", "pwa-node"], debugPorts: 1 },
    });
    // An adapter that needs no port declares none and names no port.
    expect(
      decodeExtensionPackageManifest(
        debugAdapterManifest(
          debugAdapterDeclaration({
            runtimes: ["python"],
            launchArguments: { program: "{{program}}", args: "{{args}}", justMyCode: true },
            importTypes: [],
            debugPorts: 0,
          }),
        ),
      ).components[0]?.debugAdapter?.debugPorts,
    ).toBe(0);
    // An adapter that debugs the program's children names how it announces one.
    for (const childAnnouncement of [
      { kind: "event", event: "debugpyAttach" },
      { kind: "start-debugging" },
    ]) {
      expect(
        decodeExtensionPackageManifest(
          debugAdapterManifest(debugAdapterDeclaration({ childSessions: 1, childAnnouncement })),
        ).components[0]?.debugAdapter,
      ).toMatchObject({ childSessions: 1, childAnnouncement });
    }
  });

  it("refuses a debug adapter declaration with unknown fields, in-string placeholders, or an unfilled port", () => {
    const refused: ReadonlyArray<Record<string, unknown>> = [
      // Unknown fields are refused, never ignored.
      debugAdapterDeclaration({ attach: true }),
      // A placeholder spliced into a longer string could carry a configuration's
      // text into another value.
      debugAdapterDeclaration({
        launchArguments: { program: "{{program}}", runtimeArgs: ["--inspect={{debugPort}}"] },
      }),
      debugAdapterDeclaration({
        launchArguments: { program: "{{cwd}}/{{program}}" },
        debugPorts: 0,
      }),
      debugAdapterDeclaration({ launchArguments: { program: "node {{program}}" }, debugPorts: 0 }),
      // Only the six placeholders Octant fills exist.
      debugAdapterDeclaration({
        launchArguments: { program: "{{program}}", home: "{{home}}" },
        debugPorts: 0,
      }),
      debugAdapterDeclaration({
        launchArguments: { "{{program}}": "{{program}}" },
        debugPorts: 0,
      }),
      // The launch body runs the program the person confirmed, so it names it.
      debugAdapterDeclaration({ launchArguments: { args: "{{args}}" }, debugPorts: 0 }),
      // A port the adapter never receives, or one it uses without declaring.
      debugAdapterDeclaration({ launchArguments: { program: "{{program}}" }, debugPorts: 1 }),
      debugAdapterDeclaration({ debugPorts: 0 }),
      debugAdapterDeclaration({ debugPorts: 2 }),
      // The body is a JSON object of at most 8 KiB.
      debugAdapterDeclaration({ launchArguments: ["{{program}}"], debugPorts: 0 }),
      debugAdapterDeclaration({
        launchArguments: { program: "{{program}}", padding: "x".repeat(8_192) },
        debugPorts: 0,
      }),
      debugAdapterDeclaration({ runtimes: [] }),
      debugAdapterDeclaration({ runtimes: ["Node.js"] }),
      debugAdapterDeclaration({
        importTypes: Array.from({ length: 9 }, (_, index) => `type-${index}`),
      }),
      // Children are declared together with how they are announced, or not at all.
      debugAdapterDeclaration({ childSessions: 1 }),
      debugAdapterDeclaration({ childAnnouncement: { kind: "start-debugging" } }),
      debugAdapterDeclaration({
        childSessions: 0,
        childAnnouncement: { kind: "event", event: "debugpyAttach" },
      }),
      debugAdapterDeclaration({ childSessions: 2, childAnnouncement: { kind: "start-debugging" } }),
      debugAdapterDeclaration({
        childSessions: 1,
        childAnnouncement: { kind: "event", event: "debugpy attach" },
      }),
      debugAdapterDeclaration({
        childSessions: 1,
        childAnnouncement: { kind: "request", command: "attach" },
      }),
    ];
    for (const declaration of refused) {
      expect(() => decodeExtensionPackageManifest(debugAdapterManifest(declaration))).toThrow();
    }
    const [component] = debugAdapterManifest().components;
    expect(() =>
      decodeExtensionPackageManifest({
        ...debugAdapterManifest(),
        components: [{ ...component, debugAdapter: undefined }],
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...debugAdapterManifest(),
        components: [{ ...component, entryPoint: undefined }],
      }),
    ).toThrow();
    const [server] = languageServerManifest().components;
    expect(() =>
      decodeExtensionPackageManifest({
        ...languageServerManifest(),
        components: [{ ...server, debugAdapter: debugAdapterDeclaration() }],
      }),
    ).toThrow();
  });

  it("refuses a debug adapter launch body that is not plain JSON", () => {
    const withPrototypeKey = JSON.parse(
      '{"program":"{{program}}","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    for (const launchArguments of [
      withPrototypeKey,
      { program: "{{program}}", timeout: Number.POSITIVE_INFINITY },
      { program: "{{program}}", when: new Date(0) },
    ]) {
      expect(() =>
        decodeExtensionPackageManifest(
          debugAdapterManifest(debugAdapterDeclaration({ launchArguments, debugPorts: 0 })),
        ),
      ).toThrow();
    }
  });

  it("rejects an appearance-pack that claims an executable entry point", () => {
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        declaredCapabilities: [],
        primaryComponentId: "appearance",
        components: [
          {
            id: "appearance",
            kind: "appearance-pack",
            displayName: "Octant appearance",
            declaredCapabilities: [],
            entryPoint: "must-not-execute",
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts every renderer contribution point on the current manifest version", () => {
    const decoded = decodeExtensionPackageManifest({
      ...manifest(),
      declaredCapabilities: [],
      primaryComponentId: "surface",
      components: [
        {
          id: "surface",
          kind: "ui-surface",
          displayName: "Renderer surface",
          declaredCapabilities: [],
        },
        {
          id: "appearance",
          kind: "appearance-pack",
          displayName: "Octant appearance",
          declaredCapabilities: [],
        },
        {
          id: "preview",
          kind: "preview-viewer",
          displayName: "Structured preview",
          declaredCapabilities: [],
        },
        {
          id: "board",
          kind: "board",
          displayName: "Thread board",
          declaredCapabilities: [],
          entryPoint: "builtin:board",
        },
      ],
      contributions: [
        {
          point: "sidebar.destination",
          componentId: "board",
          destinationId: "thread-board",
          label: "Thread board",
          modes: ["code"],
        },
        {
          point: "settings.section",
          componentId: "surface",
          sectionId: "github",
          label: "GitHub",
          scope: "host",
          keywords: "github",
        },
        {
          point: "workspace.tab",
          componentId: "surface",
          tabId: "preview",
          label: "Preview",
          modes: ["work", "code"],
        },
        {
          point: "thread.pane",
          componentId: "surface",
          paneId: "pull-request",
          label: "Pull request",
          modes: ["code"],
        },
        {
          point: "preview.viewer",
          componentId: "preview",
          viewerId: "structured-documents",
          label: "Structured documents",
          kinds: ["pdf", "table", "workbook", "document", "slides"],
        },
        {
          point: "appearance.preset",
          componentId: "appearance",
          presetId: "octant",
          label: "Octant",
        },
        {
          point: "board.view",
          componentId: "board",
          viewId: "thread-status",
          label: "Thread board",
          modes: ["work", "code"],
        },
      ],
    });
    expect(decoded.manifestVersion).toBe(1);
    expect(decoded.contributions?.map((contribution) => contribution.point)).toEqual([
      "sidebar.destination",
      "settings.section",
      "workspace.tab",
      "thread.pane",
      "preview.viewer",
      "appearance.preset",
      "board.view",
    ]);
  });

  it("rejects an unknown contribution point so a future host cannot silently accept it", () => {
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        declaredCapabilities: [],
        primaryComponentId: "surface",
        components: [
          {
            id: "surface",
            kind: "ui-surface",
            displayName: "Renderer surface",
            declaredCapabilities: [],
          },
        ],
        contributions: [
          {
            point: "composer.palette",
            componentId: "surface",
            commandId: "open-preview",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a board.view that names Chat, which has no board", () => {
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        declaredCapabilities: [],
        primaryComponentId: "board",
        components: [
          {
            id: "board",
            kind: "board",
            displayName: "Thread board",
            declaredCapabilities: [],
            entryPoint: "builtin:board",
          },
        ],
        contributions: [
          {
            point: "board.view",
            componentId: "board",
            viewId: "thread-status",
            label: "Thread board",
            modes: ["chat"],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("extension state and selection contracts", () => {
  it("keeps lifecycle dimensions independent", () => {
    const state = decodeExtensionActivationState({
      installed: true,
      trusted: false,
      pluginDesired: true,
      componentDesired: true,
      compatible: true,
      policyAllowed: true,
      quarantined: true,
      draining: false,
      broken: false,
      unavailable: false,
      interrupted: false,
      waiting: false,
    });
    expect(state).toMatchObject({ installed: true, trusted: false, quarantined: true });
  });

  it("treats structured references as data and rejects authority-shaped excess fields", () => {
    const selection = {
      kind: "plugin",
      extensionId,
      packageId,
      componentId: "instructions",
      packageVersion: "1.2.3",
      packageDigest: digest,
      catalogEpoch: `sha256:${"c".repeat(64)}`,
      origin: { kind: "draft", reference: "draft-opaque-1" },
    };
    expect(decodeExtensionSelection(selection)).toEqual(selection);
    expect(() =>
      decodeExtensionSelection({
        ...selection,
        authority: { kind: "trusted-extension", extensionId },
      }),
    ).toThrow();
    const { packageId: _packageId, ...withoutPackageId } = selection;
    expect(() => decodeExtensionSelection(withoutPackageId)).toThrow();
    expect(() => decodeExtensionSelection({ ...selection, catalogEpoch: "stale" })).toThrow();
  });
});

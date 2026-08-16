import type { ExtensionContentDigest } from "@octant/contracts/extensions";
import type { ExtensionSource } from "@octant/contracts/extensions";
import { normalizeCodexPluginPackage } from "./codexPluginIngestion";
import type { CodexPluginPackageInput } from "./codexPluginIngestion";
import {
  fetchPinnedUpstreamPackage,
  type PinnedUpstreamPackageReference,
} from "./pinnedUpstreamPackageFetcher";
import type { CuratedBuildIosAppsCatalogSource } from "./curatedBuildIosAppsCatalog";

/**
 * Test-only mock upstream package files. Mirrors the structure of the real
 * `openai/build-ios-apps` package: a plugin manifest, an MCP declaration with
 * a floating `@latest` executable (which the ingestion filters out), skill
 * instructions, references, scripts, assets, and a README. The content is
 * minimal but exercises every code path.
 */
export const MOCK_BUILD_IOS_APPS_FILES: Readonly<Record<string, string>> = {
  "plugins/build-ios-apps/.codex-plugin/plugin.json": JSON.stringify({
    name: "build-ios-apps",
    version: "0.1.2",
    description:
      "Build iOS apps with workflows for App Intents, SwiftUI UI work, Simulator mirroring, performance profiling, leak investigation, and simulator debugging.",
    author: { name: "OpenAI", url: "https://openai.com/" },
    homepage: "https://openai.com/",
    repository: "https://github.com/openai/plugins",
    license: "MIT",
    keywords: ["ios", "swift", "swiftui", "xcode"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: "Build iOS Apps",
      shortDescription: "Build, refine, and debug iOS apps",
      longDescription: "Use Build iOS Apps to build or refactor SwiftUI UI.",
      developerName: "OpenAI",
      category: "Developer Tools",
      capabilities: ["Interactive", "Read", "Write"],
      websiteURL: "https://openai.com/",
      privacyPolicyURL: "https://openai.com/policies/privacy-policy/",
      termsOfServiceURL: "https://openai.com/policies/terms-of-use/",
      defaultPrompt: ["Build or debug an iOS app with SwiftUI."],
      brandColor: "#0A84FF",
      composerIcon: "./assets/build-ios-apps-small.svg",
      logo: "./assets/app-icon.png",
      screenshots: [],
    },
  }),
  "plugins/build-ios-apps/.mcp.json": JSON.stringify({
    mcpServers: {
      xcodebuildmcp: {
        command: "npx",
        args: ["-y", "xcodebuildmcp@latest", "mcp"],
        env: { XCODEBUILDMCP_ENABLED_WORKFLOWS: "simulator,ui-automation,debugging,logging" },
      },
    },
  }),
  "plugins/build-ios-apps/README.md": "# Build iOS Apps\n",
  "plugins/build-ios-apps/assets/app-icon.png": "PNG-BYTES",
  "plugins/build-ios-apps/assets/build-ios-apps-small.svg": "<svg></svg>",
  "plugins/build-ios-apps/skills/swiftui-ui-patterns/SKILL.md":
    "---\nname: swiftui-ui-patterns\ndescription: Implement and review SwiftUI UI patterns.\n---\n\n# SwiftUI UI Patterns\n\nChoose a track based on your goal.\n",
  "plugins/build-ios-apps/skills/swiftui-ui-patterns/references/grids.md": "# Grids\n",
  "plugins/build-ios-apps/skills/swiftui-ui-patterns/references/forms.md": "# Forms\n",
  "plugins/build-ios-apps/skills/swiftui-ui-patterns/agents/openai.yaml": "name: test\n",
  "plugins/build-ios-apps/skills/ios-debugger-agent/SKILL.md":
    "---\nname: ios-debugger-agent\ndescription: Build, run, and debug iOS apps on Simulator.\n---\n\n# iOS Debugger Agent\n\nUse XcodeBuildMCP to build and run.\n",
  "plugins/build-ios-apps/skills/ios-debugger-agent/agents/openai.yaml": "name: test\n",
  "plugins/build-ios-apps/skills/ios-memgraph-leaks/SKILL.md":
    "---\nname: ios-memgraph-leaks\ndescription: Capture and inspect iOS leaks and memgraphs.\n---\n\n# iOS Memgraph Leaks\n\nCapture a memgraph from the running simulator.\n",
  "plugins/build-ios-apps/skills/ios-memgraph-leaks/scripts/capture_sim_memgraph.sh":
    "#!/bin/bash\necho capture\n",
  "plugins/build-ios-apps/skills/ios-memgraph-leaks/scripts/summarize_memgraph_leaks.py":
    "print('leaks')\n",
  "plugins/build-ios-apps/skills/ios-memgraph-leaks/agents/openai.yaml": "name: test\n",
  "plugins/build-ios-apps/skills/ios-app-intents/SKILL.md":
    "---\nname: ios-app-intents\ndescription: Design App Intents and App Shortcuts.\n---\n\n# iOS App Intents\n\nExpose the smallest useful action surface.\n",
  "plugins/build-ios-apps/skills/ios-app-intents/references/code-templates.md": "# Templates\n",
  "plugins/build-ios-apps/skills/ios-app-intents/agents/openai.yaml": "name: test\n",
  "plugins/build-ios-apps/skills/ios-ettrace-performance/SKILL.md":
    "---\nname: ios-ettrace-performance\ndescription: Capture and interpret ETTrace profiles.\n---\n\n# iOS ETTrace Performance\n\nCapture a focused ETTrace profile.\n",
  "plugins/build-ios-apps/skills/ios-ettrace-performance/agents/openai.yaml": "name: test\n",
  "plugins/build-ios-apps/skills/ios-simulator-browser/SKILL.md":
    "---\nname: ios-simulator-browser\ndescription: Mirror an iOS Simulator into the browser.\n---\n\n# iOS Simulator Browser\n\nStart serve-sim in a long-running terminal.\n",
  "plugins/build-ios-apps/skills/ios-simulator-browser/agents/openai.yaml": "name: test\n",
  "plugins/build-ios-apps/skills/swiftui-liquid-glass/SKILL.md":
    "---\nname: swiftui-liquid-glass\ndescription: Implement iOS 26+ SwiftUI Liquid Glass UI.\n---\n\n# SwiftUI Liquid Glass\n\nUse native Liquid Glass APIs.\n",
  "plugins/build-ios-apps/skills/swiftui-liquid-glass/agents/openai.yaml": "name: test\n",
  "plugins/build-ios-apps/skills/swiftui-performance-audit/SKILL.md":
    "---\nname: swiftui-performance-audit\ndescription: Audit SwiftUI runtime performance.\n---\n\n# SwiftUI Performance Audit\n\nDiagnose SwiftUI performance from code first.\n",
  "plugins/build-ios-apps/skills/swiftui-performance-audit/agents/openai.yaml": "name: test\n",
  "plugins/build-ios-apps/skills/swiftui-view-refactor/SKILL.md":
    "---\nname: swiftui-view-refactor\ndescription: Refactor SwiftUI views.\n---\n\n# SwiftUI View Refactor\n\nApply modern SwiftUI patterns.\n",
  "plugins/build-ios-apps/skills/swiftui-view-refactor/agents/openai.yaml": "name: test\n",
  "plugins/build-macos-apps/.codex-plugin/plugin.json": "{}",
};

export const MOCK_UPSTREAM_REFERENCE: PinnedUpstreamPackageReference = {
  owner: "openai",
  repository: "plugins",
  packagePath: "plugins/build-ios-apps",
  commit: "cd0fccd4ed62dded584c16246685b232d7bfe7f6",
};

export const MOCK_CATALOG_SOURCE = {
  kind: "catalog" as const,
  catalogId: "octant-curated" as never,
  entryId: "build-ios-apps" as never,
};

export const MOCK_CURATION_BINDING = {
  catalogId: "octant-curated",
  entryId: "build-ios-apps",
  sourceCommit: "cd0fccd4ed62dded584c16246685b232d7bfe7f6",
  reviewedAt: "2026-07-30T00:00:00.000Z",
  expectedDigest: "", // Set by createMockCatalogSource after computing the digest.
};

/**
 * Create a fake `fetch` that serves the mock upstream files through the
 * GitHub tree API + raw content endpoints.
 */
export function createMockFetch(
  files: Readonly<Record<string, string>> = MOCK_BUILD_IOS_APPS_FILES,
): {
  fetch: typeof globalThis.fetch;
  calls: Array<string>;
} {
  const calls: Array<string> = [];
  const treePaths = Object.keys(files);
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/git/trees/")) {
      return Response.json({
        sha: MOCK_UPSTREAM_REFERENCE.commit,
        truncated: false,
        tree: treePaths.map((path) => ({
          path,
          mode: "100644",
          type: "blob",
          sha: "0".repeat(40),
          size: files[path]?.length ?? 0,
        })),
      });
    }
    const prefix = `https://raw.githubusercontent.com/${MOCK_UPSTREAM_REFERENCE.owner}/${MOCK_UPSTREAM_REFERENCE.repository}/${MOCK_UPSTREAM_REFERENCE.commit}/`;
    if (!url.startsWith(prefix)) return new Response("unexpected", { status: 400 });
    const path = url.slice(prefix.length);
    const content = files[path];
    if (content === undefined) return new Response("not found", { status: 404 });
    return new Response(new TextEncoder().encode(content));
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

/**
 * Compute the expected digest for a mock package by fetching it through the
 * fake fetch and normalizing with the curation binding active.
 */
export async function computeMockExpectedDigest(
  files: Readonly<Record<string, string>> = MOCK_BUILD_IOS_APPS_FILES,
): Promise<ExtensionContentDigest> {
  const { fetch } = createMockFetch(files);
  const fetched = await fetchPinnedUpstreamPackage({
    reference: MOCK_UPSTREAM_REFERENCE,
    source: MOCK_CATALOG_SOURCE,
    appVersion: "1.0.0",
    platform: "darwin",
    fetch,
  });
  const digest = "sha256:" + "0".repeat(64);
  const binding = { ...MOCK_CURATION_BINDING, expectedDigest: digest };
  const normalized = normalizeCodexPluginPackage({
    source: fetched.source,
    format: fetched.format,
    archiveBytes: fetched.archiveBytes,
    manifest: fetched.manifest,
    entries: fetched.entries,
    expectedDigest: digest as never,
    curationBinding: binding,
    appVersion: "1.0.0",
    platform: "darwin",
  });
  return (normalized.manifest as { digest: ExtensionContentDigest }).digest;
}

/**
 * Create a complete mock catalog source with a pre-computed expected digest.
 */
export async function createMockCatalogSource(files?: Readonly<Record<string, string>>): Promise<{
  catalogSource: CuratedBuildIosAppsCatalogSource;
  mockFetch: typeof globalThis.fetch;
  expectedDigest: ExtensionContentDigest;
}> {
  const mockFiles = files ?? MOCK_BUILD_IOS_APPS_FILES;
  const { fetch: mockFetch } = createMockFetch(mockFiles);
  const expectedDigest = await computeMockExpectedDigest(mockFiles);
  return {
    catalogSource: {
      packageFormat: "codex",
      source: MOCK_CATALOG_SOURCE,
      upstreamReference: MOCK_UPSTREAM_REFERENCE,
      expectedDigest,
      curationBinding: { ...MOCK_CURATION_BINDING, expectedDigest },
      displayMetadata: {
        name: "build-ios-apps",
        version: "0.1.2",
        displayName: "Build iOS Apps",
        description:
          "Build iOS apps with workflows for App Intents, SwiftUI UI work, Simulator mirroring, performance profiling, leak investigation, and simulator debugging.",
      } as never,
    },
    mockFetch,
    expectedDigest,
  };
}

/**
 * Create a mock catalog source for an updated package version (used in
 * update/quarantine scenarios). The files differ from the base to produce a
 * different digest.
 */
export async function createMockUpdateCatalogSource(
  overrides: Readonly<Record<string, string>>,
): Promise<{
  catalogSource: CuratedBuildIosAppsCatalogSource;
  mockFetch: typeof globalThis.fetch;
  expectedDigest: ExtensionContentDigest;
}> {
  const files = { ...MOCK_BUILD_IOS_APPS_FILES, ...overrides };
  const { fetch: mockFetch } = createMockFetch(files);
  const expectedDigest = await computeMockExpectedDigest(files);
  return {
    catalogSource: {
      packageFormat: "codex",
      source: MOCK_CATALOG_SOURCE,
      upstreamReference: MOCK_UPSTREAM_REFERENCE,
      expectedDigest,
      curationBinding: { ...MOCK_CURATION_BINDING, expectedDigest },
      displayMetadata: {
        name: "build-ios-apps",
        version: "0.1.3",
        displayName: "Build iOS Apps",
        description:
          "Build iOS apps with workflows for App Intents, SwiftUI UI work, Simulator mirroring, performance profiling, leak investigation, and simulator debugging.",
      } as never,
    },
    mockFetch,
    expectedDigest,
  };
}

/**
 * Create a `CodexPluginPackageInput` for a local-folder source with the same
 * mock content. Used for negative tests proving local sources cannot become
 * reviewed.
 */
export async function createMockLocalFolderInput(
  files?: Readonly<Record<string, string>>,
): Promise<CodexPluginPackageInput> {
  const mockFiles = files ?? MOCK_BUILD_IOS_APPS_FILES;
  const { fetch } = createMockFetch(mockFiles);
  const fetched = await fetchPinnedUpstreamPackage({
    reference: MOCK_UPSTREAM_REFERENCE,
    source: MOCK_CATALOG_SOURCE,
    appVersion: "1.0.0",
    platform: "darwin",
    fetch,
  });
  return {
    source: { kind: "local-folder", sourceRef: "local-build-ios-apps" } as ExtensionSource,
    format: fetched.format,
    archiveBytes: fetched.archiveBytes,
    manifest: fetched.manifest,
    entries: fetched.entries,
    curationBinding: MOCK_CURATION_BINDING,
    appVersion: "1.0.0",
    platform: "darwin",
  };
}

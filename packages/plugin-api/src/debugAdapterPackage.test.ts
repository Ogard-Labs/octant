import { describe, expect, it } from "vitest";
import {
  DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH,
  readDebugAdapterPackageDocument,
} from "./debugAdapterPackage";
import { LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH } from "./languageServerPackage";
import { OUTSIDE_PROVIDER_DRIVER_DOCUMENT_PATH } from "./outsideProviderDriver";

function manifest(
  overrides: Record<string, unknown> = {},
  component: Record<string, unknown> = {},
) {
  return {
    manifestVersion: 1,
    slug: "node-debugger",
    displayName: "Node debugger",
    version: "1.0.0",
    provenance: { publisher: "Example Debug", canonicalUrl: "https://example.com/debug" },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos", "linux"], modes: ["code"], providerFamilies: [] },
    declaredCapabilities: ["filesystem", "shell", "network"],
    components: [
      {
        id: "debug-adapter",
        kind: "debug-adapter",
        displayName: "Node debugger",
        declaredCapabilities: ["filesystem", "shell", "network"],
        entryPoint: "bin/node-debug-adapter",
        debugAdapter: {
          runtimes: ["node"],
          launchArguments: {
            program: "{{program}}",
            args: "{{args}}",
            cwd: "{{cwd}}",
            env: "{{env}}",
            stopOnEntry: "{{stopOnEntry}}",
            port: "{{debugPort}}",
          },
          importTypes: ["node"],
          debugPorts: 1,
        },
        ...component,
      },
    ],
    ...overrides,
  };
}

function refusal(value: unknown) {
  const reading = readDebugAdapterPackageDocument(value);
  return reading.status === "refused" ? reading.reason : undefined;
}

describe("debug adapter package schema", () => {
  it("accepts the document an author writes: one debug adapter whose binary is inside the package", () => {
    expect(readDebugAdapterPackageDocument({ manifest: manifest() }).status).toBe("accepted");
    expect(
      readDebugAdapterPackageDocument({
        manifest: manifest({ declaredCapabilities: [] }, { declaredCapabilities: [] }),
      }).status,
    ).toBe("accepted");
  });

  it("is its own document, beside the other packages Octant reads as nothing else", () => {
    expect(DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH).toBe("octant-debug-adapter.json");
    expect(
      new Set([
        DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH,
        LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH,
        OUTSIDE_PROVIDER_DRIVER_DOCUMENT_PATH,
      ]).size,
    ).toBe(3);
  });

  it("refuses a document that states the identity, source, digest, or review Octant sets", () => {
    for (const overrides of [
      { extensionId: "10000000-0000-4000-8000-000000000001" },
      { packageId: "20000000-0000-4000-8000-000000000001" },
      { digest: `sha256:${"a".repeat(64)}` },
      { source: { kind: "bundled", sourceRef: "app:debug" } },
      { provenance: { publisher: "Example", reviewed: true } },
      { provenance: { reviewedAt: "2026-10-27T12:00:00.000Z" } },
    ]) {
      expect(refusal({ manifest: manifest(overrides) })).toBe("host-assigned-field");
    }
  });

  it("refuses an adapter that asks for more than its capsule grants, outside Code, or for a provider", () => {
    for (const capability of ["credentials", "browser", "external-application", "computer-use"]) {
      expect(
        refusal({
          manifest: manifest(
            { declaredCapabilities: ["filesystem", capability] },
            { declaredCapabilities: ["filesystem", capability] },
          ),
        }),
      ).toBe("declares-capabilities");
    }
    expect(
      refusal({
        manifest: manifest({
          compatibility: { platforms: ["linux"], modes: ["code", "work"], providerFamilies: [] },
        }),
      }),
    ).toBe("not-for-code");
    expect(
      refusal({
        manifest: manifest({
          compatibility: { platforms: ["linux"], modes: ["code"], providerFamilies: ["codex"] },
        }),
      }),
    ).toBe("provider-specific");
    expect(
      refusal({
        manifest: manifest({
          contributions: [
            {
              point: "thread.pane",
              componentId: "debug-adapter",
              paneId: "debugger",
              label: "Debugger",
              modes: ["code"],
            },
          ],
        }),
      }),
    ).toBe("declares-contributions");
  });

  it("refuses an entry point outside the package", () => {
    for (const entryPoint of [
      "bin/../../lldb-dap",
      "bin//adapter",
      "bin/./adapter",
      "builtin:debug/node",
    ]) {
      expect(refusal({ manifest: manifest({}, { entryPoint }) })).toBe(
        "entry-point-not-package-relative",
      );
    }
    expect(refusal({ manifest: manifest({}, { entryPoint: "/usr/bin/lldb-dap" }) })).toBe(
      "entry-invalid",
    );
  });

  it("refuses anything but exactly one debug adapter, fields it does not name, and in-string placeholders", () => {
    const base = manifest();
    const adapter = base.components[0];
    expect(
      refusal({
        manifest: { ...base, components: [adapter, { ...adapter, id: "second" }] },
      }),
    ).toBe("not-one-debug-adapter");
    expect(
      refusal({
        manifest: manifest(
          {},
          {
            kind: "language-server",
            debugAdapter: undefined,
            languageServer: { languages: ["javascript"], launchClass: "static" },
          },
        ),
      }),
    ).toBe("not-one-debug-adapter");
    expect(refusal({ manifest: base, arguments: ["--stdio"] })).toBe("entry-invalid");
    expect(
      refusal({
        manifest: manifest(
          {},
          {
            debugAdapter: {
              ...adapter?.debugAdapter,
              launchArguments: { program: "{{program}}", port: "--inspect={{debugPort}}" },
            },
          },
        ),
      }),
    ).toBe("entry-invalid");
  });
});

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ExtensionActivationScope } from "@octant/contracts/extensions";
import { decodeExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { ExtensionActivationService } from "../extensions/extensionActivationService";
import { canvasExportPluginTargets } from "./canvasExportPluginTargets";
import { offerCanvasExportTargets } from "@octant/plugin-host/canvas-export-contributions";

const activation = {
  installed: true,
  trusted: true,
  pluginDesired: true,
  componentDesired: true,
  compatible: true,
  policyAllowed: true,
  quarantined: false,
  draining: false,
  broken: false,
  unavailable: false,
  interrupted: false,
  waiting: false,
};
const resolver = new ExtensionActivationService({
  catalogStatus: () => "available",
  policy: {
    resolve: () => ({
      revision: 0,
      projectRevision: 0,
      threadRevision: 0,
      hostAllowed: true,
      modeAllowed: true,
      projectAllowed: true,
      threadAllowed: true,
      policyAllowed: true,
    }),
  },
});
function snapshot(changes: Partial<typeof activation> = {}, stateVersion = 1) {
  const facts = { ...activation, ...changes };
  return resolver.resolve(
    decodeExtensionSnapshot({
      sequence: 0,
      snapshotAt: "2026-11-07T10:00:00.000Z",
      collisions: [],
      packages: [
        {
          extensionId: "33333333-3333-4333-8333-333333333333",
          packageId: "44444444-4444-4444-8444-444444444444",
          stateVersion,
          activationVersion: 1,
          version: "1.0.0",
          digest: `sha256:${"a".repeat(64)}`,
          source: { kind: "local-folder", sourceRef: "local-export" },
          compatibility: {
            platforms: ["macos", "linux", "windows"],
            modes: ["chat", "work", "code"],
            providerFamilies: [],
          },
          activation: facts,
          diagnostics: [],
          components: [
            {
              component: {
                id: "export",
                kind: "canvas-export-target",
                displayName: "Review copy",
                declaredCapabilities: ["network"],
                entryPoint: "entry:export",
                canvasExport: {
                  contribution: {
                    schemaVersion: 1,
                    kind: "canvas-export-contribution",
                    targetId: "review-copy",
                    label: "Review copy",
                    formats: ["markdown"],
                  },
                  allowedOrigins: ["https://example.test"],
                },
              },
              activation: facts,
              effectiveState: { kind: "effective" },
            },
          ],
        },
      ],
    }),
    {
      scope: Schema.decodeUnknownSync(ExtensionActivationScope)({
        hostId: "local",
        mode: "chat",
        projectId: null,
        threadId: null,
        providerFamily: "canvas-export",
      }),
    },
  );
}
const options = {
  store: { verifiedModuleEntry: vi.fn(async () => undefined) },
  supervisor: undefined,
  runtime: undefined,
  workerEntryPoint: "/host/worker.mjs",
  platform: "darwin" as const,
};
describe("effective plugin export offers", () => {
  it("offers an explicitly trusted and enabled target without loading its entry module", () => {
    const bindings = canvasExportPluginTargets(options, () => snapshot());
    expect(
      offerCanvasExportTargets(
        bindings.map((binding) => ({
          contribution: binding.target.contribution,
          facts: binding.facts,
        })),
      ),
    ).toMatchObject([{ targetId: "review-copy", status: "ready" }]);
    expect(options.store.verifiedModuleEntry).not.toHaveBeenCalled();
  });
  it.each([
    { installed: false },
    { trusted: false },
    { pluginDesired: false },
    { componentDesired: false },
  ])("omits a target when its activation no longer admits it: %j", (changes) => {
    expect(canvasExportPluginTargets(options, () => snapshot(changes))).toHaveLength(0);
  });
});

it("keeps an export approval identity stable across runtime-only package revisions", () => {
  const first = canvasExportPluginTargets(options, () => snapshot({}, 1))[0];
  const running = canvasExportPluginTargets(options, () => snapshot({}, 3))[0];
  expect(first).toBeDefined();
  expect(running?.identity).toBe(first?.identity);
});

it("refuses an activation snapshot that has no stable authorization revision", () => {
  const current = snapshot();
  const packages = current.packages.map((pkg) => {
    const { activationVersion: _version, ...withoutVersion } = pkg;
    return withoutVersion;
  });
  expect(canvasExportPluginTargets(options, () => ({ ...current, packages }))).toEqual([]);
});

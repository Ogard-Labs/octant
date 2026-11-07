import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeCodeThread, decodeWindowId } from "@octant/contracts";
import { ExtensionProviderFamily, ExtensionSource } from "@octant/contracts/extensions";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { AGENT_PLUGINS_PLUGIN_SCHEMA } from "@octant/plugin-host/agent-plugins";
import { CredentialRequests } from "../credentials/credentialRequests";
import { createCodeToolHostPort } from "../credentials/codeToolHost";
import { linearCredentialOperation } from "../plugins/linear/linearCredentialOperation";
import { CommandCredentialBindings } from "../secretStores/commandCredentialBindings";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { loadPluginDirectory } from "./pluginDirectoryLoader";
import { normalizeAgentPluginPackage } from "./agentPluginIngestion";
import { inspectExtensionPackage } from "./packageInspector";
import { ExtensionPackageStore } from "./extensionPackageStore";
import { ExtensionLifecycleService, NOOP_EXTENSION_SUPERVISOR } from "./extensionLifecycleService";
import {
  ExtensionActivationService,
  createLocalExtensionActivationPolicy,
} from "./extensionActivationService";
import { buildCatalogs, createStoredExtensionMaterialLoader } from "./extensionChatResolver";
import { createSelectedExtensionResolver } from "./selectedExtensions";
import { resolveDraftExtensionReference } from "@octant/plugin-host";

const now = "2026-11-07T12:00:00.000Z";
const id = (value: number) => `94000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const thread = decodeCodeThread({
  id: id(1),
  projectId: id(2),
  bindingRevisionId: id(3),
  repositoryId: `repo_${"a".repeat(64)}`,
  checkoutId: id(4),
  title: "Use declared operations",
  lifecycle: "active",
  providerInstanceId: id(5),
  modelId: "model",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/fixture",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "main",
    outcomeKind: "local-implementation",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});
async function removeOwned(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeOwned(join(root, entry.name));
    else await chmod(join(root, entry.name), 0o600);
  }
  await rm(root, { recursive: true, force: true });
}

describe("installed declarative Code tools", () => {
  it("requires install, trust, enable and selection, then cancels a held credential card after disable", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-code-contribution-"));
    const connection = openSqlite(join(root, "journal.sqlite3"));
    const credentials = new CredentialRequests();
    const commands = new CommandCredentialBindings({
      now: () => performance.now(),
      uuid: randomUUID,
      canConfigure: () => true,
      context: async () => undefined,
      pin: async () => undefined,
      execute: async () => {
        throw new Error("No command is declared.");
      },
      record: () => undefined,
      records: [],
    });
    let tools: Awaited<ReturnType<ReturnType<typeof createSelectedExtensionResolver>>> | undefined;
    try {
      const packageRoot = join(root, "package");
      await mkdir(packageRoot);
      await writeFile(
        join(packageRoot, "plugin.json"),
        JSON.stringify({
          $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
          name: "account-tools",
          version: "1.0.0",
          license: "MIT",
          extensions: {
            octant: {
              codeTools: [
                {
                  id: "check",
                  label: "Check account",
                  description: "Check the linked account with person approval.",
                  operationIds: ["linear-account-check"],
                  savedCommandIds: [],
                },
              ],
            },
          },
        }),
      );
      const loaded = await loadPluginDirectory(packageRoot);
      const inspection = inspectExtensionPackage(
        normalizeAgentPluginPackage({
          source: Schema.decodeUnknownSync(ExtensionSource)({
            kind: "local-folder",
            sourceRef: "test-code-tool",
          }),
          format: "directory",
          archiveBytes: loaded.archiveBytes,
          entries: loaded.entries.map((entry) => {
            if (entry.kind === "other") throw new Error("Unexpected fixture file.");
            return { ...entry, kind: entry.kind };
          }),
          appVersion: "0.1.0",
          platform: process.platform,
        }),
      );
      applyMigrations(connection, MIGRATIONS, () => now);
      const registries = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: registries.events,
        projections: registries.projections,
        clock: () => now,
      });
      const store = new ExtensionPackageStore({ dataDirectory: root, uuid: randomUUID });
      await store.initialize();
      const lifecycle = new ExtensionLifecycleService({
        connection,
        journal,
        store,
        supervisor: NOOP_EXTENSION_SUPERVISOR,
        uuid: randomUUID,
        clock: () => now,
      });
      await lifecycle.install(inspection);
      const activation = new ExtensionActivationService({
        policy: createLocalExtensionActivationPolicy({
          project: () => ({ allowed: true, revision: 1 }),
          thread: () => ({ allowed: true, revision: 1 }),
        }),
        catalogStatus: () => "available",
        compatibility: () => true,
      });
      const providerFamily = Schema.decodeUnknownSync(ExtensionProviderFamily)("openai-compatible");
      const scope = {
        hostId: LOCAL_HOST_ID,
        mode: "code" as const,
        projectId: thread.projectId,
        threadId: String(thread.id),
        providerFamily,
      };
      const state = () => {
        const pkg = lifecycle.snapshot().packages[0];
        if (pkg === undefined) throw new Error("Expected installed package.");
        return pkg;
      };
      const effective = () => activation.resolve(lifecycle.snapshot(), { scope });
      expect(effective().packages[0]?.components[0]?.effectiveState.kind).toBe("blocked");
      await lifecycle.setSourceTrust({
        extensionId: state().extensionId,
        expectedStateVersion: state().stateVersion,
        trusted: true,
      });
      expect(effective().packages[0]?.components[0]?.effectiveState.kind).toBe("blocked");
      await lifecycle.setPluginDesired({
        extensionId: state().extensionId,
        expectedStateVersion: state().stateVersion,
        desired: true,
      });
      const component = state().components[0]?.component;
      if (component === undefined) throw new Error("Expected Code contribution.");
      await lifecycle.setComponentDesired({
        extensionId: state().extensionId,
        expectedStateVersion: state().stateVersion,
        componentId: component.id,
        desired: true,
      });
      expect(effective().packages[0]?.components[0]?.effectiveState.kind).toBe("effective");
      expect(
        activation.resolve(lifecycle.snapshot(), { scope: { ...scope, mode: "work" } }).packages[0]
          ?.components[0]?.effectiveState,
      ).toMatchObject({ kind: "blocked", reason: "mode-prohibited" });
      const catalog = buildCatalogs(lifecycle.snapshot(), effective(), {
        mode: "code",
        threadId: String(thread.id),
        projectId: String(thread.projectId),
        threadVersion: 1,
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
      }).addressing;
      const selection = resolveDraftExtensionReference("@account-tools", catalog, "test");
      if (selection.kind !== "selected") throw new Error("Expected selectable Code tool.");
      const windowId = decodeWindowId(id(6));
      const resolver = createSelectedExtensionResolver({
        snapshot: async () => lifecycle.snapshot(),
        resolveEffectiveState: (snapshot, query) => activation.resolve(snapshot, query),
        currentEffectiveState: (query) => activation.resolve(lifecycle.snapshot(), query),
        providerFamily: () => providerFamily,
        materialLoader: createStoredExtensionMaterialLoader(store),
        carriesAppManagedTools: () => true,
        codeToolHost: (input) =>
          createCodeToolHostPort({
            ...input,
            windowId: String(input.windowId),
            readThread: () => thread,
            credentialRequests: credentials,
            commands,
            operations: () => [linearCredentialOperation],
          }),
      });
      expect(await resolver({ mode: "code", thread, selections: [], windowId })).toEqual({
        kind: "resolved",
        context: [],
      });
      tools = await resolver({ mode: "code", thread, selections: [selection.selection], windowId });
      if (tools.kind !== "resolved" || tools.tools === undefined)
        throw new Error(`Expected selected Code tools: ${JSON.stringify(tools)}`);
      const set = tools.tools;
      const name = set.definitions[0]?.name;
      if (name === undefined) throw new Error("Expected qualified tool.");
      expect(name).toMatch(/^octant_plugin_/);
      expect(await set.execute({ name, inputJson: '{"operation":"list"}' })).toMatchObject({
        result: { operations: [{ id: "linear-account-check" }] },
      });
      const held = set.execute({
        name,
        inputJson: '{"operation":"request","id":"linear-account-check"}',
      });
      expect(credentials.view(String(windowId), String(thread.id)).requests).toHaveLength(1);
      await lifecycle.setPluginDesired({
        extensionId: state().extensionId,
        expectedStateVersion: state().stateVersion,
        desired: false,
      });
      credentials.view(String(windowId), String(thread.id));
      expect(await held).toMatchObject({ result: { status: "refused" }, isError: true });
      await set.close?.();
    } finally {
      if (tools?.kind === "resolved") await tools.tools?.close?.();
      commands.close();
      credentials.close();
      connection.close();
      await removeOwned(root);
    }
  });
});

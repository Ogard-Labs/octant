import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeImageGenerationScopeId,
  decodeProjectId,
  decodeWindowId,
  type ImageJob,
  type ProviderInstance,
} from "@octant/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BindingReceiptStore } from "../bindingReceiptStore";
import {
  Persistence,
  makePersistenceLive,
  type PersistenceService,
} from "../persistence/persistenceService";
import { ProjectService } from "../projectService";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { createThreadImageAgentTools, IMAGE_TOOL_NAME } from "./imageAgentTools";
import { ImageGenerationOfferService } from "./imageGenerationOfferService";
import { createKeptImageGenerationChoices } from "./keptImageGenerationChoices";

const now = "2026-11-12T10:00:00.000Z";
const windowId = decodeWindowId("a4000000-0000-4000-8000-000000000001");
const projectId = decodeProjectId("a4000000-0000-4000-8000-000000000010");
const profileId = "a4000000-0000-4000-8000-000000000020" as ProviderInstance["id"];
const threadOne = decodeImageGenerationScopeId("a4000000-0000-4000-8000-000000000031");
const threadTwo = decodeImageGenerationScopeId("a4000000-0000-4000-8000-000000000032");
const outsideProject = decodeImageGenerationScopeId("a4000000-0000-4000-8000-000000000033");
const choice = { profileInstanceId: profileId, modelId: "gpt-image-2" as ImageJob["modelId"] };

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-kept-image-choice-"));
  directories.push(directory);
  return directory;
}

function withPersistence<T>(
  directory: string,
  use: (persistence: PersistenceService) => Promise<T>,
): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        return yield* Effect.promise(() => use(persistence));
      }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now }))),
    ),
  );
}

/** A host as far as a kept image choice goes: Projects on a real journal, and thread memory. */
function host(persistence: PersistenceService) {
  const projects = new ProjectService({
    persistence,
    bindingReceiptStore: new BindingReceiptStore(() => new Uint8Array(32)),
    projectRootPort: { validate: async (_type, path) => ({ canonicalRoot: path }) },
    uuid: randomUUID,
    clock: () => now,
    now: () => 1,
  });
  const kept = createKeptImageGenerationChoices({
    threadChoices: new ImageGenerationOfferService({ uuid: () => "unused", now: () => 1 }),
    projectOf: (scope) =>
      String(scope.scopeId) === String(outsideProject) ? undefined : projectId,
    readProject: (id) => persistence.readProject(id),
    changeProject: async (command) => {
      await projects.executeProject(windowId, command);
    },
  });
  return { projects, kept };
}

function imageProfile(): ProviderInstance {
  return {
    id: profileId,
    displayName: "OpenAI Image",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2" as never],
      defaultModel: "gpt-image-2" as never,
    },
  };
}

/** The image tool as a routine's Work turn in the Project is given it. */
function routineTools(kept: ReturnType<typeof host>["kept"]) {
  const offer = vi.fn(async () => ({ status: "cancelled" }) as const);
  const enqueue = vi.fn(async () => ({ id: "a4000000-0000-4000-8000-000000000040" }) as ImageJob);
  const set = createThreadImageAgentTools({
    windowId: ROUTINE_HOST_SCOPE_ID,
    unattended: true,
    threadKind: "work-thread",
    scopeId: threadTwo,
    offers: { offer },
    kept,
    jobs: {
      enqueue,
      listByScope: () => [],
      whenTerminal: async () =>
        ({ id: "a4000000-0000-4000-8000-000000000040", status: "cancelled" }) as ImageJob,
      readArtifact: async () => {
        throw new Error("No artifact is read here.");
      },
    },
    listInstances: () => [imageProfile()],
    readImageGenerationCustomSources: () => [],
    readsImages: () => false,
  });
  return { offer, enqueue, set };
}

describe("the image choice a Project keeps", () => {
  it("survives a restart, covers every thread of the Project, and lets a routine's turn generate with it", async () => {
    const directory = temporaryDirectory();
    await withPersistence(directory, async (persistence) => {
      const { projects, kept } = host(persistence);
      await projects.executeProject(windowId, {
        kind: "create-chat-project",
        hostId: "local",
        projectId,
        expectedVersion: 0,
        name: "Research",
      });
      expect(routineTools(kept).set).toBeUndefined();

      await kept.remember({ threadKind: "chat-thread", scopeId: threadOne }, choice);
      // The same answer again changes nothing and is not an error.
      await kept.remember({ threadKind: "chat-thread", scopeId: threadOne }, choice);
      expect(persistence.readProject(projectId)).toMatchObject({
        imageGenerationChoice: choice,
        version: 2,
      });
    });

    await withPersistence(directory, async (persistence) => {
      const { kept } = host(persistence);
      expect(kept.remembered({ threadKind: "work-thread", scopeId: threadTwo })).toEqual(choice);

      const routine = routineTools(kept);
      if (routine.set === undefined) throw new Error("The routine was not offered the tool.");
      await routine.set.execute({
        name: IMAGE_TOOL_NAME,
        inputJson: JSON.stringify({ prompt: "a red cube" }),
      });
      expect(routine.offer).not.toHaveBeenCalled();
      expect(routine.enqueue).toHaveBeenCalledWith(expect.objectContaining(choice));

      await kept.forget({ threadKind: "work-thread", scopeId: threadTwo });
    });

    await withPersistence(directory, async (persistence) => {
      const { kept } = host(persistence);
      expect(kept.remembered({ threadKind: "chat-thread", scopeId: threadOne })).toBeUndefined();
      expect(routineTools(kept).set).toBeUndefined();
    });
  });

  it("keeps the choice of a thread outside a Project for that thread alone, in host memory", async () => {
    await withPersistence(temporaryDirectory(), async (persistence) => {
      const { kept } = host(persistence);
      const scope = { threadKind: "chat-thread", scopeId: outsideProject } as const;
      await kept.remember(scope, choice);
      expect(kept.remembered(scope)).toEqual(choice);
      expect(kept.remembered({ threadKind: "chat-thread", scopeId: threadOne })).toBeUndefined();
      await kept.forget(scope);
      expect(kept.remembered(scope)).toBeUndefined();
    });
  });
});

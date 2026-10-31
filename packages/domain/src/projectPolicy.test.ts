import {
  decodeDesktopCredentialRef,
  decodeDesktopMachineId,
  decodeDesktopPlacementId,
  decodeDesktopRecipe,
  decodeLeasableDesktopProvider,
} from "@octant/contracts/desktop-lease";
import type { UtcTimestamp } from "@octant/contracts/events";
import {
  decodeBindingRevisionId,
  decodeProject,
  decodeProjectAction,
  decodeProjectId,
  decodeProjectRank,
  type CanonicalProjectBinding,
  type Project,
  type ProjectActor,
} from "@octant/contracts/projects";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectPolicyRejected,
  addProjectExtraFolder,
  extraFolderRefusal,
  isPathInProjectFolders,
  projectExtraFolderRoots,
  projectFolderRoots,
  removeProjectExtraFolder,
  changeCodeProjectAccess,
  changeCodeProjectActions,
  changeCodeProjectPermissionMode,
  changeCodeProjectAutoReviewer,
  changeCodeProjectDesktopRecipe,
  changeCodeProjectPullRequestBackgroundRefresh,
  changeProjectBrandKit,
  changeProjectColor,
  changeProjectLifecycle,
  changeProjectNativeProviders,
  changeWorkProjectStatusFile,
  compareProjectOrder,
  createProject,
  moveProject,
  rankBetween,
  relinkProject,
  renameProject,
  workProjectKeepsStatusFile,
} from "./projectPolicy";

const ids = {
  chat: decodeProjectId("11111111-1111-4111-8111-111111111111"),
  work: decodeProjectId("22222222-2222-4222-8222-222222222222"),
  code: decodeProjectId("33333333-3333-4333-8333-333333333333"),
  later: decodeProjectId("44444444-4444-4444-8444-444444444444"),
  revision1: decodeBindingRevisionId("55555555-5555-4555-8555-555555555555"),
  revision2: decodeBindingRevisionId("66666666-6666-4666-8666-666666666666"),
} as const;

const createdAt = "2026-07-14T08:00:00.000Z" as UtcTimestamp;
const updatedAt = "2026-07-14T09:00:00.000Z" as UtcTimestamp;
const actor = {
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
} as ProjectActor;
const root = { canonicalRoot: "/Users/example/Workspace" } as CanonicalProjectBinding;
const home = "/Users/example";

function makeProject(
  id: Project["id"],
  rank: string,
  options: {
    readonly type?: Project["type"];
    readonly pinned?: boolean;
    readonly lifecycle?: Project["lifecycle"];
    readonly name?: string;
    readonly binding?: CanonicalProjectBinding;
  } = {},
): Project {
  const type = options.type ?? "chat";
  const common = {
    id,
    name: options.name ?? `Project ${id.slice(0, 4)}`,
    lifecycle: options.lifecycle ?? "active",
    pinned: options.pinned ?? false,
    rank: decodeProjectRank(rank),
    version: 1,
    createdAt,
    updatedAt: createdAt,
  } as const;
  if (type === "chat") return decodeProject({ ...common, type });
  const binding = options.binding ?? root;
  const bound = {
    ...common,
    type,
    binding,
    bindingHistory: [
      {
        revisionId: ids.revision1,
        revision: 1,
        currentBinding: binding,
        actor,
        changedAt: createdAt,
      },
    ],
  } as const;
  return decodeProject(
    type === "code" ? { ...bound, codeAccessPersistence: "current-session" } : bound,
  );
}

describe("Project creation and lifecycle", () => {
  it("creates strict Chat, Work, and Code variants with safe defaults", () => {
    const chat = createProject({
      type: "chat",
      id: ids.chat,
      name: "  Product notes  ",
      rank: decodeProjectRank("0/1"),
      createdAt,
    });
    const work = createProject({
      type: "work",
      id: ids.work,
      name: "Workspace",
      rank: decodeProjectRank("0/1"),
      binding: root,
      revisionId: ids.revision1,
      actor,
      createdAt,
    });
    const code = createProject({
      type: "code",
      id: ids.code,
      name: "Repository",
      rank: decodeProjectRank("0/1"),
      binding: root,
      revisionId: ids.revision1,
      actor,
      createdAt,
    });

    expect(chat).toEqual({
      id: ids.chat,
      type: "chat",
      name: "Product notes",
      lifecycle: "active",
      pinned: false,
      rank: decodeProjectRank("0/1"),
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
    expect(work).toMatchObject({ type: "work", binding: root });
    expect(code).toMatchObject({
      type: "code",
      binding: root,
      codeAccessPersistence: "current-session",
    });
    expect(work.id).not.toBe(code.id);
    expect(work.bindingHistory).not.toBe(code.bindingHistory);
  });

  it("rejects empty names and binding inputs on virtual Chat Projects", () => {
    expect(() =>
      createProject({
        type: "chat",
        id: ids.chat,
        name: "   ",
        rank: decodeProjectRank("0/1"),
        createdAt,
      }),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      createProject({
        type: "chat",
        id: ids.chat,
        name: "Chat",
        rank: decodeProjectRank("0/1"),
        binding: root,
        revisionId: ids.revision1,
        actor,
        createdAt,
      } as never),
    ).toThrow(ProjectPolicyRejected);
  });

  it("changes only the canonical Code Project access policy", () => {
    const project = makeProject(ids.code, "0/1", { type: "code" });
    const changed = changeCodeProjectAccess(project, "project-default", updatedAt);
    expect(changed).toMatchObject({
      type: "code",
      codeAccessPersistence: "project-default",
      version: 2,
    });
    expect(() =>
      changeCodeProjectAccess(makeProject(ids.chat, "0/1"), "project-default", updatedAt),
    ).toThrow(ProjectPolicyRejected);
  });

  it("sets a Code Project's Auto reviewer and returns it to Settings, refusing a non-change", () => {
    const project = makeProject(ids.code, "0/1", { type: "code" });
    const shield = changeCodeProjectAutoReviewer(project, "octant-shield", updatedAt);
    expect(shield).toMatchObject({ autoReviewer: "octant-shield", version: project.version + 1 });
    const back = changeCodeProjectAutoReviewer(shield, undefined, updatedAt);
    expect(back).not.toHaveProperty("autoReviewer");
    expect(() => changeCodeProjectAutoReviewer(back, undefined, updatedAt)).toThrow();
  });

  it("sets a Code Project's default mode and keeps its remembered Full access in step", () => {
    const project = makeProject(ids.code, "0/1", { type: "code" });
    const full = changeCodeProjectPermissionMode(project, "full-access", updatedAt);
    expect(full).toMatchObject({
      defaultPermissionMode: "full-access",
      codeAccessPersistence: "project-default",
      version: 2,
    });
    const followsSettings = changeCodeProjectPermissionMode(full, undefined, updatedAt);
    expect(followsSettings).not.toHaveProperty("defaultPermissionMode");
    expect(followsSettings.codeAccessPersistence).toBe("current-session");
    expect(() => changeCodeProjectPermissionMode(full, "full-access", updatedAt)).toThrow(
      ProjectPolicyRejected,
    );
    expect(() =>
      changeCodeProjectPermissionMode(makeProject(ids.chat, "0/1"), "auto", updatedAt),
    ).toThrow(ProjectPolicyRejected);
    // A Project that remembered Full access before Project modes existed has no
    // mode of its own; returning it to Settings must still clear the memory.
    const legacyFull = changeCodeProjectAccess(project, "project-default", updatedAt);
    expect(legacyFull).not.toHaveProperty("defaultPermissionMode");
    expect(changeCodeProjectPermissionMode(legacyFull, undefined, updatedAt)).toMatchObject({
      codeAccessPersistence: "current-session",
    });
    // The older remembered-access switch speaks for the whole mode when used.
    expect(changeCodeProjectAccess(full, "current-session", updatedAt)).not.toHaveProperty(
      "defaultPermissionMode",
    );
  });

  it("enables background pull-request refresh on a Code Project and bumps its version", () => {
    const project = makeProject(ids.code, "0/1", { type: "code" });
    const enabled = changeCodeProjectPullRequestBackgroundRefresh(project, "enabled", updatedAt);
    expect(enabled).toMatchObject({
      type: "code",
      pullRequestBackgroundRefresh: "enabled",
      version: 2,
    });
    // Absence reads as disabled, so a "disable" of an untouched Project is a
    // no-op the journal must never record.
    expect(() =>
      changeCodeProjectPullRequestBackgroundRefresh(project, "disabled", updatedAt),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      changeCodeProjectPullRequestBackgroundRefresh(
        makeProject(ids.chat, "0/1"),
        "enabled",
        updatedAt,
      ),
    ).toThrow(ProjectPolicyRejected);
  });

  it("lets a Work Project opt into a status file, which starts off for every Project", () => {
    const project = makeProject(ids.work, "0/1", { type: "work" });
    expect(workProjectKeepsStatusFile(project)).toBe(false);
    const enabled = changeWorkProjectStatusFile(project, "enabled", updatedAt);
    expect(enabled).toMatchObject({ type: "work", statusFile: "enabled", version: 2 });
    expect(workProjectKeepsStatusFile(enabled)).toBe(true);
    expect(() => changeWorkProjectStatusFile(project, "disabled", updatedAt)).toThrow(
      ProjectPolicyRejected,
    );
    expect(() =>
      changeWorkProjectStatusFile(
        makeProject(ids.code, "0/1", { type: "code" }),
        "enabled",
        updatedAt,
      ),
    ).toThrow(ProjectPolicyRejected);
  });

  it("keeps a brand kit on any Project type and clears it with an empty kit", () => {
    const kit = { "color-primary": "#0a7d5a", "font-heading": "georgia, serif" };
    for (const [id, type] of [
      [ids.chat, "chat"],
      [ids.work, "work"],
      [ids.code, "code"],
    ] as const) {
      const project = makeProject(id, "0/1", { type });
      const withKit = changeProjectBrandKit(project, kit, updatedAt);
      expect(withKit).toMatchObject({ brandKit: kit, version: 2 });
      const cleared = changeProjectBrandKit(withKit, {}, updatedAt);
      expect(cleared).not.toHaveProperty("brandKit");
    }
  });

  it("refuses a brand kit value that could end a declaration or load something", () => {
    const project = makeProject(ids.work, "0/1", { type: "work" });
    for (const kit of [
      { "color-primary": "red; } body { display: none" },
      { "color-primary": "url(https://example.com/x.png)" },
      { "font-body": "Some Web Font, sans-serif" },
      { "radius-card": "10px; color: red" },
    ]) {
      expect(() => changeProjectBrandKit(project, kit, updatedAt)).toThrow(ProjectPolicyRejected);
    }
  });

  it("refuses to save the brand kit a Project already has", () => {
    const kit = { "color-primary": "#0a7d5a" };
    const project = changeProjectBrandKit(
      makeProject(ids.work, "0/1", { type: "work" }),
      kit,
      updatedAt,
    );
    expect(() => changeProjectBrandKit(project, kit, updatedAt)).toThrow(ProjectPolicyRejected);
    expect(() =>
      changeProjectBrandKit(makeProject(ids.work, "0/1", { type: "work" }), {}, updatedAt),
    ).toThrow(ProjectPolicyRejected);
  });

  describe("a Code Project's terminal actions", () => {
    const action = (name: string, command: string) =>
      decodeProjectAction({
        id: crypto.randomUUID(),
        name,
        command,
        directory: ".",
      });

    it("are replaced as a whole list and cleared by an empty one", () => {
      const project = makeProject(ids.code, "0/1", { type: "code" });
      const dev = action("Dev", "bun run dev");
      const saved = changeCodeProjectActions(project, [dev], updatedAt);
      expect(saved).toMatchObject({ actions: [dev], version: 2 });
      const cleared = changeCodeProjectActions(saved, [], updatedAt);
      expect(cleared).not.toHaveProperty("actions");
      expect(cleared.version).toBe(3);
    });

    it("refuse a Work Project, an archived Project, and a list that changes nothing", () => {
      const dev = action("Dev", "bun run dev");
      expect(() =>
        changeCodeProjectActions(makeProject(ids.work, "0/1", { type: "work" }), [dev], updatedAt),
      ).toThrow(ProjectPolicyRejected);
      expect(() =>
        changeCodeProjectActions(
          makeProject(ids.code, "0/1", { type: "code", lifecycle: "archived" }),
          [dev],
          updatedAt,
        ),
      ).toThrow(ProjectPolicyRejected);
      const saved = changeCodeProjectActions(
        makeProject(ids.code, "0/1", { type: "code" }),
        [dev],
        updatedAt,
      );
      expect(() => changeCodeProjectActions(saved, [dev], updatedAt)).toThrow(
        ProjectPolicyRejected,
      );
    });
  });

  describe("a Code Project's desktop recipe", () => {
    const hostLocal = decodeLeasableDesktopProvider({
      providerId: "host-local",
      displayName: "This host",
      locality: "host-local",
      billed: false,
    });
    const recipe = decodeDesktopRecipe({
      providerId: "host-local",
      screen: { width: 1280, height: 800 },
      network: "none",
      leaseMinutes: 30,
      maximumLeaseMinutes: 240,
      idleMinutes: 15,
    });

    it("is set, replaced, and removed on a Code Project", () => {
      const project = makeProject(ids.code, "0/1", { type: "code" });
      const set = changeCodeProjectDesktopRecipe(project, recipe, [hostLocal], updatedAt);
      expect(set).toMatchObject({ desktopRecipe: recipe, version: 2 });
      const wider = { ...recipe, screen: { width: 1920, height: 1080 } };
      expect(
        changeCodeProjectDesktopRecipe(set, wider, [hostLocal], updatedAt).desktopRecipe,
      ).toEqual(wider);
      // Removing needs no offered provider: a Project can always drop its recipe.
      const removed = changeCodeProjectDesktopRecipe(set, null, [], updatedAt);
      expect(removed).not.toHaveProperty("desktopRecipe");
      expect(removed.version).toBe(3);
    });

    it("refuses a provider this host does not offer and network on a host-local desktop", () => {
      const project = makeProject(ids.code, "0/1", { type: "code" });
      expect(() => changeCodeProjectDesktopRecipe(project, recipe, [], updatedAt)).toThrow(
        ProjectPolicyRejected,
      );
      expect(() =>
        changeCodeProjectDesktopRecipe(
          project,
          { ...recipe, network: "allow" },
          [hostLocal],
          updatedAt,
        ),
      ).toThrow(ProjectPolicyRejected);
    });

    it("refuses a recipe moving to a provider that needs setup, and lets one already on it be edited or removed", () => {
      const cloud = decodeLeasableDesktopProvider({
        providerId: "e2b",
        displayName: "E2B",
        locality: "cloud",
        billed: true,
        needsSetup: "no-credential-store",
      });
      const keyed = {
        ...recipe,
        providerId: cloud.providerId,
        hourlyCostUsdCents: 25,
        credentialRef: decodeDesktopCredentialRef("5f0c6f7e-7b0a-4d43-9a3c-2f1d8f4e6a10"),
      };
      const project = makeProject(ids.code, "0/1", { type: "code" });
      expect(() => changeCodeProjectDesktopRecipe(project, keyed, [cloud], updatedAt)).toThrow(
        ProjectPolicyRejected,
      );
      const onCloud = { ...project, desktopRecipe: keyed } as typeof project;
      const edited = { ...keyed, idleMinutes: 30 };
      expect(
        changeCodeProjectDesktopRecipe(onCloud, edited, [cloud], updatedAt).desktopRecipe,
      ).toEqual(edited);
      expect(changeCodeProjectDesktopRecipe(onCloud, null, [cloud], updatedAt)).not.toHaveProperty(
        "desktopRecipe",
      );
    });

    it("keeps a cloud recipe only when it names a credential, and lets it reach the network", () => {
      const cloud = decodeLeasableDesktopProvider({
        providerId: "e2b",
        displayName: "E2B",
        locality: "cloud",
        billed: true,
      });
      const project = makeProject(ids.code, "0/1", { type: "code" });
      const keyless = {
        ...recipe,
        providerId: cloud.providerId,
        network: "allow" as const,
        hourlyCostUsdCents: 25,
      };
      expect(() => changeCodeProjectDesktopRecipe(project, keyless, [cloud], updatedAt)).toThrow(
        ProjectPolicyRejected,
      );
      const keyed = {
        ...keyless,
        credentialRef: decodeDesktopCredentialRef("5f0c6f7e-7b0a-4d43-9a3c-2f1d8f4e6a10"),
      };
      expect(
        changeCodeProjectDesktopRecipe(project, keyed, [cloud], updatedAt).desktopRecipe,
      ).toEqual(keyed);
    });

    it("lets a person remove a cloud recipe's key in place, but never move to the provider without one", () => {
      const cloud = decodeLeasableDesktopProvider({
        providerId: "e2b",
        displayName: "E2B",
        locality: "cloud",
        billed: true,
      });
      const keyed = {
        ...recipe,
        providerId: cloud.providerId,
        credentialRef: decodeDesktopCredentialRef("5f0c6f7e-7b0a-4d43-9a3c-2f1d8f4e6a10"),
        hourlyCostUsdCents: 25,
      };
      const { credentialRef: _removed, ...keyless } = keyed;
      const saved = changeCodeProjectDesktopRecipe(
        makeProject(ids.code, "0/1", { type: "code" }),
        keyed,
        [cloud, hostLocal],
        updatedAt,
      );
      const removed = changeCodeProjectDesktopRecipe(saved, keyless, [cloud], updatedAt);
      expect(removed.desktopRecipe).toEqual(keyless);
      // The keyless recipe stays editable on the same provider.
      const wider = { ...keyless, screen: { width: 1920, height: 1080 } };
      expect(
        changeCodeProjectDesktopRecipe(removed, wider, [cloud], updatedAt).desktopRecipe,
      ).toEqual(wider);
      const onThisHost = changeCodeProjectDesktopRecipe(saved, recipe, [hostLocal], updatedAt);
      expect(() =>
        changeCodeProjectDesktopRecipe(onThisHost, keyless, [cloud, hostLocal], updatedAt),
      ).toThrow(ProjectPolicyRejected);
    });

    it("asks a new billed recipe for the person's hourly cost, and keeps none on one that does not bill", () => {
      const cloud = decodeLeasableDesktopProvider({
        providerId: "e2b",
        displayName: "E2B",
        locality: "cloud",
        billed: true,
      });
      const project = makeProject(ids.code, "0/1", { type: "code" });
      const keyed = {
        ...recipe,
        providerId: cloud.providerId,
        credentialRef: decodeDesktopCredentialRef("5f0c6f7e-7b0a-4d43-9a3c-2f1d8f4e6a10"),
      };
      expect(() => changeCodeProjectDesktopRecipe(project, keyed, [cloud], updatedAt)).toThrow(
        "Enter what an hour of this desktop costs you",
      );
      const priced = { ...keyed, hourlyCostUsdCents: 25 };
      expect(
        changeCodeProjectDesktopRecipe(project, priced, [cloud], updatedAt).desktopRecipe,
      ).toEqual(priced);
      expect(() =>
        changeCodeProjectDesktopRecipe(
          project,
          { ...recipe, hourlyCostUsdCents: 25 },
          [hostLocal],
          updatedAt,
        ),
      ).toThrow("Only a desktop that bills you takes a cost per hour");
    });

    it("refuses a recipe that names a placement its provider does not offer", () => {
      const project = makeProject(ids.code, "0/1", { type: "code" });
      expect(() =>
        changeCodeProjectDesktopRecipe(
          project,
          { ...recipe, placementId: decodeDesktopPlacementId("this-machine") },
          [hostLocal],
          updatedAt,
        ),
      ).toThrow(ProjectPolicyRejected);
    });

    describe("for a provider whose daemon holds the person's sign-in", () => {
      const daemonRun = decodeLeasableDesktopProvider({
        providerId: "cua",
        displayName: "Cua Spaces",
        locality: "host-local",
        billed: false,
        daemon: true,
        placements: [
          {
            placementId: "this-machine",
            displayName: "This machine",
            locality: "host-local",
            billed: false,
          },
          {
            placementId: "other-machine",
            displayName: "Your other computer",
            locality: "cloud",
            billed: false,
            choosesMachine: true,
          },
        ],
      });
      const studio = {
        machineId: decodeDesktopMachineId("host-studio"),
        displayName: "studio",
      };
      const onDaemon = { ...recipe, providerId: daemonRun.providerId };
      const project = makeProject(ids.code, "0/1", { type: "code" });
      const save = (next: typeof recipe) =>
        changeCodeProjectDesktopRecipe(project, next, [daemonRun], updatedAt);

      it("keeps a recipe on one of its placements, on that placement's network rule", () => {
        const here = { ...onDaemon, placementId: decodeDesktopPlacementId("this-machine") };
        expect(save(here).desktopRecipe).toEqual(here);
        expect(() => save({ ...here, network: "allow" })).toThrow(ProjectPolicyRejected);
        expect(() => save(onDaemon)).toThrow(ProjectPolicyRejected);
        expect(() =>
          save({ ...onDaemon, placementId: decodeDesktopPlacementId("elsewhere") }),
        ).toThrow(ProjectPolicyRejected);
      });

      it("takes a placement off this machine in place of a credential, and refuses any key", () => {
        const away = {
          ...onDaemon,
          placementId: decodeDesktopPlacementId("other-machine"),
          machine: studio,
        };
        expect(save(away).desktopRecipe).toEqual(away);
        expect(() =>
          save({
            ...away,
            credentialRef: decodeDesktopCredentialRef("5f0c6f7e-7b0a-4d43-9a3c-2f1d8f4e6a10"),
          }),
        ).toThrow(ProjectPolicyRejected);
      });

      it("refuses network on a placement off this machine, whose loopback holds the person's own services", () => {
        const away = {
          ...onDaemon,
          placementId: decodeDesktopPlacementId("other-machine"),
          machine: studio,
        };
        expect(() => save({ ...away, network: "allow" })).toThrow(ProjectPolicyRejected);
      });

      it("names the machine a placement that runs on one of the person's machines uses, and only there", () => {
        const away = { ...onDaemon, placementId: decodeDesktopPlacementId("other-machine") };
        expect(() => save(away)).toThrow(ProjectPolicyRejected);
        expect(save({ ...away, machine: studio }).desktopRecipe?.machine).toEqual(studio);
        const here = { ...onDaemon, placementId: decodeDesktopPlacementId("this-machine") };
        expect(() => save({ ...here, machine: studio })).toThrow(ProjectPolicyRejected);
        expect(() =>
          changeCodeProjectDesktopRecipe(
            project,
            { ...recipe, machine: studio },
            [hostLocal],
            updatedAt,
          ),
        ).toThrow(ProjectPolicyRejected);
      });
    });

    it("refuses a Work or Chat Project and a change that changes nothing", () => {
      for (const [id, type] of [
        [ids.chat, "chat"],
        [ids.work, "work"],
      ] as const) {
        expect(() =>
          changeCodeProjectDesktopRecipe(
            makeProject(id, "0/1", { type }),
            recipe,
            [hostLocal],
            updatedAt,
          ),
        ).toThrow(ProjectPolicyRejected);
      }
      const project = makeProject(ids.code, "0/1", { type: "code" });
      expect(() => changeCodeProjectDesktopRecipe(project, null, [hostLocal], updatedAt)).toThrow(
        ProjectPolicyRejected,
      );
      const set = changeCodeProjectDesktopRecipe(project, recipe, [hostLocal], updatedAt);
      expect(() => changeCodeProjectDesktopRecipe(set, recipe, [hostLocal], updatedAt)).toThrow(
        ProjectPolicyRejected,
      );
    });
  });

  it("refuses to give the default-folder Project a status file", () => {
    const project = decodeProject({
      ...makeProject(ids.work, "0/1", { type: "work" }),
      origin: "default-folder",
    });
    expect(() => changeWorkProjectStatusFile(project, "enabled", updatedAt)).toThrow(
      ProjectPolicyRejected,
    );
    // Even a record that somehow carries the setting keeps nothing in the folder.
    expect(workProjectKeepsStatusFile({ ...project, statusFile: "enabled" } as Project)).toBe(
      false,
    );
  });

  it("renames and archives/restores without mutating the previous snapshot or type", () => {
    const original = makeProject(ids.code, "0/1", { type: "code", name: "Old name" });
    const renamed = renameProject(original, "  New name  ", updatedAt);
    const archived = changeProjectLifecycle(renamed, "archived", updatedAt);
    const restored = changeProjectLifecycle(archived, "active", updatedAt);

    expect(renamed).toMatchObject({ name: "New name", type: "code", version: 2 });
    expect(archived).toMatchObject({ lifecycle: "archived", type: "code", version: 3 });
    expect(restored).toMatchObject({ lifecycle: "active", type: "code", version: 4 });
    expect(original).toMatchObject({ name: "Old name", lifecycle: "active", version: 1 });
    expect(() => renameProject(original, "  ", updatedAt)).toThrow(ProjectPolicyRejected);
    expect(() => changeProjectLifecycle(original, "active", updatedAt)).toThrow(
      ProjectPolicyRejected,
    );
  });
});

describe("Project colour", () => {
  it("sets a colour, then clears it so the Project reads as one that never had one", () => {
    const original = makeProject(ids.work, "0/1", { type: "work" });
    const coloured = changeProjectColor(original, "teal", updatedAt);
    const cleared = changeProjectColor(coloured, null, updatedAt);

    expect(coloured).toMatchObject({ color: "teal", type: "work", version: 2 });
    expect(cleared).toMatchObject({ type: "work", version: 3 });
    expect("color" in cleared).toBe(false);
    expect(original.color).toBeUndefined();
  });

  it("refuses a colour change on an archived Project", () => {
    const archived = makeProject(ids.code, "0/1", { type: "code", lifecycle: "archived" });

    expect(() => changeProjectColor(archived, "red", updatedAt)).toThrow(ProjectPolicyRejected);
  });

  it("refuses a change that would leave the colour as it is", () => {
    const coloured = changeProjectColor(makeProject(ids.chat, "0/1"), "blue", updatedAt);

    expect(() => changeProjectColor(coloured, "blue", updatedAt)).toThrow(ProjectPolicyRejected);
    expect(() => changeProjectColor(makeProject(ids.chat, "0/1"), null, updatedAt)).toThrow(
      ProjectPolicyRejected,
    );
  });
});

describe("Project binding relink", () => {
  it("preserves identity, type, memory boundary, and order while appending audit history", () => {
    const original = makeProject(ids.work, "2/3", { type: "work", pinned: true });
    const replacement = { canonicalRoot: "/Users/example/New Workspace" } as const;
    const relinked = relinkProject(original, {
      previousBindingRevision: 1,
      binding: replacement,
      revisionId: ids.revision2,
      actor,
      changedAt: updatedAt,
    });

    expect(relinked).toMatchObject({
      id: original.id,
      type: "work",
      name: original.name,
      lifecycle: original.lifecycle,
      pinned: original.pinned,
      rank: original.rank,
      binding: replacement,
      version: 2,
      updatedAt,
    });
    expect(relinked.bindingHistory).toHaveLength(2);
    expect(relinked.bindingHistory[1]).toEqual({
      revisionId: ids.revision2,
      revision: 2,
      previousBinding: root,
      currentBinding: replacement,
      actor,
      changedAt: updatedAt,
    });
    expect(original.type).toBe("work");
    if (original.type !== "work") throw new Error("expected Work Project");
    expect(original.binding).toEqual(root);
    expect(original.bindingHistory).toHaveLength(1);
  });

  it("rejects Chat relinks, stale binding revisions, and unchanged roots", () => {
    const work = makeProject(ids.work, "0/1", { type: "work" });
    const input = {
      previousBindingRevision: 1,
      binding: { canonicalRoot: "/Users/example/New Workspace" } as CanonicalProjectBinding,
      revisionId: ids.revision2,
      actor,
      changedAt: updatedAt,
    };

    expect(() => relinkProject(makeProject(ids.chat, "0/1"), input)).toThrow(ProjectPolicyRejected);
    expect(() => relinkProject(work, { ...input, previousBindingRevision: 0 })).toThrow(
      ProjectPolicyRejected,
    );
    expect(() => relinkProject(work, { ...input, binding: root })).toThrow(ProjectPolicyRejected);
  });

  it("refuses a new main folder that overlaps an extra folder", () => {
    const work = addProjectExtraFolder(makeProject(ids.work, "0/1", { type: "work" }), {
      canonicalRoot: "/Users/example/Notes",
      actor,
      addedAt: updatedAt,
      homeDirectory: home,
    }).project;
    const relinkTo = (canonicalRoot: string) =>
      relinkProject(work, {
        previousBindingRevision: 1,
        binding: { canonicalRoot } as CanonicalProjectBinding,
        revisionId: ids.revision2,
        actor,
        changedAt: updatedAt,
      });
    for (const overlapping of ["/Users/example/Notes", "/Users/example/Notes/Drafts"]) {
      expect(() => relinkTo(overlapping)).toThrow(/extra folders/);
    }
    expect(relinkTo("/Users/example/Other").extraFolders).toHaveLength(1);
  });
});

describe("Project extra folders", () => {
  const work = () => makeProject(ids.work, "0/1", { type: "work" });
  const add = (project: Project, canonicalRoot: string) =>
    addProjectExtraFolder(project, {
      canonicalRoot,
      actor,
      addedAt: updatedAt,
      homeDirectory: home,
    });

  it("adds a folder with who added it and when, and counts it as inside the Project", () => {
    const { project, folder } = add(work(), "/Users/example/Notes");
    expect(folder).toEqual({
      canonicalRoot: "/Users/example/Notes",
      addedBy: actor,
      addedAt: updatedAt,
    });
    expect(project).toMatchObject({ version: 2, updatedAt, extraFolders: [folder] });
    const folders = projectFolderRoots(project);
    expect(folders).toEqual(["/Users/example/Workspace", "/Users/example/Notes"]);
    expect(projectExtraFolderRoots(project)).toEqual(["/Users/example/Notes"]);
    expect(isPathInProjectFolders(folders, "/Users/example/Notes/today.md")).toBe(true);
    expect(isPathInProjectFolders(folders, "/Users/example/Workspace/a.txt")).toBe(true);
    expect(isPathInProjectFolders(folders, "/Users/example/Notes-old/a.txt")).toBe(false);
    expect(isPathInProjectFolders(folders, "/Users/example/Desktop")).toBe(false);
  });

  it("refuses the main folder, a folder inside or around it, and a duplicate or nested extra", () => {
    const withNotes = add(work(), "/Users/example/Notes").project;
    for (const candidate of [
      "/Users/example/Workspace",
      "/Users/example/Workspace/docs",
      "/Users/example/Notes",
      "/Users/example/Notes/Drafts",
    ]) {
      expect(() => add(withNotes, candidate)).toThrow(ProjectPolicyRejected);
    }
    const around = makeProject(ids.work, "0/1", {
      type: "work",
      binding: { canonicalRoot: "/Users/example/Work/Workspace" } as CanonicalProjectBinding,
    });
    expect(() => add(around, "/Users/example/Work")).toThrow(/main folder/);
  });

  it("refuses the home folder, anything above it, system folders and secret folders", () => {
    for (const candidate of [
      "/Users/example",
      "/Users",
      "/System/Library",
      "/usr/local/share",
      "/etc",
      "/Applications",
      "/Users/example/.ssh",
      "/Users/example/.aws/sso",
      "/Users/example/.config",
      "/Users/example/Library",
      "/Users/example/Library/Keychains",
    ]) {
      expect(() => add(work(), candidate), candidate).toThrow(ProjectPolicyRejected);
    }
    expect(add(work(), "/Volumes/Shared/Specs").project.extraFolders).toHaveLength(1);
    expect(add(work(), "/Users/example/.config/nvim").project.extraFolders).toHaveLength(1);
  });

  it("refuses Chat Projects, archived Projects and lists past the limit", () => {
    expect(() => add(makeProject(ids.chat, "0/1"), "/Users/example/Notes")).toThrow(
      ProjectPolicyRejected,
    );
    expect(() =>
      add(
        makeProject(ids.work, "0/1", { type: "work", lifecycle: "archived" }),
        "/Users/example/N",
      ),
    ).toThrow(ProjectPolicyRejected);
    let project: Project = work();
    for (let index = 0; index < 16; index += 1) {
      project = add(project, `/Users/example/Folder ${index}`).project;
    }
    expect(() => add(project, "/Users/example/One more")).toThrow(/at most 16/);
  });

  it("removes only an extra folder and leaves a Project with none as it was before", () => {
    const withNotes = add(work(), "/Users/example/Notes").project;
    const removed = removeProjectExtraFolder(withNotes, "/Users/example/Notes", updatedAt);
    expect(removed.extraFolders).toBeUndefined();
    expect(removed.version).toBe(3);
    expect(() =>
      removeProjectExtraFolder(withNotes, "/Users/example/Workspace", updatedAt),
    ).toThrow(/main folder/);
    expect(() => removeProjectExtraFolder(withNotes, "/Users/example/Other", updatedAt)).toThrow(
      ProjectPolicyRejected,
    );
  });

  it("judges a candidate without a Project for the folder picker to explain", () => {
    expect(
      extraFolderRefusal({
        mainRoot: "/Users/example/Workspace",
        extraFolders: [],
        candidate: "/Users/example/Notes",
        homeDirectory: home,
      }),
    ).toBeUndefined();
    expect(
      extraFolderRefusal({
        mainRoot: "/Users/example/Workspace",
        extraFolders: [],
        candidate: "/",
        homeDirectory: home,
      }),
    ).toMatch(/whole disk/);
  });
});

describe("deterministic Project ranks", () => {
  it.each([
    [undefined, undefined, "0/1"],
    ["2/3", undefined, "5/3"],
    [undefined, "2/3", "-1/3"],
    ["1/3", "2/3", "1/2"],
    ["1/2", "2/3", "3/5"],
  ] as const)("places a rank between %s and %s as %s", (left, right, expected) => {
    expect(
      rankBetween(
        left === undefined ? undefined : decodeProjectRank(left),
        right === undefined ? undefined : decodeProjectRank(right),
      ),
    ).toBe(decodeProjectRank(expected));
  });

  it("reduces generated tokens and rejects malformed or non-ascending neighbors", () => {
    expect(rankBetween(decodeProjectRank("1/3"), decodeProjectRank("1/1"))).toBe(
      decodeProjectRank("1/2"),
    );
    expect(() => rankBetween(decodeProjectRank("1/1"), decodeProjectRank("1/1"))).toThrow(
      ProjectPolicyRejected,
    );
    expect(() => rankBetween(decodeProjectRank("2/1"), decodeProjectRank("1/1"))).toThrow(
      ProjectPolicyRejected,
    );
    expect(() => rankBetween("2/4" as never, undefined)).toThrow(ProjectPolicyRejected);
  });

  it("orders pinned first, then rational rank, then stable Project ID", () => {
    const unpinned = makeProject(ids.chat, "-100/1");
    const pinned = makeProject(ids.work, "100/1", { pinned: true });
    const equalA = makeProject(ids.chat, "1/2");
    const equalB = makeProject(ids.later, "1/2");
    const larger = makeProject(ids.code, "2/3");

    expect(compareProjectOrder(pinned, unpinned)).toBeLessThan(0);
    expect(compareProjectOrder(equalA, larger)).toBeLessThan(0);
    expect(compareProjectOrder(equalA, equalB)).toBeLessThan(0);
    expect(compareProjectOrder(equalB, equalA)).toBeGreaterThan(0);
    expect(compareProjectOrder(equalA, equalA)).toBe(0);
  });

  it("uses locale-independent code-unit ordering for equal-rank Project IDs", () => {
    const equalA = makeProject(ids.chat, "1/2");
    const equalB = makeProject(ids.later, "1/2");
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale-dependent ordering must not participate in replay");
    });

    try {
      expect(compareProjectOrder(equalA, equalB)).toBe(-1);
      expect(compareProjectOrder(equalB, equalA)).toBe(1);
      expect(compareProjectOrder(equalA, equalA)).toBe(0);
    } finally {
      localeCompare.mockRestore();
    }
  });
});

describe("Project moves", () => {
  it("moves between pin lanes and computes rank only from neighbors in the target lane", () => {
    const current = makeProject(ids.chat, "0/1");
    const before = makeProject(ids.work, "1/3", { pinned: true });
    const after = makeProject(ids.code, "2/3", { pinned: true });
    const moved = moveProject(current, {
      pinned: true,
      beforeProject: before,
      afterProject: after,
      updatedAt,
    });

    expect(moved).toMatchObject({ pinned: true, rank: decodeProjectRank("1/2"), version: 2 });
    expect(current).toMatchObject({ pinned: false, rank: decodeProjectRank("0/1"), version: 1 });
  });

  it("moves from the pinned lane into the unpinned lane", () => {
    const current = makeProject(ids.chat, "5/1", { pinned: true });
    const before = makeProject(ids.work, "-1/1");
    const moved = moveProject(current, {
      pinned: false,
      beforeProject: before,
      updatedAt,
    });

    expect(moved).toMatchObject({ pinned: false, rank: decodeProjectRank("0/1"), version: 2 });
    expect(current).toMatchObject({ pinned: true, rank: decodeProjectRank("5/1"), version: 1 });
  });

  it("rejects the moving Project as either neighbor", () => {
    const current = makeProject(ids.chat, "0/1");

    expect(() =>
      moveProject(current, { pinned: false, beforeProject: current, updatedAt }),
    ).toThrow(ProjectPolicyRejected);
    expect(() => moveProject(current, { pinned: false, afterProject: current, updatedAt })).toThrow(
      ProjectPolicyRejected,
    );
  });

  it("rejects the same neighboring Project on both sides", () => {
    const current = makeProject(ids.chat, "0/1");
    const neighbor = makeProject(ids.work, "1/1");

    expect(() =>
      moveProject(current, {
        pinned: false,
        beforeProject: neighbor,
        afterProject: neighbor,
        updatedAt,
      }),
    ).toThrow(ProjectPolicyRejected);
  });

  it("rejects neighbors from another mode, lifecycle, lane, or invalid order", () => {
    const current = makeProject(ids.chat, "0/1");
    const good = makeProject(ids.work, "1/3");
    const wrongMode = makeProject(ids.code, "2/3", { type: "code" });
    const archived = makeProject(ids.code, "2/3", { lifecycle: "archived" });
    const pinned = makeProject(ids.code, "2/3", { pinned: true });
    const earlier = makeProject(ids.code, "1/4");

    expect(() =>
      moveProject(current, { pinned: false, beforeProject: wrongMode, updatedAt }),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      moveProject(current, {
        pinned: false,
        beforeProject: good,
        afterProject: archived,
        updatedAt,
      }),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      moveProject(current, { pinned: false, beforeProject: good, afterProject: pinned, updatedAt }),
    ).toThrow(ProjectPolicyRejected);
    expect(() =>
      moveProject(current, {
        pinned: false,
        beforeProject: good,
        afterProject: earlier,
        updatedAt,
      }),
    ).toThrow(ProjectPolicyRejected);
  });

  it("replays concurrent moves deterministically with equal-rank ID tie-breaking", () => {
    const before = makeProject(ids.chat, "0/1");
    const after = makeProject(ids.later, "1/1");
    const first = moveProject(makeProject(ids.work, "2/1"), {
      pinned: false,
      beforeProject: before,
      afterProject: after,
      updatedAt,
    });
    const second = moveProject(makeProject(ids.code, "3/1"), {
      pinned: false,
      beforeProject: before,
      afterProject: after,
      updatedAt,
    });

    expect(first.rank).toBe(decodeProjectRank("1/2"));
    expect(second.rank).toBe(first.rank);
    expect([second, first].sort(compareProjectOrder).map((project) => project.id)).toEqual([
      ids.work,
      ids.code,
    ]);
  });
});

describe("a Project's trust in key providers", () => {
  it("is set for a Work or Code Project, replaced as a whole list, and cleared by an empty one", () => {
    for (const type of ["work", "code"] as const) {
      const project = makeProject(type === "work" ? ids.work : ids.code, "0/1", { type });
      const trusted = changeProjectNativeProviders(project, ["claude", "opencode"], updatedAt);
      expect(trusted).toMatchObject({ nativeProviders: ["claude", "opencode"], version: 2 });
      expect(decodeProject(trusted)).toEqual(trusted);
      const cleared = changeProjectNativeProviders(trusted, [], updatedAt);
      expect(cleared).not.toHaveProperty("nativeProviders");
    }
  });

  it("refuses a Chat Project, which has no folder of its own code, and a list that changes nothing", () => {
    expect(() =>
      changeProjectNativeProviders(makeProject(ids.chat, "0/1"), ["codex"], updatedAt),
    ).toThrow(ProjectPolicyRejected);
    const trusted = changeProjectNativeProviders(
      makeProject(ids.code, "0/1", { type: "code" }),
      ["codex", "claude"],
      updatedAt,
    );
    expect(() => changeProjectNativeProviders(trusted, ["claude", "codex"], updatedAt)).toThrow(
      ProjectPolicyRejected,
    );
  });

  it("names only key providers, each once, in the journal", () => {
    const project = makeProject(ids.code, "0/1", { type: "code" });
    expect(() => decodeProject({ ...project, nativeProviders: ["pi"] })).toThrow();
    expect(() => decodeProject({ ...project, nativeProviders: ["codex", "codex"] })).toThrow();
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { expect, it, vi } from "vitest";
import { SkillFolderPath } from "@octant/contracts/shell";
import { decodeExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { createExtensionClient } from "@octant/client-runtime/extension-client";
import { SkillDiscoveryService } from "./skillDiscoveryService";
import { extraSkillRootsFromSettings } from "./skillFolderRoots";
import { StandaloneSkillService } from "./standaloneSkillService";

it.each([
  { name: "leading-space basename", basename: " skills", exists: true, label: "skills" },
  { name: "whitespace basename", basename: "   ", exists: true, label: "Skill folder" },
  {
    name: "overlong missing basename with a space at the bound",
    basename: `${"x".repeat(255)} suffix`,
    exists: false,
    label: undefined,
  },
])(
  "keeps a full typed snapshot readable after actual discovery of a $name",
  async ({ basename, exists, label }) => {
    const root = await mkdtemp(join(tmpdir(), "octant-skill-label-"));
    const chosen = join(root, basename);
    const healthy = join(root, "healthy");
    const selected = Schema.decodeUnknownSync(SkillFolderPath)(`${chosen}/`);
    const roots = extraSkillRootsFromSettings(
      { providers: [], folders: [selected, Schema.decodeUnknownSync(SkillFolderPath)(healthy)] },
      { home: root, userGlobalSkillsRoot: join(root, "global") },
    );
    const discovery = new SkillDiscoveryService({
      roots: {
        resolve: async () => [
          {
            projectRoot: root,
            workingDirectory: root,
            projectRef: "fixture",
            userGlobalSkillsRoot: join(root, "global"),
            extraSkillRoots: roots,
          },
        ],
      },
    });
    try {
      await mkdir(join(healthy, "healthy-package"), { recursive: true });
      await writeFile(join(healthy, "healthy-package", "SKILL.md"), "# Healthy instructions\n");
      if (exists) {
        await mkdir(join(chosen, "example"), { recursive: true });
        await writeFile(join(chosen, "example", "SKILL.md"), "# Chosen instructions\n");
      }
      const base = decodeExtensionSnapshot({
        sequence: 0,
        snapshotAt: "2026-11-02T22:00:00.000Z",
        packages: [],
        collisions: [],
      });
      const skills = new StandaloneSkillService({
        discovery,
        lifecycle: {
          snapshot: () => base,
          install: async () => base,
          update: async () => base,
          uninstall: async () => base,
        },
      });
      await skills.reconcile();
      const client = createExtensionClient({
        baseUrl: "http://127.0.0.1",
        windowCapability: "fixture-capability",
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockImplementation(async () => Response.json(skills.snapshot(base))),
      });
      const snapshot = await client.snapshot();
      const diagnostic = snapshot.skillRoots?.find(
        (status) => status.sourceRef === roots[0]?.sourceRef,
      );
      expect(diagnostic?.displayName).toBeTruthy();
      expect(diagnostic?.displayName).toBe(diagnostic?.displayName.trim());
      expect(diagnostic?.displayName.length).toBeLessThanOrEqual(256);
      if (label !== undefined) expect(diagnostic?.displayName).toBe(label);
      expect(diagnostic?.status).toBe(exists ? "ready" : "unreadable");
      expect(
        snapshot.skills?.find((skill) => skill.skill.name === "healthy-package"),
      ).toMatchObject({ reviewed: false, desiredEnabled: false });
      expect(roots[0]?.path).toBe(resolve(chosen));
      if (exists)
        expect(
          discovery.snapshot().skills.find((skill) => skill.skill.name === "example")?.instructions,
        ).toBe("# Chosen instructions\n");
    } finally {
      discovery.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

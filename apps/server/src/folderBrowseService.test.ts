import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WindowId } from "@octant/contracts";
import type { FolderBrowseFailure } from "@octant/contracts/folder-browse";
import type { BindingReceiptStore } from "./bindingReceiptStore";
import {
  FolderBrowseService,
  FolderBrowseServiceError,
  type FolderEntryInspection,
} from "./folderBrowseService";
import type { ProjectRootPort } from "./projectRootPort";

const WINDOW_ID = "00000000-0000-4000-8000-000000000099" as WindowId;
const OTHER_WINDOW = "00000000-0000-4000-8000-000000000088" as WindowId;
const HOST = { hostId: "local", mode: "work" as const };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = cleanups.splice(0);
  await Promise.all(pending.map((fn) => fn()));
});

function makeService(overrides?: {
  homeDir?: string;
  now?: () => number;
  clock?: () => string;
  validate?: ProjectRootPort["validate"];
  issue?: BindingReceiptStore["issue"];
  inspectEntry?: (entryPath: string) => Promise<FolderEntryInspection>;
  entryInspectionTimeoutMs?: number;
}) {
  const receipts: Pick<BindingReceiptStore, "issue"> = {
    issue:
      overrides?.issue ??
      ((input) => ({
        receiptId: `receipt-${input.now}` as never,
        projectType: input.projectType,
        expiresAt: input.now + 60_000,
      })),
  };
  const roots: Pick<ProjectRootPort, "validate"> = {
    validate: overrides?.validate ?? (async (_type, candidate) => ({ canonicalRoot: candidate })),
  };
  return new FolderBrowseService({
    bindingReceiptStore: receipts,
    projectRootPort: roots,
    homeDir: overrides?.homeDir ?? "/tmp/test-home",
    now: overrides?.now ?? (() => 1000),
    clock: overrides?.clock ?? (() => "2026-07-24T12:00:00.000Z"),
    ...(overrides?.inspectEntry === undefined ? {} : { inspectEntry: overrides.inspectEntry }),
    ...(overrides?.entryInspectionTimeoutMs === undefined
      ? {}
      : { entryInspectionTimeoutMs: overrides.entryInspectionTimeoutMs }),
  });
}

/** Inspects an entry the way the host default does, without running Git. */
async function hostInspection(entryPath: string): Promise<FolderEntryInspection> {
  const details = await stat(entryPath);
  if (!details.isDirectory()) return { kind: "skipped" };
  return { kind: "folder", canonicalPath: await realpath(entryPath), isGitRepository: false };
}

async function makeTree(): Promise<{ home: string; outside: string }> {
  const home = await mkdtemp(join(tmpdir(), "octant-folder-browse-"));
  const outside = await mkdtemp(join(tmpdir(), "octant-folder-outside-"));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(join(home, "alpha"));
  await mkdir(join(home, "beta"));
  await mkdir(join(home, "projects", "app", "src"), { recursive: true });
  await writeFile(join(home, "notes.txt"), "not a folder");
  await mkdir(join(outside, "secret"));
  return { home, outside };
}

function names(candidates: ReadonlyArray<{ displayName: string }>): string[] {
  return candidates.map((candidate) => candidate.displayName);
}

async function expectRefusal(
  action: Promise<unknown>,
  category: FolderBrowseFailure["category"],
): Promise<FolderBrowseServiceError> {
  try {
    await action;
  } catch (error) {
    if (!(error instanceof FolderBrowseServiceError)) throw error;
    expect(error.failure.category).toBe(category);
    return error;
  }
  throw new Error(`expected ${category} refusal`);
}

describe("FolderBrowseService", () => {
  describe("browse", () => {
    it("rejects invalid request", async () => {
      const service = makeService();
      await expectRefusal(service.browse(WINDOW_ID, { bad: true }), "invalid");
    });

    it("rejects unknown parent candidate", async () => {
      const service = makeService();
      await expectRefusal(
        service.browse(WINDOW_ID, {
          ...HOST,
          parentCandidateId: "00000000-0000-4000-8000-000000000001",
        }),
        "not-found",
      );
    });

    it("filters the candidate list by the search term", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });

      const unfiltered = await service.browse(WINDOW_ID, HOST);
      expect(names(unfiltered.candidates).sort()).toEqual(["alpha", "beta", "projects"]);

      const filtered = await service.browse(WINDOW_ID, { ...HOST, search: "alp" });
      expect(names(filtered.candidates)).toEqual(["alpha"]);
    });

    it("keeps search inside the authorized root and current folder", async () => {
      const { home, outside } = await makeTree();
      const service = makeService({ homeDir: home });

      const leaked = await service.browse(WINDOW_ID, { ...HOST, search: basename(outside) });
      expect(names(leaked.candidates)).toEqual([]);

      const nested = await service.browse(WINDOW_ID, { ...HOST, search: "app" });
      expect(names(nested.candidates)).toEqual([]);

      const root = await service.browse(WINDOW_ID, HOST);
      const projects = root.candidates.find((candidate) => candidate.displayName === "projects");
      expect(projects).toBeDefined();
      if (projects === undefined) return;

      const fromProjects = await service.browse(WINDOW_ID, {
        ...HOST,
        parentCandidateId: projects.candidateId,
        search: "app",
      });
      expect(names(fromProjects.candidates)).toEqual(["app"]);
    });

    it("does not treat search as a glob or shell pattern", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });
      const result = await service.browse(WINDOW_ID, { ...HOST, search: "*" });
      expect(names(result.candidates)).toEqual([]);
    });

    it("builds breadcrumbs from canonical ancestors inside the authorized root", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });
      const root = await service.browse(WINDOW_ID, HOST);
      const projects = root.candidates.find((candidate) => candidate.displayName === "projects");
      expect(projects).toBeDefined();
      if (projects === undefined) return;

      const nested = await service.browse(WINDOW_ID, {
        ...HOST,
        parentCandidateId: projects.candidateId,
      });
      const app = nested.candidates.find((candidate) => candidate.displayName === "app");
      expect(app).toBeDefined();
      if (app === undefined) return;

      const deep = await service.browse(WINDOW_ID, {
        ...HOST,
        parentCandidateId: app.candidateId,
      });

      expect(deep.breadcrumbs.map((crumb) => crumb.label)).toEqual([
        basename(home),
        "projects",
        "app",
      ]);
      expect(deep.breadcrumbs.some((crumb) => crumb.label === "/" || crumb.label === "tmp")).toBe(
        false,
      );

      const clickable = deep.breadcrumbs.slice(0, -1);
      expect(clickable.length).toBe(2);
      for (const crumb of clickable) {
        expect(crumb.candidateId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
      }
      expect(deep.breadcrumbs.at(-1)?.candidateId).toBeUndefined();
    });

    it("lets an ancestor candidate reopen that folder for the same window and mode", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });
      const root = await service.browse(WINDOW_ID, HOST);
      const projects = root.candidates.find((candidate) => candidate.displayName === "projects");
      expect(projects).toBeDefined();
      if (projects === undefined) return;

      const nested = await service.browse(WINDOW_ID, {
        ...HOST,
        parentCandidateId: projects.candidateId,
      });
      const homeCrumb = nested.breadcrumbs[0];
      expect(homeCrumb?.candidateId).toBeDefined();
      if (homeCrumb?.candidateId === undefined) return;

      const backHome = await service.browse(WINDOW_ID, {
        ...HOST,
        parentCandidateId: homeCrumb.candidateId,
      });
      expect(names(backHome.candidates).sort()).toEqual(["alpha", "beta", "projects"]);
    });

    it("refuses a parent candidate from another window", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });
      const listed = await service.browse(WINDOW_ID, HOST);
      const alpha = listed.candidates.find((candidate) => candidate.displayName === "alpha");
      expect(alpha).toBeDefined();
      if (alpha === undefined) return;

      await expectRefusal(
        service.browse(OTHER_WINDOW, { ...HOST, parentCandidateId: alpha.candidateId }),
        "unauthorized",
      );
    });

    it("refuses a parent candidate issued for another mode", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });
      const listed = await service.browse(WINDOW_ID, HOST);
      const alpha = listed.candidates.find((candidate) => candidate.displayName === "alpha");
      expect(alpha).toBeDefined();
      if (alpha === undefined) return;

      await expectRefusal(
        service.browse(WINDOW_ID, {
          hostId: "local",
          mode: "code",
          parentCandidateId: alpha.candidateId,
        }),
        "invalid",
      );
    });

    it("refuses an expired parent candidate", async () => {
      const { home } = await makeTree();
      let now = 1_000;
      const service = makeService({ homeDir: home, now: () => now });
      const listed = await service.browse(WINDOW_ID, HOST);
      const alpha = listed.candidates.find((candidate) => candidate.displayName === "alpha");
      expect(alpha).toBeDefined();
      if (alpha === undefined) return;

      now = 1_000 + 120_000;
      await expectRefusal(
        service.browse(WINDOW_ID, { ...HOST, parentCandidateId: alpha.candidateId }),
        "not-found",
      );
    });

    it("omits symlink children that resolve outside the authorized root", async () => {
      const { home, outside } = await makeTree();
      await symlink(outside, join(home, "escape"));
      const service = makeService({ homeDir: home });
      const listed = await service.browse(WINDOW_ID, HOST);
      expect(names(listed.candidates)).not.toContain("escape");
    });

    it("lists the remaining folders when one entry's checks never resolve", async () => {
      const { home } = await makeTree();
      await mkdir(join(home, "stalled"));
      const service = makeService({
        homeDir: home,
        entryInspectionTimeoutMs: 25,
        inspectEntry: (entryPath) =>
          basename(entryPath) === "stalled"
            ? new Promise<FolderEntryInspection>(() => {})
            : hostInspection(entryPath),
      });

      const startedAt = Date.now();
      const listed = await service.browse(WINDOW_ID, HOST);
      const elapsedMs = Date.now() - startedAt;

      expect(names(listed.candidates).sort()).toEqual(["alpha", "beta", "projects", "stalled"]);
      const stalled = listed.candidates.find((candidate) => candidate.displayName === "stalled");
      expect(stalled?.isGitRepository).toBe(false);
      expect(elapsedMs).toBeLessThan(2_000);
    });

    it("omits an entry whose inspection fails while keeping the rest of the listing", async () => {
      const { home } = await makeTree();
      const service = makeService({
        homeDir: home,
        entryInspectionTimeoutMs: 25,
        inspectEntry: (entryPath) =>
          basename(entryPath) === "beta"
            ? Promise.reject(new Error("inspection failed"))
            : hostInspection(entryPath),
      });

      const listed = await service.browse(WINDOW_ID, HOST);
      expect(names(listed.candidates).sort()).toEqual(["alpha", "projects"]);
    });
  });

  describe("select", () => {
    it("rejects invalid request", async () => {
      const service = makeService();
      await expectRefusal(service.select(WINDOW_ID, { bad: true }), "invalid");
    });

    it("rejects unknown candidate", async () => {
      const service = makeService();
      await expectRefusal(
        service.select(WINDOW_ID, {
          ...HOST,
          candidateId: "00000000-0000-4000-8000-000000000001",
        }),
        "not-found",
      );
    });

    it("refuses a candidate from another window", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });
      const listed = await service.browse(WINDOW_ID, HOST);
      const alpha = listed.candidates.find((candidate) => candidate.displayName === "alpha");
      expect(alpha).toBeDefined();
      if (alpha === undefined) return;

      await expectRefusal(
        service.select(OTHER_WINDOW, { ...HOST, candidateId: alpha.candidateId }),
        "unauthorized",
      );
    });

    it("refuses a candidate issued for another mode", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });
      const listed = await service.browse(WINDOW_ID, HOST);
      const alpha = listed.candidates.find((candidate) => candidate.displayName === "alpha");
      expect(alpha).toBeDefined();
      if (alpha === undefined) return;

      await expectRefusal(
        service.select(WINDOW_ID, {
          hostId: "local",
          mode: "code",
          candidateId: alpha.candidateId,
        }),
        "invalid",
      );
    });

    it("refuses an expired candidate", async () => {
      const { home } = await makeTree();
      let now = 1_000;
      const service = makeService({ homeDir: home, now: () => now });
      const listed = await service.browse(WINDOW_ID, HOST);
      const alpha = listed.candidates.find((candidate) => candidate.displayName === "alpha");
      expect(alpha).toBeDefined();
      if (alpha === undefined) return;

      now = 1_000 + 120_000;
      await expectRefusal(
        service.select(WINDOW_ID, { ...HOST, candidateId: alpha.candidateId }),
        "not-found",
      );
    });

    it("refuses a candidate whose path now resolves outside the authorized root", async () => {
      const { home, outside } = await makeTree();
      const child = join(home, "child");
      await mkdir(child);
      const service = makeService({ homeDir: home });
      const listed = await service.browse(WINDOW_ID, HOST);
      const issued = listed.candidates.find((candidate) => candidate.displayName === "child");
      expect(issued).toBeDefined();
      if (issued === undefined) return;

      await rm(child, { recursive: true, force: true });
      await symlink(outside, child);

      await expectRefusal(
        service.select(WINDOW_ID, { ...HOST, candidateId: issued.candidateId }),
        "unauthorized",
      );
    });
  });

  describe("resolveCandidate", () => {
    it("resolves a candidate the host listed to the path behind it", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });
      const listed = await service.browse(WINDOW_ID, HOST);
      const beta = listed.candidates.find((candidate) => candidate.displayName === "beta");
      expect(beta).toBeDefined();
      if (beta === undefined) return;

      const path = service.resolveCandidate(WINDOW_ID, {
        ...HOST,
        candidateId: beta.candidateId,
      });

      // The host reports where the folder really is, not the path it was
      // listed by: on macOS a temporary directory is reached through a link.
      expect(path).toBe(await realpath(join(home, "beta")));
    });

    it("refuses a candidate that was shown to another window", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });
      const listed = await service.browse(WINDOW_ID, HOST);
      const beta = listed.candidates.find((candidate) => candidate.displayName === "beta");
      expect(beta).toBeDefined();
      if (beta === undefined) return;

      await expectRefusal(
        Promise.resolve().then(() =>
          service.resolveCandidate(OTHER_WINDOW, { ...HOST, candidateId: beta.candidateId }),
        ),
        "unauthorized",
      );
    });

    it("refuses a candidate that has expired", async () => {
      const { home } = await makeTree();
      let now = 1_000;
      const service = makeService({ homeDir: home, now: () => now });
      const listed = await service.browse(WINDOW_ID, HOST);
      const beta = listed.candidates.find((candidate) => candidate.displayName === "beta");
      expect(beta).toBeDefined();
      if (beta === undefined) return;

      now = 1_000 + 120_000;

      await expectRefusal(
        Promise.resolve().then(() =>
          service.resolveCandidate(WINDOW_ID, { ...HOST, candidateId: beta.candidateId }),
        ),
        "not-found",
      );
    });

    it("refuses a candidate listed for another mode", async () => {
      const { home } = await makeTree();
      const service = makeService({ homeDir: home });
      const listed = await service.browse(WINDOW_ID, HOST);
      const beta = listed.candidates.find((candidate) => candidate.displayName === "beta");
      expect(beta).toBeDefined();
      if (beta === undefined) return;

      await expectRefusal(
        Promise.resolve().then(() =>
          service.resolveCandidate(WINDOW_ID, {
            hostId: "local",
            mode: "code",
            candidateId: beta.candidateId,
          }),
        ),
        "invalid",
      );
    });
  });
});

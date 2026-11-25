import { expect, it, vi } from "vitest";
import { decodeProjectId } from "@octant/contracts";
import type { ProjectSummary } from "@octant/contracts/projects";
import { createActiveWorkProjects } from "./activeWorkProjects";

type Stored = Pick<ProjectSummary, "id" | "type" | "name" | "lifecycle">;
const stored = (id: string, type: Stored["type"], name: string, lifecycle: Stored["lifecycle"]) =>
  ({ id: decodeProjectId(id), type, name, lifecycle }) as Stored;
const p1 = "00000000-0000-4000-8000-0000000000f1";
const p2 = "00000000-0000-4000-8000-0000000000f2";
const reports = stored(p1, "work", "Reports", "active");
const parser = stored(p2, "code", "Parser", "active");
const old = stored("00000000-0000-4000-8000-0000000000f3", "code", "Old", "archived");

it("names Projects from what is stored, and asks for repositories at most once a minute", async () => {
  let now = 0;
  let held: ReadonlyArray<Stored> = [reports, parser, old];
  const bootstrap = vi.fn(async () => ({
    active: [
      {
        ...parser,
        connectedRepository: { host: "github.com", owner: "acme", repository: "parser" },
      } as unknown as ProjectSummary,
    ],
  }));
  const projects = createActiveWorkProjects({
    readProjects: () => held,
    bootstrap,
    now: () => now,
  });
  const first = await projects();
  expect([...first.keys()]).toEqual([p1, p2]);
  expect(first.get(p2)).toMatchObject({
    name: "Parser",
    connectedRepository: { owner: "acme", repository: "parser" },
  });
  now = 59_000;
  held = [{ ...reports, name: "Renamed" }, parser];
  const second = await projects();
  expect(second.get(p1)?.name).toBe("Renamed");
  expect(bootstrap).toHaveBeenCalledTimes(1);
  now = 61_000;
  await projects();
  expect(bootstrap).toHaveBeenCalledTimes(2);
});

it("does not give a relinked Project the repository of the folder it left", async () => {
  let folder = "/repos/parser";
  const bound = () => ({ ...parser, binding: { canonicalRoot: folder } });
  const bootstrap = vi.fn(async () => ({
    active: [
      {
        ...bound(),
        connectedRepository: {
          host: "github.com",
          owner: "acme",
          repository: folder === "/repos/parser" ? "parser" : "parser-next",
        },
      } as unknown as ProjectSummary,
    ],
  }));
  const projects = createActiveWorkProjects({
    readProjects: () => [bound()],
    bootstrap,
    now: () => 0,
  });
  expect((await projects()).get(p2)).toMatchObject({
    connectedRepository: { repository: "parser" },
  });
  folder = "/repos/parser-next";
  expect((await projects()).get(p2)).toMatchObject({
    connectedRepository: { repository: "parser-next" },
  });
  expect(bootstrap).toHaveBeenCalledTimes(2);
});

it("still names Projects when reading repositories fails", async () => {
  const projects = createActiveWorkProjects({
    readProjects: () => [parser],
    bootstrap: async () => {
      throw new Error("git is gone");
    },
    now: () => 0,
  });
  expect((await projects()).get(p2)).toEqual(parser);
});

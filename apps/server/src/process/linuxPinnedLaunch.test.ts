import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pinPreparedLinuxLaunch } from "./linuxPinnedLaunch";

const directories: string[] = [];
afterEach(() => {
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

it("carries an admitted folder identity to the native launch boundary after replacement", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-mediated-pin-")));
  directories.push(base);
  const project = join(base, "project");
  const victim = join(base, "victim");
  mkdirSync(project);
  mkdirSync(victim);
  const admitted = statSync(project, { bigint: true });
  renameSync(project, join(base, "original-project"));
  symlinkSync(victim, project);

  const launch = pinPreparedLinuxLaunch(
    {
      command: "/bin/sh",
      args: ["--ro-bind", realpathSync(project), project, "--", "/bin/true"],
    },
    "/bin/true",
    [{ path: project, identity: `${admitted.dev}:${admitted.ino}` }],
  );

  const pins = launch.args.slice(4, 4 + Number(launch.args[3]) * 4);
  const replacement = pins.indexOf(realpathSync(project));
  expect(replacement).toBeGreaterThan(-1);
  expect(pins.slice(replacement + 1, replacement + 3)).toEqual([
    String(admitted.dev),
    String(admitted.ino),
  ]);
});

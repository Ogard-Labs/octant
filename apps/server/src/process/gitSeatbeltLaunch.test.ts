import { describe, expect, it } from "vitest";
import {
  gitGlobalConfigReadRoots,
  prepareGitSeatbeltLaunch,
  resolveGitExecutable,
} from "./gitSeatbeltLaunch";
import type { SeatbeltConfinementPort } from "./seatbeltProfile";

describe("git Seatbelt launch", () => {
  it("lets confined git read the user's global config alongside the checkout", () => {
    let captured: Parameters<SeatbeltConfinementPort["prepare"]>[0] | undefined;
    const confinement: SeatbeltConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: "/usr/bin/sandbox-exec", args: [] };
      },
    };
    prepareGitSeatbeltLaunch({
      confinement,
      gitExecutable: "/opt/toolchain/usr/bin/git",
      checkoutRoot: "/repo",
      args: ["status"],
      temporaryDirectory: "/tmp",
      networkEgress: "allow",
    });
    const roots = captured?.readRoots ?? [];
    for (const root of gitGlobalConfigReadRoots()) expect(roots).toContain(root);
    expect(roots).toContain("/repo");
    expect(roots).toContain("/opt/toolchain/usr/bin");
  });

  it("derives global config roots from the home and XDG config directories", () => {
    expect(gitGlobalConfigReadRoots("/Users/example", undefined)).toEqual([
      "/Users/example/.gitconfig",
      "/Users/example/.config/git",
    ]);
    expect(gitGlobalConfigReadRoots("/Users/example", "/Users/example/xdg")).toEqual([
      "/Users/example/.gitconfig",
      "/Users/example/xdg/git",
    ]);
  });

  it("keeps an explicit executable and uses the plain system git off macOS", () => {
    expect(resolveGitExecutable("/custom/git", "darwin")).toBe("/custom/git");
    expect(resolveGitExecutable(undefined, "linux")).toBe("/usr/bin/git");
    expect(() => resolveGitExecutable("git", "darwin")).toThrow(/absolute/);
  });
});

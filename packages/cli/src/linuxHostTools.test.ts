import { describe, expect, it } from "vitest";
import { formatMissingLinuxHostTools, missingLinuxHostTools } from "./linuxHostTools";

describe("Linux host tools", () => {
  const present =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  it("names bubblewrap and lsof when a stock host has neither", () => {
    const missing = missingLinuxHostTools({
      platform: "linux",
      isExecutable: present(),
    });
    expect(missing.map((tool) => tool.name)).toEqual(["bwrap", "lsof"]);
    const notice = formatMissingLinuxHostTools(missing);
    expect(notice).toContain("sudo apt-get install -y bubblewrap lsof");
    expect(notice).toContain("Work and Code terminals");
    expect(notice).toContain("Running services");
  });

  it("finds lsof where the managed service looks and bwrap where the server confines with", () => {
    expect(
      missingLinuxHostTools({
        platform: "linux",
        isExecutable: present("/usr/sbin/lsof", "/usr/bin/bwrap"),
      }),
    ).toEqual([]);
  });

  it("does not count an lsof only the interactive shell's PATH can reach", () => {
    // The user unit sets no PATH, so a copy in ~/.local/bin is invisible to the service.
    const missing = missingLinuxHostTools({
      platform: "linux",
      isExecutable: present("/usr/bin/bwrap", "/home/dev/.local/bin/lsof"),
    });
    expect(missing.map((tool) => tool.name)).toEqual(["lsof"]);
  });

  it("reports only what is missing", () => {
    const missing = missingLinuxHostTools({
      platform: "linux",
      isExecutable: present("/usr/bin/lsof"),
    });
    expect(formatMissingLinuxHostTools(missing)).toContain("install -y bubblewrap\n");
  });

  it("asks nothing of a host that is not Linux", () => {
    expect(missingLinuxHostTools({ platform: "darwin", isExecutable: present() })).toEqual([]);
    expect(formatMissingLinuxHostTools([])).toBeUndefined();
  });
});

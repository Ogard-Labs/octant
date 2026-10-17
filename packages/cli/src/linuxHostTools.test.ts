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
      pathVariable: "/usr/local/bin:/usr/bin",
      isExecutable: present(),
    });
    expect(missing.map((tool) => tool.name)).toEqual(["bwrap", "lsof"]);
    const notice = formatMissingLinuxHostTools(missing);
    expect(notice).toContain("sudo apt-get install -y bubblewrap lsof");
    expect(notice).toContain("Work and Code terminals");
    expect(notice).toContain("Running services");
  });

  it("finds lsof anywhere on PATH and bwrap at the path the server confines with", () => {
    expect(
      missingLinuxHostTools({
        platform: "linux",
        pathVariable: "/opt/tools:/usr/bin",
        isExecutable: present("/opt/tools/lsof", "/usr/bin/bwrap"),
      }),
    ).toEqual([]);
  });

  it("reports only what is missing", () => {
    const missing = missingLinuxHostTools({
      platform: "linux",
      pathVariable: "/usr/bin",
      isExecutable: present("/usr/bin/lsof"),
    });
    expect(formatMissingLinuxHostTools(missing)).toContain("install -y bubblewrap\n");
  });

  it("asks nothing of a host that is not Linux", () => {
    expect(missingLinuxHostTools({ platform: "darwin", isExecutable: present() })).toEqual([]);
    expect(formatMissingLinuxHostTools([])).toBeUndefined();
  });
});

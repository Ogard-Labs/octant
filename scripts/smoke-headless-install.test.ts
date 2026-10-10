import { describe, expect, it } from "vitest";
import {
  findNodeModulesAncestor,
  installedCliEnvironment,
  serviceDescriptorPath,
} from "./smoke-headless-install";

describe("headless install smoke isolation", () => {
  it("finds a node_modules directory anywhere above the prefix", () => {
    const present = new Set(["/home/person/checkout/node_modules"]);
    const exists = (path: string) => present.has(path);
    expect(findNodeModulesAncestor("/home/person/checkout/out/prefix", exists)).toBe(
      "/home/person/checkout",
    );
    expect(findNodeModulesAncestor("/home/person/prefix", exists)).toBeUndefined();
  });

  it("names the service descriptor that server start would replace", () => {
    expect(serviceDescriptorPath("linux", "/home/person")).toBe(
      "/home/person/.config/systemd/user/octant.service",
    );
    expect(serviceDescriptorPath("darwin", "/Users/person")).toBe(
      "/Users/person/Library/LaunchAgents/app.octant.server.plist",
    );
  });

  it("gives the installed CLI no module search path from the caller's shell", () => {
    const environment = installedCliEnvironment({
      source: {
        HOME: "/home/person",
        NODE_PATH: "/home/person/checkout/node_modules",
        OCTANT_SERVER_ROOT: "/home/person/checkout/apps/server",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      bunDirectory: "/home/person/.bun/bin",
      dataDirectory: "/tmp/prefix/data",
      port: 14_001,
    });
    expect(environment).toEqual({
      HOME: "/home/person",
      PATH: "/home/person/.bun/bin:/usr/bin:/bin",
      OCTANT_DATA_DIR: "/tmp/prefix/data",
      OCTANT_SERVER_PORT: "14001",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });
});

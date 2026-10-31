import { describe, expect, it } from "vitest";
import { chooseNpmRegistry, PUBLIC_NPM_REGISTRY } from "./npmRegistryConfig";

const userConfigText = [
  "; a comment",
  "//registry.example.test/:_authToken=never-read",
  "registry=https://registry.example.test/npm/",
  "@scoped:registry=https://scoped.example.test",
].join("\n");

describe("choosing the npm registry from the person's own configuration", () => {
  it("uses the public registry when nothing names another", () => {
    expect(chooseNpmRegistry("demo", { env: {} })).toEqual({
      status: "chosen",
      registry: PUBLIC_NPM_REGISTRY,
    });
  });

  it("prefers the environment, then the scope's registry, then the default one", () => {
    expect(chooseNpmRegistry("demo", { env: {}, userConfigText })).toEqual({
      status: "chosen",
      registry: "https://registry.example.test/npm",
    });
    expect(chooseNpmRegistry("@scoped/demo", { env: {}, userConfigText })).toEqual({
      status: "chosen",
      registry: "https://scoped.example.test",
    });
    expect(
      chooseNpmRegistry("@scoped/demo", {
        env: { npm_config_registry: "https://env.example.test" },
        userConfigText,
      }),
    ).toEqual({ status: "chosen", registry: "https://env.example.test" });
  });

  it("refuses an address it cannot read or would reach insecurely instead of falling back", () => {
    const choose = (line: string) => chooseNpmRegistry("demo", { env: {}, userConfigText: line });
    expect(choose("registry=${PRIVATE_REGISTRY}")).toEqual({ status: "unreadable" });
    expect(choose("registry=ftp://x.test")).toEqual({ status: "unreadable" });
    expect(choose("registry=https://user:pw@x.test")).toEqual({ status: "unreadable" });
    expect(choose("registry=http://x.test")).toEqual({ status: "insecure" });
    expect(choose("registry=http://127.0.0.1:4873")).toEqual({
      status: "chosen",
      registry: "http://127.0.0.1:4873",
    });
  });
});

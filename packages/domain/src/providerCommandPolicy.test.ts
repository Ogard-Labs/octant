import { describe, expect, it } from "vitest";
import { providerCommandOf, providerCommandRefusal } from "./providerCommandPolicy";

const commands = [{ name: "review" }, { name: "plugin:deploy" }];

describe("provider slash commands", () => {
  it("runs a listed command in Work and in Code outside Plan", () => {
    for (const executionPolicy of ["approval-gated", "auto-accept-edits", "full-access"] as const) {
      expect(
        providerCommandRefusal({ prompt: "/review src", commands, mode: "code", executionPolicy }),
      ).toBeUndefined();
    }
    expect(
      providerCommandRefusal({ prompt: "/plugin:deploy", commands, mode: "work" }),
    ).toBeUndefined();
  });

  it("refuses a listed command in Plan, which stays read-only", () => {
    expect(
      providerCommandRefusal({
        prompt: "  /review",
        commands,
        mode: "code",
        executionPolicy: "plan",
      }),
    ).toMatch(/^\/review is a command of this thread's provider, and Plan runs none/);
  });

  it("refuses a listed command in Chat, which keeps no folder and no shell", () => {
    expect(providerCommandRefusal({ prompt: "/review", commands, mode: "chat" })).toMatch(
      /Chat runs none: it keeps no folder and no shell/,
    );
  });

  it("refuses any command-shaped opening in Plan and Chat once the provider lists commands, listed here or not", () => {
    // The list a host last wrote may come from another Project's session, so
    // a command it does not name is refused all the same.
    expect(
      providerCommandRefusal({
        prompt: "/deploy-prod now",
        commands,
        mode: "code",
        executionPolicy: "plan",
      }),
    ).toMatch(/^\/deploy-prod is a command of this thread's provider, and Plan runs none/);
    expect(
      providerCommandRefusal({ prompt: "/skill:embedded", commands: [], mode: "chat" }),
    ).toMatch(/^\/skill:embedded is a command of this thread's provider, and Chat runs none/);
    // Outside Plan an unlisted name is ordinary text for the driver to judge.
    expect(
      providerCommandRefusal({
        prompt: "/deploy-prod now",
        commands,
        mode: "code",
        executionPolicy: "approval-gated",
      }),
    ).toBeUndefined();
    // A path is not a command name.
    expect(
      providerCommandRefusal({ prompt: "/usr/bin is on PATH", commands, mode: "chat" }),
    ).toBeUndefined();
  });

  it("leaves text that only starts with a slash alone when the provider listed no such command", () => {
    expect(providerCommandOf("/usr/bin is on PATH", commands)).toBeUndefined();
    expect(providerCommandOf("/reviewer please", commands)).toBeUndefined();
    expect(providerCommandOf("please /review", commands)).toBeUndefined();
    expect(
      providerCommandRefusal({ prompt: "/review", commands: undefined, mode: "chat" }),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { fillLaunchArguments, parseJsonWithComments } from "./codeDebugService";

describe("reading a repository launch file", () => {
  it("reads JSON with comments and trailing commas, and leaves text inside strings alone", () => {
    expect(
      parseJsonWithComments(`﻿{
  // a line comment
  "url": "http://example.com/a,b", /* a block comment */
  "list": [1, 2,],
  "text": "has // no comment and a , ]",
}`),
    ).toEqual({ url: "http://example.com/a,b", list: [1, 2], text: "has // no comment and a , ]" });
  });

  it("reads an unterminated comment or broken JSON as nothing", () => {
    expect(parseJsonWithComments("{ /* never closed }")).toBeUndefined();
    expect(parseJsonWithComments("{ configurations: [] }")).toBeUndefined();
  });
});

describe("filling an adapter's launch body", () => {
  const values = {
    program: "/work/checkout/src/main.py",
    args: ["--port", "8080"],
    cwd: "/work/checkout",
    env: { MODE: "debug" },
    stopOnEntry: true,
    debugPort: 41_000,
  };

  it("replaces whole-value placeholders with the checked values and keeps every literal", () => {
    expect(
      fillLaunchArguments(
        {
          type: "python",
          program: "{{program}}",
          args: "{{args}}",
          cwd: "{{cwd}}",
          env: "{{env}}",
          stopOnEntry: "{{stopOnEntry}}",
          connect: { port: "{{debugPort}}", host: "127.0.0.1" },
          console: "internalConsole",
          list: ["{{cwd}}", 3, null],
        },
        values,
      ),
    ).toEqual({
      type: "python",
      program: "/work/checkout/src/main.py",
      args: ["--port", "8080"],
      cwd: "/work/checkout",
      env: { MODE: "debug" },
      stopOnEntry: true,
      connect: { port: 41_000, host: "127.0.0.1" },
      console: "internalConsole",
      list: ["/work/checkout", 3, null],
    });
  });

  it("keeps an environment entry named like an object's prototype as plain data", () => {
    const filled = fillLaunchArguments(
      { env: "{{env}}" },
      { ...values, env: JSON.parse('{"__proto__": "value"}') as Record<string, string> },
    );
    expect(JSON.stringify(filled)).toBe('{"env":{"__proto__":"value"}}');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

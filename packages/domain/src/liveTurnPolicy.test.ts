import type { ProviderRuntimeEvent } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  liveTurnStep,
  observeLiveTurn,
  startLiveTurn,
  summarizeStepArgument,
} from "./liveTurnPolicy";

let sequence = 0;
function event(kind: ProviderRuntimeEvent["kind"], fields: object = {}): ProviderRuntimeEvent {
  sequence += 1;
  return {
    kind,
    instanceId: "provider-a",
    sessionId: "session-a",
    sequence,
    correlationId: "correlation-a",
    occurredAt: "2026-10-06T12:00:00.000Z",
    ...fields,
  } as unknown as ProviderRuntimeEvent;
}

const toolStart = (toolName: string, argument?: string) =>
  event("tool-start", { toolCallId: `call-${sequence}`, toolName, argument });
const approval = () =>
  event("approval-request", { requestId: "r1", action: "Command", description: "Run it" });

describe("a running turn's live step", () => {
  it("has nothing to say before any tool runs", () => {
    expect(liveTurnStep(startLiveTurn("2026-10-06T12:00:00.000Z"))).toBeUndefined();
  });

  it("follows the latest tool and keeps it after the tool finishes", () => {
    let state = startLiveTurn("2026-10-06T12:00:00.000Z");
    state = observeLiveTurn(state, toolStart("Command", "bun run test"));
    expect(liveTurnStep(state)).toEqual({
      kind: "tool",
      tool: "Command",
      argument: "bun run test",
    });
    state = observeLiveTurn(state, event("tool-success", { toolCallId: "x", summary: "done" }));
    expect(liveTurnStep(state)).toMatchObject({ kind: "tool", argument: "bun run test" });
    state = observeLiveTurn(state, toolStart("File change"));
    expect(liveTurnStep(state)).toEqual({ kind: "tool", tool: "File change" });
  });

  it("says the turn is waiting for approval until the agent moves again", () => {
    let state = observeLiveTurn(startLiveTurn("t"), toolStart("Command", "rm -rf build"));
    state = observeLiveTurn(state, approval());
    expect(liveTurnStep(state)).toEqual({ kind: "waiting", reason: "approval" });
    state = observeLiveTurn(state, event("tool-progress", { toolCallId: "x", message: "go" }));
    expect(liveTurnStep(state)).toMatchObject({ kind: "tool", tool: "Command" });
  });

  it("keeps waiting for approval when a streamed call is named after the ask", () => {
    let state = observeLiveTurn(startLiveTurn("t"), toolStart("Bash"));
    state = observeLiveTurn(state, approval());
    state = observeLiveTurn(
      state,
      event("tool-progress", { toolCallId: "x", message: "Tool is ready to run.", argument: "ls" }),
    );
    expect(liveTurnStep(state)).toEqual({ kind: "waiting", reason: "approval" });
  });

  it("says the turn is waiting for an answer when the agent asks a question", () => {
    const state = observeLiveTurn(
      startLiveTurn("t"),
      event("user-input-request", { requestId: "q1", prompt: "Which one?" }),
    );
    expect(liveTurnStep(state)).toEqual({ kind: "waiting", reason: "user-input" });
  });

  it("names an app-managed tool without echoing its input", () => {
    const state = observeLiveTurn(
      startLiveTurn("t"),
      event("tool-request", {
        requestId: "r",
        toolName: "write_note",
        inputJson: '{"body":"private notes"}',
      }),
    );
    expect(liveTurnStep(state)).toEqual({ kind: "tool", tool: "write_note" });
  });
});

describe("a step argument that leaves the host", () => {
  it("collapses an absolute path to its last segment", () => {
    expect(summarizeStepArgument("cat /Users/henrik/Dev/octant/apps/web/src/App.tsx")).toBe(
      "cat …/App.tsx",
    );
    expect(summarizeStepArgument("ls -la /private/var/folders/ab/T/scratch --color")).toBe(
      "ls -la …/scratch --color",
    );
    expect(summarizeStepArgument("cp a.txt --out=/tmp/work/out.txt")).toBe(
      "cp a.txt --out=…/out.txt",
    );
    expect(summarizeStepArgument("type C:\\Users\\henrik\\notes\\todo.txt")).toBe(
      "type …/todo.txt",
    );
  });

  it("leaves relative paths and URLs alone", () => {
    expect(summarizeStepArgument("bun run test src/a/b.test.ts")).toBe(
      "bun run test src/a/b.test.ts",
    );
    expect(summarizeStepArgument("curl https://example.com/api/items")).toBe(
      "curl https://example.com/api/items",
    );
    expect(summarizeStepArgument("sed -i 's/foo/bar/' src/x.ts")).toBe(
      "sed -i 's/foo/bar/' src/x.ts",
    );
  });

  it("replaces secret-shaped values", () => {
    const cleaned = [
      summarizeStepArgument("OPENAI_API_KEY=sk-live-abcdef1234567890xyz bun run dev"),
      summarizeStepArgument("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' x"),
      summarizeStepArgument("deploy --token abc123secret --env prod"),
      summarizeStepArgument("git clone https://user:hunter2@host.example/r.git"),
      summarizeStepArgument("echo ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
      summarizeStepArgument("export DB_PASSWORD='p@ss word'"),
    ].join("\n");
    for (const secret of [
      "sk-live",
      "abcdefghijklmnopqrstuvwxyz0123",
      "abc123secret",
      "hunter2",
      "ghp_abcdef",
      "p@ss",
    ]) {
      expect(cleaned).not.toContain(secret);
    }
    expect(cleaned).toContain("--env prod");
  });

  it("replaces passwords a command carries in short flags, user:password pairs and named settings", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["mysql -uroot -pHunter2Secret db", "mysql -uroot -p[redacted] db"],
      ["docker login -u me -p s3cr3t ghcr.io", "docker login -u me -p [redacted] ghcr.io"],
      ["sshpass -p hunter2 ssh web1", "sshpass -p [redacted] ssh web1"],
      ["curl -u admin:hunter2 https://x.example", "curl -u admin:[redacted] https://x.example"],
      ["curl --user 'admin:hunter2' x", "curl --user 'admin:[redacted]' x"],
      ["DB_PASS=hunter2 node app.js", "DB_PASS=[redacted] node app.js"],
      ["MY_PW=hunter2 node app.js", "MY_PW=[redacted] node app.js"],
      [
        "npm config set //registry.example/:_authToken npm_abcdef123456",
        "npm config set …/:_authToken [redacted]",
      ],
      [
        "aws configure set aws_secret_access_key wJalrXUtnFEMI",
        "aws configure set aws_secret_access_key [redacted]",
      ],
      ["echo 'hunter2' | sudo -S apt update", "echo [redacted] | sudo -S apt update"],
      ["openssl enc -k hunter2 -in a", "openssl enc -k [redacted] -in a"],
      ["openssl enc -pass pass:hunter2 -in a", "openssl enc -pass pass:[redacted] -in a"],
    ];
    for (const [command, shown] of cases) expect(summarizeStepArgument(command)).toBe(shown);
    // A flag that takes no password keeps its value.
    expect(summarizeStepArgument("mysql -u root -p db")).toBe("mysql -u root -p db");
    expect(summarizeStepArgument("mkdir -p src/a/b")).toBe("mkdir -p src/a/b");
    expect(summarizeStepArgument("ssh -p 2222 web1")).toBe("ssh -p 2222 web1");
  });

  it("shows the command a login-shell wrapper runs, not the wrapper", () => {
    expect(summarizeStepArgument("/bin/zsh -lc 'sleep 120 && echo finished'")).toBe(
      "sleep 120 && echo finished",
    );
    expect(summarizeStepArgument('bash -c "bun run test"')).toBe("bun run test");
    expect(summarizeStepArgument("/bin/sh -lc 'echo it'\\''s fine'")).toBe("echo it's fine");
    // Only a lone wrapper is removed; a command that merely mentions one stays whole.
    expect(summarizeStepArgument("env FOO=1 /bin/zsh -lc 'ls'")).toBe("env FOO=1 …/zsh -lc 'ls'");
  });

  it("keeps only the first line and never a heredoc body", () => {
    expect(summarizeStepArgument("cat > notes.md <<'EOF'\nsecret plan\nEOF")).toBe(
      "cat > notes.md",
    );
    expect(summarizeStepArgument("echo one\necho two")).toBe("echo one");
  });

  it("truncates a long command and says nothing for blank input", () => {
    const summary = summarizeStepArgument(`echo ${"x".repeat(400)}`);
    expect(Array.from(summary ?? "").length).toBe(160);
    expect(summary?.endsWith("…")).toBe(true);
    expect(summarizeStepArgument("   \n  ")).toBeUndefined();
  });

  it("is redacted before the state ever stores it", () => {
    const state = observeLiveTurn(
      startLiveTurn("t"),
      toolStart("Command", "TOKEN=abcdef123456 ./run /Users/me/app/go.sh"),
    );
    expect(JSON.stringify(state)).not.toContain("abcdef123456");
    expect(JSON.stringify(state)).not.toContain("/Users/me");
  });
});

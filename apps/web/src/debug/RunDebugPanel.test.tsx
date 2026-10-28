import {
  CodeDebugClientFailure,
  type CodeDebugClient,
} from "@octant/client-runtime/code-debug-client";
import { decodeCodeCheckoutId, decodeCodeThreadId } from "@octant/contracts/code";
import {
  decodeCodeDebugConfiguration,
  decodeCodeDebugConfigurationsResult,
  decodeCodeDebugSessionResult,
  type CodeDebugSessionCall,
  type CodeDebugSessionResult,
} from "@octant/contracts/code-debug";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { codeDebugThreadKey, CodeDebugWindowState } from "./codeDebugWindowState";
import { RunDebugPanel } from "./RunDebugPanel";

const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const checkoutId = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000001");
const sessionId = "80000000-0000-4000-8000-000000000001";
const adapter = "10000000-0000-4000-8000-000000000001/adapter";
const key = codeDebugThreadKey(String(threadId), String(checkoutId));
const fast = { running: 5, stopped: 5 };

const configuration = decodeCodeDebugConfiguration({
  name: "Run the fixture",
  adapter,
  program: "src/main.js",
  args: ["--verbose"],
  env: [{ key: "FIXTURE_MODE", value: "debug" }],
  stopOnEntry: false,
});

const fixtureAdapter = {
  adapter,
  displayName: "Fixture adapter",
  runtimes: ["node"],
  packageName: "Fixture tools",
  packageVersion: "1.0.0",
};

function listed(approved: boolean, adapters: ReadonlyArray<unknown> = [fixtureAdapter]) {
  return decodeCodeDebugConfigurationsResult({
    status: "listed",
    adapters,
    approved: approved
      ? [{ configurationDigest: `sha256:${"a".repeat(64)}`, configuration, scope: "checkout" }]
      : [],
    launchFile: {
      status: "read",
      proposals: [
        { status: "proposed", configuration, unusedFields: ["preLaunchTask", "console"] },
        { status: "unmappable", name: "Attach to the server", reason: "not-launch" },
      ],
      truncated: false,
    },
  });
}

/**
 * A host with one session: it stops at the breakpoint on line 3, steps to
 * line 5, and ends when stopped. Only the shapes the host answers in.
 */
function fakeHost(options: { readonly start?: unknown; readonly children?: boolean } = {}) {
  let approved = false;
  let line = 3;
  let revision = 1;
  let ended = false;
  // With children: one child process, paused at line 9 until the person stops it.
  let childRunning = options.children === true;
  const answer = (value: unknown) => decodeCodeDebugSessionResult(value);
  const session = vi.fn(async (call: CodeDebugSessionCall): Promise<CodeDebugSessionResult> => {
    const request = call.request;
    if (ended) return answer({ status: "ended", endReason: "stopped" });
    const children =
      options.children === true
        ? {
            children: childRunning
              ? [{ child: 1, name: "Subprocess 4242", status: "stopped" }]
              : [],
            undebuggedChildren: 1,
          }
        : {};
    if (call.child !== undefined) {
      if (!childRunning) return answer({ status: "refused", reason: "no-session" });
      if (request.kind === "stop") {
        childRunning = false;
        return answer({ status: "ended", endReason: "stopped" });
      }
      if (request.kind === "stack-trace") {
        return answer({
          status: "stack",
          frames: [
            {
              id: 1,
              name: "worker",
              location: { kind: "checkout", path: "src/main.js", line: 9, column: 1 },
            },
          ],
          truncated: false,
        });
      }
    }
    switch (request.kind) {
      case "state":
        return answer({
          ...children,
          status: "state",
          state: {
            status: "stopped",
            programThreadId: 1,
            reason: "breakpoint",
            allThreadsStopped: true,
          },
          revision,
          exceptionFilters: [],
          output:
            (request.afterOutput ?? 0) === 0
              ? [{ sequence: 1, category: "stdout", text: "fixture ready\n" }]
              : [],
          outputDropped: false,
        });
      case "stack-trace":
        return answer({
          status: "stack",
          frames: [
            {
              id: 1,
              name: "main",
              location: { kind: "checkout", path: "src/main.js", line, column: 1 },
            },
            {
              id: 2,
              name: "node:internal",
              location: { kind: "outside-checkout", label: "elsewhere" },
            },
          ],
          truncated: false,
        });
      case "scopes":
        return answer({
          status: "scopes",
          scopes: [{ name: "Locals", variablesReference: 10, expensive: false }],
        });
      case "variables":
        return answer(
          request.variablesReference === 10
            ? {
                status: "variables",
                variables: [
                  {
                    name: "count",
                    value: "42",
                    truncated: false,
                    type: "number",
                    variablesReference: 0,
                  },
                  { name: "settings", value: "Object", truncated: false, variablesReference: 11 },
                ],
                truncated: false,
              }
            : {
                status: "variables",
                variables: [
                  { name: "port", value: "8080", truncated: false, variablesReference: 0 },
                ],
                truncated: false,
              },
        );
      case "evaluate":
        return answer({
          status: "evaluated",
          result: {
            name: request.expression,
            value: "84",
            truncated: false,
            variablesReference: 0,
          },
        });
      case "next":
        line = 5;
        revision += 1;
        return answer({ status: "done" });
      case "set-breakpoints":
        return answer({ status: "breakpoints", breakpoints: [] });
      case "stop":
        ended = true;
        return answer({ status: "ended", endReason: "stopped" });
      default:
        return answer({ status: "done" });
    }
  });
  const client: CodeDebugClient = {
    configurations: vi.fn(async () => listed(approved)),
    approve: vi.fn(async (request) => {
      approved = true;
      return {
        status: "approved" as const,
        configurationDigest: `sha256:${"a".repeat(64)}` as never,
        scope: request.scope,
      };
    }),
    start: vi.fn(async () => (options.start ?? { status: "started", sessionId }) as never),
    session,
  };
  return { client, session };
}

function sent(session: ReturnType<typeof fakeHost>["session"], kind: string) {
  return session.mock.calls
    .map(([call]) => call.request)
    .filter((request) => request.kind === kind);
}

describe("Run and debug panel", () => {
  it("confirms an imported configuration, starts it, stops at a breakpoint, shows a variable, steps, evaluates, and stops", async () => {
    const user = userEvent.setup();
    const store = new CodeDebugWindowState();
    store.toggleBreakpoint(key, "src/main.js" as never, 3);
    const { client, session } = fakeHost();
    const onOpenFile = vi.fn();
    render(
      <RunDebugPanel
        checkoutId={checkoutId}
        client={client}
        onOpenFile={onOpenFile}
        pollMs={fast}
        store={store}
        threadId={threadId}
      />,
    );

    // The launch file's entry is only a proposal; its unmappable sibling says why.
    expect(await screen.findByText("Not a launch entry.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Start/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review Run the fixture" }));
    const card = screen.getByRole("region", { name: "Confirm “Run the fixture”" });
    expect(within(card).getByText("src/main.js")).toBeVisible();
    expect(within(card).getByText("FIXTURE_MODE=debug")).toBeVisible();
    expect(within(card).getByText("preLaunchTask")).toBeVisible();
    expect(within(card).getByText(/kept in this Project's record/)).toBeVisible();
    await user.click(within(card).getByRole("button", { name: "Allow in this checkout" }));
    expect(client.approve).toHaveBeenCalledWith({
      threadId,
      checkoutId,
      configuration,
      scope: "checkout",
    });

    await user.click(await screen.findByRole("button", { name: "Start Run the fixture" }));
    expect(client.start).toHaveBeenCalledWith({
      threadId,
      checkoutId,
      configuration,
      breakpoints: [{ path: "src/main.js", breakpoints: [{ line: 3 }] }],
    });

    // Stopped at the breakpoint: the editor is asked to show the line.
    expect(await screen.findByText("Paused · breakpoint")).toBeVisible();
    expect(await screen.findByText("src/main.js:3")).toBeVisible();
    expect(screen.getByText("Outside the checkout")).toBeVisible();
    await waitFor(() => expect(store.read(key).stopped).toEqual({ path: "src/main.js", line: 3 }));
    expect(onOpenFile).toHaveBeenCalledWith("src/main.js");
    expect(await screen.findByText("42")).toBeVisible();
    expect(screen.getByText("fixture ready")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /settings/ }));
    expect(await screen.findByText("8080")).toBeVisible();

    await user.type(
      screen.getByRole("textbox", { name: "Evaluate an expression" }),
      "count * 2{Enter}",
    );
    expect(await screen.findByText("84")).toBeVisible();
    expect(sent(session, "evaluate")).toEqual([
      { kind: "evaluate", expression: "count * 2", context: "repl", frameId: 1 },
    ]);

    await user.click(screen.getByRole("button", { name: "Step over" }));
    expect(await screen.findByText("src/main.js:5")).toBeVisible();
    expect(sent(session, "next")).toEqual([{ kind: "next", programThreadId: 1 }]);
    await waitFor(() => expect(store.read(key).stopped).toEqual({ path: "src/main.js", line: 5 }));

    // A breakpoint set while the session runs goes to the adapter at once.
    store.toggleBreakpoint(key, "src/main.js" as never, 7);
    await waitFor(() =>
      expect(sent(session, "set-breakpoints")).toEqual([
        {
          kind: "set-breakpoints",
          file: { path: "src/main.js", breakpoints: [{ line: 3 }, { line: 7 }] },
        },
      ]),
    );

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("You stopped the session.")).toBeVisible();
    expect(store.read(key).session).toBeUndefined();
    expect(store.read(key).stopped).toBeUndefined();
  });

  it("keeps the keyboard in the panel as the card, the list, a session, and its ending replace the control pressed", async () => {
    const user = userEvent.setup();
    const { client } = fakeHost();
    render(
      <RunDebugPanel
        checkoutId={checkoutId}
        client={client}
        pollMs={fast}
        store={new CodeDebugWindowState()}
        threadId={threadId}
      />,
    );
    // Nothing takes focus when the list first appears.
    await screen.findByText("Not a launch entry.");
    expect(document.body).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Review Run the fixture" }));
    expect(screen.getByRole("heading", { name: "Confirm “Run the fixture”" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Configurations" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Configurations" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Review Run the fixture" }));
    await user.click(screen.getByRole("button", { name: "Allow in this checkout" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Configurations" })).toHaveFocus(),
    );

    await user.click(await screen.findByRole("button", { name: "Start Run the fixture" }));
    expect(await screen.findByText("Paused · breakpoint")).toBeVisible();
    expect(screen.getByText("Run the fixture")).toHaveFocus();
    // A step keeps focus on its own button while the adapter answers.
    const stepOver = screen.getByRole("button", { name: "Step over" });
    await user.click(stepOver);
    expect(await screen.findByText("src/main.js:5")).toBeVisible();
    expect(stepOver).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("You stopped the session.")).toHaveFocus();
  });

  it("names which adapter a configuration uses when two installed adapters share a name", async () => {
    const user = userEvent.setup();
    const { client } = fakeHost();
    const other = "10000000-0000-4000-8000-000000000002/adapter";
    vi.mocked(client.configurations).mockResolvedValue(
      listed(false, [
        fixtureAdapter,
        { ...fixtureAdapter, adapter: other, packageName: "Other tools", packageVersion: "2.1.0" },
      ]),
    );
    render(
      <RunDebugPanel
        checkoutId={checkoutId}
        client={client}
        store={new CodeDebugWindowState()}
        threadId={threadId}
      />,
    );
    expect(
      await screen.findByText("Fixture adapter (Fixture tools 1.0.0) · src/main.js"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Review Run the fixture" }));
    const card = screen.getByRole("region", { name: "Confirm “Run the fixture”" });
    expect(within(card).getByText("Fixture adapter, from Fixture tools 1.0.0")).toBeVisible();
  });

  it("clears the editor's stopped line when the tool closes, and marks it again when it reopens", async () => {
    const user = userEvent.setup();
    const store = new CodeDebugWindowState();
    const { client } = fakeHost();
    vi.mocked(client.configurations).mockResolvedValue(listed(true));
    const panel = () => (
      <RunDebugPanel
        checkoutId={checkoutId}
        client={client}
        pollMs={fast}
        store={store}
        threadId={threadId}
      />
    );
    const first = render(panel());
    await user.click(await screen.findByRole("button", { name: "Start Run the fixture" }));
    await waitFor(() => expect(store.read(key).stopped).toEqual({ path: "src/main.js", line: 3 }));

    // Closed, nothing follows the program, so the editor marks no line.
    first.unmount();
    expect(store.read(key).stopped).toBeUndefined();
    expect(store.read(key).session).toBeDefined();

    render(panel());
    await waitFor(() => expect(store.read(key).stopped).toEqual({ path: "src/main.js", line: 3 }));
  });

  it("drops the unreachable-host notice once the session answers again", async () => {
    const user = userEvent.setup();
    const { client, session } = fakeHost();
    vi.mocked(client.configurations).mockResolvedValue(listed(true));
    render(
      <RunDebugPanel
        checkoutId={checkoutId}
        client={client}
        pollMs={{ running: 5, stopped: 150 }}
        store={new CodeDebugWindowState()}
        threadId={threadId}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Start Run the fixture" }));
    expect(await screen.findByText("Paused · breakpoint")).toBeVisible();
    session.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await screen.findByText("The host could not be reached.");
    await waitFor(() =>
      expect(screen.queryByText("The host could not be reached.")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Paused · breakpoint")).toBeVisible();
  });

  it("shows the host's Plan refusal when Start is pressed in a Plan thread", async () => {
    const user = userEvent.setup();
    const { client } = fakeHost({ start: { status: "refused", reason: "plan-read-only" } });
    vi.mocked(client.configurations).mockResolvedValue(listed(true));
    const store = new CodeDebugWindowState();
    render(
      <RunDebugPanel
        checkoutId={checkoutId}
        client={client}
        pollMs={fast}
        store={store}
        threadId={threadId}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Start Run the fixture" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Plan is read-only, so nothing can be started from it.",
    );
    expect(store.read(key).session).toBeUndefined();
  });

  it("shows a paired browser that debugging stays on this computer and offers it nothing to start", async () => {
    const { client } = fakeHost();
    vi.mocked(client.configurations).mockRejectedValue(
      new CodeDebugClientFailure("local-only", "Remote action is not authorized."),
    );
    render(
      <RunDebugPanel
        checkoutId={checkoutId}
        client={client}
        store={new CodeDebugWindowState()}
        threadId={threadId}
      />,
    );
    expect(await screen.findByText("Debugging stays on this computer")).toBeVisible();
    expect(
      screen.getByText(/A paired device cannot start, control, or watch a session/),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Start|Review|New/ })).not.toBeInTheDocument();
  });

  it("writes a configuration, refuses a malformed environment line, and confirms it for the Project", async () => {
    const user = userEvent.setup();
    const { client } = fakeHost();
    render(
      <RunDebugPanel
        checkoutId={checkoutId}
        client={client}
        store={new CodeDebugWindowState()}
        threadId={threadId}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "New" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Server");
    await user.type(
      screen.getByRole("textbox", { name: "Program, in the checkout" }),
      "src/server.js",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Environment, one NAME=value per line" }),
      "PORT",
    );
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("NAME=value");

    await user.type(
      screen.getByRole("textbox", { name: "Environment, one NAME=value per line" }),
      "=8080",
    );
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Allow in this Project" }));
    expect(client.approve).toHaveBeenCalledWith({
      threadId,
      checkoutId,
      configuration: decodeCodeDebugConfiguration({
        name: "Server",
        adapter,
        program: "src/server.js",
        args: [],
        env: [{ key: "PORT", value: "8080" }],
        stopOnEntry: false,
      }),
      scope: "project",
    });
  });

  it("lists the session's child processes, shows a child's stop when it is selected, and goes back to the program when the child is stopped", async () => {
    const user = userEvent.setup();
    const store = new CodeDebugWindowState();
    const { client, session } = fakeHost({ children: true });
    vi.mocked(client.configurations).mockResolvedValue(listed(true));
    render(
      <RunDebugPanel
        checkoutId={checkoutId}
        client={client}
        pollMs={fast}
        store={store}
        threadId={threadId}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Start Run the fixture" }));
    expect(await screen.findByText("src/main.js:3")).toBeVisible();
    const processes = screen.getByRole("region", { name: "Processes" });
    expect(within(processes).getByText("One child process ran undebugged.")).toBeVisible();

    await user.click(await within(processes).findByRole("button", { name: /Subprocess 4242/ }));
    expect(await screen.findByText("src/main.js:9")).toBeVisible();
    await waitFor(() => expect(store.read(key).stopped).toEqual({ path: "src/main.js", line: 9 }));
    expect(
      session.mock.calls.some(([call]) => call.child === 1 && call.request.kind === "stack-trace"),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Stop child process" }));
    // The session goes on: the program's stop is shown again, and the child is gone.
    expect(await screen.findByText("src/main.js:3")).toBeVisible();
    expect(within(processes).queryByRole("button", { name: /Subprocess 4242/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
    expect(screen.queryByText("You stopped the session.")).toBeNull();
  });
});

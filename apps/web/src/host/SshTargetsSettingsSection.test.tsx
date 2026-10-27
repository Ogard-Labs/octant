import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SshTargetAdministrationBridge, SshTargetOperation } from "../shell/hostBridge";
import { HostPlatformContext } from "../platform";
import { SshTargetsSettingsPage } from "./SshTargetsSettingsSection";

const fingerprint = `SHA256:${"Q".repeat(43)}`;
const hostKey = {
  algorithm: "ssh-ed25519",
  publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
};
const target = {
  id: "55555555-5555-4555-8555-555555555555",
  destination: "build@devbox",
  hostKey,
  executorPath: "/opt/octant/bin/octant",
};
const status = {
  target,
  fingerprint,
  connection: "connected",
  remoteUser: "build",
  platform: "linux",
  admission: [
    { posture: "plan", decision: { status: "admitted" } },
    {
      posture: "approval-gated",
      decision: { status: "refused", reason: "confinement-backend-missing" },
    },
  ],
  runtimeBinaries: [],
};
const project = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "Service",
  targetId: target.id,
  remoteRoot: "/home/build/service",
  boundAt: "2026-10-26T10:00:00.000Z",
};

/** A desktop bridge answering as the host's local routes do, recording what was asked. */
function bridge(
  answers: Partial<
    Record<SshTargetOperation, { readonly status: number; readonly body: unknown }>
  > = {},
) {
  const sent: Array<{ readonly operation: SshTargetOperation; readonly body: unknown }> = [];
  const defaults: Record<SshTargetOperation, { readonly status: number; readonly body: unknown }> =
    {
      list: { status: 200, body: { targets: [status] } },
      projects: { status: 200, body: { projects: [project] } },
      worktrees: { status: 200, body: { worktrees: [] } },
      "probe-host-key": {
        status: 200,
        body: {
          probeId: "44444444-4444-4444-8444-444444444444",
          destination: "build@spare",
          hostKey,
          fingerprint,
        },
      },
      register: {
        status: 200,
        body: { ...status, target: { ...target, destination: "build@spare" } },
      },
      repin: { status: 200, body: status },
      connect: { status: 200, body: status },
      remove: { status: 204, body: null },
      bind: { status: 200, body: project },
      "create-worktree": { status: 409, body: { status: "refused", reason: "worktree-exists" } },
      "remove-worktree": { status: 204, body: null },
      terminal: {
        status: 200,
        body: {
          kind: "project-terminal-refused",
          reason: "unavailable",
          message: "The target has no working bubblewrap. Install bubblewrap on the target.",
        },
      },
    };
  const administration: SshTargetAdministrationBridge = {
    sshTargetRequest: vi.fn(async (operation: SshTargetOperation, body?: unknown) => {
      sent.push({ operation, body });
      return answers[operation] ?? defaults[operation];
    }),
  };
  return { administration, sent };
}

describe("Settings › SSH targets", () => {
  it("shows what each posture admits on a target, with the recovery for a refusal", async () => {
    const { administration } = bridge();
    render(<SshTargetsSettingsPage bridge={administration} />);
    const row = await screen.findByRole("group", { name: "build@devbox setting" });
    expect(row.textContent).toContain("Connected as build on Linux");
    expect(row.textContent).toContain("Plan · read-only: admitted");
    expect(row.textContent).toContain(
      "Ask for approvals: The target has no working bubblewrap. Install bubblewrap on the target.",
    );
  });

  it("pins a host key only after the person confirms the fingerprint, saying what the pin does not prove", async () => {
    const user = userEvent.setup();
    const { administration, sent } = bridge();
    render(<SshTargetsSettingsPage bridge={administration} />);
    await user.type(await screen.findByLabelText("Destination"), "build@spare");
    await user.type(screen.getByLabelText("Octant on the target"), "/opt/octant/bin/octant");
    await user.click(screen.getByRole("button", { name: "Read host key" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(fingerprint);
    expect(dialog.textContent).toContain("The pin proves only that later sessions reach this key.");
    expect(sent.map((request) => request.operation)).not.toContain("register");

    await user.click(within(dialog).getByRole("button", { name: "Pin this key" }));
    await waitFor(() =>
      expect(sent.find((request) => request.operation === "register")?.body).toEqual({
        probeId: "44444444-4444-4444-8444-444444444444",
        fingerprint,
        executorPath: "/opt/octant/bin/octant",
      }),
    );
  });

  it("says why the host refused a terminal or a worktree in a remote Project", async () => {
    const user = userEvent.setup();
    const { administration, sent } = bridge();
    render(<SshTargetsSettingsPage bridge={administration} />);
    const row = await screen.findByRole("group", { name: "Service setting" });
    expect(row.textContent).toContain("build@devbox:/home/build/service");

    await user.click(within(row).getByRole("button", { name: "Open terminal" }));
    expect(
      await screen.findByText(
        "The target has no working bubblewrap. Install bubblewrap on the target.",
      ),
    ).toBeTruthy();
    expect(sent.find((request) => request.operation === "terminal")?.body).toMatchObject({
      kind: "start",
      projectId: project.id,
      columns: 100,
      rows: 30,
    });

    await user.type(within(row).getByLabelText("New worktree name for Service"), "fix-login");
    await user.click(within(row).getByRole("button", { name: "New worktree" }));
    expect(
      await screen.findByText("A worktree or branch of that name already exists."),
    ).toBeTruthy();
    expect(sent.find((request) => request.operation === "create-worktree")?.body).toEqual({
      projectId: project.id,
      name: "fix-login",
    });
  });

  it("stops the shown terminal when it opens another or leaves the page, so no shell it can no longer reach keeps running", async () => {
    const user = userEvent.setup();
    const running = (body: unknown) => {
      const { terminalId } = body as { readonly terminalId: string };
      return {
        status: 200,
        body: {
          kind: "project-terminal",
          terminal: {
            projectId: project.id,
            terminalId,
            state: "running",
            posture: "approval-gated",
          },
        },
      };
    };
    const { administration, sent } = bridge();
    vi.mocked(administration.sshTargetRequest).mockImplementation(async (operation, body) => {
      sent.push({ operation, body });
      if (operation === "terminal") return running(body);
      if (operation === "list") return { status: 200, body: { targets: [status] } };
      if (operation === "projects") return { status: 200, body: { projects: [project] } };
      return { status: 200, body: { worktrees: [] } };
    });
    const view = render(<SshTargetsSettingsPage bridge={administration} />);
    const row = await screen.findByRole("group", { name: "Service setting" });
    const terminalCommands = () =>
      sent
        .filter((request) => request.operation === "terminal")
        .map((request) => request.body as { readonly kind: string; readonly terminalId: string })
        .filter((command) => command.kind === "start" || command.kind === "stop");

    await user.click(within(row).getByRole("button", { name: "Open terminal" }));
    await screen.findByRole("button", { name: "Close terminal" });
    await user.click(within(row).getByRole("button", { name: "Open terminal" }));
    await waitFor(() => expect(terminalCommands()).toHaveLength(3));
    const [first, stopped, second] = terminalCommands();
    expect(first?.kind).toBe("start");
    expect(stopped).toMatchObject({ kind: "stop", terminalId: first?.terminalId });
    expect(second?.kind).toBe("start");

    view.unmount();
    await waitFor(() =>
      expect(terminalCommands().at(-1)).toMatchObject({
        kind: "stop",
        terminalId: second?.terminalId,
      }),
    );
  });
});

// Each host is seen from a window on the other platform, so copy that read the
// window's platform instead of the host's would name the wrong computer.
const HOSTS = [
  { hostPlatform: "linux", window: "MacIntel", computer: "this computer", elsewhere: /this Mac/ },
  {
    hostPlatform: "darwin",
    window: "Linux x86_64",
    computer: "this Mac",
    elsewhere: /this computer/,
  },
] as const;

describe.each(HOSTS)("Settings › SSH targets on a $hostPlatform host", (host) => {
  beforeEach(() => {
    Object.defineProperty(window.navigator, "platform", { value: host.window, configurable: true });
  });
  afterEach(() => Reflect.deleteProperty(window.navigator, "platform"));

  it("names the host's computer as the one that reaches the targets and confines their work", async () => {
    render(
      <HostPlatformContext.Provider value={host.hostPlatform}>
        <SshTargetsSettingsPage bridge={bridge().administration} />
      </HostPlatformContext.Provider>,
    );
    await screen.findByRole("group", { name: "Service setting" });

    expect(screen.getByText(/^Machines .* reaches with ssh\./)).toHaveTextContent(
      `Machines ${host.computer} reaches with ssh. A Code Project can keep its folder on one; Octant admits work there only after the target proves it confines it as ${host.computer} would.`,
    );
    expect(screen.getByText(/^A Code Project whose folder is on a target\./)).toHaveTextContent(
      `A Code Project whose folder is on a target. Its terminals and worktrees run there, under the same confinement as on ${host.computer}.`,
    );
    expect(document.body.textContent).not.toMatch(host.elsewhere);
  });
});

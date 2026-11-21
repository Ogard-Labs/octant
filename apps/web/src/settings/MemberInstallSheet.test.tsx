import type {
  MemberInstallCommand,
  MemberInstallPlan,
  MemberInstallProgress,
  MemberInstallResult,
  ShieldServer,
} from "@octant/contracts/shield-servers";
import { ShieldServersClientFailure } from "@octant/client-runtime/shield-servers-client";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemberInstallSheet } from "./MemberInstallSheet";
import { ShieldServersSettings } from "./ShieldServersSettings";

const SERVER: ShieldServer = {
  serverId: "5e7e0000-0000-4000-8000-000000000001" as ShieldServer["serverId"],
  alias: "devbox",
  user: "build",
  profile: "operate",
  deployCommands: [],
};

const PLAN = {
  planId: "9a1b2c3d-0000-4000-8000-000000000001" as MemberInstallPlan["planId"],
  serverId: SERVER.serverId,
  alias: "devbox",
  user: "build",
  system: "Linux x86_64",
  target: "linux-x64",
  artifactVersion: "1.2.3",
  ring: "stable",
  signature: "verified",
  installRoot: "/home/build/.local/state/octant/install",
  service: "systemd-user",
  startsAtBoot: false,
  bootCommand: "sudo loginctl enable-linger build",
  addresses: [
    { address: "100.101.102.103", network: "tailscale" },
    { address: "192.168.1.20", network: "lan-private" },
  ],
  listenPort: 8443,
  joins: { kind: "hub", hubName: "Studio" },
} as MemberInstallPlan;

function progress(
  state: MemberInstallProgress["state"],
  steps: MemberInstallProgress["steps"],
): MemberInstallProgress {
  return {
    installId: "7c0e8d51-0000-4000-8000-000000000001",
    serverId: SERVER.serverId,
    state,
    steps,
  } as MemberInstallProgress;
}

function setup(answers: (command: MemberInstallCommand) => MemberInstallResult) {
  const memberInstall = vi.fn(async (command: MemberInstallCommand) => answers(command));
  const onOpenPrivateNetworkGuide = vi.fn();
  const user = userEvent.setup();
  render(
    <MemberInstallSheet
      client={{ memberInstall }}
      onClose={() => {}}
      onOpenPrivateNetworkGuide={onOpenPrivateNetworkGuide}
      server={SERVER}
    />,
  );
  return { memberInstall, onOpenPrivateNetworkGuide, user };
}

describe("Make this an Octant computer", () => {
  it("states what Octant read and will do before anything runs, then shows each step's outcome", async () => {
    const running = progress("running", [
      { step: "copy", state: "running" },
      { step: "verify", state: "waiting" },
      { step: "install", state: "waiting" },
      { step: "start", state: "waiting" },
      { step: "listen", state: "waiting" },
      { step: "join", state: "waiting" },
    ]);
    const finished = progress("failed", [
      { step: "copy", state: "succeeded" },
      { step: "verify", state: "succeeded" },
      { step: "install", state: "succeeded" },
      { step: "start", state: "succeeded" },
      {
        step: "listen",
        state: "failed",
        message: "100.101.102.103 is not an address of this computer.",
      },
      { step: "join", state: "not-run" },
    ]);
    const { memberInstall, user } = setup((command) =>
      command.kind === "prepare-member-install"
        ? { kind: "member-install-plan", plan: PLAN }
        : command.kind === "confirm-member-install"
          ? { kind: "member-install-progress", progress: running }
          : { kind: "member-install-progress", progress: finished },
    );

    const facts = await screen.findByLabelText("What Octant will do");
    const text = facts.textContent ?? "";
    expect(text).toContain("build@devbox");
    expect(text).toContain("Linux x86_64");
    expect(text).toContain("uname -sm");
    expect(text).toContain("Version 1.2.3 from the stable release");
    expect(text).toContain("release signature and every file's digest were checked");
    expect(text).toContain("/home/build/.local/state/octant/install");
    expect(text).toContain("never uses sudo");
    expect(text).toContain("A user service of build");
    expect(within(facts).getByText("sudo loginctl enable-linger build")).toBeTruthy();
    expect(text).toContain("Port 8443");
    expect(text).toContain("Your hub, Studio");
    expect(text).toContain("comparison code devbox shows matches");
    expect(screen.getByRole("combobox", { name: "Listens on" }).textContent).toContain(
      "100.101.102.103 (Tailscale)",
    );
    // Reading the plan ran nothing on the server.
    expect(memberInstall.mock.calls.map(([command]) => command.kind)).toEqual([
      "prepare-member-install",
    ]);

    await user.click(screen.getByRole("button", { name: "Install and join" }));
    expect(memberInstall).toHaveBeenCalledWith({
      kind: "confirm-member-install",
      planId: PLAN.planId,
      listenAddress: "100.101.102.103",
    });
    const steps = await screen.findByRole("list", { name: "Steps" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Copy the buildRunning…",
      "Verify it on the serverWaiting",
      "InstallWaiting",
      "Start the serviceWaiting",
      "Turn on the listenerWaiting",
      "Join the hubWaiting",
    ]);
    expect(
      await screen.findByText("Nothing ran after the step that failed.", {}, { timeout: 3_000 }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Steps" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Copy the buildDone",
      "Verify it on the serverDone",
      "InstallDone",
      "Start the serviceDone",
      "Turn on the listenerFailed100.101.102.103 is not an address of this computer.",
      "Join the hubNot run",
    ]);
  });

  it("keeps showing progress after a progress read fails once", async () => {
    const steps: MemberInstallProgress["steps"] = [
      { step: "copy", state: "succeeded" },
      { step: "verify", state: "succeeded" },
      { step: "install", state: "succeeded" },
      { step: "start", state: "succeeded" },
      { step: "listen", state: "failed", message: "Port taken." },
      { step: "join", state: "not-run" },
    ];
    let reads = 0;
    const memberInstall = vi.fn(async (command: MemberInstallCommand) => {
      if (command.kind === "prepare-member-install") {
        return { kind: "member-install-plan", plan: PLAN } as MemberInstallResult;
      }
      if (command.kind === "confirm-member-install") {
        return {
          kind: "member-install-progress",
          progress: progress("running", [{ step: "copy", state: "running" }]),
        } as MemberInstallResult;
      }
      reads += 1;
      if (reads === 1) throw new Error("connection lost");
      return {
        kind: "member-install-progress",
        progress: progress("failed", steps),
      } as MemberInstallResult;
    });
    const user = userEvent.setup();
    render(
      <MemberInstallSheet
        client={{ memberInstall }}
        onClose={() => {}}
        onOpenPrivateNetworkGuide={() => {}}
        server={SERVER}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Install and join" }));
    expect(
      await screen.findByText("Nothing ran after the step that failed.", {}, { timeout: 4_000 }),
    ).toBeTruthy();
    expect(reads).toBe(2);
  });

  it("stops reading progress once the host no longer accepts this window", async () => {
    const memberInstall = vi.fn(async (command: MemberInstallCommand) => {
      if (command.kind === "prepare-member-install") {
        return { kind: "member-install-plan", plan: PLAN } as MemberInstallResult;
      }
      if (command.kind === "confirm-member-install") {
        return {
          kind: "member-install-progress",
          progress: progress("running", [{ step: "copy", state: "running" }]),
        } as MemberInstallResult;
      }
      throw new ShieldServersClientFailure("Unauthorized", 401);
    });
    const user = userEvent.setup();
    render(
      <MemberInstallSheet
        client={{ memberInstall }}
        onClose={() => {}}
        onOpenPrivateNetworkGuide={() => {}}
        server={SERVER}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Install and join" }));
    expect(
      await screen.findByText(/no longer accepts this window/, {}, { timeout: 4_000 }),
    ).toBeTruthy();
    await new Promise((done) => setTimeout(done, 1_500));
    expect(memberInstall.mock.calls.filter(([c]) => c.kind === "read-member-install")).toHaveLength(
      1,
    );
  });

  it("refuses a server with no private address and links the private network guide", async () => {
    const { onOpenPrivateNetworkGuide, user } = setup(() => ({
      kind: "member-install-refused",
      reason: "no-private-address",
      message:
        "devbox has no Tailscale or private network address, and Octant listens only on one. Connect devbox to Tailscale or your local network (see the private network guide), then try again.",
    }));
    expect(await screen.findByText(/Connect devbox to Tailscale/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install and join" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open the private network guide" }));
    expect(onOpenPrivateNetworkGuide).toHaveBeenCalledTimes(1);
  });

  it("is offered on a registered server's row and opens the sheet for that server", async () => {
    const memberInstall = vi.fn(
      async (_command: MemberInstallCommand): Promise<MemberInstallResult> => ({
        kind: "member-install-plan",
        plan: PLAN,
      }),
    );
    const user = userEvent.setup();
    render(
      <ShieldServersSettings
        client={{
          read: async () => ({ servers: [SERVER], sshAgent: "available" }),
          command: async () => ({
            kind: "shield-servers-refused",
            reason: "unavailable",
            message: "",
          }),
          memberInstall,
        }}
        projectNames={new Map()}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Make this an Octant computer: devbox" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Make devbox an Octant computer" }),
    ).toBeTruthy();
    expect(memberInstall).toHaveBeenCalledWith({
      kind: "prepare-member-install",
      serverId: SERVER.serverId,
    });
  });
});

import type {
  MemberInstallCommand,
  MemberInstallResult,
  MemberRemovalPlan,
  MemberRemovalProgress,
  MemberUpdatePlan,
  MemberUpdateProgress,
  ShieldServer,
} from "@octant/contracts/shield-servers";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemberRemovalSheet, MemberUpdateSheet } from "./MemberUpkeepSheets";
import { ShieldServersSettings } from "./ShieldServersSettings";

const SERVER: ShieldServer = {
  serverId: "5e7e0000-0000-4000-8000-000000000001" as ShieldServer["serverId"],
  alias: "devbox",
  user: "build",
  profile: "operate",
  deployCommands: [],
};

const UPDATE_PLAN = {
  planId: "9a1b2c3d-0000-4000-8000-000000000002" as MemberUpdatePlan["planId"],
  serverId: SERVER.serverId,
  alias: "devbox",
  user: "build",
  target: "linux-x64",
  fromVersion: "1.2.3",
  toVersion: "1.2.4",
  ring: "stable",
  signature: "verified",
  installRoot: "/home/build/.local/state/octant/install",
  storeMigration: false,
  drains: ["wait", "stop-now"],
} as MemberUpdatePlan;

const REMOVAL_PLAN = {
  planId: "9a1b2c3d-0000-4000-8000-000000000003" as MemberRemovalPlan["planId"],
  serverId: SERVER.serverId,
  alias: "devbox",
  user: "build",
  installRoot: "/home/build/.local/state/octant/install",
  dataFolder: "/home/build/.local/share/octant",
  service: "systemd-user",
} as MemberRemovalPlan;

function itemsOf(list: HTMLElement): ReadonlyArray<string | null> {
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

function sheetClient(answers: (command: MemberInstallCommand) => MemberInstallResult) {
  return vi.fn(async (command: MemberInstallCommand) => answers(command));
}

describe("Update and Remove Octant on an Octant computer", () => {
  it("the Update sheet states what will happen and shows its steps, then the roll-back and why", async () => {
    const updateId = "7c0e8d51-0000-4000-8000-000000000002" as MemberUpdateProgress["updateId"];
    const rolledBack = {
      updateId,
      serverId: SERVER.serverId,
      state: "rolled-back",
      rollbackReason: "protocol-not-covered",
      steps: [
        { step: "copy", state: "succeeded" },
        { step: "verify", state: "succeeded" },
        { step: "drain", state: "succeeded" },
        { step: "swap", state: "succeeded" },
        {
          step: "confirm",
          state: "failed",
          message: "Octant 1.2.4 on devbox speaks protocol 2 to 3.",
        },
        { step: "roll-back", state: "succeeded" },
      ],
    } as MemberUpdateProgress;
    const memberInstall = sheetClient((command) =>
      command.kind === "prepare-member-update"
        ? { kind: "member-update-plan", plan: UPDATE_PLAN }
        : { kind: "member-update-progress", progress: rolledBack },
    );
    const user = userEvent.setup();
    render(<MemberUpdateSheet client={{ memberInstall }} onClose={() => {}} server={SERVER} />);

    const facts = await screen.findByLabelText("What the update will do");
    await user.click(screen.getByRole("radio", { name: "Stop now" }));
    const text = facts.textContent ?? "";
    expect(text).toContain("build@devbox");
    expect(text).toContain("From 1.2.3 to 1.2.4, from the stable release");
    expect(text).toContain("release signature and every file's digest were checked");
    expect(text).toContain("refuses new turns and stops now, before the swap");
    expect(text).toContain("continue by themselves once it starts again");
    expect(text).toContain("octant server upgrade");
    expect(text).toContain("/home/build/.local/state/octant/install");
    expect(text).toContain("signed hello");
    expect(text).toContain("Octant puts 1.2.3 back and says why");
    expect(itemsOf(screen.getByRole("list", { name: "Steps" }))).toEqual([
      "Copy the build",
      "Verify it on the server",
      "Drain running turns",
      "Swap to 1.2.4",
      "Confirm its signed hello",
    ]);
    // Reading the plan ran nothing on the server.
    expect(memberInstall.mock.calls.map(([command]) => command.kind)).toEqual([
      "prepare-member-update",
    ]);

    await user.click(screen.getByRole("button", { name: "Update to 1.2.4" }));
    expect(memberInstall).toHaveBeenCalledWith({
      kind: "confirm-member-update",
      planId: UPDATE_PLAN.planId,
      drain: { kind: "stop-now" },
    });
    expect(
      await screen.findByText(
        "devbox was rolled back to 1.2.3, because its protocol range does not cover this computer.",
      ),
    ).toBeTruthy();
    expect(itemsOf(screen.getByRole("list", { name: "Steps" }))).toEqual([
      "Copy the buildDone",
      "Verify it on the serverDone",
      "Drain running turnsDone",
      "Swap to 1.2.4Done",
      "Confirm its signed helloFailedOctant 1.2.4 on devbox speaks protocol 2 to 3.",
      "Roll back to 1.2.3Done",
    ]);
  });

  it("the Update sheet waits up to ten minutes for running work unless the person picks another bound", async () => {
    const progress = {
      updateId: "7c0e8d51-0000-4000-8000-000000000004" as MemberUpdateProgress["updateId"],
      serverId: SERVER.serverId,
      state: "running",
      steps: [{ step: "copy", state: "running" }],
    } as MemberUpdateProgress;
    const memberInstall = sheetClient((command) =>
      command.kind === "prepare-member-update"
        ? { kind: "member-update-plan", plan: UPDATE_PLAN }
        : { kind: "member-update-progress", progress },
    );
    const user = userEvent.setup();
    render(<MemberUpdateSheet client={{ memberInstall }} onClose={() => {}} server={SERVER} />);

    const wait = await screen.findByRole("radio", {
      name: "Wait up to 10 minutes for running work",
    });
    expect(wait.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Stop now" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    const facts = screen.getByLabelText("What the update will do").textContent ?? "";
    expect(facts).toContain("refuses new turns at once and lets running ones finish");

    const minutes = screen.getByRole("spinbutton", { name: "Minutes to wait for running work" });
    await user.clear(minutes);
    await user.type(minutes, "25");
    expect(
      screen.getByRole("radio", { name: "Wait up to 25 minutes for running work" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Update to 1.2.4" }));
    expect(memberInstall).toHaveBeenCalledWith({
      kind: "confirm-member-update",
      planId: UPDATE_PLAN.planId,
      drain: { kind: "wait", minutes: 25 },
    });
  });

  it("the Remove Octant sheet says what is deleted and kept, deletes the data folder only when ticked, and shows its steps", async () => {
    const removed = {
      removalId: "7c0e8d51-0000-4000-8000-000000000003" as MemberRemovalProgress["removalId"],
      serverId: SERVER.serverId,
      state: "removed",
      deleteData: true,
      steps: [
        { step: "leave", state: "succeeded" },
        { step: "stop", state: "succeeded" },
        { step: "delete", state: "succeeded" },
      ],
    } as MemberRemovalProgress;
    const memberInstall = sheetClient((command) =>
      command.kind === "prepare-member-removal"
        ? { kind: "member-removal-plan", plan: REMOVAL_PLAN }
        : { kind: "member-removal-progress", progress: removed },
    );
    const user = userEvent.setup();
    render(<MemberRemovalSheet client={{ memberInstall }} onClose={() => {}} server={SERVER} />);

    const facts = await screen.findByLabelText("What removing Octant will do");
    const text = () => facts.textContent ?? "";
    expect(text()).toContain("leaves your hub");
    expect(text()).toContain("systemd user service is stopped and removed");
    expect(text()).toContain(
      "The install, /home/build/.local/state/octant/install, and Octant's install and update work folders beside it.",
    );
    expect(text()).toMatch(/KeptThe data folder, \/home\/build\/\.local\/share\/octant/);
    expect(itemsOf(screen.getByRole("list", { name: "Steps" }))).toEqual([
      "Leave the hub",
      "Stop and remove the service",
      "Delete the install",
    ]);
    expect(screen.getByRole("button", { name: "Remove Octant" })).toBeTruthy();

    await user.click(screen.getByRole("checkbox", { name: "Also delete the data folder" }));
    expect(text()).toContain("This cannot be undone.");
    expect(text()).toContain(
      "Service logs Octant keeps outside the data folder on devbox (for example ~/.local/state/octant/logs on Linux or ~/Library/Logs/Octant on a Mac); logs inside the data folder go with it. Delete those by hand if you want them gone. Files Octant did not make stay on the server too.",
    );
    expect(itemsOf(screen.getByRole("list", { name: "Steps" })).at(-1)).toBe(
      "Delete the install and the data folder",
    );
    await user.click(screen.getByRole("button", { name: "Remove Octant and its data" }));
    expect(memberInstall).toHaveBeenCalledWith({
      kind: "confirm-member-removal",
      planId: REMOVAL_PLAN.planId,
      deleteData: true,
    });
    expect(
      await screen.findByText("Octant is removed from devbox, with its data folder."),
    ).toBeTruthy();
    expect(itemsOf(screen.getByRole("list", { name: "Steps" }))).toEqual([
      "Leave the hubDone",
      "Stop and remove the serviceDone",
      "Delete the install and the data folderDone",
    ]);
  });

  it("the Remove Octant sheet keeps reading progress after a read fails once", async () => {
    const removalId = "7c0e8d51-0000-4000-8000-000000000004" as MemberRemovalProgress["removalId"];
    const progressOf = (state: MemberRemovalProgress["state"]) =>
      ({
        removalId,
        serverId: SERVER.serverId,
        state,
        deleteData: false,
        steps: [
          { step: "leave", state: "succeeded" },
          { step: "stop", state: state === "running" ? "running" : "succeeded" },
          { step: "delete", state: state === "running" ? "waiting" : "succeeded" },
        ],
      }) as MemberRemovalProgress;
    let reads = 0;
    const memberInstall = vi.fn(async (command: MemberInstallCommand) => {
      if (command.kind === "prepare-member-removal") {
        return { kind: "member-removal-plan", plan: REMOVAL_PLAN } as MemberInstallResult;
      }
      if (command.kind === "confirm-member-removal") {
        return {
          kind: "member-removal-progress",
          progress: progressOf("running"),
        } as MemberInstallResult;
      }
      reads += 1;
      if (reads === 1) throw new Error("connection lost");
      return {
        kind: "member-removal-progress",
        progress: progressOf("removed"),
      } as MemberInstallResult;
    });
    const user = userEvent.setup();
    render(<MemberRemovalSheet client={{ memberInstall }} onClose={() => {}} server={SERVER} />);
    await user.click(await screen.findByRole("button", { name: "Remove Octant" }));
    expect(
      await screen.findByText(/Octant is removed from devbox/, {}, { timeout: 4_000 }),
    ).toBeTruthy();
    expect(reads).toBe(2);
  });

  it("an Octant computer's row offers Update and Remove Octant instead of Make this an Octant computer", async () => {
    const memberInstall = sheetClient((command) =>
      command.kind === "list-member-computers"
        ? {
            kind: "member-computers",
            members: [
              {
                serverId: SERVER.serverId,
                target: "linux-x64",
                artifactVersion: "1.2.3",
                listenAddress: "100.101.102.103",
                listenPort: 8443,
              },
            ],
          }
        : { kind: "member-update-plan", plan: UPDATE_PLAN },
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
    expect(await screen.findByRole("button", { name: "Remove Octant from devbox" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Make this an Octant computer: devbox" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Update Octant on devbox" }));
    expect(await screen.findByRole("dialog", { name: "Update Octant on devbox" })).toBeTruthy();
    expect(memberInstall).toHaveBeenCalledWith(
      { kind: "prepare-member-update", serverId: SERVER.serverId },
      expect.any(AbortSignal),
    );
  });
});

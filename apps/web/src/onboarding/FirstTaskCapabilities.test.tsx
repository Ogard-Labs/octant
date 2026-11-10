import { decodeAgentRunPolicySettings } from "@octant/contracts";
import { decodePersonMemoryView } from "@octant/contracts/person-memory";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { FirstTaskCapabilities, type FirstTaskCapabilitiesProps } from "./FirstTaskCapabilities";

function props(): FirstTaskCapabilitiesProps {
  return {
    browser: "supported",
    computerUse: { enabled: false, automaticUpdates: false },
    helpers: {
      current: vi.fn(async () =>
        decodeAgentRunPolicySettings({
          creationPosture: "off",
          version: 0,
          updatedAt: "2026-11-07T00:00:00.000Z",
        }),
      ),
    },
    memory: {
      read: vi.fn(async () =>
        decodePersonMemoryView({
          kind: "person-memory",
          settings: { enabled: false, pastThreadSearch: true, excludedProjectIds: [] },
          version: 0,
          entries: [],
          rememberedThreads: 0,
          untracedThreads: [],
        }),
      ),
    },
    onOpenSettings: vi.fn(),
    onDismiss: vi.fn(),
  };
}

it("reads current host settings instead of claiming the default is on", async () => {
  render(<FirstTaskCapabilities {...props()} />);
  expect(await screen.findByLabelText("Helper agents status")).toHaveTextContent("Off");
  expect(await screen.findByLabelText("Person memory status")).toHaveTextContent("Off");
  expect(screen.getByLabelText("Computer use status")).toHaveTextContent("Off");
  expect(screen.getByLabelText("Browser status")).toHaveTextContent(
    "Provider supports Browser tools",
  );
});

it("previews and dismissal perform no capability change", async () => {
  const input = props();
  render(<FirstTaskCapabilities {...input} />);
  for (const title of ["Browser", "Computer use", "Helper agents", "Person memory"]) {
    await userEvent.click(screen.getByRole("button", { name: title }));
    expect(screen.getByRole("img", { name: `Static ${title} preview` })).toBeVisible();
  }
  await userEvent.click(screen.getByRole("button", { name: "Dismiss capability card" }));
  expect(input.onDismiss).toHaveBeenCalledOnce();
  expect(input.onOpenSettings).not.toHaveBeenCalled();
});

it("uses existing settings destinations and offers no mutation controls", async () => {
  const input = props();
  render(<FirstTaskCapabilities {...input} />);
  await userEvent.click(screen.getByRole("button", { name: "Helper agents" }));
  await userEvent.click(screen.getByRole("button", { name: "Review helper agent settings" }));
  expect(input.onOpenSettings).toHaveBeenCalledWith({
    section: "harness",
    setting: "subagent-creation-posture",
  });
  expect(screen.queryByRole("switch")).toBeNull();
});

it("keeps failed host reads unknown and read-only surfaces free of settings actions", async () => {
  const input = props();
  const { onOpenSettings: _unused, ...readOnly } = input;
  render(
    <FirstTaskCapabilities
      {...readOnly}
      browser="unknown"
      helpers={{
        current: vi.fn(async () => {
          throw new Error("refused");
        }),
      }}
      memory={{
        read: vi.fn(async () => {
          throw new Error("refused");
        }),
      }}
      computerUse={undefined}
    />,
  );
  expect(await screen.findByLabelText("Person memory status")).toHaveTextContent("Not reported");
  expect(screen.getByLabelText("Helper agents status")).toHaveTextContent("Not reported");
  expect(screen.getByLabelText("Browser status")).toHaveTextContent("Not reported");
  expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
});

it("reports enabled settings and missing native permissions without starting an app", async () => {
  const input = props();
  const memory = await input.memory.read();
  const getComputerUseStatus = vi.fn(async () => ({
    supported: true,
    enabled: true,
    automaticUpdates: false,
    permissions: { accessibility: false, screenRecording: false },
    driver: "stopped",
    activeSessions: 0,
    update: "idle",
  }));
  render(
    <FirstTaskCapabilities
      {...input}
      computerUse={{ enabled: true, automaticUpdates: false }}
      bridge={{ getComputerUseStatus }}
      helpers={{
        current: vi.fn(async () =>
          decodeAgentRunPolicySettings({
            creationPosture: "automatic",
            version: 0,
            updatedAt: "2026-11-07T00:00:00.000Z",
          }),
        ),
      }}
      memory={{
        read: vi.fn(async () => ({ ...memory, settings: { ...memory.settings, enabled: true } })),
      }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Person memory status")).toHaveTextContent("On"),
  );
  expect(screen.getByLabelText("Computer use status")).toHaveTextContent("Permissions needed");
  expect(screen.getByLabelText("Helper agents status")).toHaveTextContent("Automatic");
  expect(getComputerUseStatus).toHaveBeenCalledOnce();
});

it("drops a previous host's answers before replacement readers respond", async () => {
  const input = props();
  const view = render(<FirstTaskCapabilities {...input} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Person memory status")).toHaveTextContent("Off"),
  );
  view.rerender(
    <FirstTaskCapabilities
      {...input}
      memory={{
        read: vi.fn(async () => {
          throw new Error("disconnected");
        }),
      }}
      helpers={{
        current: vi.fn(async () => {
          throw new Error("disconnected");
        }),
      }}
    />,
  );
  expect(screen.getByLabelText("Person memory status")).toHaveTextContent("Not reported");
  expect(screen.getByLabelText("Helper agents status")).toHaveTextContent("Not reported");
});

it("resumes pending setup and never asks macOS when enabling was refused", async () => {
  const input = props();
  const requestComputerUsePermissions = vi.fn();
  const onSettingsChange = vi.fn(async () => false);
  render(
    <FirstTaskCapabilities
      {...input}
      computerUse={{ enabled: false, automaticUpdates: false, setupPending: true }}
      onSettingsChange={onSettingsChange}
      bridge={{
        getComputerUseStatus: async () => ({
          supported: true,
          enabled: false,
          automaticUpdates: false,
          permissions: { accessibility: false, screenRecording: false },
          driver: "stopped",
          activeSessions: 0,
          update: "idle",
        }),
        requestComputerUsePermissions,
      }}
    />,
  );
  const start = await screen.findByRole("button", { name: "Set up Computer use" });
  await waitFor(() => expect(start).toBeEnabled());
  await userEvent.click(start);
  expect(onSettingsChange).toHaveBeenCalledWith({
    computerUse: { enabled: true, automaticUpdates: false, setupPending: true },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("not saved");
  expect(requestComputerUsePermissions).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(onSettingsChange).toHaveBeenLastCalledWith({
    computerUse: { enabled: false, automaticUpdates: false, setupPending: false },
  });
});

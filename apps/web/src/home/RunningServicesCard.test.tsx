import type { LocalServerClient } from "@octant/client-runtime";
import type {
  LocalServerOpenTarget,
  RunningService,
  RunningServiceCommand,
  RunningServiceCommandResult,
} from "@octant/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeDashboard } from "./HomeDashboard";
import { createRunningServicesCard, type RunningServicesCardSource } from "./RunningServicesCard";
import { RUNNING_SERVICES_ROW_LIMIT } from "./runningServices";

const requestId = "00000000-0000-4000-8000-000000000904";
const projectId = "00000000-0000-4000-8000-000000000902";
const threadId = "00000000-0000-4000-8000-000000000903";
const observedAt = "2026-10-06T10:00:00.000Z";

function service(index: number, overrides: Record<string, unknown> = {}): RunningService {
  const hex = index.toString(16).padStart(32, "0");
  return {
    listenerId: `lsn_${hex}`,
    port: 5170 + index,
    url: `http://127.0.0.1:${String(5170 + index)}/`,
    processName: "node",
    framework: "vite",
    workingDirectory: "/Users/example/octant/apps/web",
    ownership: "octant-owned",
    health: "listening",
    openAvailable: true,
    stop: { status: "available", confirmationRequired: false },
    projectId,
    projectName: "Octant",
    ...overrides,
  } as unknown as RunningService;
}

function listed(services: ReadonlyArray<RunningService>): RunningServiceCommandResult {
  return {
    kind: "running-services-listed",
    requestId,
    snapshot: { services, observedAt },
  } as unknown as RunningServiceCommandResult;
}

function fakeClient(
  answer: (command: RunningServiceCommand) => RunningServiceCommandResult | Promise<never>,
) {
  const commands: RunningServiceCommand[] = [];
  const executeRunningServices = vi.fn(async (command: RunningServiceCommand) => {
    commands.push(command);
    return answer(command);
  });
  return {
    commands,
    executeRunningServices,
    client: { execute: vi.fn(), executeRunningServices } as unknown as LocalServerClient,
  };
}

function source(
  client: LocalServerClient | undefined,
  overrides: Partial<RunningServicesCardSource> = {},
): RunningServicesCardSource {
  return { client, canOpen: () => true, onOpenTarget: vi.fn(), ...overrides };
}

function renderCard(card: ReturnType<typeof createRunningServicesCard>) {
  return render(
    <HomeDashboard
      cards={[card]}
      customization={{ order: [], visibility: [] }}
      onCustomizationChange={vi.fn()}
    />,
  );
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
});

describe("the Running services card", () => {
  it("is not offered when this window has no way to read the host", async () => {
    renderCard(createRunningServicesCard(source(undefined)));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Home cards" })).toBeNull());
  });

  it("says no server is running in the Code Projects in one quiet line", async () => {
    const { client } = fakeClient(() => listed([]));
    renderCard(createRunningServicesCard(source(client)));
    const card = await screen.findByRole("region", { name: "Running services" });
    expect(
      await within(card).findByText("No servers are running in your Code Projects."),
    ).toBeInTheDocument();
  });

  it("lists a server with its port, Project, branch, runtime, and health", async () => {
    const { client } = fakeClient(() =>
      listed([
        service(3, {
          branch: "fix/login",
          thread: { threadId, title: "Fix login" },
          health: "unresponsive",
        }),
      ]),
    );
    renderCard(createRunningServicesCard(source(client)));
    const card = await screen.findByRole("region", { name: "Running services" });

    expect(await within(card).findByText("vite")).toBeInTheDocument();
    expect(within(card).getByText(":5173")).toBeInTheDocument();
    expect(within(card).getByText("Octant · fix/login")).toBeInTheDocument();
    expect(within(card).getByText(/Not responding · node/)).toBeInTheDocument();
    expect(within(card).getByText("1")).toBeInTheDocument();
  });

  it("labels a server Octant does not own as not owned, claims nothing about who started it, and names a host that is not this computer", async () => {
    const { client } = fakeClient(() =>
      listed([
        service(1, {
          ownership: "left-over",
          stop: { status: "available", confirmationRequired: true },
        }),
      ]),
    );
    renderCard(createRunningServicesCard(source(client, { host: "Studio" })));
    const card = await screen.findByRole("region", { name: "Running services" });
    expect(await within(card).findByText(/Not owned by Octant/)).toBeInTheDocument();
    expect(within(card).queryByText(/Left over from Octant/)).toBeNull();
    expect(within(card).getByText(/Studio/)).toBeInTheDocument();
  });

  it("shows five rows and counts the rest", async () => {
    const many = Array.from({ length: RUNNING_SERVICES_ROW_LIMIT + 3 }, (_, index) =>
      service(index + 1),
    );
    const { client } = fakeClient(() => listed(many));
    renderCard(createRunningServicesCard(source(client)));
    const card = await screen.findByRole("region", { name: "Running services" });

    expect(await within(card).findByText("+3 more listening")).toBeInTheDocument();
    expect(within(card).getAllByRole("button", { name: /^Open / })).toHaveLength(5);
    expect(within(card).getByText("8")).toBeInTheDocument();
  });

  it("opens the page the host prepared and says so when it cannot place it", async () => {
    const target: LocalServerOpenTarget = {
      url: "http://127.0.0.1:5171/",
      allowedOrigin: "http://127.0.0.1:5171",
      acceptsLocalCertificate: false,
    } as LocalServerOpenTarget;
    const onOpenTarget = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("no"));
    const { client, commands } = fakeClient((command) =>
      command.kind === "open-running-service"
        ? ({
            kind: "running-service-open-prepared",
            requestId,
            listenerId: command.listenerId,
            target,
          } as unknown as RunningServiceCommandResult)
        : listed([service(1)]),
    );
    renderCard(createRunningServicesCard(source(client, { onOpenTarget })));
    const user = userEvent.setup();
    const open = await screen.findByRole("button", { name: "Open vite on port 5171" });

    await user.click(open);
    await waitFor(() => expect(onOpenTarget).toHaveBeenCalledTimes(1));
    expect(onOpenTarget.mock.calls[0]?.[1]).toBe(target);
    expect(commands.some((command) => command.kind === "open-running-service")).toBe(true);

    await user.click(open);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Octant could not open this server.",
    );
  });

  it("withholds Open where this window has nowhere to place the page", async () => {
    const { client } = fakeClient(() => listed([service(1)]));
    renderCard(createRunningServicesCard(source(client, { canOpen: () => false })));
    await screen.findByText("vite");
    expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop vite on port 5171" })).toBeInTheDocument();
  });

  it("stops a server Octant owns at once and adopts the listing the host answers with", async () => {
    const { client, commands } = fakeClient((command) =>
      command.kind === "stop-running-service"
        ? ({
            kind: "running-service-stopped",
            requestId,
            listenerId: command.listenerId,
            snapshot: { services: [], observedAt },
          } as unknown as RunningServiceCommandResult)
        : listed([service(1)]),
    );
    renderCard(createRunningServicesCard(source(client)));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Stop vite on port 5171" }));

    expect(
      await screen.findByText("No servers are running in your Code Projects."),
    ).toBeInTheDocument();
    const stop = commands.find((command) => command.kind === "stop-running-service");
    expect(stop).toBeDefined();
    expect(stop).not.toHaveProperty("confirmation");
  });

  it("confirms a server Octant does not own by name and echoes what it showed before the host signals it", async () => {
    const leftover = service(1, {
      ownership: "left-over",
      processName: "node",
      port: 3000,
      stop: { status: "available", confirmationRequired: true },
    });
    const { client, commands } = fakeClient((command) =>
      command.kind === "stop-running-service"
        ? ({
            kind: "running-service-stopped",
            requestId,
            listenerId: command.listenerId,
            snapshot: { services: [], observedAt },
          } as unknown as RunningServiceCommandResult)
        : listed([leftover]),
    );
    renderCard(createRunningServicesCard(source(client)));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Stop vite on port 3000" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Stop node on port 3000 in /Users/example/octant/apps/web?");
    expect(dialog).toHaveTextContent(
      "Octant does not own this server and cannot tell who started it.",
    );
    expect(dialog).not.toHaveTextContent("Octant started this server");
    expect(commands.some((command) => command.kind === "stop-running-service")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Keep it running" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(commands.some((command) => command.kind === "stop-running-service")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Stop vite on port 3000" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop this server" }),
    );
    await waitFor(() =>
      expect(commands.find((command) => command.kind === "stop-running-service")).toMatchObject({
        confirmation: {
          acknowledgedProcessName: "node",
          acknowledgedPort: 3000,
          acknowledgedWorkingDirectory: "/Users/example/octant/apps/web",
        },
      }),
    );
  });

  it("explains in words a Stop the host will not offer, with no fake control", async () => {
    const { client } = fakeClient(() =>
      listed([
        service(1, {
          ownership: "left-over",
          stop: {
            status: "unavailable",
            reason: "Stopping a leftover server must happen on the host, not from a paired device.",
          },
        }),
      ]),
    );
    renderCard(createRunningServicesCard(source(client)));
    expect(await screen.findByText(/must happen on the host/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop / })).toBeNull();
  });

  it("shows the host's refusal of a Stop instead of dropping the row", async () => {
    const { client } = fakeClient((command) =>
      command.kind === "stop-running-service"
        ? ({
            kind: "running-service-rejected",
            requestId,
            failure: {
              category: "not-found",
              message:
                "That local server changed before Octant could stop it; nothing was signalled.",
            },
          } as unknown as RunningServiceCommandResult)
        : listed([service(1)]),
    );
    renderCard(createRunningServicesCard(source(client)));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Stop vite on port 5171" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("nothing was signalled");
    expect(screen.getByText("vite")).toBeInTheDocument();
  });

  it("says it could not look, rather than that nothing is running, when the host cannot scan", async () => {
    const { client } = fakeClient(
      () =>
        ({
          kind: "running-service-rejected",
          requestId,
          failure: {
            category: "unavailable",
            message:
              "Octant could not check this computer for local servers, so it cannot say whether any are running.",
          },
        }) as unknown as RunningServiceCommandResult,
    );
    renderCard(createRunningServicesCard(source(client)));
    expect(await screen.findByText(/could not check this computer/)).toBeInTheDocument();
    expect(screen.queryByText("No servers are running in your Code Projects.")).toBeNull();
  });

  it("keeps the last listing when a later refresh is refused", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let call = 0;
    const { client } = fakeClient(() => {
      call += 1;
      if (call === 1) return listed([service(1)]);
      return {
        kind: "running-service-rejected",
        requestId,
        failure: { category: "unavailable", message: "Octant could not check this computer." },
      } as unknown as RunningServiceCommandResult;
    });
    renderCard(createRunningServicesCard(source(client)));
    await screen.findByText("vite");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(call).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("vite")).toBeInTheDocument();
  });
});

describe("the Running services refresh", () => {
  it("reads once on mount, then no faster than every five seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, executeRunningServices } = fakeClient(() => listed([service(1)]));
    renderCard(createRunningServicesCard(source(client)));
    await screen.findByText("vite");
    expect(executeRunningServices).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(executeRunningServices).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(executeRunningServices).toHaveBeenCalledTimes(2);
  });

  it("stops asking while the window is hidden and reads once when it returns", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, executeRunningServices } = fakeClient(() => listed([service(1)]));
    renderCard(createRunningServicesCard(source(client)));
    await screen.findByText("vite");
    expect(executeRunningServices).toHaveBeenCalledTimes(1);

    act(() => setVisibility("hidden"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(executeRunningServices).toHaveBeenCalledTimes(1);

    act(() => setVisibility("visible"));
    await waitFor(() => expect(executeRunningServices).toHaveBeenCalledTimes(2));
  });

  it("stops reading when the card is turned off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, executeRunningServices } = fakeClient(() => listed([service(1)]));
    const card = createRunningServicesCard(source(client));
    const view = render(
      <HomeDashboard
        cards={[card]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    await screen.findByText("vite");
    view.rerender(
      <HomeDashboard
        cards={[card]}
        customization={{ order: [], visibility: [{ id: card.id, visible: false }] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    const before = executeRunningServices.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(executeRunningServices).toHaveBeenCalledTimes(before);
  });
});

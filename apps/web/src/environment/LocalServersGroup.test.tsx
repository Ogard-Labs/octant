import type {
  LocalServerListener,
  LocalServerListenerId,
  LocalServerSnapshot,
} from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocalServersGroup } from "./LocalServersGroup";

const threadId = "00000000-0000-4000-8000-000000000901";
const projectId = "00000000-0000-4000-8000-000000000902";

function listener(overrides: Partial<LocalServerListener> = {}): LocalServerListener {
  return {
    listenerId: "lsn_0123456789abcdef0123456789abcdef" as LocalServerListenerId,
    port: 5173,
    url: "http://127.0.0.1:5173/",
    processName: "node",
    framework: "vite",
    workingDirectory: "/Users/example/code/octant",
    workspaceLabel: "octant",
    attribution: "current-checkout",
    startSource: "octant",
    bindScope: "loopback",
    health: "listening",
    openAvailable: true,
    stop: { status: "available", confirmationRequired: false },
    ...overrides,
  } as LocalServerListener;
}

function snapshot(
  currentCheckout: ReadonlyArray<LocalServerListener>,
  other: ReadonlyArray<LocalServerListener> = [],
): LocalServerSnapshot {
  return {
    threadId,
    projectId,
    currentCheckout,
    other,
    observedAt: "2026-08-14T08:00:00.000Z",
  } as unknown as LocalServerSnapshot;
}

function controller(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready" as const,
    snapshot: snapshot([listener()]),
    errorMessage: undefined,
    failure: undefined,
    busyListenerId: undefined,
    open: vi.fn(async () => undefined),
    stop: vi.fn(async () => true),
    ...overrides,
  } as never;
}

describe("LocalServersGroup", () => {
  it("groups this Project's servers above other leftovers", () => {
    const leftover = listener({
      listenerId: "lsn_ffffffffffffffffffffffffffffffff" as LocalServerListenerId,
      attribution: "other",
      startSource: "vscode",
      framework: undefined,
      port: 3000 as LocalServerListener["port"],
      url: "http://127.0.0.1:3000/" as LocalServerListener["url"],
    });
    render(
      <LocalServersGroup
        controller={controller({ snapshot: snapshot([listener()], [leftover]) })}
      />,
    );

    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings).toEqual(["This Project", "Other leftovers"]);
    expect(
      within(screen.getByRole("region", { name: "Other leftovers" })).getByText(
        "Started by VS Code",
      ),
    ).toBeVisible();
  });

  it("states health in words as well as an icon", () => {
    render(
      <LocalServersGroup
        controller={controller({
          snapshot: snapshot([listener({ health: "unresponsive", openAvailable: false })]),
        })}
      />,
    );
    expect(screen.getByText("Alive, but not responding")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });

  it("says so when the host never determined a listener's health", () => {
    render(
      <LocalServersGroup
        controller={controller({
          snapshot: snapshot([listener({ health: "unknown", openAvailable: false })]),
        })}
      />,
    );
    expect(screen.getByText("Octant could not check this server")).toBeVisible();
    // Never the wedged label: the host never established that this listener
    // holds its port without answering.
    expect(screen.queryByText("Alive, but not responding")).toBeNull();
    expect(screen.queryByRole("button", { name: /Open/ })).toBeNull();
  });

  it("distinguishes loopback from LAN bind scope", () => {
    render(
      <LocalServersGroup
        controller={controller({ snapshot: snapshot([listener({ bindScope: "lan" })]) })}
      />,
    );
    expect(screen.getByText("Reachable on your network")).toBeVisible();
  });

  it("opens exactly one origin in a new Browser tab", async () => {
    const target = {
      url: "http://127.0.0.1:5173/",
      allowedOrigin: "http://127.0.0.1:5173",
      acceptsLocalCertificate: false,
    };
    const open = vi.fn(async () => target);
    const onOpenTarget = vi.fn();
    render(<LocalServersGroup controller={controller({ open })} onOpenTarget={onOpenTarget} />);

    screen.getByRole("button", { name: /Open http:\/\/127\.0\.0\.1:5173\// }).click();

    await waitFor(() => expect(onOpenTarget).toHaveBeenCalledWith(target));
  });

  it("copies the normalized local URL and confirms the copy in words", async () => {
    const onCopyUrl = vi.fn(async () => undefined);
    render(<LocalServersGroup controller={controller()} onCopyUrl={onCopyUrl} />);
    screen.getByRole("button", { name: /Copy http/ }).click();
    expect(onCopyUrl).toHaveBeenCalledWith("http://127.0.0.1:5173/");
    expect(await screen.findByText("Copied")).toBeVisible();
  });

  it("states a copy failure instead of failing silently", async () => {
    const onCopyUrl = vi.fn(async () => {
      throw new Error("clipboard unavailable");
    });
    render(<LocalServersGroup controller={controller()} onCopyUrl={onCopyUrl} />);
    screen.getByRole("button", { name: /Copy http/ }).click();
    expect(await screen.findByRole("alert")).toHaveTextContent("Octant could not copy the URL.");
  });

  it("states an open failure when the host cannot create the Browser tab", async () => {
    const target = {
      url: "http://127.0.0.1:5173/",
      allowedOrigin: "http://127.0.0.1:5173",
      acceptsLocalCertificate: false,
    };
    const onOpenTarget = vi.fn(async () => {
      throw new Error("browser runtime unavailable");
    });
    render(
      <LocalServersGroup
        controller={controller({ open: vi.fn(async () => target) })}
        onOpenTarget={onOpenTarget}
      />,
    );
    screen.getByRole("button", { name: /Open http/ }).click();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Octant could not open a Browser tab for this server.",
    );
  });

  it("hides Open and Copy entirely when the host supplies no way to perform them", () => {
    render(<LocalServersGroup controller={controller()} />);
    expect(screen.getByText("node · vite")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open http/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy http/ })).toBeNull();
  });

  it("stops an Octant-owned server without a confirmation step", async () => {
    const stop = vi.fn(async () => true);
    render(<LocalServersGroup controller={controller({ stop })} />);
    screen.getByRole("button", { name: "Stop" }).click();
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("confirms a leftover stop by naming process, cwd, and port", async () => {
    const stop = vi.fn(async () => true);
    const row = listener({
      startSource: "vscode",
      stop: { status: "available", confirmationRequired: true },
      workingDirectory: "/Users/example/code/other-app",
    });
    render(<LocalServersGroup controller={controller({ snapshot: snapshot([row]), stop })} />);

    screen.getByRole("button", { name: "Stop" }).click();
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm stop" });
    expect(dialog).toHaveTextContent("node");
    expect(dialog).toHaveTextContent("5173");
    expect(dialog).toHaveTextContent("/Users/example/code/other-app");
    expect(stop).not.toHaveBeenCalled();

    within(dialog).getByRole("button", { name: "Stop this server" }).click();
    await waitFor(() =>
      expect(stop).toHaveBeenCalledWith(row.listenerId, {
        acknowledgedProcessName: "node",
        acknowledgedPort: 5173,
        acknowledgedWorkingDirectory: "/Users/example/code/other-app",
      }),
    );
  });

  it("shows the host's reason instead of a Stop control when Stop is withheld", () => {
    render(
      <LocalServersGroup
        controller={controller({
          snapshot: snapshot([
            listener({
              stop: {
                status: "unavailable",
                reason: "Plan threads can list and open local servers but never stop them.",
              },
            }),
          ]),
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(
      screen.getByText("Plan threads can list and open local servers but never stop them."),
    ).toBeVisible();
  });

  it("says so when nothing is running and when the section is unavailable", () => {
    const { unmount } = render(
      <LocalServersGroup controller={controller({ snapshot: snapshot([]) })} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "No local user or development servers are running.",
    );
    unmount();

    render(
      <LocalServersGroup
        controller={controller()}
        unavailableReason="Open a repository Project to view local servers."
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Open a repository Project to view local servers.",
    );
  });

  it("says discovery failed rather than that nothing is running", () => {
    render(
      <LocalServersGroup
        controller={controller({
          status: "error",
          snapshot: undefined,
          errorMessage: "Octant could not check this computer for local servers.",
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Octant could not check this computer for local servers.",
    );
    expect(
      screen.queryByText("No local user or development servers are running."),
    ).not.toBeInTheDocument();
  });

  it("surfaces a typed host refusal in words", () => {
    render(
      <LocalServersGroup
        controller={controller({
          failure: {
            category: "local-host-required",
            message: "Stopping a leftover server must happen on the host.",
          },
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Stopping a leftover server must happen on the host.",
    );
  });
});

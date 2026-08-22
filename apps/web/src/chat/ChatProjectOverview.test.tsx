import { ProjectClientFailure } from "@octant/client-runtime/project-client";
import { ChatClientFailure } from "@octant/client-runtime/chat-client";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatProjectOverview, type ChatProjectOverviewModel } from "./ChatProjectOverview";

const model: ChatProjectOverviewModel = {
  attachmentsAndContext: {
    status: "ready",
    items: [
      {
        id: "attachment",
        label: "Research brief.pdf",
        detail: "Pinned context",
      },
    ],
  },
  memory: {
    status: "ready",
    items: [{ id: "memory", label: "Keep answers concise", detail: "Preference" }],
  },
  outcomesAndDecisions: {
    status: "ready",
    items: [{ id: "outcome", label: "Launch decision", detail: "Approved outcome" }],
  },
  threads: {
    status: "ready",
    items: [{ id: "thread", label: "Plan the launch", detail: "Active" }],
  },
  unfinishedWork: {
    status: "ready",
    items: [{ id: "work", label: "Confirm launch date", detail: "Follow-up" }],
  },
};

describe("ChatProjectOverview", () => {
  it("renders bounded Chat-only sections and isolates a failed section", () => {
    render(
      <ChatProjectOverview
        model={{
          ...model,
          outcomesAndDecisions: {
            status: "failure",
            message: "Outcomes could not be loaded.",
          },
        }}
        onCreateThread={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByRole("region", { name: "Chat Project Overview" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Active threads" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Unfinished work and follow-up" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Approved memory" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Attachments and pinned context" })).toBeVisible();
    expect(screen.getByText("Plan the launch")).toBeVisible();
    expect(screen.getByText("Keep answers concise")).toBeVisible();
    expect(screen.getByText("Research brief.pdf")).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Outcomes and decisions" })).getByRole("alert"),
    ).toHaveTextContent("Outcomes could not be loaded.");
    // Chat Projects have no filesystem or shell authority, so no Work- or
    // Code-mode surface may leak into this overview.
    expect(
      screen.queryByText(/filesystem|shell|Git|worktree|terminal|Work mode|Code/i),
    ).not.toBeInTheDocument();
  });

  it("preserves and restores focus to a quick-start draft after authoritative rejection", async () => {
    const onCreateThread = vi.fn(async () => false);
    render(<ChatProjectOverview model={model} onCreateThread={onCreateThread} />);

    const quickStart = screen.getByRole("region", { name: "Chat quick start" });
    const input = within(quickStart).getByRole("textbox", {
      name: "Start a new Chat thread",
    });
    fireEvent.change(input, { target: { value: "Prepare the launch brief" } });
    fireEvent.click(within(quickStart).getByRole("button", { name: "Start thread" }));

    await waitFor(() => expect(onCreateThread).toHaveBeenCalledWith("Prepare the launch brief"));
    expect(input).toHaveValue("Prepare the launch brief");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("clears the quick-start draft only after authoritative creation succeeds", async () => {
    render(<ChatProjectOverview model={model} onCreateThread={vi.fn(async () => true)} />);

    const quickStart = screen.getByRole("region", { name: "Chat quick start" });
    const input = within(quickStart).getByRole("textbox", {
      name: "Start a new Chat thread",
    });
    fireEvent.change(input, { target: { value: "Open a launch thread" } });
    fireEvent.click(within(quickStart).getByRole("button", { name: "Start thread" }));

    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("keeps creation unavailable when the Project cannot create a thread", () => {
    render(<ChatProjectOverview model={model} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Chat thread creation is unavailable for this Project.",
    );
    expect(screen.getByRole("textbox", { name: "Start a new Chat thread" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start thread" })).toBeDisabled();
  });

  it("opens a recent thread through the supplied authoritative opener", () => {
    const onOpenThread = vi.fn();
    render(
      <ChatProjectOverview model={model} onCreateThread={vi.fn()} onOpenThread={onOpenThread} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Plan the launch/i }));
    expect(onOpenThread).toHaveBeenCalledWith("thread");
  });

  it("keeps cached recent threads read-only when their Overview is stale", () => {
    const onOpenThread = vi.fn();
    render(
      <ChatProjectOverview
        model={{
          ...model,
          threads: {
            ...model.threads,
            message: "Chat data may be out of date while the connection is offline.",
            status: "stale",
          },
        }}
        onOpenThread={onOpenThread}
      />,
    );

    expect(screen.getByText("Plan the launch")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Plan the launch/i })).not.toBeInTheDocument();
    expect(
      screen.getByText("Chat data may be out of date while the connection is offline."),
    ).toBeVisible();
  });

  it("shows unavailable sections when the initial Chat bootstrap is disconnected", async () => {
    render(
      <ChatProjectOverview
        client={{} as never}
        controller={{ bootstrap: undefined, status: "disconnected" } as never}
        projectId={"00000000-0000-4000-8000-000000000001" as never}
      />,
    );

    expect(
      await screen.findAllByText("Chat data is unavailable while the connection is offline."),
    ).toHaveLength(5);
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("keeps a partial thread query stale instead of presenting incomplete sections as empty", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const firstThread = {
      id: "00000000-0000-4000-8000-000000000011",
      projectId,
      title: "Available thread",
    };
    const unavailableThread = {
      id: "00000000-0000-4000-8000-000000000012",
      projectId,
      title: "Unavailable thread",
    };
    render(
      <ChatProjectOverview
        client={
          {
            thread: vi.fn((threadId: string) =>
              threadId === firstThread.id
                ? Promise.resolve({
                    thread: firstThread,
                    attachments: [],
                    citations: [],
                    workItems: [],
                  } as never)
                : Promise.reject(new Error("offline")),
            ),
          } as never
        }
        controller={
          {
            bootstrap: { threads: [firstThread, unavailableThread] },
            status: "ready",
          } as never
        }
        projectClient={{ memory: vi.fn(async () => ({ active: [] })) } as never}
        projectId={projectId}
      />,
    );

    expect(
      await screen.findByText("Some attachments and pinned context may be out of date."),
    ).toBeVisible();
    expect(
      screen.getByText("Some unfinished work and follow-up may be out of date."),
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Outcomes and decisions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("No provenance-backed outcomes or decisions yet."),
    ).not.toBeInTheDocument();
  });

  it("suppresses cached Overview thread content when the window authority is revoked", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const thread = {
      id: "00000000-0000-4000-8000-000000000011",
      projectId,
      title: "Previously visible thread",
    };
    render(
      <ChatProjectOverview
        client={
          {
            thread: vi.fn(async () =>
              Promise.reject(
                new ChatClientFailure({
                  category: "unauthorized",
                  message: "Window authority is invalid.",
                }),
              ),
            ),
          } as never
        }
        controller={{ bootstrap: { threads: [thread] }, status: "ready" } as never}
        projectClient={{ memory: vi.fn(async () => ({ active: [] })) } as never}
        projectId={projectId}
      />,
    );

    expect(
      await within(screen.getByRole("region", { name: "Active threads" })).findByRole("alert"),
    ).toHaveTextContent("Project threads are unauthorized.");
    expect(screen.queryByText("Previously visible thread")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Attachments and pinned context" })).getByRole(
        "alert",
      ),
    ).toHaveTextContent("Attachments and pinned context are unauthorized.");
    expect(
      within(screen.getByRole("region", { name: "Unfinished work and follow-up" })).getByRole(
        "alert",
      ),
    ).toHaveTextContent("Unfinished work and follow-up are unauthorized.");
  });

  it("does not present research citations as outcomes or decisions", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const thread = {
      id: "00000000-0000-4000-8000-000000000011",
      projectId,
      title: "Research thread",
    };
    render(
      <ChatProjectOverview
        client={
          {
            thread: vi.fn(async () => ({
              thread,
              attachments: [],
              citations: [
                {
                  citationId: "citation",
                  sourceTitle: "Research source",
                  backend: "web",
                },
              ],
              workItems: [],
            })),
          } as never
        }
        controller={{ bootstrap: { threads: [thread] }, status: "ready" } as never}
        projectClient={{ memory: vi.fn(async () => ({ active: [] })) } as never}
        projectId={projectId}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Start the next Chat in this Project",
      }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Outcomes and decisions" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByText("No provenance-backed outcomes or decisions yet."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Research source")).not.toBeInTheDocument();
  });

  it("keeps outcomes unavailable when their Project-memory source cannot load", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const thread = {
      id: "00000000-0000-4000-8000-000000000011",
      projectId,
      title: "Available thread",
    };
    render(
      <ChatProjectOverview
        client={
          {
            thread: vi.fn(async () => ({
              thread,
              attachments: [],
              workItems: [],
            })),
          } as never
        }
        controller={{ bootstrap: { threads: [thread] }, status: "ready" } as never}
        projectClient={
          {
            memory: vi.fn(async () =>
              Promise.reject(
                new ProjectClientFailure({
                  category: "unavailable",
                  message: "Project memory is unavailable.",
                }),
              ),
            ),
          } as never
        }
        projectId={projectId}
      />,
    );

    expect(
      await within(screen.getByRole("region", { name: "Outcomes and decisions" })).findByRole(
        "alert",
      ),
    ).toHaveTextContent("Outcomes and decisions are unavailable.");
  });

  it("labels finalized uploads as attachments rather than pinned context", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const thread = {
      id: "00000000-0000-4000-8000-000000000011",
      projectId,
      title: "Attachment thread",
    };
    render(
      <ChatProjectOverview
        client={
          {
            thread: vi.fn(async () => ({
              thread,
              attachments: [
                {
                  id: "attachment",
                  displayName: "Brief.pdf",
                  status: "finalized",
                },
              ],
              workItems: [],
            })),
          } as never
        }
        controller={{ bootstrap: { threads: [thread] }, status: "ready" } as never}
        projectClient={{ memory: vi.fn(async () => ({ active: [] })) } as never}
        projectId={projectId}
      />,
    );

    const attachments = await screen.findByRole("region", {
      name: "Attachments and pinned context",
    });
    expect(within(attachments).getByText("finalized")).toBeVisible();
    expect(within(attachments).queryByText("Pinned context")).not.toBeInTheDocument();
  });

  it("lists live active Project threads and expands archived threads on demand", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const active = {
      id: "00000000-0000-4000-8000-000000000011",
      projectId,
      title: "Plan the launch",
      lifecycle: "active",
    };
    const archived = {
      id: "00000000-0000-4000-8000-000000000012",
      projectId,
      title: "Old kickoff notes",
      lifecycle: "archived",
    };
    const onOpenThread = vi.fn();
    render(
      <ChatProjectOverview
        client={
          {
            thread: vi.fn(async () => ({
              thread: active,
              attachments: [],
              workItems: [],
            })),
          } as never
        }
        controller={
          {
            bootstrap: { threads: [active, archived] },
            status: "ready",
          } as never
        }
        onOpenThread={onOpenThread}
        projectClient={{ memory: vi.fn(async () => ({ active: [] })) } as never}
        projectId={projectId}
      />,
    );

    expect(await screen.findByText("Plan the launch")).toBeVisible();
    expect(screen.queryByText("Old kickoff notes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show archived threads (1)" }));
    fireEvent.click(screen.getByRole("button", { name: /Old kickoff notes/i }));
    expect(onOpenThread).toHaveBeenCalledWith(archived.id);
  });

  it("bounds thread fan-out and names the path to omitted Project threads", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const threads = Array.from({ length: 10 }, (_, index) => ({
      id: `00000000-0000-4000-8000-0000000000${index + 10}`,
      projectId,
      title: `Thread ${index + 1}`,
    }));
    const thread = vi.fn(async (threadId: string) => ({
      thread: threads.find((candidate) => candidate.id === threadId),
      attachments: [],
      workItems: [],
    }));
    render(
      <ChatProjectOverview
        client={{ thread } as never}
        controller={{ bootstrap: { threads }, status: "ready" } as never}
        projectClient={{ memory: vi.fn(async () => ({ active: [] })) } as never}
        projectId={projectId}
      />,
    );

    await waitFor(() => expect(thread).toHaveBeenCalledTimes(8));
    expect(screen.getByText("Showing 8 of 10 Project threads.")).toBeVisible();
  });

  it("publishes bootstrap, thread-backed, and memory-backed sections independently", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const thread = {
      id: "00000000-0000-4000-8000-000000000011",
      projectId,
      title: "Available immediately",
    };
    const view = deferred<{
      readonly thread: typeof thread;
      readonly attachments: ReadonlyArray<never>;
      readonly workItems: ReadonlyArray<never>;
    }>();
    const memory = deferred<{ readonly active: ReadonlyArray<never> }>();
    render(
      <ChatProjectOverview
        client={{ thread: vi.fn(() => view.promise) } as never}
        controller={{ bootstrap: { threads: [thread] }, status: "ready" } as never}
        projectClient={{ memory: vi.fn(() => memory.promise) } as never}
        projectId={projectId}
      />,
    );

    expect(screen.getByText("Available immediately")).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Approved memory" })).getByText("Loading…"),
    ).toBeVisible();

    view.resolve({ thread, attachments: [], workItems: [] });
    await waitFor(() =>
      expect(
        screen.queryByRole("region", {
          name: "Attachments and pinned context",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole("region", { name: "Approved memory" })).getByText("Loading…"),
    ).toBeVisible();

    memory.resolve({ active: [] });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Approved memory" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("No approved Project memory yet.")).not.toBeInTheDocument();
  });

  it("labels unauthorized Project-memory reads without treating them as an outage", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const thread = {
      id: "00000000-0000-4000-8000-000000000011",
      projectId,
      title: "Available thread",
    };
    const failure = new ProjectClientFailure({
      category: "unauthorized",
      message: "Window authority is invalid.",
    });
    render(
      <ChatProjectOverview
        client={
          {
            thread: vi.fn(async () => ({
              thread,
              attachments: [],
              workItems: [],
            })),
          } as never
        }
        controller={{ bootstrap: { threads: [thread] }, status: "ready" } as never}
        projectClient={{ memory: vi.fn(async () => Promise.reject(failure)) } as never}
        projectId={projectId}
      />,
    );

    expect(
      await within(screen.getByRole("region", { name: "Approved memory" })).findByRole("alert"),
    ).toHaveTextContent("Approved Project memory is unauthorized.");
    expect(
      within(screen.getByRole("region", { name: "Outcomes and decisions" })).getByRole("alert"),
    ).toHaveTextContent("Outcomes and decisions are unauthorized.");
  });

  it("discloses bounded item counts and opens the complete Project thread list", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const thread = {
      id: "00000000-0000-4000-8000-000000000011",
      projectId,
      title: "Attachment and follow-up thread",
    };
    const onViewAllProjectThreads = vi.fn();
    render(
      <ChatProjectOverview
        client={
          {
            thread: vi.fn(async () => ({
              thread,
              attachments: Array.from({ length: 10 }, (_, index) => ({
                id: `attachment-${index}`,
                displayName: `Attachment ${index + 1}`,
                status: "finalized",
              })),
              workItems: Array.from({ length: 10 }, (_, index) => ({
                id: `work-${index}`,
                status: "open",
                title: `Follow-up ${index + 1}`,
              })),
            })),
          } as never
        }
        controller={{ bootstrap: { threads: [thread] }, status: "ready" } as never}
        onViewAllProjectThreads={onViewAllProjectThreads}
        projectClient={
          {
            memory: vi.fn(async () => ({
              active: Array.from({ length: 10 }, (_, index) => ({
                id: `memory-${index}`,
                content: `Decision ${index + 1}`,
                kind: "decision",
              })),
            })),
          } as never
        }
        projectId={projectId}
      />,
    );

    expect(
      await screen.findByText("Showing 8 of 10 attachments and pinned context items."),
    ).toBeVisible();
    expect(screen.getByText("Showing 8 of 10 unfinished work and follow-up items.")).toBeVisible();
    expect(screen.getByText("Showing 8 of 10 approved Project memory entries.")).toBeVisible();
    expect(screen.getByText("Showing 8 of 10 outcomes and decisions.")).toBeVisible();

    fireEvent.click(screen.getAllByRole("button", { name: "View all Project threads" })[0]!);
    expect(onViewAllProjectThreads).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "View all Project memory" }),
    ).not.toBeInTheDocument();
  });

  it("refreshes the bounded projections when live Chat navigation changes", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    const thread = {
      id: "00000000-0000-4000-8000-000000000011",
      projectId,
      title: "Live thread",
    };
    let workItemTitle = "Initial work item";
    const loadThread = vi.fn(async () => ({
      thread,
      attachments: [],
      workItems: [{ id: "work", status: "open", title: workItemTitle }],
    }));
    const client = { thread: loadThread } as never;
    const projectClient = {
      memory: vi.fn(async () => ({ active: [] })),
    } as never;
    const controller = {
      bootstrap: { threads: [thread] },
      navigation: [],
      status: "ready",
    };
    const { rerender } = render(
      <ChatProjectOverview
        client={client}
        controller={controller as never}
        projectClient={projectClient}
        projectId={projectId}
      />,
    );

    expect(await screen.findByText("Initial work item")).toBeVisible();
    const initialCalls = loadThread.mock.calls.length;
    workItemTitle = "Refreshed work item";
    rerender(
      <ChatProjectOverview
        client={client}
        controller={{ ...controller, navigation: [{ threadId: thread.id }] } as never}
        projectClient={projectClient}
        projectId={projectId}
      />,
    );

    await waitFor(() => expect(loadThread.mock.calls.length).toBeGreaterThan(initialCalls));
    expect(await screen.findByText("Refreshed work item")).toBeVisible();
  });

  it("refreshes memory-backed sections after a Project-memory revision", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001" as never;
    let entryContent = "Initial Project decision";
    const memory = vi.fn(async () => ({
      active: [
        {
          id: "00000000-0000-4000-8000-000000000041",
          content: entryContent,
          kind: "decision",
        },
      ],
    }));
    const controller = {
      bootstrap: { threads: [] },
      navigation: [],
      status: "ready",
    };
    const client = { thread: vi.fn() } as never;
    const projectClient = { memory } as never;
    const { rerender } = render(
      <ChatProjectOverview
        client={client}
        controller={controller as never}
        memoryRevision={0}
        projectClient={projectClient}
        projectId={projectId}
      />,
    );

    expect(
      await within(screen.getByRole("region", { name: "Approved memory" })).findByText(
        "Initial Project decision",
      ),
    ).toBeVisible();
    entryContent = "Refreshed Project decision";
    rerender(
      <ChatProjectOverview
        client={client}
        controller={controller as never}
        memoryRevision={1}
        projectClient={projectClient}
        projectId={projectId}
      />,
    );

    await waitFor(() => expect(memory).toHaveBeenCalledTimes(2));
    expect(
      await within(screen.getByRole("region", { name: "Approved memory" })).findByText(
        "Refreshed Project decision",
      ),
    ).toBeVisible();
  });

  it("generates a distinct quick-start label target per visible Overview", () => {
    render(
      <>
        <ChatProjectOverview model={model} onCreateThread={vi.fn()} />
        <ChatProjectOverview model={model} onCreateThread={vi.fn()} />
      </>,
    );

    const inputs = screen.getAllByRole("textbox", {
      name: "Start a new Chat thread",
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).not.toHaveAttribute("id", inputs[1]?.id);
  });

  it("hides empty dashboard sections and leads with the Project composer", () => {
    render(
      <ChatProjectOverview
        model={{
          attachmentsAndContext: {
            status: "empty",
            message: "No attachments or pinned context in this Project yet.",
          },
          memory: {
            status: "empty",
            message: "No approved Project memory yet.",
          },
          outcomesAndDecisions: {
            status: "empty",
            message: "No provenance-backed outcomes or decisions yet.",
          },
          threads: {
            status: "empty",
            message: "No Chat threads in this Project yet.",
          },
          unfinishedWork: {
            status: "empty",
            message: "No unfinished work or follow-up in this Project.",
          },
        }}
        onCreateThread={vi.fn(async () => true)}
      />,
    );

    const overview = screen.getByRole("region", {
      name: "Chat Project Overview",
    });
    expect(overview).toHaveClass("chat-project-overview--home");
    expect(screen.queryByRole("heading", { name: "Active threads" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Unfinished work and follow-up" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Approved memory" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Attachments and pinned context" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Outcomes and decisions" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No Chat threads in this Project yet.")).not.toBeInTheDocument();
    expect(screen.queryByText("No approved Project memory yet.")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Start the next Chat in this Project",
      }),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Start a new Chat thread" })).toBeVisible();
  });

  it("shows active Project threads and expands archived threads on demand", () => {
    render(
      <ChatProjectOverview
        model={{
          attachmentsAndContext: { status: "empty" },
          memory: { status: "empty" },
          outcomesAndDecisions: { status: "empty" },
          threads: {
            status: "ready",
            items: [
              { id: "active-1", label: "Plan the launch", detail: "Active" },
              { id: "active-2", label: "Write the brief", detail: "Active" },
            ],
            archivedItems: [
              {
                id: "archived-1",
                label: "Old kickoff notes",
                detail: "Archived",
              },
            ],
          },
          unfinishedWork: { status: "empty" },
        }}
        onCreateThread={vi.fn(async () => true)}
        onOpenThread={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Active threads" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Plan the launch/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /Write the brief/i })).toBeVisible();
    expect(screen.queryByText("Old kickoff notes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show archived threads (1)" }));
    expect(screen.getByRole("button", { name: /Old kickoff notes/i })).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide archived threads" })).toBeVisible();
  });

  it("keeps archived-only Projects visible behind the archived disclosure", () => {
    render(
      <ChatProjectOverview
        model={{
          attachmentsAndContext: { status: "empty" },
          memory: { status: "empty" },
          outcomesAndDecisions: { status: "empty" },
          threads: {
            status: "ready",
            message: "No active Chat threads in this Project.",
            archivedItems: [
              {
                id: "archived-1",
                label: "Old kickoff notes",
                detail: "Archived",
              },
            ],
          },
          unfinishedWork: { status: "empty" },
        }}
        onCreateThread={vi.fn(async () => true)}
        onOpenThread={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Active threads" })).toBeVisible();
    expect(screen.getByText("No active Chat threads in this Project.")).toBeVisible();
    expect(screen.queryByText("Old kickoff notes")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show archived threads (1)" }));
    expect(screen.getByRole("button", { name: /Old kickoff notes/i })).toBeVisible();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OctantCommandProvider } from "../palette/CommandRegistry";
import type { OctantCommand } from "../palette/commandModel";
import {
  ComposerSlashTypeahead,
  useComposerSlashCommands,
  type ComposerProviderCommands,
} from "./useComposerSlashCommands";
import {
  ComposerAtTypeahead,
  useComposerAtMenu,
  useThreadProviderMentions,
  type AtMenuFiles,
  type ComposerProviderMentions,
} from "./useComposerAtMenu";
import { ThreadNativeSetupProvider } from "../providers/ThreadNativeSetupControl";
import {
  decodeAggregateVersion,
  decodeProviderInstanceId,
  decodeProviderModel,
  decodeUtcTimestamp,
} from "@octant/contracts";
import { ComposerInput, type ComposerInputElement } from "./ComposerInput";
import type { PickerGroup } from "@octant/domain";

const COMMANDS: ReadonlyArray<OctantCommand> = [
  {
    id: "skill:review",
    title: "Review",
    group: "Skills",
    detail: "Skill",
    keywords: ["review"],
    action: { kind: "address", reference: "$review" },
  },
  {
    id: "plugin:@docs/search",
    title: "Docs search",
    group: "Plugins",
    detail: "MCP server · Docs",
    keywords: ["mcp"],
    action: { kind: "address", reference: "@docs/search" },
  },
  {
    id: "connector:@notes/server",
    title: "Notes",
    group: "Connectors",
    detail: "Connector",
    keywords: ["connector"],
    action: { kind: "address", reference: "@notes/server" },
  },
  {
    id: "settings:open",
    title: "Open Settings",
    group: "Settings",
    action: { kind: "run", run: () => undefined },
  },
];

function Harness(props: {
  readonly resolve: (reference: string) => Promise<boolean>;
  readonly files?: AtMenuFiles;
  readonly provider?: ComposerProviderCommands;
  readonly mentions?: ComposerProviderMentions;
}) {
  const [draft, setDraft] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const at = useComposerAtMenu({
    draft,
    onDraftChange: setDraft,
    onResolveExtensionReference: props.resolve,
    textarea: () => textarea.current,
    ...(props.files === undefined ? {} : { files: props.files }),
    provider: props.mentions,
  });
  const slash = useComposerSlashCommands({
    draft,
    onDraftChange: setDraft,
    textarea: () => textarea.current,
    provider: props.provider,
  });
  return (
    <>
      <textarea
        aria-label="Message"
        ref={textarea}
        value={draft}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          at.sync(event.currentTarget.value, event.currentTarget.selectionStart);
          slash.sync(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
        onKeyDown={(event) => {
          at.handleKeyDown(event);
        }}
        onKeyUp={(event) => {
          at.sync(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
      />
      <ComposerAtTypeahead controller={at} />
      <ComposerSlashTypeahead controller={slash} />
      <button disabled={at.resolving}>Send</button>
    </>
  );
}

function renderComposer(resolve: (reference: string) => Promise<boolean>, files?: AtMenuFiles) {
  return render(
    <OctantCommandProvider commands={COMMANDS}>
      <Harness resolve={resolve} {...(files === undefined ? {} : { files })} />
    </OctantCommandProvider>,
  );
}

describe("composer / menu", () => {
  const provider: ComposerProviderCommands = {
    label: "Claude Code",
    commands: [{ name: "review", description: "Review a pull request", argumentHint: "<pr>" }],
  };

  it("lists the provider's own commands beside Octant's and writes the chosen one into the message", async () => {
    const user = userEvent.setup();
    render(
      <OctantCommandProvider commands={COMMANDS}>
        <Harness resolve={vi.fn(async () => true)} provider={provider} />
      </OctantCommandProvider>,
    );
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "/");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Open SettingsSettings",
      "/reviewProvider commands · Claude Code's own · <pr> · Review a pull request",
    ]);
    await user.click(screen.getByRole("option", { name: /\/review/ }));
    expect(message).toHaveValue("/review ");
  });
});

describe("composer @ menu", () => {
  it("lists skills, plugin servers, and connectors, and leaves commands to the slash menu", async () => {
    const user = userEvent.setup();
    renderComposer(vi.fn(async () => true));
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "ReviewSkill",
      "Docs searchMCP server · Docs",
      "NotesConnector",
    ]);
    await user.clear(message);
    await user.type(message, "/");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Open SettingsSettings",
    ]);
  });

  it("keeps typing available and focus in the message while a chosen skill resolves", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<boolean>();
    const resolve = vi.fn((_reference: string) => pending.promise);
    renderComposer(resolve);
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "Use @rev");
    await user.click(screen.getByRole("option", { name: /Review/ }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith("$review");
    expect(message).toHaveFocus();
    expect(message).toHaveValue("Use ");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.keyboard("now");
    expect(message).toHaveValue("Use now");
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("keeps the arrowed-to row when the key comes back up on the same token", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn(async (_reference: string) => true);
    renderComposer(resolve);
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(resolve).toHaveBeenCalledExactlyOnceWith("@docs/search");
  });

  it("lists the provider's own skills and plugins after Octant's and writes the chosen one's own reference", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn(async (_reference: string) => true);
    const mentions: ComposerProviderMentions = {
      label: "Codex",
      mentions: [
        { kind: "skill", name: "tidy", description: "Tidy the code" },
        { kind: "plugin", name: "docs", description: "Search the docs" },
      ],
    };
    render(
      <OctantCommandProvider commands={COMMANDS}>
        <Harness resolve={resolve} mentions={mentions} />
      </OctantCommandProvider>,
    );
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "ReviewSkill",
      "Docs searchMCP server · Docs",
      "NotesConnector",
      "$tidyCodex's own skill · Tidy the code",
      "@docsCodex's own plugin · Search the docs",
    ]);
    await user.clear(message);
    await user.type(message, "Ask @ti");
    await user.click(screen.getByRole("option", { name: /\$tidy/ }));
    // The provider resolves its own reference at send; Octant's resolver is not asked.
    expect(message).toHaveValue("Ask $tidy ");
    expect(message).toHaveFocus();
    expect(resolve).not.toHaveBeenCalled();
    await user.type(message, "@do");
    await user.click(screen.getByRole("option", { name: /@docs/ }));
    expect(message).toHaveValue("Ask $tidy @docs ");
  });

  it("labels Project Codex skills as Project beside account skills, inserts $name, and renders no disabled rows when off", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn(async (_reference: string) => true);
    const loadOn = vi.fn(async () => [
      {
        kind: "skill" as const,
        name: "local",
        scope: "project" as const,
        description: "Deploy this Project",
      },
      { kind: "skill" as const, name: "tidy", description: "Tidy the code" },
    ]);
    const loadOff = vi.fn(async () => [
      { kind: "skill" as const, name: "tidy", description: "Tidy the code" },
    ]);
    const accountOnly: ComposerProviderMentions = {
      label: "Codex",
      mentions: [{ kind: "skill", name: "tidy", description: "Tidy the code" }],
      scopeKey: "code:thread-1:on",
      load: loadOn,
    };
    const rendered = render(
      <OctantCommandProvider commands={COMMANDS}>
        <Harness resolve={resolve} mentions={accountOnly} />
      </OctantCommandProvider>,
    );
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@");
    expect(loadOn).toHaveBeenCalledTimes(1);
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "ReviewSkill",
      "Docs searchMCP server · Docs",
      "NotesConnector",
      "$localProject · Codex's own skill · Deploy this Project",
      "$tidyCodex's own skill · Tidy the code",
    ]);

    // Typing to filter the open `@` menu does not re-query the server on each keystroke.
    await user.type(message, "loc");
    expect(loadOn).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "$localProject · Codex's own skill · Deploy this Project",
    ]);
    await user.click(screen.getByRole("option", { name: /\$local/ }));
    expect(message).toHaveValue("$local ");
    expect(resolve).not.toHaveBeenCalled();

    // Turning Project skills off changes the scope: stale Project skills drop and no greyed/disabled row appears.
    rendered.rerender(
      <OctantCommandProvider commands={COMMANDS}>
        <Harness
          resolve={resolve}
          mentions={{
            label: "Codex",
            mentions: [{ kind: "skill", name: "tidy", description: "Tidy the code" }],
            scopeKey: "code:thread-1:off",
            load: loadOff,
          }}
        />
      </OctantCommandProvider>,
    );
    await user.clear(message);
    await user.type(message, "@");
    expect(loadOff).toHaveBeenCalledTimes(1);
    const optionsWhenOff = screen.getAllByRole("option");
    expect(optionsWhenOff.map((option) => option.textContent)).toEqual([
      "ReviewSkill",
      "Docs searchMCP server · Docs",
      "NotesConnector",
      "$tidyCodex's own skill · Tidy the code",
    ]);
    expect(screen.queryByRole("option", { name: /\$local/ })).toBeNull();
    for (const option of optionsWhenOff) {
      expect(option).not.toBeDisabled();
      expect(option).not.toHaveAttribute("aria-disabled", "true");
    }
  });

  it("opens the @ menu for a Project Codex skill even when the account has no skills of its own", async () => {
    const user = userEvent.setup();
    const load = vi.fn(async () => [
      { kind: "skill" as const, name: "project-only", scope: "project" as const },
    ]);
    render(
      <OctantCommandProvider commands={[]}>
        <Harness
          resolve={vi.fn(async () => true)}
          mentions={{ label: "Codex", mentions: [], scopeKey: "code:thread-2:on", load }}
        />
      </OctantCommandProvider>,
    );
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@");
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "$project-onlyProject · Codex's own skill",
    ]);
    await user.click(screen.getByRole("option", { name: /\$project-only/ }));
    expect(message).toHaveValue("$project-only ");
  });

  it("refreshes thread provider mentions through ThreadNativeSetupProvider when setup revision changes", async () => {
    const user = userEvent.setup();
    const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000099");
    const groups: ReadonlyArray<PickerGroup> = [
      {
        instance: {
          id: instanceId,
          displayName: "Codex",
          driverKind: "codex",
          configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
          enabled: true,
          environmentPolicy: "inherit-host",
          nativeSetup: true,
          version: decodeAggregateVersion(1),
          createdAt: decodeUtcTimestamp("2026-11-19T00:00:00.000Z"),
          updatedAt: decodeUtcTimestamp("2026-11-19T00:00:00.000Z"),
        },
        runtime: { kind: "codex-cli", label: "Codex CLI" } as never,
        readiness: "ready",
        driverLabel: "Codex",
        endpointHost: undefined,
        executionHost: "local",
        sections: [],
        providerMentions: [{ kind: "skill", name: "tidy", description: "Tidy the code" }],
      },
    ];
    const readMentions = vi
      .fn()
      .mockResolvedValueOnce([
        { kind: "skill", name: "local", scope: "project", description: "Deploy" },
        { kind: "skill", name: "tidy", description: "Tidy the code" },
      ])
      .mockResolvedValueOnce([{ kind: "skill", name: "tidy", description: "Tidy the code" }]);

    function ThreadHarness() {
      const mentions = useThreadProviderMentions(groups, {
        kind: "thread",
        mode: "code",
        threadId: "80000000-0000-4000-8000-000000000098",
        providerInstanceId: instanceId,
        executionPolicy: "approval-gated",
      });
      return (
        <Harness
          resolve={vi.fn(async () => true)}
          {...(mentions === undefined ? {} : { mentions })}
        />
      );
    }

    const baseServices = {
      instances: [{ id: instanceId, driverKind: "codex" as const }],
      read: vi.fn(async () => "inherit" as const),
      change: vi.fn(async () => "off" as const),
      readMentions,
    };

    const rendered = render(
      <OctantCommandProvider commands={[]}>
        <ThreadNativeSetupProvider services={{ ...baseServices, revision: 0 }}>
          <ThreadHarness />
        </ThreadNativeSetupProvider>
      </OctantCommandProvider>,
    );
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@");
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "$localProject · Codex's own skill · Deploy",
      "$tidyCodex's own skill · Tidy the code",
    ]);
    expect(readMentions).toHaveBeenCalledWith({
      kind: "mentions",
      mode: "code",
      threadId: "80000000-0000-4000-8000-000000000098",
    });

    rendered.rerender(
      <OctantCommandProvider commands={[]}>
        <ThreadNativeSetupProvider services={{ ...baseServices, revision: 1 }}>
          <ThreadHarness />
        </ThreadNativeSetupProvider>
      </OctantCommandProvider>,
    );
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "$tidyCodex's own skill · Tidy the code",
    ]);
    expect(screen.queryByRole("option", { name: /\$local/ })).toBeNull();
  });

  it("restarts a canceled mentions read when load identity changes while a request is in flight", async () => {
    const user = userEvent.setup();
    const first = Promise.withResolvers<
      ReadonlyArray<{
        readonly kind: "skill";
        readonly name: string;
        readonly scope?: "project";
        readonly description?: string;
      }>
    >();
    const load1 = vi.fn(() => first.promise);
    const load2 = vi.fn(async () => [
      {
        kind: "skill" as const,
        name: "local",
        scope: "project" as const,
        description: "Deploy this Project",
      },
      { kind: "skill" as const, name: "tidy", description: "Tidy the code" },
    ]);
    const accountOnly = [{ kind: "skill" as const, name: "tidy", description: "Tidy the code" }];
    const rendered = render(
      <OctantCommandProvider commands={[]}>
        <Harness
          resolve={vi.fn(async () => true)}
          mentions={{
            label: "Codex",
            mentions: accountOnly,
            scopeKey: "code:thread-3:on",
            load: load1,
          }}
        />
      </OctantCommandProvider>,
    );
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@");
    expect(load1).toHaveBeenCalledTimes(1);

    // Provider groups refresh while `load1` is still pending, rebuilding `load` with the same scopeKey.
    rendered.rerender(
      <OctantCommandProvider commands={[]}>
        <Harness
          resolve={vi.fn(async () => true)}
          mentions={{
            label: "Codex",
            mentions: accountOnly,
            scopeKey: "code:thread-3:on",
            load: load2,
          }}
        />
      </OctantCommandProvider>,
    );
    expect(load2).toHaveBeenCalledTimes(1);
    await screen.findByRole("option", { name: /\$local/ });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "$localProject · Codex's own skill · Deploy this Project",
      "$tidyCodex's own skill · Tidy the code",
    ]);

    // A late resolution of the canceled first request must not overwrite the newer result.
    await act(async () => {
      first.resolve(accountOnly);
      await first.promise;
    });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "$localProject · Codex's own skill · Deploy this Project",
      "$tidyCodex's own skill · Tidy the code",
    ]);
  });

  it("offers nothing for an at sign inside a word or an unmatched query", async () => {
    const user = userEvent.setup();
    renderComposer(vi.fn(async () => true));
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "mail me@rev");
    expect(screen.queryByRole("option")).toBeNull();
    await user.clear(message);
    await user.type(message, "@zzz");
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("lists files beside extensions and names the chosen file through the file picker", async () => {
    const user = userEvent.setup();
    const choose = vi.fn();
    renderComposer(
      vi.fn(async () => true),
      {
        open: true,
        candidates: [{ path: "src/review.ts", kind: "file" }],
        choose,
      },
    );
    await user.type(screen.getByRole("textbox", { name: "Message" }), "@rev");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "ReviewSkill",
      "src/review.tsFile",
    ]);
    await user.click(screen.getByRole("option", { name: /src\/review.ts/ }));
    expect(choose).toHaveBeenCalledExactlyOnceWith({ path: "src/review.ts", kind: "file" });
  });

  it("does not choose a skill while an IME composition is being committed", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn(async () => true);
    renderComposer(resolve);
    const message = screen.getByRole("textbox", { name: "Message" });
    await user.type(message, "@review");
    fireEvent.keyDown(message, { key: "Enter", isComposing: true });
    expect(resolve).not.toHaveBeenCalled();
    expect(message).toHaveValue("@review");
  });
});

describe("@model in the composer", () => {
  const instanceId = "80000000-0000-4000-8000-0000000000a1";
  const model = (id: string, displayName: string, values: ReadonlyArray<string>) =>
    decodeProviderModel({
      id,
      displayName,
      source: "discovered",
      verification: "verified",
      reasoning: "supported",
      inputModalities: ["text"],
      options:
        values.length === 0
          ? []
          : [{ id: "effort", displayName: "Effort", kind: "selection", values }],
    });
  const groups: ReadonlyArray<PickerGroup> = [
    {
      instance: {
        id: decodeProviderInstanceId(instanceId),
        displayName: "Team Codex",
        driverKind: "codex",
        configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
        enabled: true,
        environmentPolicy: "inherit-host",
        version: decodeAggregateVersion(1),
        createdAt: decodeUtcTimestamp("2026-11-23T00:00:00.000Z"),
        updatedAt: decodeUtcTimestamp("2026-11-23T00:00:00.000Z"),
      },
      runtime: "provider",
      readiness: "ready",
      driverLabel: "Codex",
      endpointHost: undefined,
      executionHost: "local",
      sections: [
        {
          id: "all-models",
          label: "All models",
          models: [
            { model: model("gpt-5", "GPT-5", ["low", "high"]), badges: [], toolCapable: true },
            { model: model("gpt-5-mini", "GPT-5 mini", []), badges: [], toolCapable: true },
            { model: model("chat-only", "Chat only", []), badges: [], toolCapable: false },
          ],
        },
      ],
    },
  ];

  function ModelHarness(props: { readonly initial?: string; readonly onSend?: () => void }) {
    const [draft, setDraft] = useState(props.initial ?? "");
    const prompt = useRef<ComposerInputElement>(null);
    const at = useComposerAtMenu({
      draft,
      onDraftChange: setDraft,
      textarea: () => prompt.current,
      modelGroups: groups,
    });
    return (
      <>
        <ComposerInput
          aria-label="Message"
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            at.sync(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onKeyDown={(event) => {
            if (at.handleKeyDown(event)) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              props.onSend?.();
            }
          }}
          ref={prompt}
          renderModelChip={at.renderModelChip}
          value={draft}
        />
        {at.open ? <ComposerAtTypeahead controller={at} /> : null}
      </>
    );
  }

  it("inserts the chosen provider, model and reasoning as a tag the prompt shows as a chip", async () => {
    render(<ModelHarness />);
    const prompt = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(prompt, "Review with @model{Enter}");
    const search = await screen.findByRole("combobox", { name: "Search models" });
    expect(search).toHaveFocus();
    expect(screen.getByRole("option", { name: /GPT-5 mini/ })).toBeInTheDocument();
    await userEvent.type(search, "gpt-5{Enter}");
    expect(screen.getByRole("option", { name: "Provider default" })).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(prompt).toHaveValue(`Review with @model(${instanceId}/gpt-5, reasoning=high) `);
    expect(
      screen.getByRole("button", { name: "Subagent model: Team Codex, GPT-5, high" }),
    ).toBeInTheDocument();
  });

  it("leaves the draft as typed when the picker is dismissed with Escape", async () => {
    render(<ModelHarness />);
    const prompt = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(prompt, "Ask @model{Enter}");
    await screen.findByRole("combobox", { name: "Search models" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Choose a subagent model" })).toBeNull();
    expect(prompt).toHaveValue("Ask @model");
  });

  it("offers @model as the first row and keeps typing in the prompt for a longer mention", async () => {
    render(<ModelHarness />);
    const prompt = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(prompt, "@model");
    expect(screen.getByRole("option", { name: /@model/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("combobox", { name: "Search models" })).toBeNull();
    await userEvent.type(prompt, "s/schema.ts");
    expect(prompt).toHaveValue("@models/schema.ts");
    expect(prompt).toHaveFocus();
  });

  it("opens again for a newly typed @model after an earlier one was dismissed", async () => {
    render(<ModelHarness />);
    const prompt = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(prompt, "@model{Enter}");
    await screen.findByRole("combobox", { name: "Search models" });
    await userEvent.keyboard("{Escape}");
    await userEvent.type(prompt, "{Backspace>6/}@model{Enter}");
    expect(await screen.findByRole("combobox", { name: "Search models" })).toHaveFocus();
  });

  it("leaves the caret after an inserted chip when text follows it", async () => {
    render(<ModelHarness initial="Review later" />);
    const prompt = screen.getByRole<ComposerInputElement>("textbox", { name: "Message" });
    prompt.focus();
    prompt.setSelectionRange(7, 7);
    await userEvent.keyboard("@model{Enter}");
    await screen.findByRole("combobox", { name: "Search models" });
    await userEvent.keyboard("GPT-5 mini{Enter}");
    await waitFor(() => expect(prompt).toHaveFocus());
    await userEvent.keyboard("now ");
    expect(prompt).toHaveValue(`Review @model(${instanceId}/gpt-5-mini) now later`);
  });

  it("lists only models that can run Octant's tools and says why another cannot", () => {
    render(<ModelHarness initial={`@model(${instanceId}/chat-only) x`} />);
    expect(
      screen.getByRole("button", {
        name: "Subagent model: Team Codex, Chat only, Provider default. Needs attention: Chat only cannot run Octant's tools, so it cannot take a subagent.",
      }),
    ).toBeInTheDocument();
  });

  it("reopens the picker from a chip's Enter key without sending the message", async () => {
    const onSend = vi.fn();
    render(<ModelHarness initial={`@model(${instanceId}/gpt-5) b`} onSend={onSend} />);
    const chip = screen.getByRole("button", { name: /Subagent model: Team Codex, GPT-5,/ });
    chip.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("combobox", { name: "Search models" })).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      `@model(${instanceId}/gpt-5) b`,
    );
  });

  it("says which choice needs attention when a tag's route is gone", () => {
    render(<ModelHarness initial={`@model(${instanceId}/gpt-5, reasoning=max) please`} />);
    expect(
      screen.getByRole("button", {
        name: "Subagent model: Team Codex, GPT-5, max. Needs attention: GPT-5 does not offer reasoning “max”.",
      }),
    ).toBeInTheDocument();
  });

  it("reopens the picker on a chip's current route and replaces only that tag", async () => {
    render(<ModelHarness initial={`a @model(${instanceId}/gpt-5) b`} />);
    await userEvent.click(
      screen.getByRole("button", { name: /Subagent model: Team Codex, GPT-5,/ }),
    );
    expect(screen.getByRole("option", { name: /^GPT-5Team Codex$/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      `a @model(${instanceId}/gpt-5, reasoning=low) b`,
    );
  });
});

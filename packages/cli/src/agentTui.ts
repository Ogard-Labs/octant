import type { ChatThreadView, NativeHarnessSessionView } from "@octant/contracts";
import {
  activateAgentFollowUp,
  answerAgentQuestion,
  commandAgentSession,
  previewAgentFollowUp,
  readAgentSession,
  readAgentThread,
  sendAgentPrompt,
} from "./agentHost";
import {
  paletteFor,
  statusLineFrom,
  transcriptFrom,
  type TuiPalette,
  type TuiThemeId,
  type TuiTranscriptEntry,
} from "./agentTuiModel";
import type { OpenedLocalControlSession } from "./localControl";

export interface RunAgentTuiInput {
  readonly session: OpenedLocalControlSession;
  readonly threadId: string;
  readonly themeId?: TuiThemeId | undefined;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

type OpenTui = typeof import("@opentui/core");

const HINT = "Enter sends · Shift+Enter newline · /next N · /pause · /resume · Ctrl+C quits";

/**
 * The full-screen terminal front end for one harness thread: the same
 * conversation, actions, questions, and follow-ups the app shows, drawn with
 * the app's own theme tokens. The terminal library is loaded only here, so
 * `--plain` and every other command never touch it; a host that cannot load
 * it falls back to the line mode rather than failing the command.
 */
export async function runAgentTui(input: RunAgentTuiInput): Promise<number | "unavailable"> {
  let tui: OpenTui;
  try {
    tui = await import("@opentui/core");
  } catch {
    return "unavailable";
  }
  const renderer = await tui.createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useMouse: true,
  });
  const mode = (await renderer.waitForThemeMode(400)) === "light" ? "light" : "dark";
  const screen = mountAgentScreen(tui, renderer, paletteFor(input.themeId, mode), input);
  try {
    return await screen.run();
  } finally {
    renderer.destroy();
  }
}

/** Mounts the screen on a renderer the caller owns, so a test renderer can capture it. */
export function mountAgentScreen(
  tui: OpenTui,
  renderer: Awaited<ReturnType<OpenTui["createCliRenderer"]>>,
  palette: TuiPalette,
  input: RunAgentTuiInput,
): { readonly run: () => Promise<number>; readonly refresh: () => Promise<void> } {
  const screen = new AgentScreen(tui, renderer, palette, input);
  return { run: () => screen.run(), refresh: () => screen.refresh() };
}

class AgentScreen {
  readonly #tui: OpenTui;
  readonly #renderer: Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
  readonly #palette: TuiPalette;
  readonly #input: RunAgentTuiInput;
  #thread: ChatThreadView | undefined;
  #session: NativeHarnessSessionView | null | undefined;
  #note = "";
  #drawn = "";
  #pendingFollowUp:
    | { readonly suggestionId: string; readonly turnId: string; readonly prompt: string }
    | undefined;
  #resolveExit: ((code: number) => void) | undefined;

  readonly #header;
  readonly #transcript;
  readonly #panel;
  readonly #panelText;
  readonly #composer;
  readonly #noteText;
  readonly #footer;

  constructor(
    tui: OpenTui,
    renderer: Awaited<ReturnType<OpenTui["createCliRenderer"]>>,
    palette: TuiPalette,
    input: RunAgentTuiInput,
  ) {
    this.#tui = tui;
    this.#renderer = renderer;
    this.#palette = palette;
    this.#input = input;
    const { BoxRenderable, TextRenderable, ScrollBoxRenderable, TextareaRenderable } = tui;
    const root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: palette.background,
    });
    this.#header = new TextRenderable(renderer, { content: "", height: 1, paddingLeft: 1 });
    this.#transcript = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      flexShrink: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      paddingLeft: 1,
      paddingRight: 1,
      contentOptions: { flexDirection: "column", gap: 1 },
    });
    this.#panel = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      titleColor: palette.textSecondary,
      paddingLeft: 1,
      paddingRight: 1,
      marginLeft: 1,
      marginRight: 1,
      flexShrink: 0,
      visible: false,
    });
    this.#panelText = new TextRenderable(renderer, { content: "", wrapMode: "word" });
    this.#panel.add(this.#panelText);
    const composerBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      focusedBorderColor: palette.accent,
      marginLeft: 1,
      marginRight: 1,
      marginTop: 1,
      paddingLeft: 1,
      height: 5,
      flexShrink: 0,
    });
    this.#composer = new TextareaRenderable(renderer, {
      placeholder: "Type a prompt",
      placeholderColor: palette.muted,
      textColor: palette.text,
      backgroundColor: palette.background,
      focusedBackgroundColor: palette.background,
      flexGrow: 1,
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "return", shift: true, action: "newline" },
      ],
      onSubmit: () => void this.#submit(),
    });
    composerBox.add(this.#composer);
    this.#noteText = new TextRenderable(renderer, { content: "", height: 1, paddingLeft: 2 });
    this.#footer = new TextRenderable(renderer, { content: "", height: 1, paddingLeft: 2 });
    root.add(this.#header);
    root.add(this.#transcript);
    root.add(this.#panel);
    root.add(composerBox);
    root.add(this.#noteText);
    root.add(this.#footer);
    renderer.root.add(root);
    this.#composer.focus();
  }

  run(): Promise<number> {
    return new Promise((resolve) => {
      this.#resolveExit = resolve;
      this.#renderer.keyInput.on("keypress", (key) => {
        if (key.ctrl && key.name === "c") resolve(0);
        else if (key.ctrl && key.name === "p") void this.#pauseOrResume();
      });
      this.#input.signal?.addEventListener("abort", () => resolve(1), { once: true });
      const interval = setInterval(() => void this.refresh(), this.#input.pollIntervalMs ?? 500);
      void this.refresh();
      void Promise.resolve().then(() => undefined);
      const stop = () => clearInterval(interval);
      this.#renderer.on("destroy", stop);
    });
  }

  async refresh(): Promise<void> {
    const [thread, session] = await Promise.all([
      readAgentThread(this.#input.session, this.#input.threadId),
      readAgentSession(this.#input.session, this.#input.threadId),
    ]);
    this.#thread = thread;
    this.#session = session === "unavailable" ? undefined : session;
    this.#draw();
  }

  #draw(): void {
    const { t, fg, bold, dim } = this.#tui;
    const p = this.#palette;
    const session = this.#session;
    const title = this.#thread?.thread.title ?? "Octant";
    const status = session?.session.status ?? "";
    const statusColor =
      status === "running"
        ? p.success
        : status.startsWith("paused") || status === "budget-limited"
          ? p.warning
          : status === "failed"
            ? p.danger
            : p.muted;
    this.#header.content = t`${fg(p.accent)(bold("◆ Octant"))} ${fg(p.muted)("·")} ${fg(p.text)(title)}  ${fg(statusColor)(status)}`;

    const entries = transcriptFrom(this.#thread, session);
    const pending = session?.questions.find((question) => question.status === "pending");
    const digest = JSON.stringify([entries, pending?.id, this.#pendingFollowUp?.suggestionId]);
    if (digest !== this.#drawn) {
      this.#drawn = digest;
      for (const child of this.#transcript.getChildren()) child.destroyRecursively();
      for (const entry of entries) this.#transcript.add(this.#entryBox(entry));
    }

    if (pending !== undefined) {
      this.#panel.title = " Question ";
      this.#panel.borderColor = p.accent;
      const options = pending.options.map((option, index) => `  ${index + 1}. ${option}`);
      this.#panelText.content = t`${fg(p.text)(pending.prompt)}${options.length === 0 ? "" : "\n"}${fg(p.textSecondary)(options.join("\n"))}\n${dim(fg(p.muted)("Type a number or an answer, then Enter."))}`;
      this.#panel.visible = true;
    } else if (this.#pendingFollowUp !== undefined) {
      this.#panel.title = " Follow-up ";
      this.#panel.borderColor = p.accent;
      this.#panelText.content = t`${fg(p.text)(this.#pendingFollowUp.prompt)}\n${dim(fg(p.muted)("Enter y to create it, anything else to leave it."))}`;
      this.#panel.visible = true;
    } else if (session?.followUps !== undefined && session.followUps.suggestions.length > 0) {
      this.#panel.title = " Suggested next ";
      this.#panel.borderColor = p.border;
      const lines = session.followUps.suggestions.map((suggestion, index) => {
        const done = session.activatedFollowUpIds.some(
          (id) => String(id) === String(suggestion.id),
        );
        return `${done ? "●" : "○"} ${index + 1}. ${suggestion.title}  [${suggestion.target}]`;
      });
      this.#panelText.content = t`${fg(p.textSecondary)(lines.join("\n"))}\n${dim(fg(p.muted)("/next N takes one."))}`;
      this.#panel.visible = true;
    } else {
      this.#panel.visible = false;
    }

    this.#noteText.content =
      this.#note.length === 0 ? t`${dim(fg(p.muted)(HINT))}` : t`${fg(p.warning)(this.#note)}`;
    const detail = session?.session.detail;
    this.#footer.content = t`${dim(fg(p.muted)(statusLineFrom(this.#thread, session)))}${detail === undefined ? "" : fg(p.warning)(`  ${detail}`)}`;
    this.#renderer.requestRender();
  }

  #entryBox(entry: TuiTranscriptEntry) {
    const { BoxRenderable, TextRenderable, t, fg, bold, dim } = this.#tui;
    const p = this.#palette;
    const box = new BoxRenderable(this.#renderer, { flexDirection: "column" });
    if (entry.kind === "you") {
      box.add(
        new TextRenderable(this.#renderer, {
          content: t`${fg(p.you)("◆")} ${fg(p.text)(bold("You"))} ${dim(fg(p.muted)(`· ${entry.at}`))}`,
        }),
      );
      box.add(this.#body(entry.text));
      return box;
    }
    const outcomeColor =
      entry.outcome === "completed"
        ? p.success
        : entry.outcome === "streaming" || entry.outcome === "queued"
          ? p.accent
          : p.danger;
    const live = entry.outcome === "streaming" || entry.outcome === "queued";
    box.add(
      new TextRenderable(this.#renderer, {
        content: t`${fg(p.accent)("●")} ${fg(p.text)(bold("Lead"))} ${dim(fg(p.muted)(`· ${entry.at}`))}${live ? fg(p.accent)("  working…") : entry.outcome === "completed" ? "" : fg(outcomeColor)(`  ${entry.outcome}`)}`,
      }),
    );
    if (entry.text.length > 0) box.add(this.#body(entry.text));
    if (entry.actions !== undefined) {
      const a = entry.actions;
      const routeNote = a.route === "primary" ? "" : ` · ${a.route}`;
      const actions = new BoxRenderable(this.#renderer, { paddingLeft: 2 });
      box.add(actions);
      actions.add(
        new TextRenderable(this.#renderer, {
          content: t`${dim(fg(p.muted)("└"))} ${fg(p.success)("✓")} ${fg(p.textSecondary)(`${a.toolCalls} ${a.toolCalls === 1 ? "action" : "actions"}`)} ${dim(fg(p.muted)(`· ${a.model}${routeNote} · ${a.stopReason} · ${a.duration}`))}`,
        }),
      );
    }
    return box;
  }

  #body(text: string) {
    const { BoxRenderable, TextRenderable } = this.#tui;
    const box = new BoxRenderable(this.#renderer, { paddingLeft: 2 });
    box.add(
      new TextRenderable(this.#renderer, {
        content: text,
        fg: this.#palette.text,
        wrapMode: "word",
      }),
    );
    return box;
  }

  async #submit(): Promise<void> {
    const text = this.#composer.plainText.trim();
    this.#composer.setText("");
    if (text.length === 0) return;
    this.#note = "";
    if (text === "/quit" || text === "/exit") {
      this.#resolveExit?.(0);
      return;
    }
    if (text === "/pause" || text === "/resume") {
      await this.#pauseOrResume(text === "/pause" ? "pause" : "resume");
      return;
    }
    if (this.#pendingFollowUp !== undefined) {
      const pending = this.#pendingFollowUp;
      this.#pendingFollowUp = undefined;
      if (/^y(es)?$/i.test(text)) await this.#activateFollowUp(pending);
      else this.#note = "Left as a suggestion.";
      this.#draw();
      return;
    }
    if (text === "/next" || text.startsWith("/next ")) {
      await this.#previewFollowUp(text.slice("/next".length).trim());
      return;
    }
    const question = this.#session?.questions.find((entry) => entry.status === "pending");
    if (question !== undefined) {
      const picked = /^\d+$/.test(text) ? question.options[Number(text) - 1] : undefined;
      const result = await answerAgentQuestion(
        this.#input.session,
        this.#input.threadId,
        String(question.id),
        picked ?? text,
      );
      if (result.kind === "refused") this.#note = result.message;
      await this.refresh();
      return;
    }
    if (this.#thread === undefined) {
      this.#note = "The thread could not be read.";
      this.#draw();
      return;
    }
    const sent = await sendAgentPrompt(this.#input.session, this.#thread, text);
    if (sent.kind === "refused") this.#note = sent.message;
    await this.refresh();
  }

  async #pauseOrResume(action?: "pause" | "resume"): Promise<void> {
    const session = this.#session;
    if (session === null || session === undefined) {
      this.#note = "No harness session yet.";
      this.#draw();
      return;
    }
    const paused = session.session.status !== "running" && session.session.status !== "idle";
    const result = await commandAgentSession(
      this.#input.session,
      session,
      action ?? (paused ? "resume" : "pause"),
    );
    if (result.kind === "refused") this.#note = result.message;
    await this.refresh();
  }

  async #previewFollowUp(argument: string): Promise<void> {
    const session = this.#session;
    if (session === null || session === undefined || session.followUps === undefined) {
      this.#note = "No follow-ups have been suggested yet.";
      this.#draw();
      return;
    }
    const suggestion = /^\d+$/.test(argument)
      ? session.followUps.suggestions[Number(argument) - 1]
      : undefined;
    if (suggestion === undefined) {
      this.#note = "Pick one by number: /next 1";
      this.#draw();
      return;
    }
    const previewed = await previewAgentFollowUp(
      this.#input.session,
      this.#input.threadId,
      String(suggestion.id),
    );
    if (previewed.kind === "refused") {
      this.#note = previewed.message;
      this.#draw();
      return;
    }
    const target =
      previewed.preview.wouldCreate.kind === "same-thread"
        ? "continues in this thread"
        : previewed.preview.wouldCreate.kind === "new-thread"
          ? `starts a new ${previewed.preview.wouldCreate.mode} thread`
          : "starts a new Code thread on its own worktree";
    this.#pendingFollowUp = {
      suggestionId: String(suggestion.id),
      turnId: String(session.followUps.turnId),
      prompt: `${suggestion.title} — ${target}\n${suggestion.prompt}`,
    };
    this.#draw();
  }

  async #activateFollowUp(pending: {
    readonly suggestionId: string;
    readonly turnId: string;
  }): Promise<void> {
    const result = await activateAgentFollowUp(
      this.#input.session,
      this.#input.threadId,
      pending.turnId,
      pending.suggestionId,
    );
    if (result.kind !== "follow-up-activated") {
      this.#note = result.message;
      return;
    }
    const created = result.created;
    if (created.kind === "same-thread") {
      const suggestion = this.#session?.followUps?.suggestions.find(
        (entry) => String(entry.id) === pending.suggestionId,
      );
      if (suggestion !== undefined && this.#thread !== undefined) {
        const sent = await sendAgentPrompt(this.#input.session, this.#thread, suggestion.prompt);
        if (sent.kind === "refused") this.#note = sent.message;
      }
    } else if (created.threadId !== undefined) {
      this.#note = `Created ${created.mode} thread ${created.threadId} — octant agent --thread ${created.threadId}`;
    }
    await this.refresh();
  }
}

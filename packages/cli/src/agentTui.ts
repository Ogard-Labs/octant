import type { NativeHarnessSessionView } from "@octant/contracts";
import {
  agentThreadPort,
  isAgentSnapshotRunning,
  type AgentThreadPort,
  type AgentThreadSnapshot,
} from "./agentThread";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  activateAgentFollowUp,
  answerAgentQuestion,
  attachmentMediaType,
  changeAgentModel,
  commandAgentSession,
  contextPercent,
  decideAgentApproval,
  listAgentModels,
  listAgentThreads,
  previewAgentFollowUp,
  readAgentSession,
  steerAgent,
  uploadAgentAttachment,
  type AgentModelChoice,
} from "./agentHost";
import { notifyDesktop } from "./agentNotify";
import {
  paletteFor,
  statusLineFrom,
  tasksFrom,
  transcriptFrom,
  type TuiPalette,
  type TuiThemeId,
  type TuiToolLine,
  type TuiTranscriptEntry,
} from "./agentTuiModel";
import type { ChatNavigationThread } from "@octant/contracts";
import type { OpenedLocalControlSession } from "./localControl";

export interface RunAgentTuiInput {
  readonly session: OpenedLocalControlSession;
  readonly threadId: string;
  readonly mode?: "chat" | "work" | "code";
  readonly themeId?: TuiThemeId | undefined;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  /** Start with tool diffs and output expanded (what Ctrl+E toggles). */
  readonly verbose?: boolean;
  /** No desktop notification when a turn ends. */
  readonly quiet?: boolean;
}

const MAX_FILE_SUGGESTIONS = 8;
const MAX_SCANNED_FILES = 4_000;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".cache"]);

type OpenTui = typeof import("@opentui/core");

const HINT =
  "Enter sends · Enter while working queues a note · Esc stops · Ctrl+E details · Ctrl+R reasoning · PgUp/PgDn scroll · ? help";
const REASONING_FENCE = /```(?:reasoning|thinking)\n([\s\S]*?)```|<think>([\s\S]*?)<\/think>/g;
const QUIT_WINDOW_MS = 1_500;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const SHOWN_TOOL_LINES = 4;
const SHOWN_TASKS = 6;

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
  // From here the terminal is in raw mode on the alternate screen; every
  // exit, including a failure while setting up, must give it back.
  try {
    const mode = (await renderer.waitForThemeMode(400)) === "light" ? "light" : "dark";
    const screen = mountAgentScreen(tui, renderer, paletteFor(input.themeId, mode), input);
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
  #thread: AgentThreadSnapshot | undefined;
  #port: AgentThreadPort;
  #session: NativeHarnessSessionView | null | undefined;
  #note = "";
  #drawn = "";
  #ticks = 0;
  #lastCtrlC = 0;
  #flushingSteering = false;
  #verbose = false;
  #showReasoning = false;
  #showHelp = false;
  #threadId: string;
  #threads: ReadonlyArray<ChatNavigationThread> = [];
  #models: ReadonlyArray<AgentModelChoice> = [];
  #listing: "threads" | "models" | undefined;
  #suggestions:
    | { readonly kind: "file" | "thread"; readonly items: ReadonlyArray<string> }
    | undefined;
  #files: ReadonlyArray<string> | undefined;
  #wasRunning = false;
  #pendingFollowUp:
    | { readonly suggestionId: string; readonly turnId: string; readonly prompt: string }
    | undefined;
  #resolveExit: ((code: number) => void) | undefined;

  readonly #header;
  readonly #transcript;
  readonly #panel;
  readonly #panelText;
  readonly #tasks;
  readonly #tasksText;
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
    this.#verbose = input.verbose === true;
    this.#threadId = input.threadId;
    this.#port = agentThreadPort(input.session, input.mode ?? "chat", input.threadId);
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
    this.#tasks = new BoxRenderable(renderer, {
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
    this.#tasksText = new TextRenderable(renderer, { content: "", wrapMode: "word" });
    this.#tasks.add(this.#tasksText);
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
    root.add(this.#tasks);
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
        if (key.ctrl && key.name === "c") {
          // With text selected, Ctrl+C copies it, as in any terminal; otherwise
          // it stops the turn first, and a second press right after quits.
          const selected = this.#renderer.getSelection()?.getSelectedText() ?? "";
          if (selected.trim().length > 0) {
            void this.#copy(selected);
            this.#renderer.clearSelection();
            return;
          }
          const now = Date.now();
          const again = now - this.#lastCtrlC < QUIT_WINDOW_MS;
          this.#lastCtrlC = now;
          if (again || !isAgentSnapshotRunning(this.#thread)) resolve(0);
          else void this.#interrupt();
        } else if (key.name === "escape") {
          void this.#interrupt();
        } else if (key.ctrl && key.name === "p") {
          void this.#pauseOrResume();
        } else if (key.ctrl && key.name === "e") {
          this.#verbose = !this.#verbose;
          this.#draw();
        } else if (key.ctrl && key.name === "r") {
          this.#showReasoning = !this.#showReasoning;
          this.#draw();
        } else if (key.name === "pageup" || key.name === "pagedown") {
          const page = Math.max(1, this.#transcript.height - 2);
          this.#transcript.scrollBy(key.name === "pageup" ? -page : page);
        } else if (key.name === "home" && key.ctrl) {
          this.#transcript.scrollTo(0);
        } else if (key.name === "end" && key.ctrl) {
          this.#transcript.scrollTo(this.#transcript.scrollHeight);
        } else if (!key.ctrl && !key.meta) {
          // The composer has not taken the key yet; look after it has.
          setTimeout(() => void this.#suggest(), 0);
        }
      });
      void listAgentModels(this.#input.session).then((models) => {
        this.#models = models;
        this.#draw();
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
      this.#port.read(),
      readAgentSession(this.#input.session, this.#threadId),
    ]);
    this.#thread = thread;
    this.#session = session === "unavailable" ? undefined : session;
    const running = isAgentSnapshotRunning(thread);
    if (this.#wasRunning && !running && this.#input.quiet !== true) {
      const outcome = thread?.turns.at(-1)?.outcome ?? "ended";
      notifyDesktop(
        "Octant",
        `${thread?.title ?? "Thread"} — turn ${outcome === "completed" ? "finished" : outcome}`,
      );
    }
    this.#wasRunning = running;
    this.#draw();
    await this.#flushSteering();
  }

  /** Live matches for an `@file` or `#thread` token at the end of the composer. */
  async #suggest(): Promise<void> {
    const text = this.#composer.plainText;
    const token = /(?:^|\s)([@#])([^\s@#]*)$/.exec(text);
    if (token === null) {
      if (this.#suggestions !== undefined) {
        this.#suggestions = undefined;
        this.#draw();
      }
      return;
    }
    const needle = (token[2] ?? "").toLowerCase();
    if (token[1] === "#") {
      if (this.#threads.length === 0) this.#threads = await listAgentThreads(this.#input.session);
      const items = this.#threads
        .filter((thread) => String(thread.id) !== this.#threadId)
        .filter((thread) => thread.title.toLowerCase().includes(needle))
        .slice(0, MAX_FILE_SUGGESTIONS)
        .map((thread) => `#${thread.title}`);
      this.#suggestions = { kind: "thread", items };
    } else {
      if (this.#files === undefined) this.#files = await scanFiles(process.cwd());
      const items = this.#files
        .filter((file) => file.toLowerCase().includes(needle))
        .slice(0, MAX_FILE_SUGGESTIONS)
        .map((file) => `@${file}`);
      this.#suggestions = { kind: "file", items };
    }
    this.#draw();
  }

  /** `@file` tokens become attachments, `#thread` tokens become mentions; the prompt keeps the names. */
  async #resolveMentions(text: string): Promise<{
    readonly prompt: string;
    readonly attachmentIds: string[];
    readonly threadMentionIds: string[];
    readonly refused: string[];
  }> {
    const attachmentIds: string[] = [];
    const threadMentionIds: string[] = [];
    const refused: string[] = [];
    for (const match of text.matchAll(/(?:^|\s)@([^\s@#]+)/g)) {
      const path = match[1] ?? "";
      if (attachmentMediaType(path) === undefined) continue;
      if (this.#port.mode !== "chat") {
        refused.push(`Attach files to a ${this.#port.mode} thread from the app.`);
        continue;
      }
      const uploaded = await uploadAgentAttachment(this.#input.session, this.#threadId, path);
      if (uploaded.kind === "uploaded") attachmentIds.push(uploaded.attachmentId);
      else refused.push(uploaded.message);
    }
    let prompt = text;
    for (const match of text.matchAll(/(?:^|\s)#([^\s@#]+)/g)) {
      const fragment = (match[1] ?? "").toLowerCase();
      if (this.#threads.length === 0) this.#threads = await listAgentThreads(this.#input.session);
      const byNumber = /^\d+$/.test(fragment) ? this.#threads[Number(fragment) - 1] : undefined;
      const thread =
        byNumber ??
        this.#threads.find(
          (entry) => entry.title.toLowerCase().replace(/\s+/g, "-") === fragment,
        ) ??
        this.#threads.find((entry) => entry.title.toLowerCase().includes(fragment));
      if (thread === undefined) continue;
      threadMentionIds.push(String(thread.id));
      prompt = prompt.replace(match[0], `${match[0].startsWith(" ") ? " " : ""}${thread.title}`);
    }
    return {
      prompt: prompt.replace(/(^|\s)@([^\s@#]+)/g, "$1$2"),
      attachmentIds,
      threadMentionIds,
      refused,
    };
  }

  async #switchThread(threadId: string): Promise<void> {
    this.#threadId = threadId;
    this.#port = agentThreadPort(this.#input.session, "chat", threadId);
    this.#drawn = "";
    this.#listing = undefined;
    this.#pendingFollowUp = undefined;
    for (const child of this.#transcript.getChildren()) child.destroyRecursively();
    await this.refresh();
  }

  /** A note the lead never reached during its turn becomes the next prompt. */
  async #flushSteering(): Promise<void> {
    const queued = (this.#session?.steering ?? []).filter((note) => note.status === "queued");
    if (
      queued.length === 0 ||
      this.#flushingSteering ||
      this.#thread === undefined ||
      isAgentSnapshotRunning(this.#thread) ||
      this.#session?.session.status === "running"
    ) {
      return;
    }
    this.#flushingSteering = true;
    try {
      const sent = await this.#port.send(queued.map((note) => note.text).join("\n\n"));
      if (sent.kind === "refused") this.#note = sent.message;
      else await steerAgent(this.#input.session, this.#threadId, { kind: "clear" });
    } finally {
      this.#flushingSteering = false;
    }
  }

  /** Copies through the terminal (OSC 52, works over SSH) and the host clipboard, best effort. */
  async #copy(text: string): Promise<void> {
    let copied = false;
    try {
      copied = this.#renderer.copyToClipboardOSC52(text);
    } catch {
      // A terminal without OSC 52 just says no; the host clipboard may still take it.
    }
    try {
      const host = this.#tui.createHostClipboard();
      const written = await host.writeText(text);
      copied = copied || written.status === "written";
      await host.dispose();
    } catch {
      // No host clipboard on this machine.
    }
    const lines = text.split("\n").length;
    this.#note = copied
      ? `Copied ${lines === 1 ? `${text.length} characters` : `${lines} lines`}.`
      : "This terminal does not let Octant reach the clipboard.";
    this.#draw();
  }

  async #interrupt(): Promise<void> {
    if (this.#thread === undefined) return;
    const result = await this.#port.interrupt();
    this.#note =
      result.kind === "refused"
        ? result.message
        : result.kind === "interrupted"
          ? "Stopping the turn…"
          : "Nothing is running.";
    await this.refresh();
  }

  #draw(): void {
    const { t, fg, bold, dim } = this.#tui;
    const p = this.#palette;
    const session = this.#session;
    const title = this.#thread?.title ?? "Octant";
    const status = session?.session.status ?? "";
    const statusColor =
      status === "running"
        ? p.success
        : status.startsWith("paused") || status === "budget-limited"
          ? p.warning
          : status === "failed"
            ? p.danger
            : p.muted;
    this.#ticks += 1;
    const spinner = SPINNER[this.#ticks % SPINNER.length] ?? "";
    const mode = this.#thread === undefined ? "" : ` · ${this.#thread.mode}`;
    const percent = contextPercent(this.#thread, this.#models);
    const context =
      percent === undefined
        ? ""
        : `  ${"▰".repeat(Math.round(percent / 20))}${"▱".repeat(5 - Math.round(percent / 20))} ${percent}% context`;
    this.#header.content = t`${fg(p.accent)(bold("◆ Octant"))} ${fg(p.muted)("·")} ${fg(p.text)(title)}${dim(fg(p.muted)(mode))}  ${fg(statusColor)(status === "running" ? `${spinner} running` : status)}${dim(fg(percent !== undefined && percent >= 80 ? p.warning : p.muted)(context))}`;

    const entries = transcriptFrom(this.#thread, session);
    const pending = session?.questions.find((question) => question.status === "pending");
    const digest = JSON.stringify([
      entries,
      pending?.id,
      this.#pendingFollowUp?.suggestionId,
      session?.steering,
      this.#verbose,
      this.#showReasoning,
    ]);
    const live = entries.some((entry) => entry.kind === "lead" && entry.live !== undefined);
    if (digest !== this.#drawn || live) {
      this.#drawn = digest;
      for (const child of this.#transcript.getChildren()) child.destroyRecursively();
      for (const entry of entries) this.#transcript.add(this.#entryBox(entry, spinner));
    }

    const tasks = tasksFrom(this.#thread);
    if (tasks.total > 0) {
      this.#tasks.title = ` Tasks ${tasks.done}/${tasks.total} `;
      this.#tasksText.content = this.#tasksLines(tasks);
      this.#tasks.visible = true;
    } else {
      this.#tasks.visible = false;
    }

    const approval = session?.approvals?.find((entry) => entry.status === "pending");
    if (this.#suggestions !== undefined && this.#suggestions.items.length > 0) {
      this.#panel.title = this.#suggestions.kind === "file" ? " Files " : " Threads ";
      this.#panel.borderColor = p.border;
      this.#panelText.content = t`${fg(p.textSecondary)(this.#suggestions.items.join("\n"))}\n${dim(fg(p.muted)(this.#suggestions.kind === "file" ? "Type the rest of the name; images, PDFs, and text files attach to the prompt." : "Type the rest of the title; the thread's transcript is read-only context for this turn."))}`;
      this.#panel.visible = true;
    } else if (this.#listing === "threads") {
      this.#panel.title = " Threads ";
      this.#panel.borderColor = p.border;
      const lines = this.#threads.slice(0, 9).map((thread, index) => {
        const here = String(thread.id) === this.#threadId;
        return `${here ? "●" : "○"} ${index + 1}. ${thread.title}${thread.executing ? "  working" : ""}`;
      });
      this.#panelText.content = t`${fg(p.textSecondary)(lines.length === 0 ? "No threads yet." : lines.join("\n"))}\n${dim(fg(p.muted)("/open N switches to one."))}`;
      this.#panel.visible = true;
    } else if (this.#listing === "models") {
      this.#panel.title = " Models ";
      this.#panel.borderColor = p.border;
      const lines = this.#models.slice(0, 9).map((model, index) => {
        const here =
          this.#thread !== undefined &&
          model.instanceId === this.#thread.providerInstanceId &&
          model.modelId === this.#thread.modelId;
        return `${here ? "●" : "○"} ${index + 1}. ${model.displayName}  ${model.endpoint}${model.contextLimit === undefined ? "" : `  ${Math.round(model.contextLimit / 1000)}k`}`;
      });
      this.#panelText.content = t`${fg(p.textSecondary)(lines.length === 0 ? "No harness endpoint offers a model yet. Add one in Settings → Providers." : lines.join("\n"))}\n${dim(fg(p.muted)("/model N switches the thread's model."))}`;
      this.#panel.visible = true;
    } else if (this.#showHelp) {
      this.#panel.title = " Keys ";
      this.#panel.borderColor = p.border;
      this.#panelText.content = t`${fg(p.textSecondary)(
        [
          "Enter        send · while the lead works: queue a note for its next step",
          "Shift+Enter  new line",
          "Esc          stop the running turn        Ctrl+C  stop, twice to quit",
          "Ctrl+E       show / hide diffs and output  Ctrl+R  show / hide reasoning",
          "Ctrl+P       pause / resume the run        PgUp/PgDn · Ctrl+Home/End  scroll",
          "/next N      take a suggested follow-up    /pause /resume /model /threads /open N /quit",
          "drag + Ctrl+C  copy selected text           /copy   copy the last reply",
          "y · a · n    answer an approval            1..9 or text  answer a question",
        ].join("\n"),
      )}\n${dim(fg(p.muted)("Enter or ? closes this."))}`;
      this.#panel.visible = true;
    } else if (approval !== undefined) {
      this.#panel.title = " Approval ";
      this.#panel.borderColor = p.warning;
      this.#panelText.content = t`${fg(p.text)(bold(approval.toolName))} ${fg(p.textSecondary)(approval.summary.replace(/^[a-z-]+: /, ""))}\n${dim(fg(p.muted)(`needs your say-so (${approval.approvalClass})`))}\n${fg(p.success)("y")}${fg(p.textSecondary)(" allow · ")}${fg(p.accent)("a")}${fg(p.textSecondary)(" allow for this session · ")}${fg(p.danger)("n")}${fg(p.textSecondary)(" deny — then Enter")}`;
      this.#panel.visible = true;
    } else if (pending !== undefined) {
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

  #tasksLines(tasks: ReturnType<typeof tasksFrom>): import("@opentui/core").StyledText {
    const { StyledText, fg, bold, dim } = this.#tui;
    const p = this.#palette;
    const shown = tasks.items.slice(0, SHOWN_TASKS);
    const chunks: import("@opentui/core").TextChunk[] = [];
    if (tasks.done > 0) chunks.push(fg(p.success)(`+${tasks.done} done\n`));
    if (shown.length === 0) chunks.push(fg(p.muted)("All done."));
    shown.forEach((task, index) => {
      const suffix = index < shown.length - 1 ? "\n" : "";
      chunks.push(
        task.status === "in-progress"
          ? fg(p.text)(bold(`◐ ${task.title}${suffix}`))
          : task.status === "blocked"
            ? fg(p.warning)(`◌ ${task.title}${suffix}`)
            : fg(p.textSecondary)(`○ ${task.title}${suffix}`),
      );
    });
    const more = tasks.items.length - shown.length;
    if (more > 0) chunks.push(dim(fg(p.muted)(`\n+${more} more`)));
    return new StyledText(chunks);
  }

  #entryBox(entry: TuiTranscriptEntry, spinner: string) {
    const { BoxRenderable, TextRenderable, t, fg, bold, dim } = this.#tui;
    const p = this.#palette;
    const box = new BoxRenderable(this.#renderer, { flexDirection: "column" });
    if (entry.kind === "you") {
      box.add(
        new TextRenderable(this.#renderer, {
          content: t`${fg(p.you)("◆")} ${fg(p.text)(bold("You"))} ${dim(fg(p.muted)(`· ${entry.at}`))}`,
        }),
      );
      box.add(this.#body(entry.text, false));
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
      const counts = [
        `${a.toolCalls} ${a.toolCalls === 1 ? "action" : "actions"}`,
        ...(a.edits > 0 ? [`${a.edits} ${a.edits === 1 ? "edit" : "edits"}`] : []),
      ];
      const tree = new BoxRenderable(this.#renderer, { paddingLeft: 2, flexDirection: "column" });
      box.add(tree);
      tree.add(
        new TextRenderable(this.#renderer, {
          content: t`${fg(p.textSecondary)(counts.join(" · "))}${a.failed > 0 ? fg(p.danger)(` · ${a.failed} failed`) : ""} ${dim(fg(p.muted)(`· ${a.model}${routeNote} · ${a.duration}`))}`,
        }),
      );
      this.#toolTree(tree, a.tools, a.toolCalls, undefined);
    } else if (entry.live !== undefined) {
      const tree = new BoxRenderable(this.#renderer, { paddingLeft: 2, flexDirection: "column" });
      box.add(tree);
      this.#toolTree(tree, entry.live, entry.live.length, spinner);
    }
    if (live) {
      for (const note of this.#session?.steering ?? []) {
        box.add(
          new TextRenderable(this.#renderer, {
            content: t`  ${fg(note.status === "queued" ? p.warning : p.success)(note.status === "queued" ? "⧖ queued" : "✓ delivered")} ${dim(fg(p.muted)("▸"))} ${fg(p.text)(note.text)}`,
          }),
        );
      }
    }
    return box;
  }

  /**
   * The turn's calls as a tree: the last few in full, the rest folded into
   * one "+N completed" line, and a spinner on the call still running.
   */
  #toolTree(
    into: import("@opentui/core").BoxRenderable,
    tools: ReadonlyArray<TuiToolLine>,
    total: number,
    spinner: string | undefined,
  ): void {
    const { TextRenderable, t, fg, dim } = this.#tui;
    const p = this.#palette;
    const shown = tools.slice(-SHOWN_TOOL_LINES);
    const folded = total - shown.length;
    const width = Math.max(4, ...shown.map((tool) => tool.name.length));
    if (folded > 0) {
      into.add(
        new TextRenderable(this.#renderer, {
          content: t`${dim(fg(p.muted)("├"))} ${fg(p.success)("✓")} ${dim(fg(p.muted)(`+${folded} completed`))}`,
        }),
      );
    }
    // Every recorded call has finished; the one in flight is not known by
    // name, so the spinner gets its own last line rather than masking a result.
    shown.forEach((tool, index) => {
      const last = index === shown.length - 1 && spinner === undefined;
      const mark = tool.status === "ok" ? fg(p.success)("✓") : fg(p.danger)("✗");
      const name = fg(p.accent)(tool.name.padEnd(width));
      const summary = fg(tool.status === "ok" ? p.textSecondary : p.danger)(tool.summary);
      const tail = dim(
        fg(p.muted)(`  ${tool.duration}${tool.status === "ok" ? "" : ` · ${tool.status}`}`),
      );
      into.add(
        new TextRenderable(this.#renderer, {
          content: t`${dim(fg(p.muted)(last ? "└" : "├"))} ${mark} ${name} ${summary}${tail}`,
        }),
      );
      if (this.#verbose && tool.detail !== undefined) into.add(this.#detail(tool));
    });
    if (spinner !== undefined) {
      into.add(
        new TextRenderable(this.#renderer, {
          content: t`${dim(fg(p.muted)("└"))} ${fg(p.accent)(spinner)} ${fg(p.textSecondary)("working")}`,
        }),
      );
    }
  }

  /** An edit's diff or a command's output, indented under its line. */
  #detail(tool: TuiToolLine) {
    const { BoxRenderable, TextRenderable } = this.#tui;
    const p = this.#palette;
    const box = new BoxRenderable(this.#renderer, {
      paddingLeft: 4,
      marginBottom: 1,
      flexDirection: "column",
    });
    const detail = tool.detail ?? "";
    if (detail.startsWith("--- ")) {
      const { StyledText, fg, dim } = this.#tui;
      const lines = detail
        .split("\n")
        .filter((line) => !line.startsWith("---") && !line.startsWith("+++"));
      const chunks = lines.map((line, index) => {
        const eol = index < lines.length - 1 ? "\n" : "";
        if (line.startsWith("@@")) return dim(fg(p.muted)(`${line}${eol}`));
        if (line.startsWith("+")) return fg(p.success)(`${line}${eol}`);
        if (line.startsWith("-")) return fg(p.danger)(`${line}${eol}`);
        return fg(p.textSecondary)(`${line}${eol}`);
      });
      box.add(
        new TextRenderable(this.#renderer, { content: new StyledText(chunks), wrapMode: "none" }),
      );
      return box;
    }
    const lines = detail.split("\n");
    const shown = lines.slice(-12);
    box.add(
      new TextRenderable(this.#renderer, {
        content: `${lines.length > shown.length ? `… ${lines.length - shown.length} more lines\n` : ""}${shown.join("\n")}`,
        fg: tool.status === "ok" ? p.muted : p.danger,
        wrapMode: "word",
      }),
    );
    return box;
  }

  /**
   * A reply as markdown, with any reasoning the model wrote in a fenced
   * block or think tags folded into one dim line until Ctrl+R opens it.
   */
  #body(text: string, markdown = true) {
    const { BoxRenderable, TextRenderable, t, fg, dim } = this.#tui;
    const p = this.#palette;
    const box = new BoxRenderable(this.#renderer, { paddingLeft: 2, flexDirection: "column" });
    const reasoning: string[] = [];
    const visible = text
      .replace(
        REASONING_FENCE,
        (_match, fenced: string | undefined, tagged: string | undefined) => {
          const body = (fenced ?? tagged ?? "").trim();
          if (body.length > 0) reasoning.push(body);
          return "";
        },
      )
      .trim();
    if (reasoning.length > 0) {
      const lines = reasoning.join("\n").split("\n");
      box.add(
        new TextRenderable(this.#renderer, {
          content: this.#showReasoning
            ? t`${dim(fg(p.muted)("› reasoning"))}\n${dim(fg(p.textSecondary)(lines.join("\n")))}`
            : t`${dim(fg(p.muted)(`› reasoning · ${lines.length} ${lines.length === 1 ? "line" : "lines"} · Ctrl+R`))}`,
          wrapMode: "word",
        }),
      );
    }
    if (visible.length === 0) return box;
    box.add(
      new TextRenderable(this.#renderer, {
        content: markdown ? this.#markdown(visible) : visible,
        fg: p.text,
        wrapMode: "word",
      }),
    );
    return box;
  }

  /**
   * Just enough markdown for a reply to read well in a terminal: headings,
   * bold, inline code, bullets, and fenced code. Deterministic and cheap, so
   * a streaming reply restyles on every poll without a parser in the way.
   */
  #markdown(text: string): import("@opentui/core").StyledText {
    const { StyledText, fg, bold, dim } = this.#tui;
    const p = this.#palette;
    const chunks: import("@opentui/core").TextChunk[] = [];
    let inFence = false;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      const eol = index < lines.length - 1 ? "\n" : "";
      if (line.startsWith("```")) {
        inFence = !inFence;
        const info = line.slice(3).trim();
        chunks.push(dim(fg(p.muted)(`${inFence ? `┌ ${info}` : "└"}${eol}`)));
        return;
      }
      if (inFence) {
        chunks.push(fg(p.success)(`│ ${line}${eol}`));
        return;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading !== null) {
        chunks.push(fg(p.accent)(bold(`${heading[2] ?? ""}${eol}`)));
        return;
      }
      const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
      const quote = line.startsWith("> ");
      let rest = bullet !== null ? (bullet[2] ?? "") : quote ? line.slice(2) : line;
      if (bullet !== null) chunks.push(fg(p.textSecondary)(`${bullet[1] ?? ""}• `));
      if (quote) chunks.push(dim(fg(p.muted)("│ ")));
      const inline = /(\*\*[^*]+\*\*|`[^`]+`)/g;
      let cursor = 0;
      for (const match of rest.matchAll(inline)) {
        const at = match.index ?? 0;
        if (at > cursor) chunks.push(fg(quote ? p.muted : p.text)(rest.slice(cursor, at)));
        const token = match[0];
        if (token.startsWith("**")) chunks.push(fg(p.text)(bold(token.slice(2, -2))));
        else chunks.push(fg(p.success)(token.slice(1, -1)));
        cursor = at + token.length;
      }
      if (cursor < rest.length) chunks.push(fg(quote ? p.muted : p.text)(rest.slice(cursor)));
      rest = "";
      chunks.push(fg(p.text)(eol));
    });
    return new StyledText(chunks);
  }

  async #submit(): Promise<void> {
    const text = this.#composer.plainText.trim();
    this.#composer.setText("");
    if (this.#showHelp) {
      this.#showHelp = false;
      this.#draw();
      if (text === "?" || text.length === 0) return;
    } else if (text === "?" || text === "/help" || text === "/keys") {
      this.#showHelp = true;
      this.#draw();
      return;
    }
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
    this.#suggestions = undefined;
    if (text === "/copy") {
      const reply = [...(this.#thread?.turns ?? [])]
        .reverse()
        .find((turn) => turn.reply.length > 0);
      if (reply === undefined) this.#note = "Nothing to copy yet.";
      else await this.#copy(reply.reply);
      this.#draw();
      return;
    }
    if (text === "/threads") {
      this.#threads = await listAgentThreads(this.#input.session);
      this.#listing = this.#listing === "threads" ? undefined : "threads";
      this.#draw();
      return;
    }
    if (text.startsWith("/open")) {
      const index = Number(text.slice("/open".length).trim()) - 1;
      const target = this.#threads[index];
      if (target === undefined) {
        this.#note = "Pick a thread by number from /threads: /open 2";
        this.#draw();
        return;
      }
      await this.#switchThread(String(target.id));
      return;
    }
    if (text === "/model" || text.startsWith("/model ")) {
      const argument = text.slice("/model".length).trim();
      if (argument.length === 0) {
        this.#models = await listAgentModels(this.#input.session);
        this.#listing = this.#listing === "models" ? undefined : "models";
        this.#draw();
        return;
      }
      const choice = /^\d+$/.test(argument)
        ? this.#models[Number(argument) - 1]
        : this.#models.find(
            (model) =>
              model.modelId === argument ||
              model.displayName.toLowerCase() === argument.toLowerCase(),
          );
      if (choice === undefined || this.#thread === undefined) {
        this.#note = "Pick a model by number from /model: /model 2";
        this.#draw();
        return;
      }
      if (this.#thread.mode !== "chat") {
        this.#note =
          "Change a Work or Code thread's model from the app; the terminal switches Chat threads only.";
        this.#draw();
        return;
      }
      const changed = await changeAgentModel(
        this.#input.session,
        { thread: { id: this.#thread.id, version: this.#thread.version } } as never,
        choice,
      );
      this.#note = changed.kind === "refused" ? changed.message : `Now on ${choice.displayName}.`;
      this.#listing = undefined;
      await this.refresh();
      return;
    }
    this.#listing = undefined;
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
    const approval = this.#session?.approvals?.find((entry) => entry.status === "pending");
    if (approval !== undefined) {
      const lowered = text.toLowerCase();
      const decision =
        lowered === "y" || lowered === "yes"
          ? "approve"
          : lowered === "a" || lowered === "always"
            ? "approve-always"
            : lowered === "n" || lowered === "no"
              ? "deny"
              : undefined;
      if (decision === undefined) {
        this.#note = "Answer the approval first: y, a, or n.";
        this.#draw();
        return;
      }
      const result = await decideAgentApproval(
        this.#input.session,
        this.#threadId,
        String(approval.id),
        decision,
      );
      if (result.kind === "approval-refused") this.#note = result.message;
      await this.refresh();
      return;
    }
    const question = this.#session?.questions.find((entry) => entry.status === "pending");
    if (question !== undefined) {
      const picked = /^\d+$/.test(text) ? question.options[Number(text) - 1] : undefined;
      const result = await answerAgentQuestion(
        this.#input.session,
        this.#threadId,
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
    if (isAgentSnapshotRunning(this.#thread)) {
      // The lead is busy: the note lands at its next tool step, not as a turn.
      const steered = await steerAgent(this.#input.session, this.#threadId, {
        kind: "queue",
        text,
      });
      if (steered.kind === "refused") this.#note = steered.message;
      await this.refresh();
      return;
    }
    const resolved = await this.#resolveMentions(text);
    if (resolved.refused.length > 0) {
      this.#note = resolved.refused.join(" ");
      this.#draw();
      return;
    }
    const sent = await this.#port.send(resolved.prompt, {
      attachmentIds: resolved.attachmentIds,
      threadMentionIds: resolved.threadMentionIds,
    });
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
      this.#threadId,
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
      this.#threadId,
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
        const sent = await this.#port.send(suggestion.prompt);
        if (sent.kind === "refused") this.#note = sent.message;
      }
    } else if (created.threadId !== undefined) {
      this.#note = `Created ${created.mode} thread ${created.threadId} — octant agent --thread ${created.threadId}`;
    }
    await this.refresh();
  }
}

/** Files under the working directory for `@` completion, bounded and without the usual noise. */
async function scanFiles(root: string): Promise<ReadonlyArray<string>> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0 && found.length < MAX_SCANNED_FILES) {
    const directory = pending.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if (found.length < MAX_SCANNED_FILES) {
        found.push(relative(root, path));
      }
    }
  }
  return found.sort();
}

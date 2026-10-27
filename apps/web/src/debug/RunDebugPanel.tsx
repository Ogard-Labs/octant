import {
  CodeDebugClientFailure,
  type CodeDebugClient,
} from "@octant/client-runtime/code-debug-client";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts/code";
import type {
  CodeDebugAdapterSummary,
  CodeDebugApprovalScope,
  CodeDebugConfiguration,
  CodeDebugConfigurationsResult,
} from "@octant/contracts/code-debug";
import { Bug, Play, Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { codeEditorRevealKey, requestCodeEditorReveal } from "../code/codeEditorReveal";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import {
  codeDebugThreadKey,
  codeDebugWindowState,
  fileBreakpoints,
  useCodeDebugThreadState,
  type CodeDebugWindowState,
} from "./codeDebugWindowState";
import { DebugSessionView } from "./DebugSessionView";
import {
  adapterName,
  emptyDraft,
  LOCAL_ONLY_TEXT,
  readDraft,
  refusalText,
  sameConfiguration,
  startAnswerText,
  unmappableText,
  type ConfigurationDraft,
} from "./runDebugPanelModel";
import { useFocusWhenShown } from "./useFocusWhenShown";

type Listed = Extract<CodeDebugConfigurationsResult, { readonly status: "listed" }>;

type Listing =
  | { readonly kind: "loading" }
  | { readonly kind: "listed"; readonly result: Listed }
  | { readonly kind: "refused"; readonly text: string }
  | { readonly kind: "unreachable" };

type Editing =
  | { readonly kind: "none" }
  | { readonly kind: "draft"; readonly draft: ConfigurationDraft; readonly message?: string }
  | {
      readonly kind: "confirm";
      readonly configuration: CodeDebugConfiguration;
      /** Present for a launch file entry: what the file asked for that Octant will not do. */
      readonly unusedFields?: ReadonlyArray<string>;
      /** The draft a written configuration came from, so Back keeps the person's typing. */
      readonly draft?: ConfigurationDraft;
    };

export interface RunDebugPanelProps {
  readonly client: CodeDebugClient;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  /** Opens a checkout file as a Code file tab: the ordinary file-open path. */
  readonly onOpenFile?: (path: CodeRelativePath) => void;
  readonly store?: CodeDebugWindowState;
  readonly pollMs?: { readonly running?: number; readonly stopped?: number };
}

/**
 * The Run and debug panel for one Code thread. A person picks a confirmed
 * configuration, confirms one the repository's launch file proposes or one
 * they write, and starts it; a running session shows its toolbar, call
 * stack, variables, and console. The host decides every step and every
 * refusal (docs/design/language-services.md § Debugger addendum); the panel
 * shows what it answered and never decides itself.
 */
export function RunDebugPanel(props: RunDebugPanelProps) {
  const { client, threadId, checkoutId, onOpenFile } = props;
  const store = props.store ?? codeDebugWindowState;
  const key = codeDebugThreadKey(String(threadId), String(checkoutId));
  const thread = useCodeDebugThreadState(key, store);
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [localOnly, setLocalOnly] = useState(false);
  const [editing, setEditing] = useState<Editing>({ kind: "none" });
  /** The person came back to the list from a card or the form, so its heading takes focus. */
  const [returnedToList, setReturnedToList] = useState(false);
  const showList = useCallback(() => {
    setEditing({ kind: "none" });
    setReturnedToList(true);
  }, []);
  /** The last answer the person should read: a refusal warns, a confirmation informs. */
  const [notice, setNotice] = useState<{
    readonly tone: "neutral" | "warning";
    readonly text: string;
  }>();
  const warn = useCallback((text: string) => setNotice({ tone: "warning", text }), []);
  const [ended, setEnded] = useState<string>();
  const [pending, setPending] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Any request the host would not answer: a paired device, or no host at all. */
  const failed = useCallback(
    (error: unknown) => {
      if (!mounted.current) return;
      if (error instanceof CodeDebugClientFailure && error.kind === "local-only") {
        setLocalOnly(true);
      } else {
        warn(
          error instanceof CodeDebugClientFailure && error.kind === "rejected"
            ? error.message
            : "The host could not be reached.",
        );
      }
    },
    [warn],
  );

  const currentFile = thread.currentFile;
  const refresh = useCallback(async () => {
    setListing((current) => (current.kind === "listed" ? current : { kind: "loading" }));
    try {
      const result = await client.configurations({
        threadId,
        checkoutId,
        ...(currentFile === undefined ? {} : { currentFile }),
      });
      if (!mounted.current) return;
      setListing(
        result.status === "listed"
          ? { kind: "listed", result }
          : { kind: "refused", text: refusalText(result.reason) },
      );
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof CodeDebugClientFailure && error.kind === "local-only") {
        setLocalOnly(true);
        return;
      }
      setListing({ kind: "unreachable" });
    }
  }, [checkoutId, client, currentFile, threadId]);

  // Read again when the editor's current file changes, since a launch file's
  // `${file}` entries propose from it.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showLocation = useCallback(
    (path: CodeRelativePath, line: number) => {
      requestCodeEditorReveal(codeEditorRevealKey(String(threadId), String(checkoutId), path), {
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: 1,
      });
      onOpenFile?.(path);
    },
    [checkoutId, onOpenFile, threadId],
  );

  const start = useCallback(
    async (configuration: CodeDebugConfiguration) => {
      setPending("start");
      setNotice(undefined);
      setEnded(undefined);
      setReturnedToList(false);
      try {
        const answer = await client.start({
          threadId,
          checkoutId,
          configuration,
          breakpoints: fileBreakpoints(store.read(key)),
        });
        if (!mounted.current) return;
        if (answer.status === "started") {
          store.setSession(key, { sessionId: answer.sessionId, name: configuration.name });
          return;
        }
        warn(startAnswerText(answer));
      } catch (error) {
        failed(error);
      } finally {
        if (mounted.current) setPending(undefined);
      }
    },
    [checkoutId, client, failed, key, store, threadId],
  );

  const confirm = useCallback(
    async (configuration: CodeDebugConfiguration, scope: CodeDebugApprovalScope) => {
      setPending(scope);
      setNotice(undefined);
      try {
        const answer = await client.approve({ threadId, checkoutId, configuration, scope });
        if (!mounted.current) return;
        switch (answer.status) {
          case "approved":
            showList();
            setNotice({
              tone: "neutral",
              text:
                scope === "project"
                  ? `Confirmed “${configuration.name}” for this Project. Press Start to run it.`
                  : `Confirmed “${configuration.name}” for this checkout. Press Start to run it.`,
            });
            await refresh();
            return;
          case "refused":
            warn(refusalText(answer.reason));
            return;
          case "not-recorded":
            warn("Octant could not record your confirmation, so it is not in force.");
            return;
        }
      } catch (error) {
        failed(error);
      } finally {
        if (mounted.current) setPending(undefined);
      }
    },
    [checkoutId, client, failed, refresh, showList, threadId],
  );

  const session = thread.session;
  return (
    <section aria-label="Run and debug" className="run-debug">
      <header className="run-debug__toolbar">
        <Bug aria-hidden="true" size={16} />
        <h2 className="run-debug__title">Run and debug</h2>
        {session === undefined && !localOnly ? (
          <OctantIconButton
            disabled={listing.kind === "loading"}
            label="Refresh configurations"
            onClick={() => void refresh()}
            type="button"
          >
            <RotateCw aria-hidden="true" size={14} />
          </OctantIconButton>
        ) : null}
      </header>
      {localOnly ? (
        <div className="run-debug__body">
          <Refusal text={LOCAL_ONLY_TEXT} title="Debugging stays on this computer" />
        </div>
      ) : session !== undefined ? (
        <DebugSessionView
          checkoutId={checkoutId}
          client={client}
          key={String(session.sessionId)}
          name={session.name}
          onEnded={(text) => {
            store.setSession(key, undefined);
            if (text === LOCAL_ONLY_TEXT) setLocalOnly(true);
            else setEnded(text);
            void refresh();
          }}
          onShowLocation={showLocation}
          sessionId={session.sessionId}
          store={store}
          threadId={threadId}
          {...(props.pollMs === undefined ? {} : { pollMs: props.pollMs })}
        />
      ) : (
        <div className="run-debug__body">
          {ended === undefined ? null : <EndedLine text={ended} />}
          {notice === undefined ? null : (
            <OctantAlert tone={notice.tone}>{notice.text}</OctantAlert>
          )}
          {editing.kind === "none" ? (
            <Configurations
              focusHeading={returnedToList}
              listing={listing}
              onConfirm={(configuration, unusedFields) =>
                setEditing({ kind: "confirm", configuration, unusedFields })
              }
              onStart={(configuration) => void start(configuration)}
              onWrite={(adapter) => setEditing({ kind: "draft", draft: emptyDraft(adapter) })}
              pending={pending}
            />
          ) : editing.kind === "draft" ? (
            <ConfigurationForm
              adapters={listing.kind === "listed" ? listing.result.adapters : []}
              draft={editing.draft}
              {...(editing.message === undefined ? {} : { message: editing.message })}
              onCancel={showList}
              onReview={(draft) => {
                const reading = readDraft(draft);
                setEditing(
                  reading.status === "ready"
                    ? { kind: "confirm", configuration: reading.configuration, draft }
                    : { kind: "draft", draft, message: reading.message },
                );
              }}
            />
          ) : (
            <ConfirmationCard
              adapters={listing.kind === "listed" ? listing.result.adapters : []}
              configuration={editing.configuration}
              onBack={() =>
                editing.draft === undefined
                  ? showList()
                  : setEditing({ kind: "draft", draft: editing.draft })
              }
              onConfirm={(scope) => void confirm(editing.configuration, scope)}
              pending={pending}
              {...(editing.unusedFields === undefined
                ? {}
                : { unusedFields: editing.unusedFields })}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** Why the last session ended; it takes focus when Stop, which it replaces, had it. */
function EndedLine(props: { readonly text: string }) {
  const ref = useFocusWhenShown<HTMLParagraphElement>();
  return (
    <p className="run-debug__line" ref={ref} role="status" tabIndex={-1}>
      {props.text}
    </p>
  );
}

function Refusal(props: { readonly title: string; readonly text: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="run-debug__card">
      <h3 className="run-debug__card-title" id={headingId}>
        {props.title}
      </h3>
      <p className="run-debug__card-lede">{props.text}</p>
    </section>
  );
}

function Configurations(props: {
  readonly focusHeading: boolean;
  readonly listing: Listing;
  readonly pending: string | undefined;
  readonly onStart: (configuration: CodeDebugConfiguration) => void;
  readonly onConfirm: (
    configuration: CodeDebugConfiguration,
    unusedFields: ReadonlyArray<string>,
  ) => void;
  readonly onWrite: (adapter: string | undefined) => void;
}) {
  const confirmedId = useId();
  const proposedId = useId();
  const { listing } = props;
  const heading = useFocusWhenShown<HTMLHeadingElement>(
    props.focusHeading && listing.kind === "listed",
  );
  switch (listing.kind) {
    case "loading":
      return <p className="run-debug__empty">Reading this thread's debug configurations…</p>;
    case "unreachable":
      return <Refusal text="The host could not be reached." title="Run and debug is unavailable" />;
    case "refused":
      return <Refusal text={listing.text} title="This thread cannot debug a program" />;
    case "listed":
      break;
  }
  const { adapters, approved, launchFile } = listing.result;
  if (adapters.length === 0) {
    return (
      <Refusal
        text="No debug adapter is installed and switched on for Code. Add one in Settings › Skills & Extensions, review it, and switch it on."
        title="No debug adapter"
      />
    );
  }
  return (
    <>
      <section aria-labelledby={confirmedId} className="run-debug__section">
        <div className="run-debug__section-head">
          <h3 className="run-debug__heading" id={confirmedId} ref={heading} tabIndex={-1}>
            Configurations
          </h3>
          <OctantButton
            onClick={() =>
              props.onWrite(adapters[0] === undefined ? undefined : String(adapters[0].adapter))
            }
            size="xs"
            type="button"
            variant="ghost"
          >
            <Plus aria-hidden="true" size={14} />
            New
          </OctantButton>
        </div>
        {approved.length === 0 ? (
          <p className="run-debug__empty">
            No configuration is confirmed here yet. Confirm one from the repository below, or write
            a new one.
          </p>
        ) : (
          <ul className="run-debug__list">
            {approved.map((entry) => (
              <li className="run-debug__row" key={String(entry.configurationDigest)}>
                <div className="run-debug__row-text">
                  <span className="run-debug__row-name">{entry.configuration.name}</span>
                  <span className="run-debug__row-meta">
                    {adapterName(adapters, String(entry.configuration.adapter))} ·{" "}
                    {entry.configuration.program} ·{" "}
                    {entry.scope === "project" ? "this Project" : "this checkout"}
                  </span>
                </div>
                <OctantButton
                  aria-label={`Start ${entry.configuration.name}`}
                  disabled={props.pending !== undefined}
                  focusableWhenDisabled
                  onClick={() => props.onStart(entry.configuration)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  <Play aria-hidden="true" size={14} />
                  {props.pending === "start" ? "Starting…" : "Start"}
                </OctantButton>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby={proposedId} className="run-debug__section">
        <h3 className="run-debug__heading" id={proposedId}>
          From .vscode/launch.json
        </h3>
        {launchFile.status === "absent" ? (
          <p className="run-debug__empty">This checkout has no .vscode/launch.json.</p>
        ) : launchFile.status === "unreadable" ? (
          <p className="run-debug__empty">
            Octant could not read .vscode/launch.json: it is not valid JSON with comments, is too
            large, or lists no configurations.
          </p>
        ) : launchFile.proposals.length === 0 ? (
          <p className="run-debug__empty">.vscode/launch.json lists no configurations.</p>
        ) : (
          <ul className="run-debug__list">
            {launchFile.proposals.map((proposal, index) =>
              proposal.status === "proposed" ? (
                <li className="run-debug__row" key={`proposal-${index}`}>
                  <div className="run-debug__row-text">
                    <span className="run-debug__row-name">{proposal.configuration.name}</span>
                    <span className="run-debug__row-meta">
                      {adapterName(adapters, String(proposal.configuration.adapter))} ·{" "}
                      {proposal.configuration.program}
                      {approved.some((entry) =>
                        sameConfiguration(entry.configuration, proposal.configuration),
                      )
                        ? " · confirmed"
                        : ""}
                    </span>
                  </div>
                  <OctantButton
                    aria-label={`Review ${proposal.configuration.name}`}
                    onClick={() => props.onConfirm(proposal.configuration, proposal.unusedFields)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Review
                  </OctantButton>
                </li>
              ) : (
                <li className="run-debug__row run-debug__row--unmappable" key={`proposal-${index}`}>
                  <div className="run-debug__row-text">
                    <span className="run-debug__row-name">
                      {proposal.name ?? "An unnamed entry"}
                    </span>
                    <span className="run-debug__row-meta">{unmappableText(proposal.reason)}</span>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
        {launchFile.status === "read" && launchFile.truncated ? (
          <p className="run-debug__empty">Only the first 64 entries are shown.</p>
        ) : null}
        <p className="run-debug__hint">
          Octant reads this file only to propose configurations. Nothing in it runs until you
          confirm it.
        </p>
      </section>
    </>
  );
}

function ConfigurationForm(props: {
  readonly adapters: ReadonlyArray<CodeDebugAdapterSummary>;
  readonly draft: ConfigurationDraft;
  readonly message?: string;
  readonly onReview: (draft: ConfigurationDraft) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.draft);
  const ids = {
    name: useId(),
    program: useId(),
    args: useId(),
    cwd: useId(),
    env: useId(),
    stop: useId(),
    heading: useId(),
  };
  const nameField = useFocusWhenShown<HTMLInputElement>();
  const change = (patch: Partial<ConfigurationDraft>) => setDraft({ ...draft, ...patch });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onReview(draft);
  };
  return (
    <form aria-labelledby={ids.heading} className="run-debug__form" noValidate onSubmit={submit}>
      <h3 className="run-debug__heading" id={ids.heading}>
        New configuration
      </h3>
      <label className="run-debug__field" htmlFor={ids.name}>
        <span>Name</span>
        <OctantInput
          autoComplete="off"
          id={ids.name}
          onChange={(event) => change({ name: event.currentTarget.value })}
          ref={nameField}
          value={draft.name}
        />
      </label>
      <div className="run-debug__field">
        <span aria-hidden="true">Adapter</span>
        <OctantSelectField
          aria-label="Adapter"
          onValueChange={(adapter) => change({ adapter })}
          options={props.adapters.map((adapter) => ({
            id: String(adapter.adapter),
            label: adapter.displayName,
          }))}
          value={draft.adapter}
        />
      </div>
      <label className="run-debug__field" htmlFor={ids.program}>
        <span>Program, in the checkout</span>
        <OctantInput
          autoComplete="off"
          id={ids.program}
          onChange={(event) => change({ program: event.currentTarget.value })}
          placeholder="src/main.js"
          spellCheck={false}
          value={draft.program}
        />
      </label>
      <label className="run-debug__field" htmlFor={ids.args}>
        <span>Arguments, one per line</span>
        <OctantTextarea
          id={ids.args}
          onChange={(event) => change({ args: event.currentTarget.value })}
          rows={2}
          spellCheck={false}
          value={draft.args}
        />
      </label>
      <label className="run-debug__field" htmlFor={ids.cwd}>
        <span>Working folder, in the checkout</span>
        <OctantInput
          autoComplete="off"
          id={ids.cwd}
          onChange={(event) => change({ cwd: event.currentTarget.value })}
          placeholder="The checkout's root"
          spellCheck={false}
          value={draft.cwd}
        />
      </label>
      <label className="run-debug__field" htmlFor={ids.env}>
        <span>Environment, one NAME=value per line</span>
        <OctantTextarea
          id={ids.env}
          onChange={(event) => change({ env: event.currentTarget.value })}
          rows={2}
          spellCheck={false}
          value={draft.env}
        />
      </label>
      <label className="run-debug__check" htmlFor={ids.stop}>
        <OctantCheckbox
          checked={draft.stopOnEntry}
          id={ids.stop}
          onChange={(event) => change({ stopOnEntry: event.currentTarget.checked })}
        />
        <span>Pause at the program's first line</span>
      </label>
      {props.message === undefined ? null : (
        <OctantAlert tone="warning">{props.message}</OctantAlert>
      )}
      <div className="run-debug__card-actions">
        <OctantButton onClick={props.onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </OctantButton>
        <OctantButton size="sm" type="submit">
          Review
        </OctantButton>
      </div>
    </form>
  );
}

/**
 * What confirming allows, in full, before the person allows it: the card is
 * the shell-command approval for this configuration.
 */
function ConfirmationCard(props: {
  readonly adapters: ReadonlyArray<CodeDebugAdapterSummary>;
  readonly configuration: CodeDebugConfiguration;
  readonly unusedFields?: ReadonlyArray<string>;
  readonly pending: string | undefined;
  readonly onConfirm: (scope: CodeDebugApprovalScope) => void;
  readonly onBack: () => void;
}) {
  const headingId = useId();
  const heading = useFocusWhenShown<HTMLHeadingElement>();
  const { configuration } = props;
  return (
    <section aria-labelledby={headingId} className="run-debug__card run-debug__confirm">
      <h3 className="run-debug__card-title" id={headingId} ref={heading} tabIndex={-1}>
        Confirm “{configuration.name}”
      </h3>
      <p className="run-debug__card-lede">
        Confirming lets you start this program from this panel. It runs confined to this checkout,
        reaching only the hosts this thread's network rules allow, and never in Plan, for a paired
        device, or for an agent.
      </p>
      <dl className="run-debug__facts">
        <dt>Adapter</dt>
        <dd>{adapterName(props.adapters, String(configuration.adapter))}</dd>
        <dt>Program</dt>
        <dd>
          <code>{configuration.program}</code>
        </dd>
        <dt>Arguments</dt>
        <dd>
          {configuration.args.length === 0 ? (
            "None"
          ) : (
            <ul>
              {configuration.args.map((argument, index) => (
                <li key={index}>
                  <code>{argument}</code>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Working folder</dt>
        <dd>
          {configuration.cwd === undefined ? (
            "The checkout's root"
          ) : (
            <code>{configuration.cwd}</code>
          )}
        </dd>
        <dt>Environment</dt>
        <dd>
          {configuration.env.length === 0 ? (
            "None"
          ) : (
            <ul>
              {configuration.env.map((entry) => (
                <li key={String(entry.key)}>
                  <code>
                    {entry.key}={entry.value}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Pause at first line</dt>
        <dd>{configuration.stopOnEntry ? "Yes" : "No"}</dd>
        {props.unusedFields === undefined || props.unusedFields.length === 0 ? null : (
          <>
            <dt>Octant does not use</dt>
            <dd>
              <ul>
                {props.unusedFields.map((field) => (
                  <li key={field}>
                    <code>{field}</code>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      <p className="run-debug__hint">
        The arguments and environment values are kept in this Project's record of what you allowed
        to run. Editing the configuration, or any change to its adapter, asks again.
      </p>
      <div className="run-debug__card-actions">
        <OctantButton onClick={props.onBack} size="sm" type="button" variant="ghost">
          Back
        </OctantButton>
        <OctantButton
          disabled={props.pending !== undefined}
          focusableWhenDisabled
          onClick={() => props.onConfirm("checkout")}
          size="sm"
          type="button"
          variant="secondary"
        >
          Allow in this checkout
        </OctantButton>
        <OctantButton
          disabled={props.pending !== undefined}
          focusableWhenDisabled
          onClick={() => props.onConfirm("project")}
          size="sm"
          type="button"
          variant="secondary"
        >
          Allow in this Project
        </OctantButton>
      </div>
    </section>
  );
}

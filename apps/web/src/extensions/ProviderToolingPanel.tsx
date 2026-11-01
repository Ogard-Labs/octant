import type { ProviderToolingClient } from "@octant/client-runtime/provider-tooling-client";
import type {
  ProviderToolingEntry,
  ProviderToolingListing,
  ProviderToolingPlan,
  ProviderToolingRefusal,
  ProviderToolingRequest,
  ProviderToolingSection,
  ProviderToolingSectionKind,
} from "@octant/contracts";
import { PROVIDER_TOOLING_NOTES } from "@octant/domain";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { SettingGroup, SettingRow, SettingsSection, SettingsState } from "../settings/primitives";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

export interface ProviderToolingAccount {
  readonly id: string;
  readonly displayName: string;
  readonly driverKind: "claude" | "codex";
  /** The account's "Run as itself" switch, when the provider list says. */
  readonly nativeSetup?: boolean;
}

export interface ProviderToolingPanelProps {
  readonly client: Pick<ProviderToolingClient, "list" | "plan" | "apply" | "cancel">;
  /** The Claude Code and Codex accounts on this host. */
  readonly accounts: ReadonlyArray<ProviderToolingAccount>;
  /** Whether this is the Octant window on the host; a paired device can only read this page. */
  readonly localHost: boolean;
  /** Opens the account's "Run as itself" switch in Settings › Providers. */
  readonly onOpenRunAsItself: (accountId: string) => void;
}

const PRODUCT = { claude: "Claude Code", codex: "Codex" } as const;
const SECTION_TITLE: Readonly<Record<ProviderToolingSectionKind, string>> = {
  "mcp-servers": "MCP servers",
  plugins: "Plugins",
  marketplaces: "Plugin marketplaces",
};

type AddKind = "mcp" | "marketplace" | "plugin";
type Step =
  | { readonly kind: "idle" }
  | { readonly kind: "planning" }
  | { readonly kind: "confirm"; readonly plan: ProviderToolingPlan }
  | { readonly kind: "running"; readonly plan: ProviderToolingPlan }
  | {
      readonly kind: "done";
      readonly ok: boolean;
      readonly message: string;
      readonly output: string;
    };
type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "ready"; readonly listing: ProviderToolingListing };

/**
 * Adds and removes MCP servers and plugins on a Claude Code or Codex account
 * by running that provider's own commands against the account's folder.
 * Nothing runs until the person has read the exact command and chosen "Run
 * this command". A secret never appears here after it is typed: the host
 * holds it and the command line shows a placeholder. Octant does not edit the
 * provider's files, and what is added reaches Octant threads only while the
 * account runs as itself.
 */
export function ProviderToolingPanel(props: ProviderToolingPanelProps) {
  const { client } = props;
  const ids = useId();
  const [accountId, setAccountId] = useState(props.accounts[0]?.id ?? "");
  const account = props.accounts.find((candidate) => candidate.id === accountId);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [addKind, setAddKind] = useState<AddKind>("mcp");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [refusal, setRefusal] = useState<ProviderToolingRefusal>();
  const generation = useRef(0);

  useEffect(() => {
    if (account === undefined && props.accounts[0] !== undefined) {
      setAccountId(props.accounts[0].id);
    }
  }, [account, props.accounts]);

  const refresh = useCallback(async () => {
    if (account === undefined || !props.localHost) return;
    const current = ++generation.current;
    setLoaded({ kind: "loading" });
    try {
      const result = await client.list(account.id as never);
      if (current !== generation.current) return;
      setLoaded(
        result.status === "listed"
          ? { kind: "ready", listing: result }
          : { kind: "unavailable", message: result.message },
      );
    } catch {
      if (current !== generation.current) return;
      setLoaded({
        kind: "unavailable",
        message: "Octant could not reach the host. Close Settings and open it again to retry.",
      });
    }
  }, [account, client, props.localHost]);

  useEffect(() => {
    setStep({ kind: "idle" });
    setRefusal(undefined);
    void refresh();
  }, [refresh]);

  const plan = useCallback(
    async (request: ProviderToolingRequest) => {
      if (account === undefined) return;
      setRefusal(undefined);
      setStep({ kind: "planning" });
      try {
        const result = await client.plan(account.id as never, request);
        if (result.status === "planned") setStep({ kind: "confirm", plan: result });
        else {
          setStep({ kind: "idle" });
          setRefusal(result);
        }
      } catch {
        setStep({ kind: "idle" });
        setRefusal({
          status: "refused",
          reason: "unavailable",
          message: "Octant could not reach the host. Nothing was run.",
        });
      }
    },
    [account, client],
  );

  const run = useCallback(
    async (planned: ProviderToolingPlan) => {
      setStep({ kind: "running", plan: planned });
      try {
        const result = await client.apply({ planId: planned.planId, digest: planned.digest });
        if (result.status === "applied") {
          setStep({
            kind: "done",
            ok: true,
            message: "Done. The provider reported:",
            output: result.output,
          });
          void refresh();
        } else if (result.status === "failed") {
          setStep({ kind: "done", ok: false, message: result.message, output: result.output });
          void refresh();
        } else {
          setStep({ kind: "done", ok: false, message: result.message, output: "" });
        }
      } catch {
        setStep({
          kind: "done",
          ok: false,
          message: "Octant could not reach the host. Check the list before trying again.",
          output: "",
        });
      }
    },
    [client, refresh],
  );

  if (!props.localHost) {
    return (
      <SettingsSection
        description="Adding tools to Claude Code and Codex changes the files those programs keep on this computer, so it is done from the Octant window on this computer."
        title="Claude and Codex"
      >
        <SettingsState kind="empty">
          Open Octant on this computer to add or remove tools for Claude Code and Codex.
        </SettingsState>
      </SettingsSection>
    );
  }
  if (props.accounts.length === 0 || account === undefined) {
    return (
      <SettingsSection
        description="Add MCP servers and plugins to a Claude Code or Codex account through that program's own commands."
        title="Claude and Codex"
      >
        <SettingsState kind="empty">
          No Claude Code or Codex account is set up yet. Add one in Settings › Providers first.
        </SettingsState>
      </SettingsSection>
    );
  }

  const product = PRODUCT[account.driverKind];
  const listing = loaded.kind === "ready" ? loaded.listing : undefined;
  const runsAsItself = listing?.runsAsItself ?? account.nativeSetup === true;
  const sections = listing?.sections ?? [];
  const sectionOf = (kind: ProviderToolingSectionKind) =>
    sections.find((section) => section.kind === kind);
  const busy = step.kind === "planning" || step.kind === "running";

  return (
    <>
      <SettingsSection
        description="Add MCP servers and plugins to an account through the program's own commands. Octant shows the exact command first and runs it only when you say so. It never edits Claude's or Codex's files itself."
        title="Claude and Codex"
      >
        <SettingRow
          description="The account whose own folder these commands change."
          htmlFor={`${ids}-account`}
          label="Account"
          scope="host"
          settingId="provider-tooling-account"
        >
          <OctantSelectField
            aria-label="Account"
            id={`${ids}-account`}
            onValueChange={setAccountId}
            options={props.accounts.map((candidate) => ({
              id: candidate.id,
              label: `${candidate.displayName} (${PRODUCT[candidate.driverKind]})`,
            }))}
            value={account.id}
          />
        </SettingRow>
        <OctantAlert
          action={
            <OctantButton
              onClick={() => props.onOpenRunAsItself(account.id)}
              size="sm"
              type="button"
              variant="outline"
            >
              Open the Run as itself setting
            </OctantButton>
          }
          tone={runsAsItself ? "neutral" : "warning"}
        >
          {runsAsItself
            ? `Run ${product} as itself is on for ${account.displayName}, so Octant threads on this account load what you add here.`
            : `A tool added here reaches Octant threads only when ${account.displayName} runs as itself. That switch is off, so ${product} will have it in its own app but Octant threads will not load it.`}
        </OctantAlert>
        {PROVIDER_TOOLING_NOTES[account.driverKind].map((note) => (
          <p className="endpoint-flow__hint" key={note}>
            {note}
          </p>
        ))}
        {listing?.accountDirectory === undefined ? null : (
          <p className="endpoint-flow__hint">Folder: {listing.accountDirectory}</p>
        )}
      </SettingsSection>

      <ConfiguredSection
        busy={busy}
        loaded={loaded}
        onRefresh={() => void refresh()}
        onRemove={(request) => void plan(request)}
        product={product}
      />

      <SettingsSection
        description={`Each form builds one ${product} command. You review it before it runs.`}
        title="Add to this account"
      >
        {step.kind === "confirm" || step.kind === "running" ? (
          <ConfirmCommand
            onCancel={() => {
              // Drops the plan on the host too, which deletes any secret held for it.
              void props.client.cancel(step.plan.planId).catch(() => undefined);
              setStep({ kind: "idle" });
            }}
            onRun={() => void run(step.plan)}
            plan={step.plan}
            running={step.kind === "running"}
          />
        ) : (
          <>
            <div className="endpoint-flow__field">
              <span id={`${ids}-kind`}>What to add</span>
              <OctantToggleGroup<AddKind>
                aria-labelledby={`${ids}-kind`}
                onValueChange={(next) => {
                  const selected = next[0];
                  if (selected !== undefined) {
                    setAddKind(selected);
                    setRefusal(undefined);
                  }
                }}
                value={[addKind]}
              >
                <OctantToggleGroupItem value="mcp">MCP server</OctantToggleGroupItem>
                <OctantToggleGroupItem value="marketplace">
                  Plugin marketplace
                </OctantToggleGroupItem>
                <OctantToggleGroupItem value="plugin">Plugin</OctantToggleGroupItem>
              </OctantToggleGroup>
            </div>
            {addKind === "mcp" ? (
              <AddMcpForm
                busy={busy}
                driverKind={account.driverKind}
                key={`mcp-${account.id}`}
                onReview={(request) => void plan(request)}
              />
            ) : addKind === "marketplace" ? (
              <NoCommandOr
                key={`marketplace-${account.id}`}
                product={product}
                section={sectionOf("marketplaces")}
                what="plugin marketplaces"
              >
                <AddMarketplaceForm busy={busy} onReview={(request) => void plan(request)} />
              </NoCommandOr>
            ) : (
              <NoCommandOr
                key={`plugin-${account.id}`}
                product={product}
                section={sectionOf("plugins")}
                what="plugins"
              >
                <InstallPluginForm busy={busy} onReview={(request) => void plan(request)} />
              </NoCommandOr>
            )}
          </>
        )}
        {step.kind === "planning" ? (
          <SettingsState kind="loading">Checking the command…</SettingsState>
        ) : null}
        {refusal === undefined ? null : <OctantAlert tone="warning">{refusal.message}</OctantAlert>}
        {step.kind === "done" ? (
          <OctantAlert
            action={
              <OctantButton
                onClick={() => setStep({ kind: "idle" })}
                size="sm"
                type="button"
                variant="ghost"
              >
                Dismiss
              </OctantButton>
            }
            tone={step.ok ? "success" : "danger"}
          >
            {step.message}
            {step.output.trim() === "" ? null : (
              <pre className="provider-tooling__output">{step.output}</pre>
            )}
          </OctantAlert>
        ) : null}
      </SettingsSection>
    </>
  );
}

function ConfiguredSection(props: {
  readonly loaded: Loaded;
  readonly product: string;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly onRemove: (request: ProviderToolingRequest) => void;
}) {
  const { loaded } = props;
  return (
    <SettingsSection
      actions={
        <OctantButton
          disabled={loaded.kind === "loading" || props.busy}
          onClick={props.onRefresh}
          size="sm"
          type="button"
          variant="ghost"
        >
          Refresh
        </OctantButton>
      }
      description={`What ${props.product} reports for this account. Listing asks ${props.product} to check each server, which can take a few seconds.`}
      title="Already configured"
    >
      {loaded.kind === "loading" ? (
        <SettingsState kind="loading">Asking {props.product}…</SettingsState>
      ) : loaded.kind === "unavailable" ? (
        <SettingsState kind="error">{loaded.message}</SettingsState>
      ) : (
        loaded.listing.sections.map((section) => (
          <SectionList
            busy={props.busy}
            key={section.kind}
            onRemove={props.onRemove}
            product={props.product}
            section={section}
          />
        ))
      )}
    </SettingsSection>
  );
}

function SectionList(props: {
  readonly section: ProviderToolingSection;
  readonly product: string;
  readonly busy: boolean;
  readonly onRemove: (request: ProviderToolingRequest) => void;
}) {
  const { section } = props;
  return (
    <SettingGroup label={SECTION_TITLE[section.kind]}>
      {section.status === "no-command" ? (
        <SettingsState kind="empty">
          This version of {props.product} has no command for{" "}
          {SECTION_TITLE[section.kind].toLowerCase()}, so Octant offers nothing here and does not
          write its files.
        </SettingsState>
      ) : section.status === "failed" ? (
        <SettingsState kind="error">
          {section.message ?? `${props.product} could not list this.`}
          {section.lines.length === 0 ? null : (
            <pre className="provider-tooling__output">{section.lines.join("\n")}</pre>
          )}
        </SettingsState>
      ) : section.status === "unreadable" ? (
        <SettingsState kind="empty">
          Octant could not read how {props.product} answered, so it shows the answer as it came:
          <pre className="provider-tooling__output">{section.lines.join("\n")}</pre>
        </SettingsState>
      ) : section.entries.length === 0 ? (
        <SettingsState kind="empty">None added yet.</SettingsState>
      ) : (
        section.entries.map((entry, index) => (
          <EntryRow
            busy={props.busy}
            entry={entry}
            key={`${entry.name}-${entry.marketplace ?? ""}-${index}`}
            kind={section.kind}
            onRemove={props.onRemove}
          />
        ))
      )}
    </SettingGroup>
  );
}

function EntryRow(props: {
  readonly entry: ProviderToolingEntry;
  readonly kind: ProviderToolingSectionKind;
  readonly busy: boolean;
  readonly onRemove: (request: ProviderToolingRequest) => void;
}) {
  const { entry } = props;
  const detail = [
    entry.marketplace === undefined ? undefined : `From ${entry.marketplace}`,
    entry.detail,
    entry.scope === undefined ? undefined : `Scope: ${entry.scope}`,
    entry.enabled === false ? "Switched off" : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  const request: ProviderToolingRequest =
    props.kind === "mcp-servers"
      ? { kind: "mcp-remove", name: entry.name }
      : props.kind === "marketplaces"
        ? { kind: "marketplace-remove", name: entry.name }
        : {
            kind: "plugin-uninstall",
            plugin: entry.name,
            ...(entry.marketplace === undefined ? {} : { marketplace: entry.marketplace }),
          };
  return (
    <SettingRow
      description={detail === "" ? undefined : detail}
      label={entry.name}
      scope="host"
      settingId={`provider-tooling-${props.kind}`}
    >
      <OctantButton
        aria-label={`Remove ${entry.name}`}
        disabled={props.busy}
        onClick={() => props.onRemove(request)}
        size="sm"
        type="button"
        variant="secondary"
      >
        Remove
      </OctantButton>
    </SettingRow>
  );
}

function NoCommandOr(props: {
  readonly section: ProviderToolingSection | undefined;
  readonly product: string;
  readonly what: string;
  readonly children: ReactNode;
}) {
  if (props.section?.status === "no-command") {
    return (
      <SettingsState kind="empty">
        This version of {props.product} has no command for {props.what}, so Octant offers nothing
        here and does not write its files.
      </SettingsState>
    );
  }
  return <>{props.children}</>;
}

function ConfirmCommand(props: {
  readonly plan: ProviderToolingPlan;
  readonly running: boolean;
  readonly onRun: () => void;
  readonly onCancel: () => void;
}) {
  const { plan } = props;
  return (
    <div aria-label="Review the command" className="endpoint-flow__form" role="group">
      <p className="endpoint-flow__detail">{plan.summary}</p>
      <div className="extensions-settings__instruction-review">
        <pre aria-label="The command" className="provider-tooling__command">
          {plan.commandLine}
        </pre>
      </div>
      <ul className="endpoint-flow__hint">
        {plan.effects.map((effect) => (
          <li key={effect}>{effect}</li>
        ))}
        {plan.usesSecret ? (
          <li>
            The secret is held by Octant and given to the command through its environment. It is not
            in the command line above.
          </li>
        ) : null}
        {plan.runsAsItself ? null : (
          <li>Octant threads on this account will not load it until the account runs as itself.</li>
        )}
      </ul>
      <div className="endpoint-flow__actions">
        <OctantButton
          disabled={props.running}
          onClick={props.onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </OctantButton>
        <OctantButton disabled={props.running} onClick={props.onRun} size="sm" type="button">
          {props.running ? "Running…" : "Run this command"}
        </OctantButton>
      </div>
    </div>
  );
}

function splitLines(value: string): ReadonlyArray<string> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function AddMcpForm(props: {
  readonly driverKind: "claude" | "codex";
  readonly busy: boolean;
  readonly onReview: (request: ProviderToolingRequest) => void;
}) {
  const ids = useId();
  const [how, setHow] = useState<"command" | "address">("command");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [settings, setSettings] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tokenVariable, setTokenVariable] = useState("");
  const [problem, setProblem] = useState<string>();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName === "") return setProblem("Give the server a name.");
    if (how === "command") {
      if (command.trim() === "") return setProblem("Enter the command that starts it.");
      const env: Array<{ name: string; value: string }> = [];
      for (const line of splitLines(settings)) {
        const equals = line.indexOf("=");
        if (equals <= 0) return setProblem("Write each setting as NAME=value, one per line.");
        env.push({ name: line.slice(0, equals).trim(), value: line.slice(equals + 1) });
      }
      setProblem(undefined);
      return props.onReview({
        kind: "mcp-add-stdio",
        name: trimmedName,
        command: command.trim(),
        args: splitLines(args),
        env,
      });
    }
    if (url.trim() === "") return setProblem("Enter its address.");
    setProblem(undefined);
    props.onReview({
      kind: "mcp-add-url",
      name: trimmedName,
      url: url.trim(),
      ...(props.driverKind === "claude"
        ? {
            transport,
            ...(clientId.trim() === "" ? {} : { oauthClientId: clientId.trim() }),
            ...(clientSecret === "" ? {} : { oauthClientSecret: clientSecret }),
          }
        : tokenVariable.trim() === ""
          ? {}
          : { bearerTokenEnvVar: tokenVariable.trim() }),
    });
    // The host holds the secret from here; the page does not keep it.
    setClientSecret("");
  };

  return (
    <form
      aria-label="Add an MCP server"
      className="endpoint-flow__form"
      noValidate
      onSubmit={submit}
    >
      <div className="endpoint-flow__field">
        <label htmlFor={`${ids}-name`}>Name</label>
        <OctantInput
          className="settings-view__text-input"
          id={`${ids}-name`}
          onChange={(event) => setName(event.currentTarget.value)}
          spellCheck={false}
          value={name}
        />
      </div>
      <div className="endpoint-flow__field">
        <span id={`${ids}-how`}>How it is reached</span>
        <OctantToggleGroup<"command" | "address">
          aria-labelledby={`${ids}-how`}
          onValueChange={(next) => {
            const selected = next[0];
            if (selected !== undefined) setHow(selected);
          }}
          value={[how]}
        >
          <OctantToggleGroupItem value="command">Command</OctantToggleGroupItem>
          <OctantToggleGroupItem value="address">Address</OctantToggleGroupItem>
        </OctantToggleGroup>
      </div>
      {how === "command" ? (
        <>
          <div className="endpoint-flow__field">
            <label htmlFor={`${ids}-command`}>Command</label>
            <OctantInput
              className="settings-view__text-input"
              id={`${ids}-command`}
              onChange={(event) => setCommand(event.currentTarget.value)}
              placeholder="npx"
              spellCheck={false}
              value={command}
            />
          </div>
          <div className="endpoint-flow__field">
            <label htmlFor={`${ids}-args`}>Arguments</label>
            <OctantTextarea
              aria-describedby={`${ids}-args-hint`}
              className="settings-view__text-input"
              id={`${ids}-args`}
              onChange={(event) => setArgs(event.currentTarget.value)}
              rows={3}
              spellCheck={false}
              value={args}
            />
            <span className="endpoint-flow__hint" id={`${ids}-args-hint`}>
              One per line. Each line is passed as one argument, exactly as written.
            </span>
          </div>
          <div className="endpoint-flow__field">
            <label htmlFor={`${ids}-settings`}>Plain settings</label>
            <OctantTextarea
              aria-describedby={`${ids}-settings-hint`}
              className="settings-view__text-input"
              id={`${ids}-settings`}
              onChange={(event) => setSettings(event.currentTarget.value)}
              rows={2}
              spellCheck={false}
              value={settings}
            />
            <span className="endpoint-flow__hint" id={`${ids}-settings-hint`}>
              NAME=value, one per line. Not for keys: the command line shows them, and Octant
              refuses a value that looks like one.
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="endpoint-flow__field">
            <label htmlFor={`${ids}-url`}>Address</label>
            <OctantInput
              className="settings-view__text-input"
              id={`${ids}-url`}
              inputMode="url"
              onChange={(event) => setUrl(event.currentTarget.value)}
              placeholder="https://host.example/mcp"
              spellCheck={false}
              value={url}
            />
          </div>
          {props.driverKind === "claude" ? (
            <>
              <div className="endpoint-flow__field">
                <span id={`${ids}-transport`}>Protocol</span>
                <OctantToggleGroup<"http" | "sse">
                  aria-labelledby={`${ids}-transport`}
                  onValueChange={(next) => {
                    const selected = next[0];
                    if (selected !== undefined) setTransport(selected);
                  }}
                  value={[transport]}
                >
                  <OctantToggleGroupItem value="http">HTTP</OctantToggleGroupItem>
                  <OctantToggleGroupItem value="sse">SSE</OctantToggleGroupItem>
                </OctantToggleGroup>
              </div>
              <div className="endpoint-flow__field">
                <label htmlFor={`${ids}-client-id`}>OAuth client ID (optional)</label>
                <OctantInput
                  className="settings-view__text-input"
                  id={`${ids}-client-id`}
                  onChange={(event) => setClientId(event.currentTarget.value)}
                  spellCheck={false}
                  value={clientId}
                />
              </div>
              <div className="endpoint-flow__field">
                <label htmlFor={`${ids}-client-secret`}>OAuth client secret (optional)</label>
                <OctantInput
                  aria-describedby={`${ids}-client-secret-hint`}
                  autoComplete="off"
                  className="settings-view__text-input"
                  id={`${ids}-client-secret`}
                  onChange={(event) => setClientSecret(event.currentTarget.value)}
                  type="password"
                  value={clientSecret}
                />
                <span className="endpoint-flow__hint" id={`${ids}-client-secret-hint`}>
                  Held by Octant until you run the command, then given to Claude Code through its
                  environment. It never appears in the command shown or in the record Octant keeps.
                </span>
              </div>
            </>
          ) : (
            <div className="endpoint-flow__field">
              <label htmlFor={`${ids}-token-variable`}>Bearer token variable (optional)</label>
              <OctantInput
                aria-describedby={`${ids}-token-variable-hint`}
                className="settings-view__text-input"
                id={`${ids}-token-variable`}
                onChange={(event) => setTokenVariable(event.currentTarget.value)}
                placeholder="EXAMPLE_TOKEN"
                spellCheck={false}
                value={tokenVariable}
              />
              <span className="endpoint-flow__hint" id={`${ids}-token-variable-hint`}>
                The name of the environment variable Codex reads the token from. Enter the name,
                never the token.
              </span>
            </div>
          )}
        </>
      )}
      {problem === undefined ? null : <OctantAlert tone="warning">{problem}</OctantAlert>}
      <div className="endpoint-flow__actions">
        <OctantButton disabled={props.busy} size="sm" type="submit">
          Review command
        </OctantButton>
      </div>
    </form>
  );
}

function AddMarketplaceForm(props: {
  readonly busy: boolean;
  readonly onReview: (request: ProviderToolingRequest) => void;
}) {
  const ids = useId();
  const [source, setSource] = useState("");
  const [problem, setProblem] = useState<string>();
  return (
    <form
      aria-label="Add a plugin marketplace"
      className="endpoint-flow__form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (source.trim() === "") return setProblem("Enter where the marketplace lives.");
        setProblem(undefined);
        props.onReview({ kind: "marketplace-add", source: source.trim() });
      }}
    >
      <div className="endpoint-flow__field">
        <label htmlFor={`${ids}-source`}>Marketplace</label>
        <OctantInput
          aria-describedby={`${ids}-source-hint`}
          className="settings-view__text-input"
          id={`${ids}-source`}
          onChange={(event) => setSource(event.currentTarget.value)}
          placeholder="owner/repo"
          spellCheck={false}
          value={source}
        />
        <span className="endpoint-flow__hint" id={`${ids}-source-hint`}>
          A GitHub repository as owner/repo, an https:// address, or a folder path that starts with
          /. Adding it installs no plugin.
        </span>
      </div>
      {problem === undefined ? null : <OctantAlert tone="warning">{problem}</OctantAlert>}
      <div className="endpoint-flow__actions">
        <OctantButton disabled={props.busy} size="sm" type="submit">
          Review command
        </OctantButton>
      </div>
    </form>
  );
}

function InstallPluginForm(props: {
  readonly busy: boolean;
  readonly onReview: (request: ProviderToolingRequest) => void;
}) {
  const ids = useId();
  const [plugin, setPlugin] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [problem, setProblem] = useState<string>();
  return (
    <form
      aria-label="Install a plugin"
      className="endpoint-flow__form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (plugin.trim() === "") return setProblem("Enter the plugin's name.");
        setProblem(undefined);
        props.onReview({
          kind: "plugin-install",
          plugin: plugin.trim(),
          ...(marketplace.trim() === "" ? {} : { marketplace: marketplace.trim() }),
        });
      }}
    >
      <div className="endpoint-flow__field">
        <label htmlFor={`${ids}-plugin`}>Plugin</label>
        <OctantInput
          className="settings-view__text-input"
          id={`${ids}-plugin`}
          onChange={(event) => setPlugin(event.currentTarget.value)}
          spellCheck={false}
          value={plugin}
        />
      </div>
      <div className="endpoint-flow__field">
        <label htmlFor={`${ids}-marketplace`}>Marketplace</label>
        <OctantInput
          aria-describedby={`${ids}-marketplace-hint`}
          className="settings-view__text-input"
          id={`${ids}-marketplace`}
          onChange={(event) => setMarketplace(event.currentTarget.value)}
          spellCheck={false}
          value={marketplace}
        />
        <span className="endpoint-flow__hint" id={`${ids}-marketplace-hint`}>
          The marketplace's name as listed above. Add the marketplace first if it is not there.
        </span>
      </div>
      {problem === undefined ? null : <OctantAlert tone="warning">{problem}</OctantAlert>}
      <div className="endpoint-flow__actions">
        <OctantButton disabled={props.busy} size="sm" type="submit">
          Review command
        </OctantButton>
      </div>
    </form>
  );
}

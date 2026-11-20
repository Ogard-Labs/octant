import type { BlockedToolsClient } from "@octant/client-runtime/blocked-tools-client";
import {
  decodeBlockedToolsCommand,
  type BlockableToolProvider,
  type BlockedToolsCommand,
  type BlockedToolsSettings as BlockedToolsSnapshot,
} from "@octant/contracts/blocked-tools";
import { useCallback, useEffect, useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantFieldError } from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { SettingRow, SettingsCompactRow, SettingsSection, SettingsState } from "./primitives";

export interface BlockedToolsSettingsProps {
  /** Absent where the host publishes no list, such as a paired device. */
  readonly client: BlockedToolsClient | undefined;
  readonly focusedSetting?: string | undefined;
}

const PROVIDERS = [
  "claude",
  "codex",
  "opencode",
  "pi",
] as const satisfies ReadonlyArray<BlockableToolProvider>;

const PRODUCT: Readonly<Record<BlockableToolProvider, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};

/** An example of each provider's own tool names, shown as the field's placeholder. */
const EXAMPLE: Readonly<Record<BlockableToolProvider, string>> = {
  claude: "WebFetch",
  codex: "shell",
  opencode: "webfetch",
  pi: "bash",
};

/** What the section says the list does, in the person's words. */
export const BLOCKED_TOOLS_FACT =
  "Tools you block here are kept from that provider at every level, with or without Strict. Octant passes them to the provider's own deny setting where it has one, and refuses them itself otherwise.";

/**
 * Settings › Permissions › Blocked tools. Empty until the person adds a tool;
 * each block and unblock is journaled. A provider is offered only where
 * Octant can keep a named tool from its runtime, and a name that provider
 * cannot block is refused when it is added.
 */
export function BlockedToolsSettings(props: BlockedToolsSettingsProps) {
  const { client } = props;
  const ids = useId();
  const [settings, setSettings] = useState<BlockedToolsSnapshot>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [provider, setProvider] = useState<BlockableToolProvider>("claude");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const load = useCallback(async () => {
    if (client === undefined) return;
    try {
      setSettings(await client.settings());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(
    candidate: BlockableToolProvider,
    tool: string,
    blocked: boolean,
  ): Promise<boolean> {
    if (client === undefined || settings === undefined) return false;
    let command: BlockedToolsCommand;
    try {
      command = decodeBlockedToolsCommand({
        kind: "set-provider-tool-blocked",
        provider: candidate,
        tool,
        blocked,
        expectedVersion: settings.version,
      });
    } catch {
      setProblem(
        "Use the provider's own tool name, or server__tool for a tool of one of its MCP servers.",
      );
      return false;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await client.change(command);
      if (result.kind === "blocked-tools-settings") {
        setSettings(result.settings);
        return true;
      }
      setProblem(result.message);
      if (result.reason === "stale-version") await load();
      return false;
    } catch {
      setProblem("Blocked tools could not be changed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const body =
    client === undefined ? (
      <SettingsState kind="empty">Blocked tools are set on the host machine.</SettingsState>
    ) : settings === undefined ? (
      <SettingsState kind={loadFailed ? "error" : "loading"}>
        {loadFailed ? "Blocked tools could not be read from this host." : "Reading blocked tools…"}
      </SettingsState>
    ) : (
      <>
        <div className="setgroup">
          {settings.tools.length === 0 ? (
            <SettingsState kind="empty">
              No tool is blocked. Each provider runs its own.
            </SettingsState>
          ) : (
            settings.tools.map((entry, index) => (
              <SettingsCompactRow
                focused={props.focusedSetting === "blocked-tools" && index === 0}
                key={`${entry.provider}:${entry.tool}`}
                label={entry.tool}
                labelWraps
                meta={`${PRODUCT[entry.provider]} · Blocked`}
                settingId="blocked-tools"
              >
                <OctantButton
                  aria-label={`Unblock ${entry.tool} for ${PRODUCT[entry.provider]}`}
                  disabled={busy}
                  onClick={() => void send(entry.provider, entry.tool, false)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  Unblock
                </OctantButton>
              </SettingsCompactRow>
            ))
          )}
          <SettingRow
            description="The tool's name as the provider names it, or server__tool for a tool of one of its MCP servers. Codex can block shell, view_image, web_search and MCP server tools."
            htmlFor={`${ids}-tool`}
            label="Block a tool"
            scope="host"
            settingId="blocked-tools-add"
          >
            <form
              className="protected-files__add"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const tool = draft.trim();
                if (tool === "") return;
                void send(provider, tool, true).then((added) => {
                  if (added) setDraft("");
                });
              }}
            >
              <OctantSelectField
                aria-label="Provider"
                disabled={busy}
                id={`${ids}-provider`}
                onValueChange={(value) => {
                  const next = PROVIDERS.find((id) => id === value);
                  if (next !== undefined) setProvider(next);
                }}
                options={PROVIDERS.map((id) => ({ id, label: PRODUCT[id] }))}
                value={provider}
              />
              <OctantInput
                aria-label="Tool to block"
                className="settings-view__text-input"
                disabled={busy}
                id={`${ids}-tool`}
                onChange={(event) => setDraft(event.currentTarget.value)}
                placeholder={EXAMPLE[provider]}
                type="text"
                value={draft}
              />
              <OctantButton disabled={busy || draft.trim() === ""} size="sm" type="submit">
                Block
              </OctantButton>
            </form>
          </SettingRow>
        </div>
        <div className="settings-feedback-slot" aria-live="polite">
          {problem === undefined ? null : (
            <OctantFieldError className="settings-section-line">{problem}</OctantFieldError>
          )}
        </div>
      </>
    );

  return (
    <SettingsSection description={BLOCKED_TOOLS_FACT} title="Blocked tools">
      {body}
    </SettingsSection>
  );
}

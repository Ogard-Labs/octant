import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type {
  ExtensionCommandFailure,
  UserAddedMcpServerRequest,
} from "@octant/contracts/extension-rpc";
import { Plus, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";

type ServerKind = "stdio" | "streamable-http";

interface ValueRow {
  readonly id: number;
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}

export interface AddMcpServerDialogProps {
  readonly open: boolean;
  readonly client: Pick<ExtensionClient, "addUserMcpServer">;
  /** Whether this host keeps secrets; a browser-hosted Settings cannot. */
  readonly secretsAvailable: boolean;
  readonly onClose: () => void;
  /** Told once the server's package is installed and switched on. */
  readonly onAdded: () => void;
}

/**
 * Add MCP server: a command Octant starts, or an address it connects to. A
 * value marked secret goes to this host's credential store, not into the
 * package, and Octant cannot show it again. The server is installed, trusted
 * and switched on as one act; its tools still ask for approval per call.
 */
export function AddMcpServerDialog(props: AddMcpServerDialogProps) {
  const titleId = useId();
  return (
    <OctantDialog
      className="endpoint-add"
      label="Add an MCP server"
      labelledBy={titleId}
      onClose={props.onClose}
      open={props.open}
    >
      <h2 className="endpoint-add__title" id={titleId}>
        Add an MCP server
      </h2>
      {props.open ? (
        <AddMcpServerForm
          client={props.client}
          onAdded={props.onAdded}
          onClose={props.onClose}
          secretsAvailable={props.secretsAvailable}
        />
      ) : null}
    </OctantDialog>
  );
}

function AddMcpServerForm(props: Omit<AddMcpServerDialogProps, "open">) {
  const ids = useId();
  const [kind, setKind] = useState<ServerKind>("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  // Environment variables and headers are separate lists. Sharing one list
  // made a variable typed for a local command reappear as a header after
  // switching to Address, so a value meant only for a process on this computer
  // was sent to the remote server. Each transport keeps its own rows, like its
  // command or address, and only the selected transport's rows are submitted.
  const [envRows, setEnvRows] = useState<ReadonlyArray<ValueRow>>([]);
  const [headerRows, setHeaderRows] = useState<ReadonlyArray<ValueRow>>([]);
  const rows = kind === "stdio" ? envRows : headerRows;
  const setRows = kind === "stdio" ? setEnvRows : setHeaderRows;
  const [nextRowId, setNextRowId] = useState(1);
  const [problem, setProblem] = useState<string>();
  const [failure, setFailure] = useState<ExtensionCommandFailure>();
  const [submitting, setSubmitting] = useState(false);

  const addRow = () => {
    setRows([...rows, { id: nextRowId, name: "", value: "", secret: false }]);
    setNextRowId(nextRowId + 1);
  };
  const changeRow = (id: number, patch: Partial<Omit<ValueRow, "id">>) =>
    setRows(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const removeRow = (id: number) => setRows(rows.filter((row) => row.id !== id));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return setProblem("Give the server a name.");
    const values = rows
      .map((row) => ({ name: row.name.trim(), value: row.value, secret: row.secret }))
      .filter((row) => row.name.length > 0 || row.value.length > 0);
    const unnamed = values.find((row) => row.name.length === 0);
    if (unnamed !== undefined) {
      return setProblem(
        kind === "stdio" ? "Every variable needs a name." : "Every header needs a name.",
      );
    }
    let request: UserAddedMcpServerRequest;
    if (kind === "stdio") {
      const trimmedCommand = command.trim();
      if (trimmedCommand.length === 0) return setProblem("Enter the command that starts it.");
      request = {
        name: trimmedName,
        server: {
          type: "stdio",
          command: trimmedCommand,
          args: args
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
          env: values,
        },
      };
    } else {
      const trimmedUrl = url.trim();
      if (trimmedUrl.length === 0) return setProblem("Enter its address.");
      request = {
        name: trimmedName,
        server: { type: "streamable-http", url: trimmedUrl, headers: values },
      };
    }
    setProblem(undefined);
    setFailure(undefined);
    setSubmitting(true);
    try {
      const result = await props.client.addUserMcpServer(request);
      if (result.kind === "extension-command-failed") {
        setFailure(result.failure);
        return;
      }
      props.onAdded();
    } catch (error) {
      setFailure({
        category: "unavailable",
        message: error instanceof Error ? error.message : "Extension service is unavailable.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const valuesLabel = kind === "stdio" ? "Environment variables" : "Headers";
  return (
    <form
      aria-label="Add an MCP server"
      className="endpoint-flow__form"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <p className="endpoint-flow__detail">
        A command Octant starts on this computer, or an address it connects to. Its tools ask for
        your approval on every call.
      </p>
      <div className="endpoint-flow__field">
        <label htmlFor={`${ids}-name`}>Name</label>
        <OctantInput
          className="settings-view__text-input"
          id={`${ids}-name`}
          onChange={(event) => setName(event.currentTarget.value)}
          value={name}
        />
      </div>
      <div className="endpoint-flow__field">
        <span id={`${ids}-kind`}>How Octant reaches it</span>
        <OctantToggleGroup<ServerKind>
          aria-labelledby={`${ids}-kind`}
          onValueChange={(next) => {
            const selected = next[0];
            if (selected !== undefined) setKind(selected);
          }}
          value={[kind]}
        >
          <OctantToggleGroupItem value="stdio">Command</OctantToggleGroupItem>
          <OctantToggleGroupItem value="streamable-http">Address</OctantToggleGroupItem>
        </OctantToggleGroup>
      </div>
      {kind === "stdio" ? (
        <>
          <div className="endpoint-flow__field">
            <label htmlFor={`${ids}-command`}>Command</label>
            <OctantInput
              aria-describedby={`${ids}-command-hint`}
              className="settings-view__text-input"
              id={`${ids}-command`}
              onChange={(event) => setCommand(event.currentTarget.value)}
              placeholder="npx"
              spellCheck={false}
              value={command}
            />
            <span className="endpoint-flow__hint" id={`${ids}-command-hint`}>
              A program on this computer, by name or full path. Octant runs it confined.
            </span>
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
              One per line.
            </span>
          </div>
        </>
      ) : (
        <div className="endpoint-flow__field">
          <label htmlFor={`${ids}-url`}>Address</label>
          <OctantInput
            aria-describedby={`${ids}-url-hint`}
            className="settings-view__text-input"
            id={`${ids}-url`}
            inputMode="url"
            onChange={(event) => setUrl(event.currentTarget.value)}
            placeholder="https://host.example/mcp"
            spellCheck={false}
            type="url"
            value={url}
          />
          <span className="endpoint-flow__hint" id={`${ids}-url-hint`}>
            Needs https unless it is on this computer.
          </span>
        </div>
      )}
      <fieldset className="endpoint-flow__field">
        <legend>{valuesLabel}</legend>
        {rows.length === 0 ? null : (
          <ul aria-label={valuesLabel} className="mcp-server-values">
            {rows.map((row) => (
              <li className="mcp-server-values__row" key={row.id}>
                <OctantInput
                  aria-label={kind === "stdio" ? "Variable name" : "Header name"}
                  className="settings-view__text-input"
                  onChange={(event) => changeRow(row.id, { name: event.currentTarget.value })}
                  placeholder={kind === "stdio" ? "API_KEY" : "Authorization"}
                  spellCheck={false}
                  value={row.name}
                />
                <OctantInput
                  aria-label="Value"
                  autoComplete="off"
                  className="settings-view__text-input"
                  onChange={(event) => changeRow(row.id, { value: event.currentTarget.value })}
                  spellCheck={false}
                  type={row.secret ? "password" : "text"}
                  value={row.value}
                />
                <label className="mcp-server-values__secret">
                  <OctantCheckbox
                    checked={row.secret}
                    disabled={!props.secretsAvailable}
                    onChange={(event) => changeRow(row.id, { secret: event.currentTarget.checked })}
                  />
                  <span>Secret</span>
                </label>
                <OctantIconButton
                  label="Remove"
                  onClick={() => removeRow(row.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <X size={14} />
                </OctantIconButton>
              </li>
            ))}
          </ul>
        )}
        <OctantButton onClick={addRow} size="sm" type="button" variant="outline">
          <Plus aria-hidden="true" size={14} />
          {kind === "stdio" ? "Add variable" : "Add header"}
        </OctantButton>
        <span className="endpoint-flow__hint">
          {props.secretsAvailable
            ? "A secret value is kept in this Mac's credential store, never in the package, and Octant can't show it again."
            : "This browser can't keep secrets. Add secret values from the Octant app on this Mac."}
        </span>
      </fieldset>
      {problem === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {problem}
        </OctantAlert>
      )}
      {failure === undefined ? null : (
        <OctantAlert className="provider-settings__alert" tone="warning">
          {failure.message}
        </OctantAlert>
      )}
      <div className="endpoint-flow__actions">
        <OctantButton onClick={props.onClose} size="sm" type="button" variant="ghost">
          Cancel
        </OctantButton>
        <OctantButton disabled={submitting} size="sm" type="submit">
          {submitting ? "Adding…" : "Add server"}
        </OctantButton>
      </div>
    </form>
  );
}

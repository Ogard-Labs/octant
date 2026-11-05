import { OctantAlert } from "../ui/base/OctantAlert";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CommandCredentialsClient } from "@octant/client-runtime/command-credentials-client";
import {
  decodeCommandCredentialCommand,
  type CommandCredentialBinding,
  type CommandCredentialResult,
} from "@octant/contracts/command-credentials";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantButton } from "../ui/base/OctantButton";
import { SettingsSection } from "./primitives";
import "../credentials/credentialRequests.css";

export function CommandCredentialBindingsSettings(props: {
  readonly client: CommandCredentialsClient | undefined;
  readonly projectNames: ReadonlyMap<string, string>;
}) {
  const clientIdentity = useRef({ client: props.client });
  if (clientIdentity.current.client !== props.client)
    clientIdentity.current = { client: props.client };
  const id = useId();
  const [bindings, setBindings] = useState<ReadonlyArray<CommandCredentialBinding>>([]);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [project, setProject] = useState("");
  const accept = (result: CommandCredentialResult) => {
    if (result.kind === "command-credential-view") {
      setBindings(result.bindings);
      setMessage(undefined);
    } else if (result.kind === "command-credential-refused") {
      setBindings([]);
      setMessage(result.message);
    }
  };
  useEffect(() => {
    const abort = new AbortController();
    setBindings([]);
    setBusy(false);
    setMessage(undefined);
    void props.client
      ?.read(undefined, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted) accept(result);
      })
      .catch(() => {
        if (!abort.signal.aborted) setMessage("Credential commands could not be read.");
      });
    return () => abort.abort();
  }, [props.client]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.client === undefined || busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const text = (name: string) => String(values.get(name) ?? "").trim();
    const captured = clientIdentity.current;
    setBusy(true);
    setMessage(undefined);
    try {
      const environment = text("environment")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match =
            /^([A-Z_][A-Z0-9_]*)=op:\/\/([a-z0-9]{26})\/([a-z0-9]{26})\/(?:([A-Za-z0-9_-]+)\/)?([A-Za-z0-9_-]+)$/i.exec(
              line.trim(),
            );
          if (match === null) throw Error("reference");
          return {
            name: match[1],
            vaultId: match[2],
            itemId: match[3],
            ...(match[4] === undefined ? {} : { sectionId: match[4] }),
            fieldId: match[5],
          };
        });
      const command = decodeCommandCredentialCommand({
        kind: "save",
        definition: {
          label: text("label"),
          projectId: project,
          executable: text("executable"),
          args: text("args") === "" ? [] : text("args").split("\n"),
          directory: text("directory"),
          accountId: text("account"),
          environment,
          timeoutMs: Number(text("timeout")) * 1000,
        },
      });
      const result = await props.client.execute(command);
      if (clientIdentity.current !== captured) return;
      accept(result);
      if (result.kind === "command-credential-view") form.reset();
    } catch {
      if (clientIdentity.current !== captured) return;
      setMessage(
        "Use a Project, an absolute executable, an account ID and 1–8 ENV=op://vaultID/itemID/[sectionID/]fieldID mappings. Enter references, never values.",
      );
    } finally {
      if (clientIdentity.current === captured) setBusy(false);
    }
  };
  if (props.client === undefined) return null;
  return (
    <SettingsSection
      title="Credential commands"
      description="Save a fixed command for a Code Project. Every run needs a fresh human approval and current Full access. Other access levels are not supported by this command channel."
    >
      <div className="credential-requests">
        {bindings.map((binding) => (
          <div className="credential-request-card command-credential-card" key={binding.bindingId}>
            <strong>{binding.definition.label}</strong>
            <code className="credential-request-code">
              {binding.definition.executable}{" "}
              {binding.definition.args.map((arg) => JSON.stringify(arg)).join(" ")}
            </code>
            <p>
              {props.projectNames.get(String(binding.definition.projectId)) ?? "Code Project"} ·
              Account {binding.definition.accountId} · op {binding.credentialVersion}
            </p>
            <OctantButton
              variant="secondary"
              disabled={busy}
              onClick={() => {
                const captured = clientIdentity.current;
                setBusy(true);
                void props.client
                  ?.execute({
                    kind: "remove",
                    bindingId: binding.bindingId,
                    expectedRevision: binding.revision,
                  })
                  .then((result) => {
                    if (clientIdentity.current === captured) accept(result);
                  })
                  .catch(() => {
                    if (clientIdentity.current === captured)
                      setMessage("The binding could not be removed.");
                  })
                  .finally(() => {
                    if (clientIdentity.current === captured) setBusy(false);
                  });
              }}
              aria-label={`Remove ${binding.definition.label}`}
            >
              Remove binding
            </OctantButton>
          </div>
        ))}
        <form
          noValidate
          className="credential-request-card command-credential-card"
          onSubmit={(event) => void save(event)}
          autoComplete="off"
        >
          <h3>New credential command</h3>
          <label htmlFor={`${id}-project`}>Code Project</label>
          <OctantSelectField
            id={`${id}-project`}
            value={project}
            onValueChange={setProject}
            placeholder="Choose a Code Project"
            options={[...props.projectNames].map(([id, label]) => ({ id, label }))}
          />
          <label htmlFor={`${id}-label`}>Command name</label>
          <OctantInput id={`${id}-label`} name="label" required maxLength={80} />
          <label htmlFor={`${id}-executable`}>Recipient executable</label>
          <OctantInput
            id={`${id}-executable`}
            name="executable"
            required
            placeholder="/absolute/path/to/client"
          />
          <label htmlFor={`${id}-args`}>Fixed arguments · one per line</label>
          <OctantTextarea id={`${id}-args`} name="args" rows={3} />
          <label htmlFor={`${id}-directory`}>Directory within the Project · empty for root</label>
          <OctantInput id={`${id}-directory`} name="directory" />
          <label htmlFor={`${id}-account`}>1Password account ID</label>
          <OctantInput id={`${id}-account`} name="account" required minLength={26} maxLength={26} />
          <label htmlFor={`${id}-environment`}>
            Credential references · one ENV=op://… mapping per line
          </label>
          <OctantTextarea
            id={`${id}-environment`}
            name="environment"
            required
            rows={4}
            spellCheck={false}
          />
          <label htmlFor={`${id}-timeout`}>Run timeout · seconds</label>
          <OctantInput
            id={`${id}-timeout`}
            name="timeout"
            type="number"
            min={1}
            max={300}
            defaultValue={60}
            required
          />
          <p>
            The recipient and its descendants receive these credentials and ordinary Full access,
            including network access. Choose an executable you trust. Output concealment cannot
            prevent deliberate disclosure. A supported local op 2 CLI is pinned when saved;
            replacing either executable requires a new binding.
          </p>
          <OctantButton type="submit" disabled={busy || project === ""}>
            {busy ? "Verifying…" : "Save command binding"}
          </OctantButton>
        </form>
        {message === undefined ? null : <OctantAlert tone="danger">{message}</OctantAlert>}
      </div>
    </SettingsSection>
  );
}

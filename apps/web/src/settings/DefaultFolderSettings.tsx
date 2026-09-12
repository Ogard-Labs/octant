import { DefaultFolder } from "@octant/contracts/shell";
import { Schema } from "effect";
import { useEffect, useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

const decodeDefaultFolder = Schema.decodeUnknownOption(DefaultFolder);

export interface DefaultFolderSettingsProps {
  /** The folder in effect, as the host reports it. */
  readonly folder: string | undefined;
  /** Resolves to whether the host accepted the folder. */
  readonly onFolderChange: (folder: DefaultFolder) => Promise<boolean> | boolean | void;
}

/**
 * Where threads started without a Project, and the files Octant produces,
 * live. The host judges the path — it has to sit inside the home folder — so
 * a refused path stays in the field with the reason beside it rather than
 * snapping back as if nothing was typed.
 */
export function DefaultFolderSettings(props: DefaultFolderSettingsProps) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.folder ?? "");
  const [status, setStatus] = useState<string>();
  useEffect(() => {
    if (!editing) setDraft(props.folder ?? "");
  }, [editing, props.folder]);

  if (!editing) {
    return (
      <div className="default-folder-settings">
        <code className="default-folder-settings__path" title={props.folder}>
          {props.folder ?? "Not set"}
        </code>
        <OctantButton onClick={() => setEditing(true)} size="sm" type="button" variant="secondary">
          Change
        </OctantButton>
      </div>
    );
  }

  const submit = async () => {
    const folder = decodeDefaultFolder(draft.trim());
    if (folder._tag === "None") {
      setStatus("Enter an absolute path.");
      return;
    }
    const accepted = await props.onFolderChange(folder.value);
    if (accepted === false) {
      setStatus("The folder must be an absolute path inside your home folder.");
      return;
    }
    setStatus(undefined);
    setEditing(false);
  };

  return (
    <form
      className="default-folder-settings default-folder-settings--editing"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="visually-hidden" htmlFor={inputId}>
        Default folder
      </label>
      <OctantInput
        autoFocus
        id={inputId}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="/Users/you/Documents/Octant"
        spellCheck={false}
        value={draft}
      />
      <OctantButton size="sm" type="submit">
        Save
      </OctantButton>
      <OctantButton
        onClick={() => {
          setStatus(undefined);
          setEditing(false);
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        Cancel
      </OctantButton>
      {status === undefined ? null : (
        <p aria-live="polite" className="default-folder-settings__status">
          {status}
        </p>
      )}
    </form>
  );
}

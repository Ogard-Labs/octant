import { useId, useState } from "react";
import { Plus, X } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ArtifactTagsProps {
  readonly tags: ReadonlyArray<string>;
  /** Begins adding a tag; absent when this surface cannot change tags. */
  readonly onAdd?: (tag: string) => void;
  readonly onRemove?: (tag: string) => void;
  /** The row's add control is a quiet text button; the card's sits in a chip row. */
  readonly variant?: "card" | "row";
}

/**
 * The tags one artifact carries, and the way to change them.
 *
 * A tag is the person's own label, so it reads as a chip with its own remove
 * control rather than as a fact of the artifact: removing one is undoable by
 * typing it again, which is also why there is no confirmation.
 */
export function ArtifactTags(props: ArtifactTagsProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const canChange = props.onAdd !== undefined || props.onRemove !== undefined;

  const submit = () => {
    const tag = draft.trim();
    setDraft("");
    setAdding(false);
    if (tag !== "") props.onAdd?.(tag);
  };

  if (props.tags.length === 0 && !canChange) return null;

  return (
    <span className="artifact-tags">
      {props.tags.map((tag) => (
        <span className="artifact-tags__chip" key={tag}>
          {tag}
          {props.onRemove === undefined ? null : (
            <OctantButton
              aria-label={`Remove tag ${tag}`}
              className="artifact-tags__chip-remove"
              onClick={() => props.onRemove?.(tag)}
              size="sm"
              type="button"
              variant="bare"
            >
              <X aria-hidden="true" size={10} strokeWidth={2} />
            </OctantButton>
          )}
        </span>
      ))}
      {props.onAdd === undefined ? null : adding ? (
        <span className="artifact-tags__add">
          <label className="sr-only" htmlFor={inputId}>
            Tag name
          </label>
          <OctantInput
            className="artifact-tags__input"
            id={inputId}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
              if (event.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
            placeholder="Tag name"
            type="text"
            unstyled
            value={draft}
          />
          <OctantButton onClick={submit} size="sm" type="button" variant="ghost">
            Add
          </OctantButton>
        </span>
      ) : (
        <OctantButton
          className="artifact-tags__chip-add"
          onClick={() => setAdding(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Plus aria-hidden="true" size={10} strokeWidth={2} />
          Tag
        </OctantButton>
      )}
    </span>
  );
}

import { chordFromEvent, isShadowedKeybinding, sameChord } from "@octant/domain";
import { useContext, useEffect, useRef } from "react";
import { useKeybindings } from "../keybindings/useKeybindings";
import { isApplePlatform } from "../platform";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantMenu } from "../ui/base/OctantMenu";
import { Archive, Plus, Trash2 } from "../ui/icons";
import { composerStashRecoveryKey, hasComposerStashContent } from "./composerStashDraft";
import { planComposerStashRestore } from "./composerStashRestore";
import { useRegisterComposerMenuAction } from "./ComposerMenuActions";
import { useComposerNoticeSink } from "./ComposerNotice";
import { useComposerStash } from "./useComposerStash";

import {
  ComposerStashScopeContext,
  type ComposerStashControlsProps,
} from "./ComposerStashControls";
import "./composerStash.css";

export function ComposerStashActions(props: ComposerStashControlsProps) {
  const scope = useContext(ComposerStashScopeContext);
  const target = props.binding.target;
  const location = {
    ...target.location,
    host: scope?.host ?? target.location.host,
    windowId: scope?.windowId ?? target.location.windowId,
  };
  return (
    <BoundComposerStashActions
      binding={{ ...props.binding, target: { ...target, location } }}
      key={composerStashRecoveryKey(location)}
      surface={props.surface}
    />
  );
}

function BoundComposerStashActions(props: ComposerStashControlsProps) {
  const { binding, surface } = props;
  const stash = useComposerStash(binding);
  const hasContent = hasComposerStashContent(binding.draft);
  const { keybindings } = useKeybindings();
  const chord = keybindings.bindings.get("composer-stash");
  const shortcut = useRef<() => void>(() => {});
  shortcut.current = () => void (hasContent ? stash.move() : stash.open(true));
  useEffect(() => {
    const element = surface.current;
    if (
      element === null ||
      chord === undefined ||
      isShadowedKeybinding(keybindings, "composer-stash")
    ) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        !(event.target instanceof Element) ||
        event.target.closest(".composer-input, textarea, [data-composer-draft-input]") === null ||
        !sameChord(chord, chordFromEvent(event, isApplePlatform()))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) shortcut.current();
    };
    element.addEventListener("keydown", onKeyDown, true);
    return () => element.removeEventListener("keydown", onKeyDown, true);
  }, [chord, keybindings, surface]);

  const save = {
    label: "Stash draft",
    icon: <Archive size={14} />,
    disabled: !hasContent || stash.busy || binding.unavailable !== undefined,
    onSelect: () => void stash.move(),
  };
  const browse = {
    label: "Saved drafts",
    icon: <Archive size={14} />,
    disabled: stash.busy,
    onSelect: () => void stash.open(false),
  };
  const usesAttachMenu = useRegisterComposerMenuAction("composer-stash", save);
  useRegisterComposerMenuAction("composer-saved-drafts", browse);
  const noticeInComposer = useComposerNoticeSink(
    "composer-stash",
    stash.notice === undefined || stash.entries !== undefined
      ? undefined
      : {
          key: "composer-stash",
          text: stash.notice.text,
          tone: stash.notice.tone === "success" ? "neutral" : "warning",
          ...(stash.notice.tone === "success" ? { transient: true } : {}),
        },
  );

  return (
    <>
      {noticeInComposer || stash.entries !== undefined || stash.notice === undefined ? null : (
        <OctantAlert tone={stash.notice.tone} layout="row">
          {stash.notice.text}
        </OctantAlert>
      )}
      {usesAttachMenu ? null : (
        <div className="composer-field__attach">
          <OctantMenu
            actions={[save, browse]}
            items={[]}
            onValueChange={() => {}}
            selectionMode="action"
            trigger={<Plus size={16} />}
            triggerLabel="Draft actions"
            triggerTitle="Draft actions"
            value=""
          />
        </div>
      )}
      {stash.entries === undefined ? null : (
        <OctantDialog label="Saved drafts" onClose={stash.close} open>
          <h2 className="oct-title">Saved drafts</h2>
          {stash.notice?.tone === "warning" ? (
            <OctantAlert tone="warning" layout="row">
              {stash.notice.text}
            </OctantAlert>
          ) : null}
          {stash.entries.length === 0 ? (
            <p>Drafts you stash on this computer appear here.</p>
          ) : (
            <ul className="composer-stash-list">
              {stash.entries.map((entry) => {
                const availability = planComposerStashRestore(
                  entry.source,
                  binding.target,
                  binding.draft,
                  entry.draft,
                );
                const text = entry.draft.text.trim().replace(/\s+/g, " ");
                const label =
                  text.length > 0
                    ? text.slice(0, 120)
                    : (entry.draft.files[0]?.name ?? "Draft with selected context");
                return (
                  <li className="composer-stash-list__entry" key={entry.id}>
                    <div>
                      <div>{label}</div>
                      <small>
                        {entry.source.mode === "chat"
                          ? "Chat"
                          : entry.source.mode === "work"
                            ? "Work"
                            : "Code"}
                        {entry.draft.files.length > 0
                          ? ` · ${entry.draft.files.length} attachment${entry.draft.files.length === 1 ? "" : "s"}`
                          : ""}
                      </small>
                      {availability.kind === "refused" ? <p>{availability.reason}</p> : null}
                    </div>
                    <OctantButton
                      type="button"
                      size="sm"
                      disabled={stash.busy || availability.kind === "refused"}
                      onClick={() => void stash.move(entry)}
                    >
                      Restore
                    </OctantButton>
                    <OctantButton
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove saved draft ${label}`}
                      disabled={stash.busy}
                      onClick={() => void stash.remove(entry)}
                    >
                      <Trash2 size={14} />
                    </OctantButton>
                  </li>
                );
              })}
            </ul>
          )}
          <OctantButton type="button" variant="secondary" onClick={stash.close}>
            Close
          </OctantButton>
        </OctantDialog>
      )}
    </>
  );
}

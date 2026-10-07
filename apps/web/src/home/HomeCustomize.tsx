import type { HomeCardCustomization } from "@octant/contracts/shell";
import { ChevronDown, ChevronUp, GripVertical, SlidersHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { IconButton } from "../shell/IconButton";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import {
  isDefaultHomeCardCustomization,
  moveHomeCard,
  setHomeCardVisible,
  type HomeCardDefinition,
  type HomeCardPlacement,
} from "./homeCards";

export interface HomeCustomizeProps {
  readonly definitions: ReadonlyArray<HomeCardDefinition>;
  readonly placements: ReadonlyArray<HomeCardPlacement>;
  readonly customization: HomeCardCustomization;
  readonly onChange: (next: HomeCardCustomization) => void;
}

/**
 * The Customize control under the composer: one switch per card, a handle to
 * drag it into place, and up and down buttons for the keyboard. Every change is
 * stored at once, so closing the panel is the only step left.
 */
export function HomeCustomize(props: HomeCustomizeProps) {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const [over, setOver] = useState<number | undefined>(undefined);
  const headingId = useId();
  const last = props.placements.length - 1;

  function finishDrag() {
    setDragging(undefined);
    setOver(undefined);
  }

  return (
    <OctantPopover
      align="end"
      className="home-customize"
      onOpenChange={setOpen}
      open={open}
      titledBy={headingId}
      trigger={
        <>
          <SlidersHorizontal aria-hidden="true" size={14} strokeWidth={1.8} />
          Customize
        </>
      }
      triggerLabel="Customize"
      triggerVariant="ghost"
    >
      <h2 className="oct-section-label home-customize__heading" id={headingId}>
        Cards on this screen
      </h2>
      <ul aria-label="Cards" className="home-customize__list">
        {props.placements.map((placement, index) => {
          const { definition } = placement;
          const Icon = definition.icon;
          return (
            <li
              className="home-customize__row"
              data-dragging={dragging === definition.id ? "true" : undefined}
              data-drop-target={over === index && dragging !== definition.id ? "true" : undefined}
              draggable
              key={definition.id}
              onDragEnd={finishDrag}
              onDragOver={(event) => {
                if (dragging === undefined) return;
                event.preventDefault();
                setOver(index);
              }}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", definition.id);
                setDragging(definition.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== undefined) {
                  props.onChange(
                    moveHomeCard(props.definitions, props.customization, dragging, index),
                  );
                }
                finishDrag();
              }}
            >
              <span aria-hidden="true" className="home-customize__grip" title="Drag to reorder">
                <GripVertical size={16} strokeWidth={1.8} />
              </span>
              <Icon
                aria-hidden="true"
                className="home-customize__icon"
                size={16}
                strokeWidth={1.8}
              />
              <span className="oct-row-label home-customize__name">{definition.title}</span>
              <span className="home-customize__move">
                <IconButton
                  disabled={index === 0}
                  icon={ChevronUp}
                  label={`Move ${definition.title} up`}
                  onClick={() =>
                    props.onChange(
                      moveHomeCard(
                        props.definitions,
                        props.customization,
                        definition.id,
                        index - 1,
                      ),
                    )
                  }
                />
                <IconButton
                  disabled={index === last}
                  icon={ChevronDown}
                  label={`Move ${definition.title} down`}
                  onClick={() =>
                    props.onChange(
                      moveHomeCard(
                        props.definitions,
                        props.customization,
                        definition.id,
                        index + 1,
                      ),
                    )
                  }
                />
              </span>
              <OctantSwitch
                checked={placement.visible}
                label={`Show ${definition.title}`}
                onCheckedChange={(visible) =>
                  props.onChange(
                    setHomeCardVisible(
                      props.definitions,
                      props.customization,
                      definition.id,
                      visible,
                    ),
                  )
                }
              />
            </li>
          );
        })}
      </ul>
      <div className="home-customize__footer">
        <OctantButton
          disabled={isDefaultHomeCardCustomization(props.customization)}
          onClick={() => props.onChange({ order: [], visibility: [] })}
          size="sm"
          type="button"
          variant="secondary"
        >
          Reset to default
        </OctantButton>
      </div>
    </OctantPopover>
  );
}

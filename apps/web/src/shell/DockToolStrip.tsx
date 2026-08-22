import { MoreHorizontal, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { DockToolIcon } from "./dockToolIcons";
import { partitionDockTools } from "./dockToolStripModel";
import { IconButton } from "./IconButton";
import type {
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
} from "./rightUtilityDockModel";

const TOOL_SLOT_WIDTH = 92;
const OVERFLOW_SLOT_WIDTH = 30;

export interface DockToolStripProps {
  readonly active?: RightUtilityDockSurfaceId;
  readonly capacity?: number;
  readonly onClose: (surface: RightUtilityDockSurfaceId) => void;
  readonly onSelect: (surface: RightUtilityDockSurfaceId) => void;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor>;
}

export function DockToolStrip(props: DockToolStripProps) {
  const [measuredCapacity, setMeasuredCapacity] = useState(props.tabs.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const overflowId = useId();
  const overflowTrigger = useRef<HTMLButtonElement>(null);
  const capacity = props.capacity ?? measuredCapacity;
  const { visible, overflow } = partitionDockTools(props.tabs, props.active, capacity);

  useEffect(() => {
    if (props.capacity !== undefined) return;
    const node = strip.current;
    if (node === null) return;
    const measure = () => {
      const width = node.clientWidth;
      // jsdom reports 0; treat that as unknown width and keep every tool.
      if (width === 0) {
        setMeasuredCapacity(props.tabs.length);
        return;
      }
      setMeasuredCapacity(Math.max(1, Math.floor((width - OVERFLOW_SLOT_WIDTH) / TOOL_SLOT_WIDTH)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [props.capacity, props.tabs.length]);

  useEffect(() => {
    if (overflow.length === 0) setOverflowOpen(false);
  }, [overflow.length]);

  function onStripKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (props.tabs.length === 0) return;
    const index = props.tabs.findIndex((tool) => tool.id === props.active);
    const current = index < 0 ? 0 : index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = props.tabs[(current + 1) % props.tabs.length];
      if (next !== undefined) props.onSelect(next.id);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = props.tabs[(current - 1 + props.tabs.length) % props.tabs.length];
      if (next !== undefined) props.onSelect(next.id);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      const next = props.tabs[0];
      if (next !== undefined) props.onSelect(next.id);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const next = props.tabs[props.tabs.length - 1];
      if (next !== undefined) props.onSelect(next.id);
    }
  }

  return (
    <div
      aria-label="Open tools"
      className="dock-tool-strip"
      onKeyDown={onStripKeyDown}
      ref={strip}
      role="tablist"
    >
      {visible.map((tool) => (
        <span className="dock-tool-strip__tab" key={tool.id}>
          <button
            aria-selected={tool.id === props.active}
            className="dock-tool-strip__select window-no-drag"
            onClick={() => props.onSelect(tool.id)}
            role="tab"
            tabIndex={tool.id === props.active ? 0 : -1}
            type="button"
          >
            <DockToolIcon surface={tool.id} />
            <span>{tool.label}</span>
          </button>
          <IconButton
            className="dock-tool-strip__close"
            icon={X}
            label={`Hide ${tool.label}`}
            onClick={() => props.onClose(tool.id)}
          />
        </span>
      ))}
      {overflow.length === 0 ? null : (
        <span className="dock-tool-strip__overflow">
          <IconButton
            aria-controls={overflowId}
            aria-expanded={overflowOpen}
            icon={MoreHorizontal}
            label="More tools"
            onClick={() => setOverflowOpen((open) => !open)}
            ref={overflowTrigger}
          />
          {overflowOpen ? (
            <span
              className="workspace-disclosure dock-tool-strip__overflow-menu"
              id={overflowId}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                setOverflowOpen(false);
                overflowTrigger.current?.focus();
              }}
            >
              {overflow.map((tool) => (
                <span className="dock-tool-strip__overflow-row" key={tool.id}>
                  <button
                    className="workspace-disclosure__action window-no-drag"
                    onClick={() => {
                      props.onSelect(tool.id);
                      setOverflowOpen(false);
                    }}
                    type="button"
                  >
                    <DockToolIcon surface={tool.id} />
                    <span>{tool.label}</span>
                  </button>
                  <IconButton
                    icon={X}
                    label={`Hide ${tool.label}`}
                    onClick={() => props.onClose(tool.id)}
                  />
                </span>
              ))}
            </span>
          ) : null}
        </span>
      )}
    </div>
  );
}

import { MoreHorizontal, X } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useDismissOnOutsidePointer } from "../lib/useDismissOnOutsidePointer";
import { DockToolIcon } from "./dockToolIcons";
import { partitionDockTools } from "./dockToolStripModel";
import { IconButton } from "./IconButton";
import { OctantButton } from "../ui/base/OctantButton";
import type {
  RightUtilityDockSurfaceDescriptor,
  RightUtilityDockSurfaceId,
  RightUtilityDockTabDescriptor,
} from "./rightUtilityDockModel";

const UNMEASURED_TOOL_WIDTH = 192;
const OVERFLOW_SLOT_WIDTH = 32;

export interface DockToolStripProps {
  readonly active?: string;
  readonly capacity?: number;
  readonly onClose: (tabId: string) => void;
  readonly onSelect: (tabId: string) => void;
  readonly tabs: ReadonlyArray<RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor>;
}

export const DockToolStrip = memo(function DockToolStrip(props: DockToolStripProps) {
  const [measuredCapacity, setMeasuredCapacity] = useState(props.tabs.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const tabWidths = useRef(new Map<string, number>());
  const overflowId = useId();
  const overflowTrigger = useRef<HTMLButtonElement>(null);
  const overflowRegion = useRef<HTMLSpanElement>(null);
  const capacity = props.capacity ?? measuredCapacity;
  const { visible, overflow } = useMemo(
    () => partitionDockTools(props.tabs, props.active, capacity),
    [props.tabs, props.active, capacity],
  );

  useLayoutEffect(() => {
    if (props.capacity !== undefined) return;
    const node = strip.current;
    if (node === null) return;
    const cluster = node.parentElement;
    const measure = () => {
      const width = cluster === null ? node.clientWidth : cluster.clientWidth;
      if (width === 0) {
        // Without layout, retain every tab until there is a measurable cluster.
        if (measuredCapacity !== props.tabs.length) setMeasuredCapacity(props.tabs.length);
        return;
      }
      const style = getComputedStyle(cluster ?? node);
      const padding =
        (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      const gap = Number.parseFloat(style.columnGap) || Number.parseFloat(style.gap) || 0;
      let siblings = 0;
      if (cluster !== null) {
        for (const child of cluster.children) {
          if (
            child !== node &&
            child instanceof HTMLElement &&
            getComputedStyle(child).display !== "none"
          )
            siblings += child.offsetWidth + gap;
        }
      }
      const mountedTabs = node.querySelectorAll<HTMLElement>(".dock-tool-strip__tab");
      mountedTabs.forEach((element, index) => {
        const tool = visible[index];
        if (tool !== undefined)
          tabWidths.current.set(tool.id, element.getBoundingClientRect().width);
      });
      const currentIds = new Set(props.tabs.map((tab) => tab.id));
      for (const id of tabWidths.current.keys())
        if (!currentIds.has(id)) tabWidths.current.delete(id);
      const available = Math.max(0, width - padding - siblings);
      const tabGap = Number.parseFloat(getComputedStyle(node).gap) || 0;
      let next = props.tabs.length;
      while (next > 1) {
        const partition = partitionDockTools(props.tabs, props.active, next);
        const used =
          partition.visible.reduce(
            (sum, tab) => sum + (tabWidths.current.get(tab.id) ?? UNMEASURED_TOOL_WIDTH),
            0,
          ) +
          Math.max(0, partition.visible.length - 1) * tabGap +
          (partition.overflow.length > 0 ? OVERFLOW_SLOT_WIDTH + tabGap : 0);
        if (used <= available) break;
        next -= 1;
      }
      if (next !== measuredCapacity) setMeasuredCapacity(next);
    };
    // Measure the actual labels and exclude the padding reserved for native
    // window controls. Counting that padding as tab space caused real click
    // targets to sit underneath the bottom-panel and sidebar controls.
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(cluster ?? node);
    for (const element of node.querySelectorAll(".dock-tool-strip__tab")) observer.observe(element);
    return () => observer.disconnect();
  }, [props.capacity, props.tabs, props.active, measuredCapacity, visible]);

  useEffect(() => {
    if (overflow.length === 0) setOverflowOpen(false);
  }, [overflow.length]);

  const dismissOverflow = useCallback(() => setOverflowOpen(false), []);
  useDismissOnOutsidePointer(overflowOpen, dismissOverflow, overflowRegion);

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
          <OctantButton
            aria-selected={tool.id === props.active}
            className="dock-tool-strip__select window-no-drag"
            onClick={() => props.onSelect(tool.id)}
            role="tab"
            title={tool.label}
            size="sm"
            tabIndex={tool.id === props.active ? 0 : -1}
            type="button"
            variant="ghost"
          >
            <DockToolIcon surface={dockToolSurface(tool)} />
            <span>{tool.label}</span>
          </OctantButton>
          <IconButton
            className="dock-tool-strip__close"
            icon={X}
            label={`Hide ${tool.label}`}
            onClick={() => props.onClose(tool.id)}
          />
        </span>
      ))}
      {overflow.length === 0 ? null : (
        <span className="dock-tool-strip__overflow" ref={overflowRegion}>
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
                  <OctantButton
                    className="workspace-disclosure__action window-no-drag"
                    onClick={() => {
                      props.onSelect(tool.id);
                      setOverflowOpen(false);
                    }}
                    type="button"
                    variant="ghost"
                  >
                    <DockToolIcon surface={dockToolSurface(tool)} />
                    <span>{tool.label}</span>
                  </OctantButton>
                  <IconButton
                    className="dock-tool-strip__close dock-tool-strip__close--overflow"
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
});

function dockToolSurface(
  tool: RightUtilityDockSurfaceDescriptor | RightUtilityDockTabDescriptor,
): RightUtilityDockSurfaceId {
  return "surface" in tool ? tool.surface.id : tool.id;
}

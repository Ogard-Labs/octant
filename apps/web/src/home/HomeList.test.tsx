import { act, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Activity } from "../ui/icons";
import { HomeDashboard } from "./HomeDashboard";
import { HOME_LIST_COLD_ROWS } from "./HomeList";
import type { HomeListCardDefinition, HomeListRead } from "./homeCards";
import {
  HOME_LIST_CACHE_VERSION,
  readHomeListCache,
  writeHomeListCache,
  type CachedHomeListSection,
} from "./homeListCache";
import type { HomeListRow, HomeListSection } from "./homeListModel";

const SCOPE = "code|http://host|local|project-1";

function memoryStorage(initial?: string) {
  const items = new Map<string, string>();
  if (initial !== undefined) items.set("octant.homeList.cache", initial);
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

function row(id: string, section: HomeListRow["section"], title: string): HomeListRow {
  return {
    id,
    section,
    glyph: "pull-request",
    tone: "neutral",
    label: "Open",
    title,
    meta: ["octant", "5m"],
    trailing: "Passed",
    onOpen: vi.fn(),
  };
}

function section(
  id: HomeListSection["id"],
  rows: ReadonlyArray<HomeListRow>,
  seeAll?: string,
): HomeListSection {
  return {
    id,
    title: id,
    rows,
    total: rows.length,
    ...(seeAll === undefined ? {} : { seeAll: { label: seeAll, onSelect: vi.fn() } }),
  };
}

function seeded(sections: ReadonlyArray<HomeListSection>) {
  const storage = memoryStorage();
  writeHomeListCache(storage, SCOPE, sections);
  return storage;
}

/** A card whose answer the test gives when it likes. */
function lateCard(id: string) {
  let answer: (read: HomeListRead) => void = () => undefined;
  const definition: HomeListCardDefinition = {
    id,
    title: id,
    icon: Activity,
    defaultOn: true,
    available: true,
    useListRows: () => {
      const [read, setRead] = useState<HomeListRead>({ status: "loading" });
      answer = setRead;
      return read;
    },
  };
  return { definition, answer: (read: HomeListRead) => act(() => answer(read)) };
}

function renderList(
  card: HomeListCardDefinition,
  storage: ReturnType<typeof memoryStorage> | undefined,
) {
  return render(
    <HomeDashboard
      cacheScope={SCOPE}
      cacheStorage={storage}
      cards={[card]}
      customization={{ order: [], visibility: [] }}
      onCustomizationChange={vi.fn()}
    />,
  );
}

describe("the start list's cached paint", () => {
  it("paints the last answer on the first frame, inert and marked as updating, before any source answers", async () => {
    const storage = seeded([
      section("needs-you", [row("a", "needs-you", "Review the cache")], "See all"),
    ]);
    const late = lateCard("needs-you");
    renderList(late.definition, storage);

    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("Review the cache")).toBeVisible();
    expect(within(needs).queryByRole("button", { name: /Review the cache/ })).toBeNull();
    expect(within(needs).getByRole("button", { name: "See all in Needs you" })).toBeDisabled();
    expect(needs.querySelector(".spinner")).not.toBeNull();
  });

  it("replaces the stored rows in place with the fresh answer and makes them live", async () => {
    const storage = seeded([section("needs-you", [row("a", "needs-you", "Old title")])]);
    const late = lateCard("needs-you");
    renderList(late.definition, storage);
    const before = await screen.findByRole("region", { name: "Needs you" });

    await late.answer({ status: "ready", rows: [row("b", "needs-you", "Fresh title")] });

    const after = screen.getByRole("region", { name: "Needs you" });
    expect(after).toBe(before);
    expect(within(after).queryByText("Old title")).toBeNull();
    expect(within(after).getByRole("button", { name: /Fresh title/ })).toBeEnabled();
    expect(after.querySelector(".spinner")).toBeNull();
    const kept = readHomeListCache(storage, SCOPE);
    expect(kept?.[0]?.rows[0]?.title).toBe("Fresh title");
  });

  it("draws skeleton rows in the sections a first start will have, then the real rows", async () => {
    const late = lateCard("needs-you");
    renderList(late.definition, memoryStorage());

    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(needs.querySelectorAll(".home-list__row--skeleton")).toHaveLength(HOME_LIST_COLD_ROWS);
    expect(within(needs).getByText("Loading Needs you")).toBeInTheDocument();

    await late.answer({ status: "ready", rows: [row("a", "needs-you", "Fresh title")] });
    expect(needs.querySelectorAll(".home-list__row--skeleton")).toHaveLength(0);
  });

  it("keeps a slower section's skeleton in its place while a faster one is already live", async () => {
    const fast = lateCard("needs-you");
    const slow = lateCard("continue");
    render(
      <HomeDashboard
        cacheScope={SCOPE}
        cacheStorage={memoryStorage()}
        cards={[fast.definition, slow.definition]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    await screen.findByRole("region", { name: "Needs you" });
    await fast.answer({ status: "ready", rows: [row("a", "needs-you", "Fresh title")] });

    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getByRole("button", { name: /Fresh title/ })).toBeEnabled();
    const next = screen.getByRole("region", { name: "Continue" });
    expect(next.querySelectorAll(".home-list__row--skeleton")).toHaveLength(HOME_LIST_COLD_ROWS);
  });

  it("lays a skeleton row and a loaded row out at one fixed height", () => {
    const css = readFileSync(join(process.cwd(), "src/home/home-list.css"), "utf8");
    const rule = /\.home-list__row\.home-list__row \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/height: var\(--home-list-row-h\)/);
    expect(rule).toMatch(/min-height: var\(--home-list-row-h\)/);
    // The skeleton row is the same element class, so it takes the same height.
    expect(css).toMatch(/\.home-list__row--skeleton \{/);
  });

  it("holds as many stored rows as the earlier answer had, so the slot keeps its height", async () => {
    const storage = seeded([
      section("your-pull-requests", [
        row("a", "your-pull-requests", "One"),
        row("b", "your-pull-requests", "Two"),
      ]),
    ]);
    const late = lateCard("pull-requests");
    renderList(late.definition, storage);
    const mine = await screen.findByRole("region", { name: "Your pull requests" });
    expect(mine.querySelectorAll(".home-list__row")).toHaveLength(2);
    await late.answer({
      status: "ready",
      rows: [row("c", "your-pull-requests", "Three"), row("d", "your-pull-requests", "Four")],
    });
    expect(mine.querySelectorAll(".home-list__row")).toHaveLength(2);
  });
});

describe("the start list's cache", () => {
  it("refuses an entry written under another schema version", () => {
    const sections: ReadonlyArray<CachedHomeListSection> = [
      { id: "needs-you", total: 0, rows: [] },
    ];
    const stale = JSON.stringify({
      version: HOME_LIST_CACHE_VERSION + 1,
      scopes: { [SCOPE]: { savedAt: 1, sections } },
    });
    expect(readHomeListCache(memoryStorage(stale), SCOPE)).toBeUndefined();
    expect(readHomeListCache(memoryStorage("not json"), SCOPE)).toBeUndefined();
  });

  it("keeps only words, never an action, and survives a store that refuses writes", () => {
    const storage = memoryStorage();
    writeHomeListCache(storage, SCOPE, [section("continue", [row("a", "continue", "Pick up")])]);
    const text = storage.items.get("octant.homeList.cache") ?? "";
    expect(text).toContain("Pick up");
    expect(text).not.toContain("onOpen");
    expect(() =>
      writeHomeListCache(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
        },
        SCOPE,
        [],
      ),
    ).not.toThrow();
  });

  it("keeps each host and Project's answer apart and drops the oldest past its cap", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 10; index += 1) {
      writeHomeListCache(
        storage,
        `scope-${String(index)}`,
        [section("continue", [row("a", "continue", `Title ${String(index)}`)])],
        { now: index },
      );
    }
    expect(readHomeListCache(storage, "scope-9")?.[0]?.rows[0]?.title).toBe("Title 9");
    expect(readHomeListCache(storage, "scope-0")).toBeUndefined();
  });
});

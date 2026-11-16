/** Keep a readable transcript as terminal width changes. */
export function agentTuiLayout(columns: number) {
  return { sidebar: columns >= 100, info: columns >= 140, sidebarWidth: 26, infoWidth: 28 };
}

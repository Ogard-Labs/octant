# 0158. First task entry keeps setup optional

**Status:** Accepted

## Context

A review of first-task entry found that the required display name delayed work,
large suggestions competed with the composer, and the empty Code workspace hid
its setup routes inside the Project picker. Profile editing also dominated
General settings despite having no effect on task readiness or authority.

## Decision

- Supersede 0033: a display name is optional in first run, as it is in the
  profile contract. Skip setup is available from the first step; dismissal
  records the same skipped outcome. No name is inferred from the OS account.
- Every setup step remains reachable without a name. Existing answers are
  preserved, and first run still waits for pending writes and avatar imports;
  rejected writes leave it pending, as required by 0019.
  An invalid replacement name retains the last settled name when setup is skipped.
- Skipping grants no authority and creates no thread. Provider, Project, model,
  and permission readiness remain checked when work is actually requested.
- Profile has its own Personal settings destination. Its fields remain open
  under 0072; General prioritizes operational defaults. Existing links to the
  profile setting continue to reach it.
- Empty Code entry exposes folder setup and, where available, a direct route
  to the projectless-thread setting. Opening that setting never enables it.
- Code suggestions keep their full descriptions visible and fill the existing
  composer when chosen. The welcome pattern remains user-controlled under
  0091, with quieter defaults and a clear central reading column.
- Continue retains recent threads and their status, Project, branch, provider,
  pull-request details, and resume action. Rows adapt to the workspace width;
  background refresh keeps the previous list visible until new data arrives.
- The compact model picker uses a horizontal source bar and single-line model
  rows where provider and capability information would otherwise repeat.
  Search, Favorites, and Recent retain provider identity per row. Recent keeps
  the last five explicit model choices locally; it does not change readiness.
- Favorite actions name their model. Search leads into keyboard model navigation,
  and a native range control supports dragging and keyboard adjustment of only
  the reasoning levels the selected model declares.

## Consequences

- The existing unnamed-profile presentation remains valid after skipping.
- First run and Settings share the existing profile editor and persistence.
- These are presentation and entry changes, not new model capabilities,
  permission grants, provider integrations, or execution paths.

## Related

- 0019 User profile and first-run setup
- 0033 First run asks what to call you
- 0072 Settings collections stay open
- 0073 One surface language
- 0091 The application ground is the theme pattern or a photo

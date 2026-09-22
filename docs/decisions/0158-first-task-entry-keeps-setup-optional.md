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
- Skipping grants no authority and creates no thread. Provider, Project, model,
  and permission readiness remain checked when work is actually requested.
- Profile has its own Personal settings destination. Its fields remain open
  under 0072; General prioritizes operational defaults. Existing links to the
  profile setting continue to reach it.
- Empty Code entry exposes folder setup and, where available, a direct route
  to the projectless-thread setting. Opening that setting never enables it.
- Code suggestions are compact labels that fill the existing composer; their
  full descriptions are available on request. The welcome pattern remains
  user-controlled under 0091, with a quieter default opacity and intensity.
- The model picker identifies its active provider, avoids repeating that
  provider on every row, and names each favorite action for its model.
  Search and mixed-provider favorites retain provider identity per row.

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

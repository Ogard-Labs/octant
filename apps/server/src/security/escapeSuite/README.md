# Escape suite (Security S4)

Adversarial regression fixtures for the "Escape suite fails closed" exit gate.
Canonical design: `docs/security/security-architecture-threat-model.md` §§ Escape Suite.

## Layers

| Layer                    | What runs                                                                     | Where                                                                    |
| ------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1 Pure policy            | Truth tables against fail-closed domain / extension modules                   | `packages/domain/src/escapeSuitePolicy.test.ts` (+ extension activation) |
| 2 Server integration     | Fixture rows → structured denial + correlated audit event + zero side effects | `apps/server/src/security/escapeSuite/*.test.ts`                         |
| 3 Sandbox runtime probes | Real OS denials: Seatbelt on macOS, Bubblewrap on Linux (see below)           | macOS CI job, Linux client-trust CI job, packaged Work confinement gate  |

## Layer 3: where the native probes run

Each probe skips itself where its sandbox is absent, so the CI job that has the
sandbox lists the file explicitly. A probe named in no job does not run in CI.

| Probe                                                                                        | Sandbox                               | Runs in                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process/seatbeltProfile.test.ts` (writes outside the root, Keychain and home reads, egress) | Seatbelt                              | `ci.yml` › Desktop and scripts (macOS) › Seatbelt escape probes                                                                                         |
| `process/sessionEscapeProcess.test.ts` (a child that starts its own session)                 | Seatbelt                              | same step                                                                                                                                               |
| `process/secretGuard.test.ts`, `secretStores/confinedCommandCredentialProcess.test.ts`       | Seatbelt                              | same step                                                                                                                                               |
| `network/providerRuntimeNetwork.hostile.test.ts` (a wrapped runtime reaches only its proxy)  | Seatbelt; Bubblewrap where `bwrap` is | same step on macOS                                                                                                                                      |
| `providers/outsideDriverProcess.escape.test.ts`                                              | Seatbelt                              | `ci.yml` › Desktop and scripts (macOS)                                                                                                                  |
| `process/linuxConfinement.test.ts` › a provider runtime under Bubblewrap (credential reads)  | Bubblewrap                            | `ci.yml` › Desktop Linux client trust, with `OCTANT_REQUIRE_LINUX_ISOLATION=1` so a missing `bwrap` fails                                               |
| `scripts/smoke-packaged-work-confinement.ts` (App Sandbox, XPC broker, selected folder)      | App Sandbox                           | `packaged-work-confinement.yml` on a change to the gate, or by hand: `bun run smoke:packaged-work-confinement` on an arm64 Mac that allows UI scripting |

The other host-Bubblewrap cases in `process/linuxConfinement.test.ts` skip
wherever `bwrap` is not installed; only the client-trust job installs it and
relaxes Ubuntu's user-namespace restriction for it.

## S1 mapping (`toolCallPolicy`)

The unified `toolCallPolicy` choke point (S1) is not merged on this branch. Layer 1–2 rows call the **current** fail-closed modules and record the eventual `toolCallPolicy` resolution step they map to:

| Escape-suite fixture         | Current module(s)                                     | Future `toolCallPolicy` step        |
| ---------------------------- | ----------------------------------------------------- | ----------------------------------- |
| `injected-readme`            | `toolActionPolicy`, `workConfinementPolicy`           | catalog / schema / approval / taint |
| `rogue-mcp-server`           | `packages/plugin-host` activation, `toolActionPolicy` | extension-capability / activation   |
| `scope-widening-child`       | `agentRunPolicy`                                      | child-clamp                         |
| `overreaching-remote-client` | `remoteAccessPolicy`, `codePolicy`                    | remote-principal                    |

When S1 lands, prefer routing these rows through `toolCallPolicy` while keeping the same structured denial codes and audit event names.

## Fixtures

Inert data only under `fixtures/`. The rogue MCP server is a local supervised process
descriptor — never a network dependency.

# Escape suite (Security S4)

Adversarial regression fixtures for the "Escape suite fails closed" exit gate.
Canonical design: `docs/security/security-architecture-threat-model.md` §§ Escape Suite.

## Layers

| Layer                    | What runs                                                                                           | Where                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1 Pure policy            | Truth tables against fail-closed domain / extension modules                                         | `packages/domain/src/escapeSuitePolicy.test.ts` (+ extension activation) |
| 2 Server integration     | Fixture rows → structured denial + correlated audit event + zero side effects                       | `apps/server/src/security/escapeSuite/*.test.ts`                         |
| 3 Sandbox runtime probes | macOS Seatbelt OS denials for writes outside bound root, `~/` / Keychain reads, egress under `none` | **Out-of-band / native evidence** — not executed on Linux CI runners     |

## S1 mapping (`toolCallPolicy`)

The unified `toolCallPolicy` choke point (S1) is not merged on this branch. Layer 1–2 rows call the **current** fail-closed modules and record the eventual `toolCallPolicy` resolution step they map to:

| Escape-suite fixture         | Current module(s)                                    | Future `toolCallPolicy` step        |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------- |
| `injected-readme`            | `toolActionPolicy`, `workConfinementPolicy`          | catalog / schema / approval / taint |
| `rogue-mcp-server`           | `packages/extensions` activation, `toolActionPolicy` | extension-capability / activation   |
| `scope-widening-child`       | `agentRunPolicy`                                     | child-clamp                         |
| `overreaching-remote-client` | `remoteAccessPolicy`, `codePolicy`                   | remote-principal                    |

When S1 lands, prefer routing these rows through `toolCallPolicy` while keeping the same structured denial codes and audit event names.

## Fixtures

Inert data only under `fixtures/`. The rogue MCP server is a local supervised process
descriptor — never a network dependency.

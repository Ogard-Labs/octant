import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type ProviderInstance,
  type ProviderObservedState,
  type ProviderRegistrySnapshot,
} from "@octant/contracts";
import type { ProviderClient } from "@octant/client-runtime/provider-client";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProviderController } from "./useProviderController";
import type { OctantHostBridge } from "../shell/hostBridge";

const id = decodeProviderInstanceId("80000000-0000-4000-8000-000000000091");

describe("useProviderController", () => {
  it.each([
    ["opencode", "create-opencode-provider", "OpenCode local", "/opt/homebrew/bin/opencode"],
    ["codex", "create-codex-provider", "Codex local", "/opt/homebrew/bin/codex"],
    ["kimi-code", "create-kimi-code-provider", "Kimi local", "/opt/homebrew/bin/kimi"],
  ] as const)(
    "creates a %s instance through its strict command",
    async (driverKind, commandKind, displayName, binaryPath) => {
      const api = client();
      vi.mocked(api.execute).mockResolvedValueOnce({
        kind: "provider-created",
        instance: provider(
          driverKind === "opencode"
            ? { displayName, configuration: { kind: "opencode-cli", binaryPath } }
            : driverKind === "codex"
              ? {
                  displayName,
                  driverKind: "codex",
                  configuration: { kind: "codex-cli", binaryPath },
                }
              : {
                  displayName,
                  driverKind: "kimi-code",
                  configuration: { kind: "kimi-code-acp", binaryPath },
                },
        ),
      });
      const { result } = renderHook(() => useProviderController({ client: api }));
      await waitFor(() => expect(result.current.status).toBe("ready"));

      await act(async () => {
        await expect(result.current.create(driverKind, displayName, binaryPath)).resolves.toBe(
          true,
        );
      });

      expect(api.execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: commandKind, displayName, binaryPath }),
      );
    },
  );

  it("creates Devin through a strict subscription-only configuration command", async () => {
    const api = client();
    vi.mocked(api.execute).mockImplementationOnce(async (command) => ({
      kind: "provider-created",
      instance: devinProvider({ id: "instanceId" in command ? command.instanceId : id }),
    }));
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.create("devin", "Devin local", "/Users/example/.local/bin/devin"),
      ).resolves.toBe(true);
    });

    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-devin-provider",
        displayName: "Devin local",
        configuration: {
          kind: "devin-acp",
          binaryPath: "/Users/example/.local/bin/devin",
          authentication: "subscription",
        },
      }),
    );
  });

  it("creates Pi through a strict non-secret RPC configuration command", async () => {
    const api = client();
    vi.mocked(api.execute).mockImplementationOnce(async (command) => ({
      kind: "provider-created",
      instance: piProvider({ id: "instanceId" in command ? command.instanceId : id }),
    }));
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(result.current.create("pi", "Pi local", "/opt/homebrew/bin/pi")).resolves.toBe(
        true,
      );
    });

    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-pi-provider",
        displayName: "Pi local",
        configuration: { kind: "pi-rpc", binaryPath: "/opt/homebrew/bin/pi" },
      }),
    );
    expect(JSON.stringify(vi.mocked(api.execute).mock.calls)).not.toMatch(/apiKey|oauthToken/);
  });

  it("creates Oh My Pi through a strict non-secret RPC configuration with pinned version", async () => {
    const api = client();
    vi.mocked(api.execute).mockImplementationOnce(async (command) => ({
      kind: "provider-created",
      instance: ohMyPiProvider({ id: "instanceId" in command ? command.instanceId : id }),
    }));
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.create("oh-my-pi", "Oh My Pi local", "/Users/example/.bun/bin/omp"),
      ).resolves.toBe(true);
    });

    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-oh-my-pi-provider",
        displayName: "Oh My Pi local",
        configuration: {
          kind: "oh-my-pi-rpc",
          binaryPath: "/Users/example/.bun/bin/omp",
          supportedVersion: "17.2.1",
        },
      }),
    );
    expect(JSON.stringify(vi.mocked(api.execute).mock.calls)).not.toMatch(/apiKey|oauthToken/);
  });

  it("creates Kilo through a strict non-secret ACP configuration command", async () => {
    const api = client();
    vi.mocked(api.execute).mockImplementationOnce(async (command) => ({
      kind: "provider-created",
      instance: kiloProvider({ id: "instanceId" in command ? command.instanceId : id }),
    }));
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.create("kilo", "Kilo local", "/opt/homebrew/bin/kilo"),
      ).resolves.toBe(true);
    });

    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-kilo-provider",
        displayName: "Kilo local",
        configuration: { kind: "kilo-acp", binaryPath: "/opt/homebrew/bin/kilo" },
      }),
    );
    expect(JSON.stringify(vi.mocked(api.execute).mock.calls)).not.toMatch(/apiKey|oauthToken/);
  });

  it("creates and reconfigures Ollama through strict non-secret loopback commands", async () => {
    const api = client();
    vi.mocked(api.execute)
      .mockImplementationOnce(async (command) => ({
        kind: "provider-created",
        instance: ollamaProvider({ id: "instanceId" in command ? command.instanceId : id }),
      }))
      .mockImplementationOnce(async (command) => ({
        kind: "provider-updated",
        instance: ollamaProvider({
          id: "instanceId" in command ? command.instanceId : id,
          configuration: {
            kind: "ollama-native-http",
            baseUrl: "http://localhost:11434",
          },
          version: 2 as never,
        }),
      }));
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createOllama("Ollama local", {
          kind: "ollama-native-http",
          baseUrl: "http://127.0.0.1:11434",
        }),
      ).resolves.toBe(true);
    });
    await waitFor(() =>
      expect(result.current.instances.some((instance) => instance.driverKind === "ollama")).toBe(
        true,
      ),
    );
    const createdId = result.current.instances.find(
      (instance) => instance.driverKind === "ollama",
    )!.id;
    await act(async () => {
      await expect(
        result.current.changeOllamaConfiguration(createdId, {
          kind: "ollama-native-http",
          baseUrl: "http://localhost:11434",
        }),
      ).resolves.toBe(true);
    });

    expect(api.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "create-ollama-provider",
        displayName: "Ollama local",
        configuration: {
          kind: "ollama-native-http",
          baseUrl: "http://127.0.0.1:11434",
        },
      }),
    );
    expect(api.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "change-ollama-configuration",
        configuration: {
          kind: "ollama-native-http",
          baseUrl: "http://localhost:11434",
        },
      }),
    );
    expect(JSON.stringify(vi.mocked(api.execute).mock.calls)).not.toMatch(
      /apiKey|authorization|credential/,
    );
  });

  it("loads the current-session default and serializes provider mutations", async () => {
    const first =
      deferred<ReturnType<ProviderClient["execute"]> extends Promise<infer T> ? T : never>();
    const api = client();
    vi.mocked(api.execute)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        kind: "provider-updated",
        instance: provider({ version: 2 as never }),
      });
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.defaults.permissionPersistence).toBe("current-session");

    let rename!: Promise<boolean>;
    let disable!: Promise<boolean>;
    act(() => {
      rename = result.current.rename(id, "Local CLI");
      disable = result.current.setEnabled(id, false);
    });
    await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(1));
    first.resolve({ kind: "provider-updated", instance: provider({ displayName: "Local CLI" }) });
    await expect(rename).resolves.toBe(true);
    await expect(disable).resolves.toBe(true);
    expect(api.execute).toHaveBeenCalledTimes(2);
  });

  it("recovers authoritative state after a lost mutation response without replaying it", async () => {
    const api = client();
    vi.mocked(api.execute).mockRejectedValueOnce({
      category: "unavailable",
      message: "Octant Provider service is unavailable.",
    });
    vi.mocked(api.bootstrap)
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(
        snapshot([provider({ displayName: "Recovered name", version: 2 as never })]),
      );
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await expect(result.current.rename(id, "Recovered name")).resolves.toBe(false);
    });
    expect(api.execute).toHaveBeenCalledOnce();
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
    expect(result.current.instances[0]?.displayName).toBe("Recovered name");
    expect(result.current.message).toMatch(/authoritative provider state/i);
  });

  it("shows probe progress and keeps normalized results only", async () => {
    const pending = deferred<Awaited<ReturnType<ProviderClient["probe"]>>>();
    const api = client();
    vi.mocked(api.probe).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let check!: Promise<boolean>;
    act(() => {
      check = result.current.probe(id);
    });
    expect(result.current.probingIds.has(id)).toBe(true);
    pending.resolve(observation());
    await expect(check).resolves.toBe(true);
    await waitFor(() => expect(result.current.probingIds.has(id)).toBe(false));
    expect(result.current.observedByInstance.get(id)?.readiness).toBe("ready");
  });

  it("clears prior discovery immediately and installs authoritative probe failure", async () => {
    const pending = deferred<Awaited<ReturnType<ProviderClient["probe"]>>>();
    const failed = failureObservation("unauthenticated");
    const api = client();
    vi.mocked(api.bootstrap)
      .mockResolvedValueOnce(snapshot([provider()], [observation()]))
      .mockResolvedValueOnce(snapshot([provider()], [failed]));
    vi.mocked(api.probe).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.observedByInstance.get(id)?.readiness).toBe("ready"));

    let check!: Promise<boolean>;
    act(() => {
      check = result.current.probe(id);
    });
    expect(result.current.observedByInstance.get(id)).toBeUndefined();
    pending.reject({ category: "unauthenticated", message: "secret provider diagnostic" });
    await expect(check).resolves.toBe(false);

    await waitFor(() =>
      expect(result.current.observedByInstance.get(id)?.readiness).toBe("unauthenticated"),
    );
    expect(result.current.observedByInstance.get(id)?.models).toEqual([]);
    expect(new Set(Object.values(result.current.observedByInstance.get(id)!.capabilities))).toEqual(
      new Set(["unavailable"]),
    );
    expect(result.current.message).not.toContain("secret provider diagnostic");
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("keeps prior discovery cleared when probe failure refresh is unavailable", async () => {
    const pending = deferred<Awaited<ReturnType<ProviderClient["probe"]>>>();
    const api = client();
    vi.mocked(api.bootstrap)
      .mockResolvedValueOnce(snapshot([provider()], [observation()]))
      .mockRejectedValueOnce(new Error("secret refresh diagnostic"));
    vi.mocked(api.probe).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.observedByInstance.get(id)?.readiness).toBe("ready"));

    let check!: Promise<boolean>;
    act(() => {
      check = result.current.probe(id);
    });
    expect(result.current.observedByInstance.get(id)).toBeUndefined();
    pending.reject({ category: "unavailable", message: "secret provider diagnostic" });
    await expect(check).resolves.toBe(false);

    expect(result.current.observedByInstance.get(id)).toBeUndefined();
    expect(result.current.status).toBe("ready");
    await waitFor(() =>
      expect(result.current.message).toBe("Octant Provider service is unavailable."),
    );
    expect(result.current.message).not.toMatch(/secret provider|secret refresh/i);
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("creates non-secret configuration before storing a bearer credential", async () => {
    const calls: string[] = [];
    const api = client();
    vi.mocked(api.execute).mockImplementation(async (command) => {
      calls.push("provider.create");
      expect(command.kind).toBe("create-openai-compatible-provider");
      return {
        kind: "provider-created",
        instance: httpProvider({ id: "instanceId" in command ? command.instanceId : id }),
      };
    });
    const host = credentialHost(calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createOpenAiCompatible(
          "Gateway",
          httpProvider().configuration,
          transientCredential("private-value", calls),
        ),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual(["provider.create", "credential.set", "field.clear"]);
    expect(JSON.stringify(result.current)).not.toContain("private-value");
  });

  it("creates an image profile before storing its write-only credential and purges it on remove", async () => {
    const calls: string[] = [];
    const created = openAiImageProvider();
    const api = client();
    vi.mocked(api.execute).mockImplementation(async (command) => {
      if (command.kind === "create-openai-image-provider") {
        calls.push("provider.create");
        return { kind: "provider-created", instance: { ...created, id: command.instanceId } };
      }
      if (command.kind !== "remove-provider") {
        throw new Error(`unexpected provider command ${command.kind}`);
      }
      calls.push("provider.remove");
      return { kind: "provider-removed", instanceId: command.instanceId, version: 2 as never };
    });
    const host = credentialHost(calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createOpenAiImage(
          "GPT Image",
          created.configuration,
          transientCredential("image-secret", calls),
        ),
      ).resolves.toBe(true);
    });
    expect(calls).toEqual(["provider.create", "credential.set", "field.clear"]);
    expect(JSON.stringify(result.current)).not.toContain("image-secret");

    const createdId = result.current.instances.find(
      (instance) => instance.driverKind === "openai-image",
    )?.id;
    expect(createdId).toBeDefined();
    if (createdId === undefined) throw new Error("expected created image profile");

    await act(async () => {
      await expect(result.current.remove(createdId)).resolves.toBe(true);
    });
    expect(calls).toEqual([
      "provider.create",
      "credential.set",
      "field.clear",
      "provider.remove",
      "credential.clear",
    ]);
    expect(host.clearProviderCredential).toHaveBeenCalledWith(createdId);
  });

  it("creates a BFL image profile before storing its write-only credential and purges it on remove", async () => {
    const calls: string[] = [];
    const created = bflImageProvider();
    const api = client();
    vi.mocked(api.execute).mockImplementation(async (command) => {
      if (command.kind === "create-bfl-image-provider") {
        calls.push("provider.create");
        return { kind: "provider-created", instance: { ...created, id: command.instanceId } };
      }
      if (command.kind !== "remove-provider") {
        throw new Error(`unexpected provider command ${command.kind}`);
      }
      calls.push("provider.remove");
      return { kind: "provider-removed", instanceId: command.instanceId, version: 2 as never };
    });
    const host = credentialHost(calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createBflImage(
          "FLUX",
          created.configuration,
          transientCredential("bfl-secret", calls),
        ),
      ).resolves.toBe(true);
    });
    expect(calls).toEqual(["provider.create", "credential.set", "field.clear"]);
    expect(JSON.stringify(result.current)).not.toContain("bfl-secret");

    const createdId = result.current.instances.find(
      (instance) => instance.driverKind === "bfl-image",
    )?.id;
    expect(createdId).toBeDefined();
    if (createdId === undefined) throw new Error("expected created image profile");

    await act(async () => {
      await expect(result.current.remove(createdId)).resolves.toBe(true);
    });
    expect(calls).toEqual([
      "provider.create",
      "credential.set",
      "field.clear",
      "provider.remove",
      "credential.clear",
    ]);
    expect(host.clearProviderCredential).toHaveBeenCalledWith(createdId);
  });

  it("creates Claude subscription configuration without credential mutation", async () => {
    const calls: string[] = [];
    const api = client();
    vi.mocked(api.execute).mockImplementation(async (command) => {
      calls.push("provider.create");
      expect(command).toMatchObject({
        kind: "create-claude-provider",
        configuration: { authentication: "subscription" },
      });
      return {
        kind: "provider-created",
        instance: claudeProvider({ id: "instanceId" in command ? command.instanceId : id }),
      };
    });
    const host = credentialHost(calls);
    const credential = transientCredential("must-not-be-used", calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createClaude("Claude local", claudeProvider().configuration, credential),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual(["provider.create", "field.clear"]);
    expect(host.setProviderCredential).not.toHaveBeenCalled();
    expect(host.clearProviderCredential).not.toHaveBeenCalled();
  });

  it("creates Claude API-key configuration before write-only credential storage", async () => {
    const calls: string[] = [];
    const api = client();
    vi.mocked(api.execute).mockImplementation(async (command) => {
      calls.push("provider.create");
      return {
        kind: "provider-created",
        instance: claudeProvider({
          id: "instanceId" in command ? command.instanceId : id,
          configuration: {
            kind: "claude-agent-sdk",
            binaryPath: "/opt/homebrew/bin/claude",
            authentication: "api-key",
          },
        }),
      };
    });
    const host = credentialHost(calls);
    const credential = transientCredential("private-value", calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createClaude(
          "Claude key",
          {
            kind: "claude-agent-sdk",
            binaryPath: "/opt/homebrew/bin/claude",
            authentication: "api-key",
          },
          credential,
        ),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual(["provider.create", "credential.set", "field.clear"]);
    expect(JSON.stringify(result.current)).not.toContain("private-value");
  });

  it("creates Mistral Vibe API-key configuration before write-only credential storage", async () => {
    const calls: string[] = [];
    const api = client();
    vi.mocked(api.execute).mockImplementation(async (command) => {
      calls.push("provider.create");
      return {
        kind: "provider-created",
        instance: vibeProvider({
          id: "instanceId" in command ? command.instanceId : id,
          configuration: {
            kind: "mistral-vibe-acp",
            binaryPath: "/Users/example/.local/bin/vibe-acp",
            authentication: "api-key",
          },
        }),
      };
    });
    const host = credentialHost(calls);
    const credential = transientCredential("private-value", calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createMistralVibe(
          "Mistral Vibe local",
          vibeProvider({
            configuration: {
              kind: "mistral-vibe-acp",
              binaryPath: "/Users/example/.local/bin/vibe-acp",
              authentication: "api-key",
            },
          }).configuration,
          credential,
        ),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual(["provider.create", "credential.set", "field.clear"]);
    expect(JSON.stringify(result.current)).not.toContain("private-value");
  });

  it("starts and completes provider-native browser authentication without token data", async () => {
    const api = client(snapshot([vibeProvider()]));
    vi.mocked(api.execute)
      .mockResolvedValueOnce({
        kind: "provider-authentication-started",
        instanceId: id,
        attempt: {
          attemptId: "provider-attempt-1" as never,
          signInUrl: "https://auth.mistral.example/attempt",
          expiresAt: "2026-07-17T11:00:00.000Z" as never,
        },
      })
      .mockResolvedValueOnce({ kind: "provider-authentication-completed", instanceId: id });
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let attempt: Awaited<ReturnType<typeof result.current.beginProviderAuthentication>>;
    await act(async () => {
      attempt = await result.current.beginProviderAuthentication(id);
    });
    expect(attempt).toMatchObject({
      attemptId: "provider-attempt-1",
      signInUrl: "https://auth.mistral.example/attempt",
    });
    await act(async () => {
      await expect(
        result.current.completeProviderAuthentication(id, attempt!.attemptId),
      ).resolves.toBe(true);
    });
    expect(api.execute).toHaveBeenNthCalledWith(1, {
      kind: "begin-provider-authentication",
      instanceId: id,
    });
    expect(api.execute).toHaveBeenNthCalledWith(2, {
      kind: "complete-provider-authentication",
      instanceId: id,
      attemptId: "provider-attempt-1",
    });
    expect(JSON.stringify(attempt)).not.toMatch(/token|credential|api.?key/i);
  });

  it("keeps a created Claude provider visible when API-key storage fails", async () => {
    const calls: string[] = [];
    const api = client();
    vi.mocked(api.execute).mockResolvedValue({
      kind: "provider-created",
      instance: claudeProvider({
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "api-key",
        },
      }),
    });
    const host = credentialHost(calls);
    vi.mocked(host.setProviderCredential).mockImplementation(async () => {
      calls.push("credential.set");
      throw new Error("private-value raw Keychain diagnostic");
    });
    const credential = transientCredential("private-value", calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createClaude(
          "Claude key",
          {
            kind: "claude-agent-sdk",
            binaryPath: "/opt/homebrew/bin/claude",
            authentication: "api-key",
          },
          credential,
        ),
      ).resolves.toBe(false);
    });

    expect(calls).toEqual(["credential.set", "field.clear"]);
    expect(result.current.instances).toHaveLength(2);
    expect(result.current.message).not.toMatch(/private-value|Keychain/i);
  });

  it("clears a Claude API key after switching durable configuration to subscription", async () => {
    const calls: string[] = [];
    const apiKeyProvider = claudeProvider({
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "api-key",
      },
    });
    const api = client(snapshot([apiKeyProvider]));
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.update");
      return {
        kind: "provider-updated",
        instance: claudeProvider({ version: 2 as never }),
      };
    });
    const host = credentialHost(calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeClaudeConfiguration(
          id,
          claudeProvider().configuration,
          transientCredential("", calls),
        ),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual(["provider.update", "credential.clear", "field.clear"]);
  });

  // A clear that fails once the instance has stopped using the key leaves a
  // secret behind rather than an unusable provider, so the change stands and
  // cleanup is retried later.
  it("defers Claude credential cleanup when deletion fails after the switch to subscription", async () => {
    const apiKeyProvider = claudeProvider({
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: "/opt/homebrew/bin/claude",
        authentication: "api-key",
      },
    });
    const api = client(snapshot([apiKeyProvider]));
    vi.mocked(api.execute).mockResolvedValue({
      kind: "provider-updated",
      instance: claudeProvider({ version: 2 as never }),
    });
    const host = credentialHost();
    vi.mocked(host.clearProviderCredential).mockRejectedValueOnce(new Error("private diagnostic"));
    const credential = transientCredential("");
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeClaudeConfiguration(id, claudeProvider().configuration, credential),
      ).resolves.toBe(true);
    });

    expect(api.execute).toHaveBeenCalledOnce();
    expect(credential.clear).toHaveBeenCalledOnce();
    expect(result.current.instances[0]?.configuration).toMatchObject({
      authentication: "subscription",
    });
    expect(JSON.stringify(result.current)).not.toContain("private diagnostic");

    await act(async () => {
      await expect(result.current.retry()).resolves.toBe(true);
    });

    expect(host.clearProviderCredential).toHaveBeenCalledTimes(2);
    expect(result.current.message).toMatch(/credential cleanup completed/i);
  });

  it("stores a non-empty key before switching Claude subscription to API-key mode", async () => {
    const calls: string[] = [];
    const api = client(snapshot([claudeProvider()]));
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.update");
      return {
        kind: "provider-updated",
        instance: claudeProvider({
          version: 2 as never,
          configuration: {
            kind: "claude-agent-sdk",
            binaryPath: "/opt/homebrew/bin/claude",
            authentication: "api-key",
          },
        }),
      };
    });
    const host = credentialHost(calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeClaudeConfiguration(
          id,
          {
            kind: "claude-agent-sdk",
            binaryPath: "/opt/homebrew/bin/claude",
            authentication: "api-key",
          },
          transientCredential("private-value", calls),
        ),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual(["credential.set", "provider.update", "field.clear"]);
  });

  it("rolls back a newly stored key when switching Claude to API-key mode fails", async () => {
    const calls: string[] = [];
    const api = client(snapshot([claudeProvider()]));
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.update");
      throw new Error("private registry diagnostic");
    });
    const host = credentialHost(calls);
    const credential = transientCredential("private-value", calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeClaudeConfiguration(
          id,
          {
            kind: "claude-agent-sdk",
            binaryPath: "/opt/homebrew/bin/claude",
            authentication: "api-key",
          },
          credential,
        ),
      ).resolves.toBe(false);
    });

    expect(calls).toEqual(["credential.set", "provider.update", "credential.clear", "field.clear"]);
    expect(result.current.instances[0]?.configuration).toMatchObject({
      authentication: "subscription",
    });
    expect(result.current.message).not.toContain("private registry diagnostic");
  });

  it("preserves explicit API-key configuration when rollback cleanup also fails", async () => {
    const calls: string[] = [];
    const apiKeyConfiguration = {
      kind: "claude-agent-sdk" as const,
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "api-key" as const,
    };
    const api = client(snapshot([claudeProvider()]));
    vi.mocked(api.execute)
      .mockImplementationOnce(async () => {
        calls.push("provider.update");
        throw new Error("private registry diagnostic");
      })
      .mockImplementationOnce(async () => {
        calls.push("provider.recovery-update");
        return {
          kind: "provider-updated",
          instance: claudeProvider({ version: 2 as never, configuration: apiKeyConfiguration }),
        };
      });
    const host = credentialHost(calls);
    vi.mocked(host.clearProviderCredential).mockImplementationOnce(async () => {
      calls.push("credential.clear");
      throw new Error("private cleanup diagnostic");
    });
    const credential = transientCredential("private-value", calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeClaudeConfiguration(id, apiKeyConfiguration, credential),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual([
      "credential.set",
      "provider.update",
      "credential.clear",
      "provider.recovery-update",
      "field.clear",
    ]);
    expect(result.current.instances[0]?.configuration).toMatchObject({
      authentication: "api-key",
    });
    expect(result.current.message).toMatch(/saved.*check the connection/i);
    expect(JSON.stringify(result.current)).not.toMatch(
      /private-value|private registry diagnostic|private cleanup diagnostic/,
    );
  });

  it("retries cleanup when API-key configuration recovery cannot be persisted", async () => {
    const calls: string[] = [];
    const apiKeyConfiguration = {
      kind: "claude-agent-sdk" as const,
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "api-key" as const,
    };
    const api = client(snapshot([claudeProvider()]));
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.update");
      throw new Error("private registry diagnostic");
    });
    const host = credentialHost(calls);
    vi.mocked(host.clearProviderCredential).mockImplementationOnce(async () => {
      calls.push("credential.clear");
      throw new Error("private cleanup diagnostic");
    });
    const credential = transientCredential("private-value", calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeClaudeConfiguration(id, apiKeyConfiguration, credential),
      ).resolves.toBe(false);
    });

    expect(api.execute).toHaveBeenCalledTimes(2);
    expect(result.current.instances[0]?.configuration).toMatchObject({
      authentication: "subscription",
    });
    expect(result.current.message).toMatch(/credential.*cleanup.*retry.*remove/i);
    expect(JSON.stringify(result.current)).not.toMatch(
      /private-value|private registry diagnostic|private cleanup diagnostic/,
    );

    await act(async () => {
      await expect(result.current.retry()).resolves.toBe(true);
    });

    expect(host.clearProviderCredential).toHaveBeenCalledTimes(2);
    expect(result.current.message).toMatch(/credential cleanup completed/i);
  });

  it("rediscovers cleanup-required credentials after a controller reload", async () => {
    const api = client(snapshot([claudeProvider()]));
    const host = credentialHost();
    vi.mocked(host.providerCredentialStatus)
      .mockResolvedValueOnce("stored")
      .mockResolvedValue("missing");
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));

    await waitFor(() => expect(result.current.message).toMatch(/cleanup.*retry.*remove/i));
    expect(host.clearProviderCredential).not.toHaveBeenCalled();

    await act(async () => {
      await expect(result.current.retry()).resolves.toBe(true);
    });

    expect(host.clearProviderCredential).toHaveBeenCalledWith(id);
    expect(result.current.message).toMatch(/credential cleanup completed/i);
  });

  it.each(["rejects", "returns unavailable"] as const)(
    "blocks subscription removal when credential status %s during reload",
    async (outcome) => {
      const api = client(snapshot([claudeProvider()]));
      vi.mocked(api.execute).mockResolvedValue({
        kind: "provider-removed",
        instanceId: id,
        version: 2 as never,
      });
      const host = credentialHost();
      if (outcome === "rejects") {
        vi.mocked(host.providerCredentialStatus).mockRejectedValue(
          new Error("private status diagnostic"),
        );
      } else {
        vi.mocked(host.providerCredentialStatus).mockResolvedValue("unavailable");
      }
      const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));

      await waitFor(() =>
        expect(result.current.message).toMatch(/status.*could not be verified.*retry.*remov/i),
      );
      await act(async () => {
        await expect(result.current.remove(id)).resolves.toBe(false);
      });

      expect(api.execute).not.toHaveBeenCalled();
      expect(host.clearProviderCredential).not.toHaveBeenCalled();
      expect(result.current.instances).toHaveLength(1);
      expect(JSON.stringify(result.current)).not.toContain("private status diagnostic");
    },
  );

  it("retries unavailable status before confirmed-missing subscription removal", async () => {
    const api = client(snapshot([claudeProvider()]));
    vi.mocked(api.execute).mockResolvedValue({
      kind: "provider-removed",
      instanceId: id,
      version: 2 as never,
    });
    const host = credentialHost();
    vi.mocked(host.providerCredentialStatus)
      .mockResolvedValueOnce("unavailable")
      .mockResolvedValue("missing");
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.message).toMatch(/status.*could not be verified/i));

    await act(async () => {
      await expect(result.current.retry()).resolves.toBe(true);
    });

    expect(result.current.message).toMatch(/credential status.*verified/i);
    await act(async () => {
      await expect(result.current.remove(id)).resolves.toBe(true);
    });
    expect(host.clearProviderCredential).not.toHaveBeenCalled();
    expect(api.execute).toHaveBeenCalledOnce();
    expect(result.current.instances).toHaveLength(0);
  });

  it("clears unconfirmed subscription status after switching to API-key mode", async () => {
    const calls: string[] = [];
    const apiKeyConfiguration = {
      kind: "claude-agent-sdk" as const,
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "api-key" as const,
    };
    const apiKeyProvider = claudeProvider({
      version: 2 as never,
      configuration: apiKeyConfiguration,
    });
    const api = client(snapshot([claudeProvider()]));
    vi.mocked(api.bootstrap)
      .mockResolvedValueOnce(snapshot([claudeProvider()]))
      .mockResolvedValue(snapshot([apiKeyProvider]));
    vi.mocked(api.execute).mockImplementation(async (command) => {
      if (command.kind === "change-claude-configuration") {
        calls.push("provider.update");
        return { kind: "provider-updated", instance: apiKeyProvider };
      }
      calls.push("provider.remove");
      return { kind: "provider-removed", instanceId: id, version: 3 as never };
    });
    const host = credentialHost(calls);
    vi.mocked(host.providerCredentialStatus).mockResolvedValue("unavailable");
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.message).toMatch(/status.*could not be verified/i));

    await act(async () => {
      await expect(
        result.current.changeClaudeConfiguration(
          id,
          apiKeyConfiguration,
          transientCredential("private-value", calls),
        ),
      ).resolves.toBe(true);
      await expect(result.current.retry()).resolves.toBe(true);
    });

    expect(result.current.message ?? "").not.toMatch(/credential status.*verified/i);
    expect(host.providerCredentialStatus).toHaveBeenCalledOnce();
    await act(async () => {
      await expect(result.current.remove(id)).resolves.toBe(true);
    });
    expect(calls).toEqual([
      "credential.set",
      "provider.update",
      "field.clear",
      "provider.remove",
      "credential.clear",
    ]);
    expect(result.current.instances).toHaveLength(0);
  });

  it("clears cleanup-required credentials after removing a subscription provider", async () => {
    const calls: string[] = [];
    const apiKeyConfiguration = {
      kind: "claude-agent-sdk" as const,
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "api-key" as const,
    };
    const api = client(snapshot([claudeProvider()]));
    vi.mocked(api.execute).mockImplementation(async (command) => {
      if (command.kind === "change-claude-configuration") {
        calls.push("provider.update");
        throw new Error("private registry diagnostic");
      }
      calls.push("provider.remove");
      return { kind: "provider-removed", instanceId: id, version: 2 as never };
    });
    const host = credentialHost(calls);
    vi.mocked(host.clearProviderCredential).mockImplementationOnce(async () => {
      calls.push("credential.clear");
      throw new Error("private cleanup diagnostic");
    });
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeClaudeConfiguration(
          id,
          apiKeyConfiguration,
          transientCredential("private-value", calls),
        ),
      ).resolves.toBe(false);
    });
    await act(async () => {
      await expect(result.current.remove(id)).resolves.toBe(true);
    });

    expect(calls).toEqual([
      "credential.set",
      "provider.update",
      "credential.clear",
      "provider.update",
      "field.clear",
      "provider.remove",
      "credential.clear",
    ]);
    expect(result.current.instances).toHaveLength(0);
    expect(JSON.stringify(result.current)).not.toMatch(
      /private-value|private registry diagnostic|private cleanup diagnostic/,
    );
  });

  it("clears Claude API-key credentials after removal but skips subscription credentials", async () => {
    for (const authentication of ["api-key", "subscription"] as const) {
      const calls: string[] = [];
      const instance = claudeProvider({
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication,
        },
      });
      const api = client(snapshot([instance]));
      vi.mocked(api.execute).mockImplementation(async () => {
        calls.push("provider.remove");
        return { kind: "provider-removed", instanceId: id, version: 2 as never };
      });
      const host = credentialHost(calls);
      const { result, unmount } = renderHook(() =>
        useProviderController({ client: api, hostBridge: host }),
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));

      await act(async () => {
        await expect(result.current.remove(id)).resolves.toBe(true);
      });

      expect(calls).toEqual(
        authentication === "api-key"
          ? ["provider.remove", "credential.clear"]
          : ["provider.remove"],
      );
      unmount();
    }
  });

  it("clears Anthropic-compatible credentials after removal", async () => {
    for (const authentication of ["api-key", "bearer", "none"] as const) {
      const calls: string[] = [];
      const instance = anthropicProvider({
        configuration: {
          kind: "anthropic-compatible-http",
          baseUrl: "https://api.anthropic.example/v1",
          authentication,
          protocol: "auto",
          protocolVersion: "2023-06-01",
          manualModelIds: [],
        },
      });
      const api = client(snapshot([instance]));
      vi.mocked(api.execute).mockImplementation(async () => {
        calls.push("provider.remove");
        return { kind: "provider-removed", instanceId: id, version: 2 as never };
      });
      const host = credentialHost(calls);
      const { result, unmount } = renderHook(() =>
        useProviderController({ client: api, hostBridge: host }),
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));

      await act(async () => {
        await expect(result.current.remove(id)).resolves.toBe(true);
      });

      expect(calls).toEqual(
        authentication === "none" ? ["provider.remove"] : ["provider.remove", "credential.clear"],
      );
      unmount();
    }
  });

  it("removes a no-auth Anthropic-compatible provider even when hostBridge is unavailable", async () => {
    const calls: string[] = [];
    const instance = anthropicProvider({
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "https://api.anthropic.example/v1",
        authentication: "none",
        protocol: "auto",
        protocolVersion: "2023-06-01",
        manualModelIds: [],
      },
    });
    const api = client(snapshot([instance]));
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.remove");
      return { kind: "provider-removed", instanceId: id, version: 2 as never };
    });
    const { result, unmount } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(result.current.remove(id)).resolves.toBe(true);
    });

    expect(calls).toEqual(["provider.remove"]);
    unmount();
  });

  // A browser-only window has a provider client but no desktop bridge. An edit
  // that neither stores nor clears a key needs no Keychain authority, and
  // demanding one made a subscription instance uneditable outside the desktop.
  it("changes a subscription Grok binary path in a window without host credential authority", async () => {
    const calls: string[] = [];
    const instance = grokProvider();
    const api = client(snapshot([instance]));
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.update");
      return { kind: "provider-updated", instance: grokProvider({ version: 2 as never }) };
    });
    const { result, unmount } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeGrokConfiguration(
          id,
          { ...grokProvider().configuration, binaryPath: "/opt/homebrew/bin/grok" },
          transientCredential("", calls),
        ),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual(["provider.update", "field.clear"]);
    unmount();
  });

  // The server refuses an authentication change while the instance has an
  // active session. Clearing the key first left the instance still configured
  // for API-key authentication with no key to connect with, forcing the user to
  // re-enter it.
  it("keeps the stored Claude credential when a refused change stops using it", async () => {
    const calls: string[] = [];
    const api = client(
      snapshot([
        claudeProvider({
          configuration: {
            kind: "claude-agent-sdk",
            binaryPath: "/opt/homebrew/bin/claude",
            authentication: "api-key",
          },
        }),
      ]),
    );
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.update");
      throw new Error("private registry diagnostic");
    });
    const host = credentialHost(calls);
    const { result, unmount } = renderHook(() =>
      useProviderController({ client: api, hostBridge: host }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeClaudeConfiguration(
          id,
          claudeProvider().configuration,
          transientCredential("", calls),
        ),
      ).resolves.toBe(false);
    });

    expect(host.clearProviderCredential).not.toHaveBeenCalled();
    expect(calls).toEqual(["provider.update", "field.clear"]);
    expect(result.current.message).toMatch(/credential was left in place/i);
    expect(JSON.stringify(result.current)).not.toContain("private registry diagnostic");
    unmount();
  });

  it("keeps the stored Mistral Vibe credential when a refused change stops using it", async () => {
    const calls: string[] = [];
    const api = client(
      snapshot([
        vibeProvider({
          configuration: {
            kind: "mistral-vibe-acp",
            binaryPath: "/Users/example/.local/bin/vibe-acp",
            authentication: "api-key",
          },
        }),
      ]),
    );
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.update");
      throw new Error("private registry diagnostic");
    });
    const host = credentialHost(calls);
    const { result, unmount } = renderHook(() =>
      useProviderController({ client: api, hostBridge: host }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeMistralVibeConfiguration(
          id,
          vibeProvider().configuration,
          transientCredential("", calls),
        ),
      ).resolves.toBe(false);
    });

    expect(host.clearProviderCredential).not.toHaveBeenCalled();
    expect(calls).toEqual(["provider.update", "field.clear"]);
    expect(result.current.message).toMatch(/credential was left in place/i);
    expect(JSON.stringify(result.current)).not.toContain("private registry diagnostic");
    unmount();
  });

  it("clears the stored Mistral Vibe credential after the change that stops using it", async () => {
    const calls: string[] = [];
    const api = client(
      snapshot([
        vibeProvider({
          configuration: {
            kind: "mistral-vibe-acp",
            binaryPath: "/Users/example/.local/bin/vibe-acp",
            authentication: "api-key",
          },
        }),
      ]),
    );
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.update");
      return { kind: "provider-updated", instance: vibeProvider({ version: 2 as never }) };
    });
    const host = credentialHost(calls);
    const { result, unmount } = renderHook(() =>
      useProviderController({ client: api, hostBridge: host }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeMistralVibeConfiguration(
          id,
          vibeProvider().configuration,
          transientCredential("", calls),
        ),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual(["provider.update", "credential.clear", "field.clear"]);
    unmount();
  });

  it("clears the Anthropic-compatible credential when switching auth to none", async () => {
    const calls: string[] = [];
    const apiKeyProvider = anthropicProvider({
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "https://api.anthropic.example/v1",
        authentication: "api-key",
        protocol: "auto",
        protocolVersion: "2023-06-01",
        manualModelIds: [],
      },
    });
    const api = client(snapshot([apiKeyProvider]));
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.update");
      return {
        kind: "provider-updated",
        instance: anthropicProvider({
          version: 2 as never,
          configuration: {
            kind: "anthropic-compatible-http",
            baseUrl: "https://api.anthropic.example/v1",
            authentication: "none",
            protocol: "auto",
            protocolVersion: "2023-06-01",
            manualModelIds: [],
          },
        }),
      };
    });
    const host = credentialHost(calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeAnthropicCompatibleConfiguration(
          id,
          {
            kind: "anthropic-compatible-http",
            baseUrl: "https://api.anthropic.example/v1",
            authentication: "none",
            protocol: "auto",
            protocolVersion: "2023-06-01",
            manualModelIds: [],
          },
          transientCredential("", calls),
        ),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual(["credential.clear", "provider.update", "field.clear"]);
  });

  it("requires a new credential when switching Anthropic-compatible auth from api-key to bearer", async () => {
    const calls: string[] = [];
    const apiKeyProvider = anthropicProvider({
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "https://api.anthropic.example/v1",
        authentication: "api-key",
        protocol: "auto",
        protocolVersion: "2023-06-01",
        manualModelIds: [],
      },
    });
    const api = client(snapshot([apiKeyProvider]));
    const host = credentialHost(calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeAnthropicCompatibleConfiguration(
          id,
          {
            kind: "anthropic-compatible-http",
            baseUrl: "https://api.anthropic.example/v1",
            authentication: "bearer",
            protocol: "auto",
            protocolVersion: "2023-06-01",
            manualModelIds: [],
          },
          transientCredential("", calls),
        ),
      ).resolves.toBe(false);
    });

    expect(calls).toEqual(["field.clear"]);
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("stores a new credential before switching Anthropic-compatible auth from api-key to bearer", async () => {
    const calls: string[] = [];
    const apiKeyProvider = anthropicProvider({
      configuration: {
        kind: "anthropic-compatible-http",
        baseUrl: "https://api.anthropic.example/v1",
        authentication: "api-key",
        protocol: "auto",
        protocolVersion: "2023-06-01",
        manualModelIds: [],
      },
    });
    const api = client(snapshot([apiKeyProvider]));
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.update");
      return {
        kind: "provider-updated",
        instance: anthropicProvider({
          version: 2 as never,
          configuration: {
            kind: "anthropic-compatible-http",
            baseUrl: "https://api.anthropic.example/v1",
            authentication: "bearer",
            protocol: "auto",
            protocolVersion: "2023-06-01",
            manualModelIds: [],
          },
        }),
      };
    });
    const host = credentialHost(calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeAnthropicCompatibleConfiguration(
          id,
          {
            kind: "anthropic-compatible-http",
            baseUrl: "https://api.anthropic.example/v1",
            authentication: "bearer",
            protocol: "auto",
            protocolVersion: "2023-06-01",
            manualModelIds: [],
          },
          transientCredential("new-bearer-value", calls),
        ),
      ).resolves.toBe(true);
    });

    expect(calls).toEqual(["credential.set", "provider.update", "field.clear"]);
  });

  it("clears the credential field only after successful storage settles", async () => {
    const stored = deferred<void>();
    const calls: string[] = [];
    const api = client();
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.create");
      return { kind: "provider-created", instance: httpProvider() };
    });
    const host = credentialHost();
    vi.mocked(host.setProviderCredential).mockImplementation(async () => {
      calls.push("credential.set");
      await stored.promise;
      calls.push("credential.settled");
    });
    const credential = transientCredential("private-value", calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let creating!: Promise<boolean>;
    act(() => {
      creating = result.current.createOpenAiCompatible(
        "Gateway",
        httpProvider().configuration,
        credential,
      );
    });
    await waitFor(() => expect(calls).toEqual(["provider.create", "credential.set"]));
    expect(credential.clear).not.toHaveBeenCalled();

    stored.resolve();
    await expect(creating).resolves.toBe(true);
    expect(calls).toEqual([
      "provider.create",
      "credential.set",
      "credential.settled",
      "field.clear",
    ]);
  });

  it("clears the credential field after storage failure settles", async () => {
    const calls: string[] = [];
    const api = client();
    vi.mocked(api.execute).mockResolvedValue({
      kind: "provider-created",
      instance: httpProvider(),
    });
    const host = credentialHost();
    vi.mocked(host.setProviderCredential).mockImplementation(async () => {
      calls.push("credential.set");
      throw new Error("private-value raw Keychain diagnostic");
    });
    const credential = transientCredential("private-value", calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createOpenAiCompatible("Gateway", httpProvider().configuration, credential),
      ).resolves.toBe(false);
    });

    expect(calls).toEqual(["credential.set", "field.clear"]);
    expect(result.current.message).not.toMatch(/private-value|Keychain/i);
  });

  it("keeps a created provider visible when credential storage fails", async () => {
    const api = client();
    vi.mocked(api.execute).mockResolvedValue({
      kind: "provider-created",
      instance: httpProvider(),
    });
    const host = credentialHost();
    vi.mocked(host.setProviderCredential).mockRejectedValue(
      new Error("private-value raw Keychain diagnostic"),
    );
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createOpenAiCompatible(
          "Gateway",
          httpProvider().configuration,
          transientCredential("private-value"),
        ),
      ).resolves.toBe(false);
    });

    expect(result.current.instances).toHaveLength(2);
    expect(result.current.message).not.toMatch(/private-value|Keychain/i);
  });

  it("preserves the existing credential when an update credential is blank", async () => {
    const calls: string[] = [];
    const api = client(snapshot([httpProvider()]));
    vi.mocked(api.execute).mockResolvedValue({
      kind: "provider-updated",
      instance: httpProvider({ version: 2 as never }),
    });
    const host = credentialHost();
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.changeOpenAiCompatibleConfiguration(
          id,
          httpProvider().configuration,
          transientCredential("", calls),
        ),
      ).resolves.toBe(true);
    });

    expect(api.execute).toHaveBeenCalledOnce();
    expect(host.setProviderCredential).not.toHaveBeenCalled();
    expect(host.clearProviderCredential).not.toHaveBeenCalled();
    expect(calls).toEqual(["field.clear"]);
  });

  it("reports host credential authority and supports explicit clearing", async () => {
    const api = client(snapshot([httpProvider()]));
    const host = credentialHost();
    vi.mocked(host.providerCredentialStatus).mockResolvedValueOnce("stored");
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await expect(result.current.providerCredentialStatus(id)).resolves.toBe("stored");
    await act(async () => {
      await expect(result.current.clearProviderCredential(id)).resolves.toBe(true);
    });

    expect(result.current.credentialManagementAvailable).toBe(true);
    expect(host.clearProviderCredential).toHaveBeenCalledWith(id);
  });

  it("reports unavailable credential authority in a browser-only window", async () => {
    const api = client(snapshot([httpProvider()]));
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.credentialManagementAvailable).toBe(false);
    await expect(result.current.providerCredentialStatus(id)).resolves.toBe("unavailable");
  });

  it("blocks browser-only Claude API-key creation at the host authority boundary", async () => {
    const calls: string[] = [];
    const api = client();
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createClaude(
          "Claude key",
          {
            kind: "claude-agent-sdk",
            binaryPath: "/opt/homebrew/bin/claude",
            authentication: "api-key",
          },
          transientCredential("", calls),
        ),
      ).resolves.toBe(false);
    });

    expect(api.execute).not.toHaveBeenCalled();
    expect(calls).toEqual(["field.clear"]);
    expect(result.current.message).toMatch(/credential management.*unavailable.*host/i);
    expect(result.current.message).not.toMatch(/enter.*API key/i);
  });

  it("keeps Claude subscription creation available in a browser-only window", async () => {
    const api = client();
    vi.mocked(api.execute).mockImplementation(async (command) => ({
      kind: "provider-created",
      instance: claudeProvider({ id: "instanceId" in command ? command.instanceId : id }),
    }));
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        result.current.createClaude(
          "Claude subscription",
          claudeProvider().configuration,
          transientCredential(""),
        ),
      ).resolves.toBe(true);
    });

    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-claude-provider",
        configuration: expect.objectContaining({ authentication: "subscription" }),
      }),
    );
  });

  it("deletes the credential after removing a bearer provider", async () => {
    const calls: string[] = [];
    const api = client(snapshot([httpProvider()]));
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.remove");
      return { kind: "provider-removed", instanceId: id, version: 2 as never };
    });
    const host = credentialHost(calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(result.current.remove(id)).resolves.toBe(true);
    });
    expect(calls).toEqual(["provider.remove", "credential.clear"]);
  });

  it("defers cleanup when credential deletion fails after removal", async () => {
    const api = client(snapshot([httpProvider()]));
    vi.mocked(api.execute).mockResolvedValue({
      kind: "provider-removed",
      instanceId: id,
      version: 2 as never,
    });
    const host = credentialHost();
    vi.mocked(host.clearProviderCredential).mockRejectedValueOnce(
      new Error("private-value raw Keychain diagnostic"),
    );
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(result.current.remove(id)).resolves.toBe(true);
    });
    expect(result.current.instances).toHaveLength(0);
    expect(result.current.message).toMatch(/removed.*credential could not be cleared/i);
    expect(result.current.message).not.toMatch(/private-value|Keychain/i);

    // The stranded secret is retried by the same deferred cleanup the
    // configuration paths use.
    await act(async () => {
      await result.current.retry();
    });
    expect(host.clearProviderCredential).toHaveBeenCalledTimes(2);
  });

  // The server refuses removal while the instance still has an active session.
  // Clearing the key first left the instance configured for API-key
  // authentication with a write-only key that could not be put back.
  it("keeps a rejected provider's credential when registry removal fails", async () => {
    const calls: string[] = [];
    const api = client(snapshot([httpProvider()]));
    vi.mocked(api.execute).mockImplementation(async () => {
      calls.push("provider.remove");
      throw new Error("private registry diagnostic");
    });
    const host = credentialHost(calls);
    const { result } = renderHook(() => useProviderController({ client: api, hostBridge: host }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(result.current.remove(id)).resolves.toBe(false);
    });

    expect(calls).toEqual(["provider.remove"]);
    expect(host.clearProviderCredential).not.toHaveBeenCalled();
    expect(result.current.instances).toHaveLength(1);
    expect(result.current.message).toMatch(/removal failed/i);
    expect(result.current.message).not.toContain("private registry diagnostic");
  });

  it("updates provider order while preserving permission persistence", async () => {
    const secondId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000092");
    const api = client(snapshot([provider(), provider({ id: secondId, displayName: "Second" })]));
    vi.mocked(api.execute).mockResolvedValueOnce({
      kind: "provider-defaults-updated",
      defaults: {
        permissionPersistence: "current-session",
        providerOrder: [secondId, id],
        version: 1 as never,
      },
    });
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(result.current.updateProviderOrder([secondId, id])).resolves.toBe(true);
    });

    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "update-provider-defaults",
        permissionPersistence: "current-session",
        providerOrder: [secondId, id],
      }),
    );
    expect(result.current.defaults.providerOrder).toEqual([secondId, id]);
  });

  it("updates the agent-eligible default pool while preserving permission persistence", async () => {
    const agentEligibleModels = [
      { providerInstanceId: id, modelId: decodeProviderModelId("gpt-5.2") },
      { providerInstanceId: id, modelId: decodeProviderModelId("gpt-5.2-mini") },
    ];
    const api = client(snapshot([provider()]));
    vi.mocked(api.execute).mockResolvedValueOnce({
      kind: "provider-defaults-updated",
      defaults: {
        permissionPersistence: "current-session",
        agentEligibleModels,
        version: 1 as never,
      },
    });
    const { result } = renderHook(() => useProviderController({ client: api }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(result.current.updateAgentEligibleModels(agentEligibleModels)).resolves.toBe(
        true,
      );
    });

    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "update-provider-defaults",
        permissionPersistence: "current-session",
        agentEligibleModels,
      }),
    );
    expect(result.current.defaults.agentEligibleModels).toEqual(agentEligibleModels);
  });
});

function client(initial = snapshot()): ProviderClient {
  return {
    bootstrap: vi.fn(async () => initial),
    execute: vi.fn(),
    probe: vi.fn(),
  };
}

function credentialHost(calls: string[] = []): OctantHostBridge {
  return {
    clearProviderCredential: vi.fn(async () => void calls.push("credential.clear")),
    close: vi.fn(),
    maximizeOrRestore: vi.fn(),
    minimize: vi.fn(),
    projectWindowCapability: "C".repeat(43),
    providerCredentialStatus: vi.fn(async () => "missing" as const),
    resetBounds: vi.fn(),
    selectProjectRoot: vi.fn(),
    setProviderCredential: vi.fn(async () => void calls.push("credential.set")),
    setSidebarMaterialPreference: vi.fn(),
    subscribeResolvedMaterial: vi.fn(() => vi.fn()),
  };
}

function transientCredential(value: string, calls: string[] = []) {
  return {
    value,
    clear: vi.fn(() => void calls.push("field.clear")),
  };
}

function snapshot(
  instances: ReadonlyArray<ProviderInstance> = [provider()],
  observedStates: ReadonlyArray<ProviderObservedState> = [],
): ProviderRegistrySnapshot {
  return {
    instances,
    defaults: { permissionPersistence: "current-session", version: 0 as never },
    observedStates,
  };
}

function provider(patch: Partial<ProviderInstance> = {}): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName: "OpenCode local",
    driverKind: "opencode",
    configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-07-14T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-07-14T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  });
}

function openAiImageProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "openai-image" }> {
  return {
    id,
    displayName: "GPT Image",
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2" as never],
      defaultModel: "gpt-image-2" as never,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-08-28T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-08-28T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "openai-image" }>;
}

function bflImageProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "bfl-image" }> {
  return {
    id,
    displayName: "FLUX",
    driverKind: "bfl-image",
    configuration: {
      kind: "bfl-image-http",
      modelAllowlist: ["flux-pro-1.1" as never],
      defaultModel: "flux-pro-1.1" as never,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-08-28T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-08-28T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "bfl-image" }>;
}

function httpProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "openai-compatible" }> {
  return {
    id,
    displayName: "Gateway",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example/v1",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-07-14T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-07-14T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "openai-compatible" }>;
}

function claudeProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "claude" }> {
  return {
    id,
    displayName: "Claude local",
    driverKind: "claude",
    configuration: {
      kind: "claude-agent-sdk",
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "subscription",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-07-16T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-07-16T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "claude" }>;
}

function anthropicProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "anthropic-compatible" }> {
  return {
    id,
    displayName: "Anthropic gateway",
    driverKind: "anthropic-compatible",
    configuration: {
      kind: "anthropic-compatible-http",
      baseUrl: "https://api.anthropic.example/v1",
      authentication: "api-key",
      protocol: "auto",
      protocolVersion: "2023-06-01",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-07-16T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-07-16T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "anthropic-compatible" }>;
}

function vibeProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "mistral-vibe" }> {
  return {
    id,
    displayName: "Mistral Vibe local",
    driverKind: "mistral-vibe",
    configuration: {
      kind: "mistral-vibe-acp",
      binaryPath: "/Users/example/.local/bin/vibe-acp",
      authentication: "subscription",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-07-17T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-07-17T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "mistral-vibe" }>;
}

function grokProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "grok" }> {
  return {
    id,
    displayName: "Grok Build local",
    driverKind: "grok",
    configuration: {
      kind: "grok-acp",
      binaryPath: "/Users/example/.grok/bin/grok",
      authentication: "subscription",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-07-17T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-07-17T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "grok" }>;
}

function devinProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "devin" }> {
  return {
    id,
    displayName: "Devin local",
    driverKind: "devin",
    configuration: {
      kind: "devin-acp",
      binaryPath: "/Users/example/.local/bin/devin",
      authentication: "subscription",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-07-18T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-07-18T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "devin" }>;
}

function piProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "pi" }> {
  return {
    id,
    displayName: "Pi local",
    driverKind: "pi",
    configuration: { kind: "pi-rpc", binaryPath: "/opt/homebrew/bin/pi" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-07-18T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-07-18T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "pi" }>;
}

function ohMyPiProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "oh-my-pi" }> {
  return {
    id,
    displayName: "Oh My Pi local",
    driverKind: "oh-my-pi",
    configuration: {
      kind: "oh-my-pi-rpc",
      binaryPath: "/Users/example/.bun/bin/omp",
      supportedVersion: "17.2.1",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-07-18T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-07-18T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "oh-my-pi" }>;
}

function kiloProvider(
  patch: Partial<ProviderInstance> = {},
): Extract<ProviderInstance, { driverKind: "kilo" }> {
  return {
    id,
    displayName: "Kilo local",
    driverKind: "kilo",
    configuration: { kind: "kilo-acp", binaryPath: "/opt/homebrew/bin/kilo" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-07-18T10:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-07-18T10:00:00.000Z" as ProviderInstance["updatedAt"],
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "kilo" }>;
}

function ollamaProvider(
  patch: Record<string, unknown> = {},
): Extract<ProviderInstance, { driverKind: "ollama" }> {
  return {
    id,
    displayName: "Ollama local",
    driverKind: "ollama",
    configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-07-18T09:00:00.000Z" as never,
    updatedAt: "2026-07-18T09:00:00.000Z" as never,
    ...patch,
  } as Extract<ProviderInstance, { driverKind: "ollama" }>;
}

function observation(patch: Partial<ProviderObservedState> = {}): ProviderObservedState {
  return {
    instanceId: id,
    readiness: "ready" as const,
    processState: "running" as const,
    detectedVersion: "1.17.19",
    models: [
      {
        id: "model-1" as never,
        displayName: "Model One",
        source: "discovered" as const,
        verification: "verified" as const,
        reasoning: "supported" as const,
        inputModalities: ["text"],
        options: [],
      },
    ],
    capabilities: Object.fromEntries(
      [
        "streaming",
        "resume",
        "interruption",
        "approvals",
        "userQuestions",
        "reasoning",
        "usage",
        "toolActivity",
        "fileChanges",
        "diffs",
        "taskProgress",
        "nativeChildAgents",
        "nativeAttachments",
        "nativeWebResearch",
        "appManagedTools",
        "citations",
      ].map((key) => [key, "supported"]),
    ) as Awaited<ReturnType<ProviderClient["probe"]>>["capabilities"],
    observedAt: "2026-07-14T10:00:00.000Z" as never,
    ...patch,
  };
}

function failureObservation(
  readiness: Extract<ProviderObservedState["readiness"], "unauthenticated" | "unavailable">,
): ProviderObservedState {
  return observation({
    readiness,
    processState: "stopped",
    models: [],
    capabilities: Object.fromEntries(
      Object.keys(observation().capabilities).map((key) => [key, "unavailable"]),
    ) as ProviderObservedState["capabilities"],
    message: "Provider probe failed.",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

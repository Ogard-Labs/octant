import { describe, expect, it, vi } from "vitest";
import { CredentialRequests } from "../../credentials/credentialRequests";
import { IntegrationCredentialOperations } from "../../integration/integrationCredentialOperations";
import { createIntegrationHostPort } from "../../integration/integrationHostPort";
import { createAzureIntegration } from "./azureIntegration";
import { azureCredentialOperation } from "./azureCredentialOperation";

describe("Azure fixed credential reads", () => {
  it.each([
    [200, '{"value":[{"subscriptionId":"private-account-fixture"}]}', "used"],
    [
      200,
      JSON.stringify({
        value: Array.from({ length: 60 }, (_, index) => ({
          subscriptionId: `subscription-${index}`,
          displayName: "private-account-fixture".repeat(20),
        })),
      }),
      "used",
    ],
    [401, '{"error":{"message":"expired-token-fixture"}}', "failed"],
    [302, '{"value":[]}', "failed"],
  ])(
    "returns status only for HTTP %s without exposing response content",
    async (status, body, expected) => {
      const operations = new IntegrationCredentialOperations();
      const runtime = createAzureIntegration(
        createIntegrationHostPort({
          registerCredentialOperation: (operation) => operations.register(operation),
        }),
      );
      const operation = operations.list()[0];
      if (operation === undefined) throw new Error("Azure operation was not registered");
      const fetch = vi.fn(
        async (_request: Request) =>
          new Response(body, {
            status,
            ...(status === 302
              ? { headers: { location: "https://management.azure.com/other-resource" } }
              : {}),
          }),
      );
      const service = new CredentialRequests({ fetch });
      try {
        const pending = service.request({
          windowId: "window",
          threadId: "thread",
          operation,
          current: () => true,
          signal: new AbortController().signal,
        });
        const card = service.view("window", "thread").requests[0];
        if (card === undefined) throw new Error("No consent card");
        expect(card.destination).toBe(azureCredentialOperation.request.url);
        await service.answer("window", {
          id: card.id,
          action: "allow",
          secret: "private-short-lived-token",
        });
        expect(await pending).toEqual({ status: expected });
        expect(fetch).toHaveBeenCalledTimes(1);
        const request = fetch.mock.calls[0]?.[0];
        expect(request?.url).toBe(azureCredentialOperation.request.url);
        expect(request?.method).toBe("GET");
        expect(request?.redirect).toBe("error");
        expect(request?.body).toBeNull();
        expect(JSON.stringify(service.view("window", "thread"))).not.toMatch(
          /private-account-fixture|expired-token-fixture|private-short-lived-token/,
        );
      } finally {
        service.close();
        await runtime.close();
      }
      expect(operations.list()).toEqual([]);
    },
  );
});

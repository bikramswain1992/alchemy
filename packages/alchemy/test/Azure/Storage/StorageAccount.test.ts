import * as Azure from "@/Azure/index.ts";
import { AzureEnvironment } from "@/Azure/Environment.ts";
import { StorageAccountProvider } from "@/Azure/Storage/StorageAccount.ts";
import { ResourceGroupInventoryUncertain } from "@/Azure/Resources/ResourceGroup.ts";
import { DestroyError } from "@/Apply.ts";
import * as Provider from "@/Provider.ts";
import { createInternalTags } from "@/Tags.ts";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import * as storage from "@distilled.cloud/azure/storage";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const { test } = Test.make({ providers: Azure.providers(Azure.fromCli()) });

const unitCredentials = Effect.succeed({
  bearerToken: Redacted.make("test"),
  subscriptionId: "test",
  apiBaseUrl: "https://management.azure.com",
});

const unitServices = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  client: HttpClient.HttpClient,
) =>
  effect.pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(Credentials, unitCredentials),
    Effect.provideService(
      AzureEnvironment,
      Effect.succeed({
        bearerToken: Redacted.make("test"),
        subscriptionId: "test",
        apiBaseUrl: "https://management.azure.com",
        location: "eastus",
      }),
    ),
  );

test.provider(
  "replaces accounts on name, location, or resource-group changes, not tag changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const provider = yield* Provider.Provider<Azure.Storage.StorageAccount>(
        Azure.Storage.StorageAccount.Type,
      );
      const output = {
        id: "/subscriptions/test/resourceGroups/fixture/providers/Microsoft.Storage/storageAccounts/alcfixture",
        name: "alcfixture",
        subscriptionId: "test",
        resourceGroupName: "fixture",
        location: "eastus",
        blobEndpoint: "https://alcfixture.blob.core.windows.net/",
        tags: {},
      };
      const diff = (news: Azure.Storage.StorageAccountProps) =>
        provider.diff!({
          id: "AccountDiff",
          fqn: "AccountDiff",
          instanceId: "test",
          olds: {
            name: "alcfixture",
            resourceGroupName: "fixture",
            location: "eastus",
          },
          news,
          oldBindings: [],
          newBindings: [],
          output,
        });
      expect(
        yield* diff({
          name: "alcother",
          resourceGroupName: "fixture",
          location: "eastus",
        }),
      ).toEqual({ action: "replace", deleteFirst: true });
      expect(
        yield* diff({
          name: "alcfixture",
          resourceGroupName: "fixture",
          location: "westus",
        }),
      ).toEqual({ action: "replace", deleteFirst: true });
      expect(
        yield* diff({
          name: "alcfixture",
          resourceGroupName: "other",
          location: "eastus",
        }),
      ).toEqual({ action: "replace", deleteFirst: true });
      expect(
        yield* diff({
          name: "alcfixture",
          resourceGroupName: "fixture",
          location: "EASTUS",
          tags: { purpose: "changed" },
        }),
      ).toBeUndefined();
      yield* stack.destroy();
    }).pipe(Effect.provide(StorageAccountProvider())),
  { tags: ["unit", "provider:azure", "local"], timeout: 10_000 },
);

test.provider(
  "retains observed readiness checks when ARM omits create and delete polling headers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const id = "AccountWithoutLro";
      const tags = { ...(yield* createInternalTags(id)) };
      const calls: string[] = [];
      let createReads = 0;
      let deleteReads = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          calls.push(`${request.method} ${path}`);
          const response =
            request.method === "PUT"
              ? Response.json({ name: "alcnoheaders", location: "eastus" })
              : request.method === "DELETE"
                ? new Response(null, { status: 204 })
                : calls.some((call) => call.startsWith("DELETE ")) &&
                    ++deleteReads > 1
                  ? Response.json(
                      {
                        error: {
                          code: "StorageAccountNotFound",
                          message: "gone",
                        },
                      },
                      { status: 404 },
                    )
                  : calls.some((call) => call.startsWith("PUT "))
                    ? Response.json({
                        name: "alcnoheaders",
                        location: "eastus",
                        tags,
                        properties: {
                          provisioningState:
                            calls.some((call) => call.startsWith("DELETE ")) ||
                            ++createReads > 1
                              ? "Succeeded"
                              : "Creating",
                          supportsHttpsTrafficOnly: true,
                          minimumTlsVersion: "TLS1_2",
                          allowBlobPublicAccess: false,
                          allowSharedKeyAccess: false,
                        },
                      })
                    : Response.json(
                        {
                          error: {
                            code: "StorageAccountNotFound",
                            message: "missing",
                          },
                        },
                        { status: 404 },
                      );
          return HttpClientResponse.fromWeb(request, response);
        }),
      );
      const provider = yield* Provider.Provider<Azure.Storage.StorageAccount>(
        Azure.Storage.StorageAccount.Type,
      );
      const account = yield* unitServices(
        provider.reconcile({
          id,
          fqn: id,
          instanceId: "test",
          news: { resourceGroupName: "fixture", name: "alcnoheaders" },
          olds: undefined,
          output: undefined,
          bindings: [],
          session: {} as Parameters<typeof provider.reconcile>[0]["session"],
        }),
        client,
      );
      expect(account.name).toBe("alcnoheaders");
      yield* unitServices(
        provider.delete({
          id,
          fqn: id,
          instanceId: "test",
          olds: { resourceGroupName: "fixture", name: "alcnoheaders" },
          output: account,
          bindings: [],
          session: {} as Parameters<typeof provider.delete>[0]["session"],
        }),
        client,
      );
      expect(calls.map((call) => call.split(" ")[0])).toEqual([
        "GET",
        "PUT",
        "GET",
        "GET",
        "GET",
        "DELETE",
        "GET",
        "GET",
      ]);
      yield* stack.destroy();
    }).pipe(Effect.provide(StorageAccountProvider())),
  { tags: ["unit", "provider:azure", "local"], timeout: 30_000 },
);

test.provider(
  "waits for the create ARM operation before reading a ready storage account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const id = "AccountLro";
      const tags = { ...(yield* createInternalTags(id)) };
      const calls: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          calls.push(`${request.method} ${path}`);
          const response =
            path === "/operations/create"
              ? Response.json({ status: "Succeeded" })
              : request.method === "PUT"
                ? new Response(null, {
                    status: 202,
                    headers: {
                      "Azure-AsyncOperation":
                        "https://management.azure.com/operations/create",
                      "Retry-After": "0",
                    },
                  })
                : calls.some((call) => call.startsWith("PUT "))
                  ? Response.json({
                      name: "alclrofixture",
                      location: "eastus",
                      kind: "StorageV2",
                      sku: { name: "Standard_LRS" },
                      tags,
                      properties: {
                        provisioningState: "Succeeded",
                        primaryEndpoints: {
                          blob: "https://alclrofixture.blob.core.windows.net/",
                        },
                        supportsHttpsTrafficOnly: true,
                        minimumTlsVersion: "TLS1_2",
                        allowBlobPublicAccess: false,
                        allowSharedKeyAccess: false,
                      },
                    })
                  : Response.json(
                      {
                        error: {
                          code: "StorageAccountNotFound",
                          message: "missing",
                        },
                      },
                      { status: 404 },
                    );
          return HttpClientResponse.fromWeb(request, response);
        }),
      );
      const provider = yield* Provider.Provider<Azure.Storage.StorageAccount>(
        Azure.Storage.StorageAccount.Type,
      );
      const account = yield* unitServices(
        provider.reconcile({
          id,
          fqn: id,
          instanceId: "test",
          news: { resourceGroupName: "fixture", name: "alclrofixture" },
          olds: undefined,
          output: undefined,
          bindings: [],
          session: {} as Parameters<typeof provider.reconcile>[0]["session"],
        }),
        client,
      );
      expect(account.name).toBe("alclrofixture");
      expect(calls.map((call) => call.split(" ")[0])).toEqual([
        "GET",
        "PUT",
        "GET",
        "GET",
      ]);
      expect(calls[2]).toBe("GET /operations/create");
      yield* stack.destroy();
    }).pipe(Effect.provide(StorageAccountProvider())),
  { tags: ["unit", "provider:azure", "local"], timeout: 10_000 },
);

test.provider(
  "waits for a delete Location operation before accepting absence",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const id = "AccountDeleteLro";
      const tags = { ...(yield* createInternalTags(id)) };
      const calls: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          calls.push(`${request.method} ${path}`);
          const response =
            path === "/operations/delete"
              ? Response.json({ status: "Succeeded" })
              : request.method === "DELETE"
                ? new Response(null, {
                    status: 202,
                    headers: {
                      Location:
                        "https://management.azure.com/operations/delete",
                      "Retry-After": "0",
                    },
                  })
                : calls.some((call) => call.startsWith("DELETE "))
                  ? Response.json(
                      {
                        error: {
                          code: "StorageAccountNotFound",
                          message: "gone",
                        },
                      },
                      { status: 404 },
                    )
                  : Response.json({
                      name: "alcdeletefixture",
                      location: "eastus",
                      tags,
                      properties: { provisioningState: "Succeeded" },
                    });
          return HttpClientResponse.fromWeb(request, response);
        }),
      );
      const provider = yield* Provider.Provider<Azure.Storage.StorageAccount>(
        Azure.Storage.StorageAccount.Type,
      );
      yield* unitServices(
        provider.delete({
          id,
          fqn: id,
          instanceId: "test",
          olds: { resourceGroupName: "fixture", name: "alcdeletefixture" },
          output: {
            id: "/subscriptions/test/resourceGroups/fixture/providers/Microsoft.Storage/storageAccounts/alcdeletefixture",
            name: "alcdeletefixture",
            subscriptionId: "test",
            resourceGroupName: "fixture",
            location: "eastus",
            blobEndpoint: "https://alcdeletefixture.blob.core.windows.net/",
            tags: {},
          },
          bindings: [],
          session: {} as Parameters<typeof provider.delete>[0]["session"],
        }),
        client,
      );
      expect(calls.map((call) => call.split(" ")[0])).toEqual([
        "GET",
        "DELETE",
        "GET",
        "GET",
      ]);
      expect(calls[2]).toBe("GET /operations/delete");
      yield* stack.destroy();
    }).pipe(Effect.provide(StorageAccountProvider())),
  { tags: ["unit", "provider:azure", "local"], timeout: 10_000 },
);

const destroy = (stack: Test.ScratchStack) =>
  stack.destroy().pipe(
    Effect.retry({
      while: (error) =>
        error instanceof DestroyError &&
        error.failures.some(
          (failure) =>
            Cause.squash(failure.cause) instanceof
            ResourceGroupInventoryUncertain,
        ),
      schedule: Schedule.spaced("5 seconds"),
      times: 9,
    }),
  );

test.provider(
  "creates a private StorageV2 account, updates observed tags and deletes it",
  (stack) =>
    Effect.gen(function* () {
      yield* destroy(stack);
      const provision = (purpose: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const group = yield* Azure.Resources.ResourceGroup("Group", {});
            const account = yield* Azure.Storage.StorageAccount("Account", {
              resourceGroupName: group.name,
              location: "eastus",
              tags: { purpose },
            });
            return { group, account };
          }),
        );

      const { account } = yield* provision("first");
      expect(account.id).toContain(
        "/providers/Microsoft.Storage/storageAccounts/",
      );
      expect(account.name).toMatch(/^[a-z0-9]{3,24}$/);
      const read = () =>
        storage.GetStorageAccountProperties({
          subscriptionId: account.subscriptionId,
          resourceGroupName: account.resourceGroupName,
          accountName: account.name,
        });
      const initial = yield* read();
      expect(initial.kind).toBe("StorageV2");
      expect(initial.sku?.name).toBe("Standard_LRS");
      expect(initial.properties?.supportsHttpsTrafficOnly).toBe(true);
      expect(initial.properties?.allowBlobPublicAccess).toBe(false);
      expect(initial.properties?.minimumTlsVersion).toBe("TLS1_2");
      expect(initial.tags?.purpose).toBe("first");

      yield* provision("second");
      expect((yield* read()).tags?.purpose).toBe("second");
      yield* destroy(stack);
      const gone = yield* resources
        .GetResourceGroup({
          subscriptionId: account.subscriptionId,
          resourceGroupName: account.resourceGroupName,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }),
  { tags: ["provider:azure", "live"], timeout: 120_000 },
);

test.provider(
  "creates a private deployment container and deletes it before its account",
  (stack) =>
    Effect.gen(function* () {
      yield* destroy(stack);
      const { account, container } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup(
            "ContainerGroup",
            {},
          );
          const account = yield* Azure.Storage.StorageAccount(
            "ContainerAccount",
            {
              resourceGroupName: group.name,
            },
          );
          const container = yield* Azure.Storage.BlobContainer("Deployment", {
            resourceGroupName: group.name,
            accountName: account.name,
          });
          return { account, container };
        }),
      );
      const observed = yield* storage.GetBlobContainer({
        subscriptionId: account.subscriptionId,
        resourceGroupName: account.resourceGroupName,
        accountName: account.name,
        containerName: container.name,
      });
      expect(observed.properties?.publicAccess).toBe("None");
      expect(observed.properties?.metadata?.alchemy_id).toBe("Deployment");
      yield* destroy(stack);
    }),
  { tags: ["provider:azure", "live"], timeout: 120_000 },
);

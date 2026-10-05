import * as Azure from "@/Azure/index.ts";
import { ResourceGroupInventoryUncertain } from "@/Azure/Resources/ResourceGroup.ts";
import { DestroyError } from "@/Apply.ts";
import { makeFunctionArchive } from "@/Azure/Web/FunctionDeployment.ts";
import { FunctionApp } from "@/Azure/Web/FunctionApp.ts";
import { FunctionAppProvider } from "@/Azure/Web/FunctionApp.ts";
import { AzureEnvironment } from "@/Azure/Environment.ts";
import { makeFunctionSource } from "@/Azure/Web/FunctionSource.ts";
import { unzipFiles } from "@/Util/zip.ts";
import * as Test from "@/Test/Alchemy";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as web from "@distilled.cloud/azure/web";
import { expect, test } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

test.effect(
  "packages an executable v4 entry, its dependency, and an observed code-version route",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const main = `${root}/main.ts`;
      yield* fs.writeFileString(main, 'export default "function-app-test";\n');
      const source = yield* makeFunctionSource;
      const bundle = yield* source.bundle({ main });
      const zip = yield* makeFunctionArchive(bundle);
      const files = yield* unzipFiles(zip);
      expect(files["host.json"]).toBeDefined();
      expect(files["index.mjs"]).toBeDefined();
      expect(
        files["node_modules/@azure/functions/dist/azure-functions.js"],
      ).toBeDefined();
      expect(new TextDecoder().decode(files["index.mjs"]!)).toContain(
        bundle.codeHash,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  { tags: ["unit", "provider:azure", "local"] },
);

const { test: live } = Test.make({
  providers: Azure.providers(Azure.fromCli()),
});

live.provider(
  "keeps a default Azure region stable when ARM returns its display name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const provider = yield* FunctionApp.Provider;
      const diff = yield* provider.diff!({
        id: "Http",
        fqn: "Http",
        instanceId: "test",
        olds: {
          resourceGroupName: "group",
          planId:
            "/subscriptions/test/resourceGroups/group/providers/Microsoft.Web/serverfarms/plan",
          storageAccountId:
            "/subscriptions/test/resourceGroups/group/providers/Microsoft.Storage/storageAccounts/account",
          deploymentContainerId:
            "/subscriptions/test/resourceGroups/group/providers/Microsoft.Storage/storageAccounts/account/blobServices/default/containers/packages",
          main: "main.ts",
        },
        news: {
          resourceGroupName: "group",
          planId:
            "/subscriptions/test/resourceGroups/group/providers/Microsoft.Web/serverfarms/plan",
          storageAccountId:
            "/subscriptions/test/resourceGroups/group/providers/Microsoft.Storage/storageAccounts/account",
          deploymentContainerId:
            "/subscriptions/test/resourceGroups/group/providers/Microsoft.Storage/storageAccounts/account/blobServices/default/containers/packages",
          main: "main.ts",
        },
        output: {
          id: "/subscriptions/test/resourceGroups/group/providers/Microsoft.Web/sites/http",
          name: "http",
          subscriptionId: "test",
          resourceGroupName: "group",
          location: "East US",
          planId:
            "/subscriptions/test/resourceGroups/group/providers/Microsoft.Web/serverfarms/plan",
          storageAccountId:
            "/subscriptions/test/resourceGroups/group/providers/Microsoft.Storage/storageAccounts/account",
          deploymentContainerId:
            "/subscriptions/test/resourceGroups/group/providers/Microsoft.Storage/storageAccounts/account/blobServices/default/containers/packages",
          principalId: "principal",
          url: "https://http.azurewebsites.net",
          tags: {},
        },
        oldBindings: [],
        newBindings: [],
      });
      expect(diff).toBeUndefined();
      yield* stack.destroy();
    }).pipe(
      Effect.provide(FunctionAppProvider()),
      Effect.provideService(
        AzureEnvironment,
        Effect.succeed({
          subscriptionId: "test",
          apiBaseUrl: "https://management.azure.com",
          bearerToken: Redacted.make("test"),
          location: "eastus",
        }),
      ),
    ),
  { tags: ["unit", "provider:azure", "local"], timeout: 10_000 },
);

live.provider(
  "publishes an Effect-native HTTP app after assigning storage roles",
  (stack) =>
    Effect.gen(function* () {
      const destroy = stack.destroy().pipe(
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
      yield* destroy;
      yield* Effect.gen(function* () {
        const app = yield* stack.deploy(
          Effect.gen(function* () {
            const group = yield* Azure.Resources.ResourceGroup("Group", {});
            const storage = yield* Azure.Storage.StorageAccount("Storage", {
              resourceGroupName: group.name,
            });
            const container = yield* Azure.Storage.BlobContainer("Packages", {
              resourceGroupName: group.name,
              accountName: storage.name,
            });
            const plan = yield* Azure.Web.AppServicePlan("Plan", {
              resourceGroupName: group.name,
            });
            return yield* FunctionApp(
              "App",
              {
                resourceGroupName: group.name,
                planId: plan.id,
                storageAccountId: storage.id,
                deploymentContainerId: container.id,
                main: new URL("./fixtures/function-app.ts", import.meta.url)
                  .href,
                env: { GREETING: "hello" },
              },
              Effect.succeed({
                fetch: Effect.succeed(HttpServerResponse.text("hello")),
              }),
            );
          }),
        );
        const observed = yield* web.GetWebApp({
          subscriptionId: app.subscriptionId,
          resourceGroupName: app.resourceGroupName,
          name: app.name,
        });
        expect(observed.identity?.principalId).toBe(app.principalId);
        expect(observed.properties?.functionAppConfig?.runtime?.name).toBe(
          "node",
        );
        expect(
          observed.properties?.functionAppConfig?.scaleAndConcurrency
            ?.instanceMemoryMB,
        ).toBe(2048);
        expect(
          observed.properties?.functionAppConfig?.scaleAndConcurrency
            ?.maximumInstanceCount,
        ).toBe(100);
        const client = yield* HttpClient.HttpClient;
        const response = yield* client
          .get(`${app.url}/hello`)
          .pipe(
            Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 8 }),
          );
        expect(response.status).toBe(200);
        expect(yield* response.text).toBe("hello");
      }).pipe(Effect.ensuring(destroy.pipe(Effect.orDie)));
    }),
  { tags: ["provider:azure", "live"], timeout: 210_000 },
);

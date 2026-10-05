import * as Alchemy from "alchemy";
import * as Azure from "alchemy/Azure";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default Alchemy.Stack(
  "AzureFunctionAppExample",
  {
    providers: Azure.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {});
    const account = yield* Azure.Storage.StorageAccount("Storage", {
      resourceGroupName: group.name,
    });
    const packages = yield* Azure.Storage.BlobContainer("Packages", {
      resourceGroupName: group.name,
      accountName: account.name,
    });
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroupName: group.name,
    });
    const app = yield* Azure.Web.FunctionApp(
      "Http",
      {
        resourceGroupName: group.name,
        planId: plan.id,
        storageAccountId: account.id,
        deploymentContainerId: packages.id,
        main: new URL("./src/Http.ts", import.meta.url).href,
      },
      Effect.succeed({
        fetch: Effect.succeed(
          HttpServerResponse.text("Hello from Azure Functions"),
        ),
      }),
    );
    return { url: app.url };
  }),
);

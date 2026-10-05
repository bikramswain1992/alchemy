import * as Azure from "alchemy/Azure";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// The deployed runtime evaluates this module; infrastructure references are
// supplied by the stack in alchemy.run.ts during deployment.
export default Azure.Web.FunctionApp(
  "Http",
  {
    resourceGroupName: "runtime",
    planId: "runtime",
    storageAccountId: "runtime",
    deploymentContainerId: "runtime",
    main: import.meta.url,
  },
  Effect.succeed({
    fetch: Effect.succeed(
      HttpServerResponse.text("Hello from Azure Functions"),
    ),
  }),
);

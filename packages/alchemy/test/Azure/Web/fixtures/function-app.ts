import { FunctionApp } from "@/Azure/Web/FunctionApp.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default FunctionApp(
  "Fixture",
  {
    resourceGroupName: "runtime",
    planId: "runtime",
    storageAccountId: "runtime",
    deploymentContainerId: "runtime",
    main: import.meta.url,
  },
  Effect.succeed({
    fetch: Effect.succeed(HttpServerResponse.text("hello")),
  }),
);

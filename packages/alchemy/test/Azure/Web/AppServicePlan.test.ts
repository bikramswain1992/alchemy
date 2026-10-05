import * as Azure from "@/Azure/index.ts";
import { ResourceGroupInventoryUncertain } from "@/Azure/Resources/ResourceGroup.ts";
import { DestroyError } from "@/Apply.ts";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers(Azure.fromCli()) });

test.provider(
  "creates and deletes a Linux Flex Consumption plan",
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
      const { plan } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {});
          const plan = yield* Azure.Web.AppServicePlan("Plan", {
            resourceGroupName: group.name,
            location: "eastus",
          });
          return { plan };
        }),
      );
      const observed = yield* web.GetAppServicePlan({
        subscriptionId: plan.subscriptionId,
        resourceGroupName: plan.resourceGroupName,
        name: plan.name,
      });
      expect(observed.sku?.name).toBe("FC1");
      expect(observed.properties?.reserved).toBe(true);
      yield* destroy;
    }),
  { tags: ["provider:azure", "live"], timeout: 120_000 },
);

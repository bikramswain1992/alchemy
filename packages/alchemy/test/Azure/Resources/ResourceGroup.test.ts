import * as Azure from "@/Azure/index.ts";
import * as Test from "@/Test/Alchemy";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Azure.providers(Azure.fromCli()) });

test.provider(
  "creates, updates tags and destroys an owned Resource Group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Azure.Resources.ResourceGroup("Group", {
            tags: { purpose: "testing" },
          });
        }),
      );
      expect(group.id).toContain("/resourceGroups/");
      const observed = yield* resources.GetResourceGroup({
        subscriptionId: group.subscriptionId,
        resourceGroupName: group.name,
      });
      expect(observed.tags?.purpose).toBe("testing");
      expect(observed.tags?.["alchemy::id"]).toBeDefined();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Azure.Resources.ResourceGroup("Group", {
            tags: { purpose: "updated" },
          });
        }),
      );
      expect(
        (yield* resources.GetResourceGroup({
          subscriptionId: group.subscriptionId,
          resourceGroupName: group.name,
        })).tags?.purpose,
      ).toBe("updated");
      yield* stack.destroy();
      const gone = yield* resources
        .GetResourceGroup({
          subscriptionId: group.subscriptionId,
          resourceGroupName: group.name,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag(
            ["ResourceGroupNotFound", "ResourceNotFound", "NotFound"],
            () => Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }),
  { tags: ["provider:azure", "live"], timeout: 120_000 },
);

test.provider(
  "refuses to delete a group whose ownership tags were removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Azure.Resources.ResourceGroup("Guarded", {
            tags: { purpose: "ownership" },
          });
        }),
      );
      const before = yield* resources.GetResourceGroup({
        subscriptionId: group.subscriptionId,
        resourceGroupName: group.name,
      });
      yield* resources.ResourceGroupsCreateOrUpdate({
        subscriptionId: group.subscriptionId,
        resourceGroupName: group.name,
        location: before.location,
        tags: { external: "true" },
      });
      const outcome = yield* Effect.result(stack.destroy());
      expect(Result.isFailure(outcome)).toBe(true);
      const stillThere = yield* resources.GetResourceGroup({
        subscriptionId: group.subscriptionId,
        resourceGroupName: group.name,
      });
      expect(stillThere.tags?.external).toBe("true");
      yield* resources.ResourceGroupsCreateOrUpdate({
        subscriptionId: group.subscriptionId,
        resourceGroupName: group.name,
        location: before.location,
        tags: before.tags,
      });
      yield* stack.destroy();
    }),
  { tags: ["provider:azure", "live"], timeout: 120_000 },
);

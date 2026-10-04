import * as Azure from "@/Azure/index.ts";
import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy.ts";
import { DestroyError } from "@/Apply.ts";
import {
  ResourceGroupInventoryUncertain,
  ResourceGroupNotEmpty,
  ResourceGroupProvider,
} from "@/Azure/Resources/ResourceGroup.ts";
import * as Provider from "@/Provider.ts";
import { createInternalTags } from "@/Tags.ts";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import * as resources from "@distilled.cloud/azure/resources";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const { test } = Test.make({ providers: Azure.providers(Azure.fromCli()) });

const destroyWhenInventorySettles = (stack: Test.ScratchStack) =>
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
  "fails closed when ARM inventory omits a newly changed group's child",
  (stack) =>
    Effect.gen(function* () {
      yield* destroyWhenInventorySettles(stack);
      const id = "InventoryGuard";
      const name = "alchemy-inventory-guard-fixture";
      const now = yield* Clock.currentTimeMillis;
      const tags = {
        ...(yield* createInternalTags(id)),
        "alchemy::resource-group-updated-at": String(now),
      };
      const provider = yield* Provider.Provider<Azure.Resources.ResourceGroup>(
        Azure.Resources.ResourceGroup.Type,
      );
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.method === "DELETE")
            throw new Error("recursive delete must not be called");
          const body = request.url.includes("/resources?")
            ? { value: [] }
            : request.url.includes("/storageAccounts/")
              ? { name: "foreign-child", location: "eastus", kind: "StorageV2" }
              : {
                  name,
                  location: "eastus",
                  tags,
                };
          return HttpClientResponse.fromWeb(request, Response.json(body));
        }),
      );
      const credentials = Effect.succeed({
        bearerToken: Redacted.make("test"),
        subscriptionId: "test",
        apiBaseUrl: "https://management.azure.com",
      });
      const child = yield* storage
        .GetStorageAccountProperties({
          subscriptionId: "test",
          resourceGroupName: name,
          accountName: "foreign-child",
        })
        .pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(Credentials, credentials),
        );
      expect(child.name).toBe("foreign-child");
      const outcome = yield* Effect.result(
        provider
          .delete({
            id,
            fqn: id,
            instanceId: "test",
            olds: {},
            output: {
              id: `/subscriptions/test/resourceGroups/${name}`,
              name,
              subscriptionId: "test",
              location: "eastus",
              tags: {},
            },
            bindings: [],
            session: {} as Parameters<typeof provider.delete>[0]["session"],
          })
          .pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provideService(Credentials, credentials),
          ),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome))
        expect(outcome.failure).toBeInstanceOf(ResourceGroupInventoryUncertain);
      yield* destroyWhenInventorySettles(stack);
    }).pipe(Effect.provide(ResourceGroupProvider())),
  { tags: ["unit", "provider:azure", "local"] },
);

test.provider(
  "deletes an established empty group after a single inventory read",
  (stack) =>
    Effect.gen(function* () {
      yield* destroyWhenInventorySettles(stack);
      const id = "EstablishedGroup";
      const name = "alchemy-empty-fixture";
      const tags = { ...(yield* createInternalTags(id)) };
      const now = yield* Clock.currentTimeMillis;
      const provider = yield* Provider.Provider<Azure.Resources.ResourceGroup>(
        Azure.Resources.ResourceGroup.Type,
      );
      let listCalls = 0;
      let deleteCalls = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.method === "DELETE") deleteCalls++;
          if (request.url.includes("/resources?")) listCalls++;
          const response =
            request.method === "DELETE"
              ? new Response(null, { status: 200 })
              : deleteCalls > 0
                ? Response.json(
                    {
                      error: { code: "ResourceGroupNotFound", message: "gone" },
                    },
                    { status: 404 },
                  )
                : Response.json(
                    request.url.includes("/resources?")
                      ? { value: [] }
                      : {
                          name,
                          location: "eastus",
                          tags: {
                            ...tags,
                            "alchemy::resource-group-updated-at": String(
                              now - 120_000,
                            ),
                          },
                        },
                  );
          return HttpClientResponse.fromWeb(request, response);
        }),
      );
      yield* provider
        .delete({
          id,
          fqn: id,
          instanceId: "test",
          olds: {},
          output: {
            id: `/subscriptions/test/resourceGroups/${name}`,
            name,
            subscriptionId: "test",
            location: "eastus",
            tags: {},
          },
          bindings: [],
          session: {} as Parameters<typeof provider.delete>[0]["session"],
        })
        .pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(
            Credentials,
            Effect.succeed({
              bearerToken: Redacted.make("test"),
              subscriptionId: "test",
              apiBaseUrl: "https://management.azure.com",
            }),
          ),
        );
      expect(listCalls).toBe(1);
      expect(deleteCalls).toBe(1);
      yield* destroyWhenInventorySettles(stack);
    }).pipe(Effect.provide(ResourceGroupProvider())),
  { tags: ["unit", "provider:azure", "local"] },
);

test.provider(
  "creates, updates tags and destroys an owned Resource Group",
  (stack) =>
    Effect.gen(function* () {
      yield* destroyWhenInventorySettles(stack);
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
      yield* destroyWhenInventorySettles(stack);
      const gone = yield* resources
        .GetResourceGroup({
          subscriptionId: group.subscriptionId,
          resourceGroupName: group.name,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag(["ResourceGroupNotFound", "ResourceNotFound"], () =>
            Effect.succeed(true),
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
      yield* destroyWhenInventorySettles(stack);
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
      yield* destroyWhenInventorySettles(stack);
    }),
  { tags: ["provider:azure", "live"], timeout: 120_000 },
);

test.provider(
  "requires explicit adoption for an existing, unowned group with an explicit name",
  (stack) => {
    const name = "alchemy-azure-rg-adoption-guard";
    let created = false;
    return Effect.gen(function* () {
      yield* destroyWhenInventorySettles(stack);
      const credentials = yield* Azure.Credentials;
      const { subscriptionId } = yield* credentials;
      const existing = yield* resources
        .GetResourceGroup({ subscriptionId, resourceGroupName: name })
        .pipe(
          Effect.catchTag(["ResourceGroupNotFound", "ResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      // Never take over or delete a group that predated this test.
      expect(existing).toBeUndefined();
      yield* resources.ResourceGroupsCreateOrUpdate({
        subscriptionId,
        resourceGroupName: name,
        location: "eastus",
        tags: { purpose: "adoption-guard" },
      });
      created = true;
      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Azure.Resources.ResourceGroup("ExistingGroup", {
              name,
              tags: { purpose: "adopted" },
            });
          }),
        );
      const outcome = yield* Effect.result(deploy());
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure).toBeInstanceOf(OwnedBySomeoneElse);
      }
      const untouched = yield* resources.GetResourceGroup({
        subscriptionId,
        resourceGroupName: name,
      });
      expect(untouched.tags?.purpose).toBe("adoption-guard");
      expect(untouched.tags?.["alchemy::id"]).toBeUndefined();
      const adopted = yield* deploy().pipe(adopt(true));
      expect(adopted.name).toBe(name);
      expect(
        (yield* resources.GetResourceGroup({
          subscriptionId,
          resourceGroupName: name,
        })).tags?.purpose,
      ).toBe("adopted");
      yield* destroyWhenInventorySettles(stack);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const cleanup = yield* Effect.result(
            destroyWhenInventorySettles(stack),
          );
          if (!created) {
            if (Result.isFailure(cleanup))
              return yield* Effect.fail(cleanup.failure);
            return;
          }
          const { subscriptionId } = yield* yield* Azure.Credentials;
          const group = yield* resources
            .GetResourceGroup({ subscriptionId, resourceGroupName: name })
            .pipe(
              Effect.catchTag(
                ["ResourceGroupNotFound", "ResourceNotFound"],
                () => Effect.succeed(undefined),
              ),
            );
          if (!group) {
            if (Result.isFailure(cleanup))
              yield* destroyWhenInventorySettles(stack);
            return;
          }
          if (
            group.tags?.purpose !== "adoption-guard" &&
            (group.tags?.purpose !== "adopted" ||
              group.tags?.["alchemy::id"] !== "ExistingGroup")
          ) {
            return yield* Effect.fail(
              new Error(
                `Test group ${name} has unexpected tags; refusing cleanup`,
              ),
            );
          }
          const children = yield* resources.ListResourceByResourceGroup({
            subscriptionId,
            resourceGroupName: name,
          });
          if (children.value.length || children.nextLink)
            return yield* new ResourceGroupNotEmpty({ name });
          yield* resources.DeleteResourceGroup({
            subscriptionId,
            resourceGroupName: name,
          });
          const remains = yield* resources
            .GetResourceGroup({ subscriptionId, resourceGroupName: name })
            .pipe(
              Effect.map(() => true),
              Effect.catchTag("ResourceGroupNotFound", () =>
                Effect.succeed(false),
              ),
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (exists) => !exists,
                times: 8,
              }),
            );
          expect(remains).toBe(false);
          if (Result.isFailure(cleanup))
            yield* destroyWhenInventorySettles(stack);
        }).pipe(Effect.orDie),
      ),
    );
  },
  { tags: ["provider:azure", "live"], timeout: 120_000 },
);

test.provider(
  "refuses to delete an owned group containing a foreign storage account",
  (stack) => {
    let group: { name: string; subscriptionId: string } | undefined;
    let accountName: string | undefined;
    const removeAccount = Effect.gen(function* () {
      if (!group || !accountName) return;
      yield* storage
        .DeleteStorageAccount({
          subscriptionId: group.subscriptionId,
          resourceGroupName: group.name,
          accountName,
        })
        .pipe(
          Effect.catchTag(
            ["ResourceNotFound", "ResourceGroupNotFound"],
            () => Effect.void,
          ),
        );
      const remains = yield* storage
        .GetStorageAccountProperties({
          subscriptionId: group.subscriptionId,
          resourceGroupName: group.name,
          accountName,
        })
        .pipe(
          Effect.map(() => true),
          Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
            Effect.succeed(false),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (exists) => !exists,
            times: 8,
          }),
        );
      expect(remains).toBe(false);
    });
    return Effect.gen(function* () {
      yield* destroyWhenInventorySettles(stack);
      group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Azure.Resources.ResourceGroup("NonemptyGuard", {});
        }),
      );
      accountName = `alc${group.name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(-21)}`;
      yield* storage.CreateStorageAccount({
        subscriptionId: group.subscriptionId,
        resourceGroupName: group.name,
        accountName,
        location: "eastus",
        kind: "StorageV2",
        sku: { name: "Standard_LRS" },
      });
      const actualAccount = yield* storage.GetStorageAccountProperties({
        subscriptionId: group.subscriptionId,
        resourceGroupName: group.name,
        accountName,
      });
      expect(actualAccount.name).toBe(accountName);
      const outcome = yield* Effect.result(stack.destroy());
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure).toBeInstanceOf(DestroyError);
        if (outcome.failure instanceof DestroyError) {
          const cause = Cause.squash(outcome.failure.failures[0]!.cause);
          expect(
            cause instanceof ResourceGroupNotEmpty ||
              cause instanceof ResourceGroupInventoryUncertain,
          ).toBe(true);
        }
      }
      expect(
        (yield* resources.GetResourceGroup({
          subscriptionId: group.subscriptionId,
          resourceGroupName: group.name,
        })).name,
      ).toBe(group.name);
      expect(
        (yield* storage.GetStorageAccountProperties({
          subscriptionId: group.subscriptionId,
          resourceGroupName: group.name,
          accountName,
        })).name,
      ).toBe(accountName);
      yield* removeAccount;
      accountName = undefined;
      yield* destroyWhenInventorySettles(stack);
      const gone = yield* resources
        .GetResourceGroup({
          subscriptionId: group.subscriptionId,
          resourceGroupName: group.name,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag(["ResourceGroupNotFound", "ResourceNotFound"], () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }).pipe(
      Effect.ensuring(
        removeAccount.pipe(
          Effect.andThen(destroyWhenInventorySettles(stack)),
          Effect.orDie,
        ),
      ),
    );
  },
  { tags: ["provider:azure", "live"], timeout: 120_000 },
);

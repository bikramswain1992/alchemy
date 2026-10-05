import * as Azure from "@/Azure/index.ts";
import { ResourceGroupInventoryUncertain } from "@/Azure/Resources/ResourceGroup.ts";
import { DestroyError } from "@/Apply.ts";
import * as Output from "@/Output.ts";
import * as Test from "@/Test/Alchemy";
import * as authorization from "@distilled.cloud/azure/authorization";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers(Azure.fromCli()) });

test.provider(
  "grants an identity access to a storage account and releases the assignment",
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
      const resolveCredentials = yield* Azure.Credentials;
      const token = (yield* resolveCredentials).bearerToken;
      const principalId = yield* Effect.sync(() => {
        const claims = JSON.parse(
          Buffer.from(
            Redacted.value(token).split(".")[1]!,
            "base64url",
          ).toString("utf8"),
        );
        return claims.oid as string;
      });
      const { assignment } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {});
          const account = yield* Azure.Storage.StorageAccount("Storage", {
            resourceGroupName: group.name,
          });
          const assignment = yield* Azure.Authorization.RoleAssignment(
            "BlobAccess",
            {
              scope: account.id,
              principalId,
              roleDefinitionId: Output.interpolate`/subscriptions/${account.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe`,
            },
          );
          return { assignment };
        }),
      );
      const actual = yield* authorization.GetRoleAssignment({
        scope: assignment.scope,
        roleAssignmentName: assignment.name,
      });
      expect(actual.properties?.principalId).toBe(principalId);
      yield* destroy;
    }),
  { tags: ["provider:azure", "live"], timeout: 120_000 },
);

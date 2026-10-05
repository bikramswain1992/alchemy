import * as storage from "@distilled.cloud/azure/storage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  stripInternalTags,
  tagRecord,
} from "../../Tags.ts";
import { waitForArmLro } from "../ArmLro.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface StorageAccountProps {
  /** Name of the containing resource group. A group passed by name is not owned by this resource. */
  resourceGroupName: string;
  /** Globally unique lowercase-alphanumeric name (3–24 characters); generated when omitted. */
  name?: string;
  /** Azure region; defaults to the configured location. Changing it replaces the account. */
  location?: string;
  /** User tags. */
  tags?: Record<string, string>;
}

export type StorageAccount = Resource<
  "Azure.Storage.StorageAccount",
  StorageAccountProps,
  {
    /** ARM identifier. */
    id: string;
    /** Storage account name. */
    name: string;
    /** Subscription identifier. */
    subscriptionId: string;
    /** Parent resource group name. */
    resourceGroupName: string;
    /** Azure location. */
    location: string;
    /** Blob service URL. */
    blobEndpoint: string;
    /** User-defined tags. */
    tags: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A StorageV2 account suitable for Azure Functions host and deployment storage.
 *
 * ### Creating a Storage Account
 * **Example:** Create in a managed resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("Group", {});
 * const account = yield* Azure.Storage.StorageAccount("Storage", {
 *   resourceGroupName: group.name,
 * });
 * ```
 *
 * @resource
 * @category Storage
 */
export const StorageAccount = Resource<StorageAccount>(
  "Azure.Storage.StorageAccount",
);

export class StorageAccountInvalidName extends Data.TaggedError(
  "Azure.StorageAccountInvalidName",
)<{ name: string }> {}

export class StorageAccountNotReady extends Data.TaggedError(
  "Azure.StorageAccountNotReady",
)<{ name: string }> {}

const accountName = Effect.fn(function* (id: string, name?: string) {
  const value =
    name ??
    `alc${yield* createPhysicalName({ id, delimiter: "", lowercase: true, maxLength: 21 })}`;
  if (!/^[a-z0-9]{3,24}$/.test(value))
    return yield* new StorageAccountInvalidName({ name: value });
  return value;
});

const get = (subscriptionId: string, resourceGroupName: string, name: string) =>
  storage
    .GetStorageAccountProperties({
      subscriptionId,
      resourceGroupName,
      accountName: name,
    })
    .pipe(
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "StorageAccountNotFound"],
        () => Effect.succeed(undefined),
      ),
    );

const waitReady = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  get(subscriptionId, resourceGroupName, name).pipe(
    Effect.flatMap((account) =>
      account?.properties?.provisioningState === "Succeeded"
        ? Effect.succeed(account)
        : Effect.fail(new StorageAccountNotReady({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "Azure.StorageAccountNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 10,
    }),
  );

const attrs = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  observed: storage.GetStorageAccountPropertiesResponse,
) => ({
  id:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${name}`,
  name,
  subscriptionId,
  resourceGroupName,
  location: observed.location,
  blobEndpoint:
    observed.properties?.primaryEndpoints?.blob ??
    `https://${name}.blob.core.windows.net/`,
  tags: stripInternalTags(tagRecord(observed.tags)),
});

export const StorageAccountProvider = () =>
  Provider.succeed(StorageAccount, {
    stables: ["id", "name", "subscriptionId", "resourceGroupName"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (
        (news.name && news.name !== (olds?.name ?? output?.name)) ||
        (output && news.resourceGroupName !== output.resourceGroupName) ||
        (news.location &&
          output?.location &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      )
        return { action: "replace" as const, deleteFirst: true };
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName =
        olds?.resourceGroupName ?? output?.resourceGroupName;
      if (!resourceGroupName) return undefined;
      const name = yield* accountName(id, olds?.name ?? output?.name);
      const observed = yield* get(subscriptionId, resourceGroupName, name);
      if (!observed) return undefined;
      const result = attrs(subscriptionId, resourceGroupName, name, observed);
      return (yield* hasAlchemyTags(id, observed.tags))
        ? result
        : Unowned(result);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId, location } = yield* AzureEnvironment.current;
      const name = yield* accountName(id, news.name ?? output?.name);
      const resourceGroupName = news.resourceGroupName;
      const desiredTags = { ...news.tags, ...(yield* createInternalTags(id)) };
      let observed = yield* get(subscriptionId, resourceGroupName, name);
      if (!observed) {
        const response = yield* storage
          .CreateStorageAccount({
            subscriptionId,
            resourceGroupName,
            accountName: name,
            location: news.location ?? location,
            kind: "StorageV2",
            sku: { name: "Standard_LRS" },
            tags: desiredTags,
            properties: {
              supportsHttpsTrafficOnly: true,
              minimumTlsVersion: "TLS1_2",
              allowBlobPublicAccess: false,
              allowSharedKeyAccess: false,
            },
          })
          .pipe(
            Effect.catchTag("ResourceConflict", () =>
              Effect.succeed(undefined),
            ),
          );
        observed =
          response?.azureAsyncOperation || response?.locationHeader
            ? yield* waitForArmLro(response, {
                read: get(subscriptionId, resourceGroupName, name),
                isReady: (account) =>
                  account?.properties?.provisioningState === "Succeeded",
              }).pipe(
                Effect.flatMap((account) =>
                  account
                    ? Effect.succeed(account)
                    : Effect.fail(new StorageAccountNotReady({ name })),
                ),
              )
            : yield* waitReady(subscriptionId, resourceGroupName, name);
      }
      const { upsert, removed } = diffTags(
        tagRecord(observed.tags),
        desiredTags,
      );
      const properties = observed.properties;
      if (
        upsert.length ||
        removed.length ||
        properties?.supportsHttpsTrafficOnly !== true ||
        properties.minimumTlsVersion !== "TLS1_2" ||
        properties.allowBlobPublicAccess !== false ||
        properties.allowSharedKeyAccess !== false
      ) {
        yield* storage.UpdateStorageAccount({
          subscriptionId,
          resourceGroupName,
          accountName: name,
          tags: desiredTags,
          properties: {
            supportsHttpsTrafficOnly: true,
            minimumTlsVersion: "TLS1_2",
            allowBlobPublicAccess: false,
            allowSharedKeyAccess: false,
          },
        });
        observed = yield* waitReady(subscriptionId, resourceGroupName, name);
      }
      return attrs(subscriptionId, resourceGroupName, name, observed);
    }),
    delete: Effect.fn(function* ({ id, output }) {
      const observed = yield* get(
        output.subscriptionId,
        output.resourceGroupName,
        output.name,
      );
      if (!observed) return;
      if (!(yield* hasAlchemyTags(id, observed.tags)))
        return yield* new StorageAccountInvalidName({
          name: `Unowned: ${output.name}`,
        });
      const response = yield* storage
        .DeleteStorageAccount({
          subscriptionId: output.subscriptionId,
          resourceGroupName: output.resourceGroupName,
          accountName: output.name,
        })
        .pipe(
          Effect.catchTag(
            [
              "ResourceNotFound",
              "ResourceGroupNotFound",
              "StorageAccountNotFound",
            ],
            () => Effect.succeed(undefined),
          ),
        );
      const read = get(
        output.subscriptionId,
        output.resourceGroupName,
        output.name,
      );
      if (response?.azureAsyncOperation || response?.location) {
        yield* waitForArmLro(response, {
          read,
          isReady: (account) => account === undefined,
        });
      } else {
        yield* read.pipe(
          Effect.flatMap((account) =>
            account
              ? Effect.fail(new StorageAccountNotReady({ name: output.name }))
              : Effect.void,
          ),
          Effect.retry({
            while: (error) => error._tag === "Azure.StorageAccountNotReady",
            schedule: Schedule.spaced("5 seconds"),
            times: 10,
          }),
        );
      }
    }),
  });

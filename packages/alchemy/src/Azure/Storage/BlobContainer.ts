import * as storage from "@distilled.cloud/azure/storage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface BlobContainerProps {
  /** Resource group that owns the storage account. */
  resourceGroupName: string;
  /** Storage account containing the deployment container. */
  accountName: string;
  /** Private container name, generated when omitted. */
  name?: string;
  /** Additional container metadata. */
  metadata?: Record<string, string>;
}

export type BlobContainer = Resource<
  "Azure.Storage.BlobContainer",
  BlobContainerProps,
  {
    /** ARM identifier. */
    id: string;
    /** Name. */
    name: string;
    /** Subscription identifier. */
    subscriptionId: string;
    /** Resource group name. */
    resourceGroupName: string;
    /** Storage account name. */
    accountName: string;
    /** User metadata. */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * Private Azure Blob container, used to store a Flex Function App's deployment packages.
 *
 * ### Creating a Container
 * **Example:** Create in a storage account
 * ```typescript
 * const container = yield* Azure.Storage.BlobContainer("Deployment", {
 *   resourceGroupName: group.name,
 *   accountName: account.name,
 * });
 * ```
 *
 * @resource
 * @category Storage
 */
export const BlobContainer = Resource<BlobContainer>(
  "Azure.Storage.BlobContainer",
);

export class BlobContainerNotReady extends Data.TaggedError(
  "Azure.BlobContainerNotReady",
)<{
  name: string;
}> {}

export class BlobContainerUnowned extends Data.TaggedError(
  "Azure.BlobContainerUnowned",
)<{
  name: string;
}> {}

const internalMetadata = (id: string) =>
  createInternalTags(id).pipe(
    Effect.map((tags) => ({
      alchemy_stack: tags["alchemy::stack"],
      alchemy_stage: tags["alchemy::stage"],
      alchemy_id: tags["alchemy::id"],
    })),
  );

const get = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  name: string,
) =>
  storage
    .ListBlobContainers({ subscriptionId, resourceGroupName, accountName })
    .pipe(
      Effect.flatMap((page) =>
        page.value.some((container) => container.name === name)
          ? storage.GetBlobContainer({
              subscriptionId,
              resourceGroupName,
              accountName,
              containerName: name,
            })
          : Effect.succeed(undefined),
      ),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "StorageAccountNotFound"],
        () => Effect.succeed(undefined),
      ),
    );

const attrs = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  name: string,
  observed: storage.GetBlobContainerResponse,
) => ({
  id:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${accountName}/blobServices/default/containers/${name}`,
  name,
  subscriptionId,
  resourceGroupName,
  accountName,
  metadata: Object.fromEntries(
    Object.entries(observed.properties?.metadata ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("alchemy_"),
    ),
  ),
});

export const BlobContainerProvider = () =>
  Provider.succeed(BlobContainer, {
    stables: [
      "id",
      "name",
      "subscriptionId",
      "resourceGroupName",
      "accountName",
    ],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (
        (news.name && news.name !== (olds?.name ?? output?.name)) ||
        (output &&
          (news.accountName !== output.accountName ||
            news.resourceGroupName !== output.resourceGroupName))
      )
        return { action: "replace" as const, deleteFirst: true };
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName =
        olds?.resourceGroupName ?? output?.resourceGroupName;
      const accountName = olds?.accountName ?? output?.accountName;
      if (!resourceGroupName || !accountName) return undefined;
      const name =
        olds?.name ??
        output?.name ??
        (yield* createPhysicalName({ id, maxLength: 63, lowercase: true }));
      const observed = yield* get(
        subscriptionId,
        resourceGroupName,
        accountName,
        name,
      );
      if (!observed) return undefined;
      const expected = yield* internalMetadata(id);
      const metadata = observed.properties?.metadata;
      const result = attrs(
        subscriptionId,
        resourceGroupName,
        accountName,
        name,
        observed,
      );
      return Object.entries(expected).every(
        ([key, value]) => metadata?.[key] === value,
      )
        ? result
        : Unowned(result);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const { resourceGroupName, accountName } = news;
      const name =
        news.name ??
        output?.name ??
        (yield* createPhysicalName({ id, maxLength: 63, lowercase: true }));
      const metadata = { ...news.metadata, ...(yield* internalMetadata(id)) };
      let observed = yield* get(
        subscriptionId,
        resourceGroupName,
        accountName,
        name,
      );
      if (
        !observed ||
        observed.properties?.publicAccess !== "None" ||
        Object.entries(metadata).some(
          ([key, value]) => observed?.properties?.metadata?.[key] !== value,
        ) ||
        Object.keys(observed.properties?.metadata ?? {}).some(
          (key) => !(key in metadata),
        )
      ) {
        yield* storage.CreateBlobContainer({
          subscriptionId,
          resourceGroupName,
          accountName,
          containerName: name,
          properties: { publicAccess: "None", metadata },
        });
        observed = yield* get(
          subscriptionId,
          resourceGroupName,
          accountName,
          name,
        ).pipe(
          Effect.flatMap((value) =>
            value
              ? Effect.succeed(value)
              : Effect.fail(new BlobContainerNotReady({ name })),
          ),
          Effect.retry({
            while: (error) => error._tag === "Azure.BlobContainerNotReady",
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
        );
      }
      return attrs(
        subscriptionId,
        resourceGroupName,
        accountName,
        name,
        observed,
      );
    }),
    delete: Effect.fn(function* ({ id, output }) {
      const observed = yield* get(
        output.subscriptionId,
        output.resourceGroupName,
        output.accountName,
        output.name,
      );
      if (!observed) return;
      const expected = yield* internalMetadata(id);
      if (
        !Object.entries(expected).every(
          ([key, value]) => observed.properties?.metadata?.[key] === value,
        )
      )
        return yield* new BlobContainerUnowned({ name: output.name });
      yield* storage
        .DeleteBlobContainer({
          subscriptionId: output.subscriptionId,
          resourceGroupName: output.resourceGroupName,
          accountName: output.accountName,
          containerName: output.name,
        })
        .pipe(
          Effect.catchTag(
            ["ResourceNotFound", "ResourceGroupNotFound"],
            () => Effect.void,
          ),
        );
      yield* get(
        output.subscriptionId,
        output.resourceGroupName,
        output.accountName,
        output.name,
      ).pipe(
        Effect.flatMap((container) =>
          container
            ? Effect.fail(new BlobContainerNotReady({ name: output.name }))
            : Effect.void,
        ),
        Effect.retry({
          while: (error) => error._tag === "Azure.BlobContainerNotReady",
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
        }),
      );
    }),
  });

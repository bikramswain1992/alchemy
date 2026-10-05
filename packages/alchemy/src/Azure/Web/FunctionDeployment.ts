import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import * as web from "@distilled.cloud/azure/web";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { hasAlchemyTags } from "../../Tags.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { zipFiles, type ZipFile } from "../../Util/zip.ts";
import type * as Bundle from "../../Bundle/Bundle.ts";
import type { Providers } from "../Providers.ts";
import { makeFunctionSource } from "./FunctionSource.ts";

/** Internal code generation: the app is provisioned and storage grants are ready first. */
export interface FunctionDeploymentProps {
  appId: string;
  ownerId: string;
  url: string;
  grantIds: string[];
  main: string;
  handler?: string;
  build?: Bundle.BundleConfig;
  isExternal?: boolean;
}

export type FunctionDeployment = Resource<
  "Azure.Web.FunctionDeployment",
  FunctionDeploymentProps,
  { appId: string; ownerId: string; codeHash: string; url: string },
  never,
  Providers
>;

/** Internal resource tracking the remotely running version of an Azure Function App. */
export const FunctionDeployment = Resource<FunctionDeployment>(
  "Azure.Web.FunctionDeployment",
);

export class FunctionPublishFailed extends Data.TaggedError(
  "Azure.FunctionPublishFailed",
)<{ status: number; message: string }> {}

export class FunctionNotReady extends Data.TaggedError(
  "Azure.FunctionNotReady",
)<{ url: string; codeHash: string }> {}

export class FunctionDependencyFailed extends Data.TaggedError(
  "Azure.FunctionDependencyFailed",
)<{ packageName: string; message: string }> {}

export class FunctionDeploymentUnowned extends Data.TaggedError(
  "Azure.FunctionDeploymentUnowned",
)<{ appId: string }> {}

// Pin transitive runtime packages and their npm integrity digests. The ZIP is
// ready to execute: Flex's /api/publish does not run npm install by default.
const packages = [
  [
    "@azure/functions",
    "4.7.2",
    "5ps8yz4gn6oZSzeQbpUreWHFYl/YS03F1Sk/pz7YJphfctRcHuLF5tcrdm9AyRiYzja4Bkd63bju+g/E27opPQ==",
  ],
  [
    "long",
    "4.0.0",
    "XsP+KhQif4bjX1kbuSiySJFNAehNxgLb6hPRGJ9QsUr8ajHkuXGdrHmFUTUUXhDwVX2R5bY4JNZEwbUiMhV+MA==",
  ],
  [
    "cookie",
    "0.7.2",
    "yki5XnKuf750l50uGTllt6kKILY4nQ1eNIQatoXEByZ5dWgnKqbnqmTrBE5B4N7lrMJKQ2ytWMiTO2o0v6Ew/w==",
  ],
  [
    "undici",
    "5.29.0",
    "raqeBD6NQK4SkWhQzeYKd1KmIG6dllBOTt55Rmkt4HtI9mwdWtJljnrXjAFUBLTSN67HWrOIZ3EPF4kjUw80Bg==",
  ],
  [
    "@fastify/busboy",
    "2.1.1",
    "vBZP4NlzfOlerQTnba4aqZoMhE/a9HY7HRqoOPaETQcSQuWEIyZMHGfVu6w9wGtGK5fED5qRs2DteVCjOH60sA==",
  ],
] as const;

const npmFiles = Effect.fn(function* (
  name: string,
  version: string,
  integrity: string,
) {
  const http = yield* HttpClient.HttpClient;
  const file = name.substring(name.lastIndexOf("/") + 1);
  const url = `https://registry.npmjs.org/${name}/-/${file}-${version}.tgz`;
  const response = yield* http.get(url);
  if (response.status !== 200)
    return yield* new FunctionDependencyFailed({
      packageName: name,
      message: `npm returned ${response.status}`,
    });
  const buffer = new Uint8Array(yield* response.arrayBuffer);
  return yield* Effect.try({
    try: () => {
      const actual = createHash("sha512").update(buffer).digest("base64");
      if (actual !== integrity) throw new Error("tarball integrity mismatch");
      const tar = gunzipSync(buffer);
      const files: ZipFile[] = [];
      const decoder = new TextDecoder();
      for (let i = 0; i + 512 <= tar.length;) {
        const header = tar.subarray(i, i + 512);
        const field = (start: number, length: number) =>
          decoder
            .decode(header.subarray(start, start + length))
            .replace(/\0.*$/s, "");
        const path = field(0, 100);
        if (!path) break;
        const size = parseInt(field(124, 12).trim(), 8);
        if (!Number.isFinite(size) || size < 0 || i + 512 + size > tar.length)
          throw new Error("invalid tarball entry");
        const prefix = field(345, 155);
        const entry = prefix ? `${prefix}/${path}` : path;
        const relative = entry.replace(/^package\//, "");
        if (header[156] === 48 || header[156] === 0) {
          if (
            !entry.startsWith("package/") ||
            relative.includes("..") ||
            relative.startsWith("/")
          )
            throw new Error("invalid package path");
          files.push({
            path: `node_modules/${name}/${relative}`,
            content: new Uint8Array(tar.subarray(i + 512, i + 512 + size)),
          });
        }
        i += 512 + Math.ceil(size / 512) * 512;
      }
      if (
        !files.some((file) => file.path === `node_modules/${name}/package.json`)
      )
        throw new Error("package.json missing from tarball");
      return files;
    },
    catch: (error) =>
      new FunctionDependencyFailed({
        packageName: name,
        message: String(error),
      }),
  });
});

/** Package the bundled program with a separately routable live version probe. */
export const makeFunctionArchive = Effect.fn(function* (source: {
  files: ReadonlyArray<ZipFile>;
  codeHash: string;
}) {
  const files = source.files.map((file) =>
    file.path === "index.mjs" ? { ...file, path: "alchemy-main.mjs" } : file,
  );
  files.push({
    path: "index.mjs",
    content: `import { app } from "@azure/functions";\napp.http("alchemy-version", { methods: ["GET"], authLevel: "anonymous", route: "__alchemy/version", handler: () => ({ body: ${JSON.stringify(source.codeHash)} }) });\nawait import("./alchemy-main.mjs");\n`,
  });
  const dependencies = yield* Effect.forEach(
    packages,
    ([name, version, integrity]) => npmFiles(name, version, integrity),
    { concurrency: 5 },
  );
  return yield* zipFiles([...files, ...dependencies.flat()]);
});

const probe = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(
      `${url.replace(/\/$/, "")}/__alchemy/version`,
    );
    return response.status === 200 ? (yield* response.text).trim() : undefined;
  }).pipe(
    Effect.timeoutOption("8 seconds"),
    Effect.map((value) => (value._tag === "Some" ? value.value : undefined)),
    Effect.catch(() => Effect.succeed(undefined)),
  );

const getOwnedApp = (
  appId: string,
  ownerId: string,
  {
    unownedAsMissing = false,
    invalidAsMissing = false,
  }: { unownedAsMissing?: boolean; invalidAsMissing?: boolean } = {},
) =>
  Effect.gen(function* () {
    const match =
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Web\/sites\/([^/]+)$/i.exec(
        appId,
      );
    if (!match)
      return invalidAsMissing
        ? undefined
        : yield* new FunctionDeploymentUnowned({ appId });
    const [, subscriptionId, resourceGroupName, name] = match;
    const observed = yield* web
      .GetWebApp({
        subscriptionId: subscriptionId!,
        resourceGroupName: resourceGroupName!,
        name: name!,
      })
      .pipe(
        Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
          Effect.succeed(undefined),
        ),
      );
    if (observed && !(yield* hasAlchemyTags(ownerId, observed.tags)))
      return unownedAsMissing
        ? undefined
        : yield* new FunctionDeploymentUnowned({ appId });
    return observed;
  });

export const FunctionDeploymentProvider = () =>
  Provider.succeed(FunctionDeployment, {
    stables: ["appId", "ownerId", "url"],
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output && news.appId.toLowerCase() !== output.appId.toLowerCase())
        return { action: "replace" as const, deleteFirst: true };
      if (output) {
        const source = yield* makeFunctionSource;
        const bundled = yield* source.bundle(news);
        if (bundled.codeHash !== output.codeHash)
          return { action: "update" as const };
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (!olds && !output) return undefined;
      const appId = output?.appId ?? olds!.appId;
      const ownerId = output?.ownerId ?? olds!.ownerId;
      // The host's own read gates adoption. Before its tags are rebranded,
      // this internal child is simply not yet observable as our deployment.
      if (
        !(yield* getOwnedApp(appId, ownerId, {
          unownedAsMissing: true,
          invalidAsMissing: true,
        }))
      )
        return undefined;
      const url = output?.url ?? olds!.url;
      const version = yield* probe(url);
      return version
        ? {
            appId,
            ownerId,
            codeHash: version,
            url,
          }
        : undefined;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const source = yield* makeFunctionSource;
      const bundled = yield* source.bundle(news);
      if (!(yield* getOwnedApp(news.appId, news.ownerId)))
        return yield* new FunctionNotReady({
          url: news.url,
          codeHash: bundled.codeHash,
        });
      if ((yield* probe(news.url)) !== bundled.codeHash) {
        yield* Effect.log(`Packaging Azure Function ${news.appId}`);
        const bytes = yield* makeFunctionArchive(bundled);
        yield* Effect.log(
          `Publishing Azure Function ${news.appId} (${bytes.length} bytes)`,
        );
        const credentials = yield* Credentials;
        const http = yield* HttpClient.HttpClient;
        const appName = news.appId.split("/").pop()!;
        yield* Effect.gen(function* () {
          // Resolve the ARM bearer on every request, including RBAC/SCM retries.
          const token = (yield* credentials).bearerToken;
          const response = yield* http
            .execute(
              HttpClientRequest.post(
                `https://${appName}.scm.azurewebsites.net/api/publish?type=zip`,
              ).pipe(
                HttpClientRequest.setHeader(
                  "Authorization",
                  `Bearer ${Redacted.value(token)}`,
                ),
                HttpClientRequest.bodyUint8Array(
                  new Uint8Array(bytes),
                  "application/zip",
                ),
              ),
            )
            .pipe(Effect.timeout("25 seconds"));
          yield* Effect.log(
            `Azure Function publish returned HTTP ${response.status}`,
          );
          if (response.status < 200 || response.status >= 300)
            return yield* new FunctionPublishFailed({
              status: response.status,
              message: (yield* response.text).slice(0, 1000),
            });
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "Azure.FunctionPublishFailed" &&
              [403, 404, 409, 429, 503].includes(error.status),
            schedule: Schedule.spaced("5 seconds"),
            times: 8,
          }),
        );
        yield* probe(news.url).pipe(
          Effect.flatMap((version) =>
            version === bundled.codeHash
              ? Effect.void
              : Effect.fail(
                  new FunctionNotReady({
                    url: news.url,
                    codeHash: bundled.codeHash,
                  }),
                ),
          ),
          Effect.retry({
            while: (error) => error._tag === "Azure.FunctionNotReady",
            schedule: Schedule.spaced("5 seconds"),
            times: 8,
          }),
        );
      }
      return {
        appId: news.appId,
        ownerId: news.ownerId,
        codeHash: bundled.codeHash,
        url: news.url,
      };
    }),
    // Deployments are removed before their grants. Stop the retiring app while
    // its managed identity still has storage access; host deletion follows.
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* getOwnedApp(output.appId, output.ownerId, {
        invalidAsMissing: true,
      });
      if (!observed || observed.properties?.state === "Stopped") return;
      const match =
        /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Web\/sites\/([^/]+)$/i.exec(
          output.appId,
        )!;
      const [, subscriptionId, resourceGroupName, name] = match;
      yield* web
        .StopWebApp({
          subscriptionId: subscriptionId!,
          resourceGroupName: resourceGroupName!,
          name: name!,
        })
        .pipe(
          Effect.catchTag(
            ["ResourceNotFound", "ResourceGroupNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

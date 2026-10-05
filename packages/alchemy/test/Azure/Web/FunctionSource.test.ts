import { serve } from "@/Http.ts";
import { makeFunctionSource } from "@/Azure/Web/FunctionSource.ts";
import { makeHandler } from "@/Runtime/Bootstrap/AzureFunction.ts";
import { entrypointTag } from "@/Runtime/Bootstrap/Process.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { zipFiles, unzipFiles } from "@/Util/zip.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const text = (content: string | Uint8Array) =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

test.effect(
  "bundles a root-level Azure Functions v4 archive with a named handler",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const main = `${root}/main.ts`;
      yield* fs.writeFileString(
        main,
        'export const selected = "azure-entry-marker";\n',
      );
      const source = yield* makeFunctionSource;
      const first = yield* source.bundle({ main, handler: "selected" });
      const second = yield* source.bundle({ main, handler: "selected" });
      expect(second.codeHash).toBe(first.codeHash);
      expect(first.codeHash).toMatch(/^[a-f0-9]{16}$/);

      const archive = yield* zipFiles(first.files);
      const files = yield* unzipFiles(archive);
      expect(files["host.json"]).toBeDefined();
      expect(files["index.mjs"]).toBeDefined();
      expect(files["package.json"]).toBeDefined();
      expect(Object.keys(files).every((name) => !name.startsWith("../"))).toBe(
        true,
      );
      const host = JSON.parse(text(files["host.json"]!));
      expect(host.version).toBe("2.0");
      expect(host.extensions.http.routePrefix).toBe("");
      const pkg = JSON.parse(text(files["package.json"]!));
      expect(pkg.main).toBe("index.mjs");
      expect(pkg.dependencies["@azure/functions"]).toMatch(/^\^4\./);
      const entry = text(files["index.mjs"]!);
      expect(
        Object.values(files).some((part) =>
          text(part).includes("azure-entry-marker"),
        ),
      ).toBe(true);
      expect(entry).toContain("app.http");
      expect(entry).toContain("__ALCHEMY_RUNTIME__");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { tags: ["unit", "provider:azure", "local"] },
);

test.effect(
  "code hash changes when source or selected handler changes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const main = `${root}/main.ts`;
      yield* fs.writeFileString(
        main,
        'export const first = "one"; export const second = "two";\n',
      );
      const source = yield* makeFunctionSource;
      const original = yield* source.bundle({ main, handler: "first" });
      const otherHandler = yield* source.bundle({ main, handler: "second" });
      expect(otherHandler.codeHash).not.toBe(original.codeHash);
      yield* fs.writeFileString(
        main,
        'export const first = "changed"; export const second = "two";\n',
      );
      const modified = yield* source.bundle({ main, handler: "first" });
      expect(modified.codeHash).not.toBe(original.codeHash);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { tags: ["unit", "provider:azure", "local"] },
);

test.effect(
  "Azure invocation bridges method, path, headers, body and closes each request scope",
  () =>
    Effect.gen(function* () {
      const previousName = process.env.ALCHEMY_STACK_NAME;
      const previousStage = process.env.ALCHEMY_STAGE;
      process.env.ALCHEMY_STACK_NAME = "azure-bootstrap-unit";
      process.env.ALCHEMY_STAGE = "testing";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousName === undefined) delete process.env.ALCHEMY_STACK_NAME;
          else process.env.ALCHEMY_STACK_NAME = previousName;
          if (previousStage === undefined) delete process.env.ALCHEMY_STAGE;
          else process.env.ALCHEMY_STAGE = previousStage;
        }),
      );
      const closed: string[] = [];
      const context = {
        Type: "Azure.Web.FunctionApp",
        id: "test",
        env: {},
        set: () => Effect.succeed(""),
        get: () => Effect.succeed(undefined),
      };
      const fetch = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const scope = yield* Scope.Scope;
        const runtime = yield* RuntimeContext;
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            closed.push(request.url);
          }),
        );
        const body = yield* request.text;
        return HttpServerResponse.text(
          `${runtime.Type}:${request.method}:${request.url}:${request.headers["x-test"]}:${body}`,
          { status: 201, headers: { "x-result": "ok" } },
        );
      });
      const entrypoint = Layer.succeed(entrypointTag, {
        RuntimeContext: {
          exports: Effect.succeed({
            program: serve(fetch).pipe(
              Effect.provideService(RuntimeContext, context),
            ),
          }),
        },
      });
      const handler = makeHandler(entrypoint);
      const request = (path: string) => ({
        method: "POST",
        url: `https://example.test/${path}?n=1`,
        headers: new Headers({ "x-test": "yes" }),
        arrayBuffer: () =>
          Promise.resolve(new TextEncoder().encode("hello").buffer),
      });
      const first = yield* Effect.promise(() => handler(request("first")));
      const second = yield* Effect.promise(() => handler(request("second")));
      expect(first.status).toBe(201);
      expect(first.headers?.["x-result"]).toBe("ok");
      expect(text(first.body!)).toContain(
        "Azure.Web.FunctionApp:POST:/first?n=1:yes:hello",
      );
      expect(text(second.body!)).toContain("/second?n=1");
      expect(closed).toEqual(["/first?n=1", "/second?n=1"]);
    }).pipe(Effect.scoped),
  { tags: ["unit", "provider:azure", "local"], exclusive: true },
);

test.effect(
  "keeps the invocation scope open until a streamed response is consumed",
  () =>
    Effect.gen(function* () {
      const previousName = process.env.ALCHEMY_STACK_NAME;
      const previousStage = process.env.ALCHEMY_STAGE;
      process.env.ALCHEMY_STACK_NAME = "azure-bootstrap-stream";
      process.env.ALCHEMY_STAGE = "testing";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousName === undefined) delete process.env.ALCHEMY_STACK_NAME;
          else process.env.ALCHEMY_STACK_NAME = previousName;
          if (previousStage === undefined) delete process.env.ALCHEMY_STAGE;
          else process.env.ALCHEMY_STAGE = previousStage;
        }),
      );
      let closed = false;
      const fetch = Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          }),
        );
        return HttpServerResponse.stream(
          Stream.fromEffect(
            Effect.sync(() => {
              expect(closed).toBe(false);
              return new TextEncoder().encode("streamed");
            }),
          ),
        );
      });
      const entrypoint = Layer.succeed(entrypointTag, {
        RuntimeContext: { exports: Effect.succeed({ program: serve(fetch) }) },
      });
      const handler = makeHandler(entrypoint);
      const response = yield* Effect.promise(() =>
        handler({
          method: "GET",
          url: "https://example.test/stream",
          headers: new Headers(),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }),
      );
      expect(response.status).toBe(200);
      expect(text(response.body)).toBe("streamed");
      expect(closed).toBe(true);
    }).pipe(Effect.scoped),
  { tags: ["unit", "provider:azure", "local"], exclusive: true },
);

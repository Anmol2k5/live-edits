// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { S3Storage } from "./storage.ts";

describe("S3 concurrent uploads", () => {
  it.each([false, true])("preserves the first object when same-name uploads race (separate instances: %s)", async (separateInstances) => {
    const objects = new Map<string, Buffer>();
    const client = {
      async send(command: { constructor: { name: string }; input: { Key: string; Body?: AsyncIterable<Uint8Array>; IfNoneMatch?: string } }) {
        const { Key, Body, IfNoneMatch } = command.input;
        if (command.constructor.name === "HeadObjectCommand") {
          if (!objects.has(Key)) throw Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } });
          return {};
        }
        if (command.constructor.name === "PutObjectCommand") {
          const chunks: Uint8Array[] = [];
          for await (const chunk of Body!) chunks.push(chunk);
          if (IfNoneMatch === "*" && objects.has(Key)) throw Object.assign(new Error("PreconditionFailed"), { $metadata: { httpStatusCode: 412 } });
          objects.set(Key, Buffer.concat(chunks));
          return {};
        }
        if (command.constructor.name === "DeleteObjectCommand") objects.delete(Key);
        return {};
      },
    } as unknown as S3Client;
    const config = { endpoint: "http://s3.example.test", region: "us-east-1", bucket: "test", accessKeyId: "test", secretAccessKey: "test", forcePathStyle: true };
    const staging = mkdtempSync(join(tmpdir(), "s3-race-"));
    const first = new S3Storage(config, staging, client);
    const second = separateInstances ? new S3Storage(config, staging, client) : first;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bodies = [Buffer.concat([png, Buffer.alloc(20, 1)]), Buffer.concat([png, Buffer.alloc(40, 2)])];
    const body = async function* (bytes: Buffer) { yield bytes; };
    const results = await Promise.allSettled([
      first.put("aaaaaaaa", "same.png", body(bodies[0]), bodies[0].length, 0, 1000),
      second.put("aaaaaaaa", "same.png", body(bodies[1]), bodies[1].length, 0, 1000),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe(separateInstances ? "exists" : "upload in progress");
    const winner = results[0].status === "fulfilled" ? 0 : 1;
    expect(objects.get("aaaaaaaa/same.png")).toEqual(bodies[winner]);
  });
});

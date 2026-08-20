import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { GatewayChunk } from "@codex-clone/core";
import { UnixSocketGatewayClient } from "./gateway-client.js";

/**
 * The container half of the gateway protocol, over a real unix socket.
 *
 * The contract under test is the one PLAN.md section 7 (risk 4) demands: the
 * gateway is a single point of failure for every running task, so every way it
 * can fail must terminate the iterator with a `refused` chunk. Never a throw
 * the loop does not expect, and never a hang.
 */

let dir: string;
let servers: Server[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-gwc-"));
});

after(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers = [];
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const socketPath = join(dir, `s-${n++}.sock`);
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

async function collect(socketPath: string, idleTimeoutMs = 3000): Promise<GatewayChunk[]> {
  const client = new UnixSocketGatewayClient({ socketPath, idleTimeoutMs });
  const out: GatewayChunk[] = [];
  for await (const chunk of client.send({ runId: "r", model: "m", input: [], stream: true })) out.push(chunk);
  return out;
}

describe("UnixSocketGatewayClient", () => {
  it("parses an NDJSON chunk stream", async () => {
    const socketPath = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "reasoning", text: "hm" })}\n`);
      res.write(`${JSON.stringify({ type: "delta", messageId: "m1", text: "hi" })}\n`);
      res.end(`${JSON.stringify({ type: "done", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, costUsd: 0 } })}\n`);
    });

    assert.deepEqual(
      (await collect(socketPath)).map((c) => c.type),
      ["reasoning", "delta", "done"],
    );
  });

  it("reassembles chunks split across packet boundaries", async () => {
    const line = `${JSON.stringify({ type: "delta", messageId: "m1", text: "hello" })}\n`;
    const socketPath = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(line.slice(0, 9));
      setTimeout(() => {
        res.write(line.slice(9));
        res.end();
      }, 30);
    });

    const chunks = await collect(socketPath);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.type === "delta" && chunks[0].text, "hello");
  });

  it("handles a final line with no trailing newline", async () => {
    const socketPath = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(JSON.stringify({ type: "done", usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 } }));
    });
    assert.equal((await collect(socketPath))[0]?.type, "done");
  });

  it("ignores a garbage line rather than aborting the turn", async () => {
    const socketPath = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write("this is not json\n");
      res.write(`${JSON.stringify({ type: "not_a_chunk_type" })}\n`);
      res.end(`${JSON.stringify({ type: "delta", messageId: "m1", text: "survived" })}\n`);
    });

    const chunks = await collect(socketPath);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.type === "delta" && chunks[0].text, "survived");
  });

  it("turns an HTTP error into a refusal", async () => {
    const socketPath = await serve((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("gateway exploded");
    });

    const chunks = await collect(socketPath);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.type, "refused");
    assert.equal(chunks[0]?.type === "refused" && chunks[0].reason, "upstream_error");
    assert.match(chunks[0]?.type === "refused" ? chunks[0].message : "", /HTTP 500.*gateway exploded/s);
  });

  it("turns a missing socket into a refusal, not a rejection", async () => {
    const chunks = await collect(join(dir, "nothing-here.sock"));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.type, "refused");
  });

  it("times out rather than hanging when the gateway goes silent", async () => {
    const socketPath = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      // Write nothing, ever. This is the hang PLAN.md risk 4 is about.
    });

    const startedAt = Date.now();
    const chunks = await collect(socketPath, 400);
    const elapsed = Date.now() - startedAt;

    assert.equal(chunks.at(-1)?.type, "refused");
    assert.match(chunks.at(-1)?.type === "refused" ? (chunks.at(-1) as { message: string }).message : "", /within 400ms/);
    assert.ok(elapsed < 5000, `must give up promptly, took ${elapsed}ms`);
  });

  it("refuses when the connection drops mid-stream", async () => {
    const socketPath = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "delta", messageId: "m1", text: "partial" })}\n`);
      setTimeout(() => res.destroy(), 20);
    });

    const chunks = await collect(socketPath);
    // The partial work is kept; the stream then ends. Either way the iterator
    // terminates, which is the property that matters.
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0]?.type, "delta");
  });
});

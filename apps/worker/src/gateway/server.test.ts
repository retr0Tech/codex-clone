import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { GatewayChunk, RunBudget } from "@codex-clone/core";
import { WIND_DOWN_INSTRUCTION } from "@codex-clone/core";
import { StaticCredentialStore } from "./credentials.js";
import { FakeUpstream, upstream } from "./fake-upstream.js";
import { callGateway } from "./ndjson-client.js";
import { GatewayServer, injectWindDown, parseGatewayRequest } from "./server.js";
import type { UpstreamEvent } from "./upstream.js";

/**
 * The gateway end to end over a real unix socket, with a fake provider.
 *
 * Real socket, real HTTP framing, real NDJSON -- and no network, no API key,
 * which is the whole point of moving the model call to the host.
 */

const budget: RunBudget = { maxTurns: 2, maxCostUsd: 1000, wallClockMs: 600_000 };
const FAKE_KEY = "sk-test-not-a-real-key-000000000000";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-gw-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
async function withGateway(
  turns: UpstreamEvent[][],
  run: (ctx: {
    call: (body: unknown) => Promise<GatewayChunk[]>;
    socketPath: string;
    server: GatewayServer;
    fake: FakeUpstream;
  }) => Promise<void>,
  opts: { budget?: RunBudget; key?: string | null } = {},
): Promise<void> {
  const socketPath = join(dir, `gw-${n++}.sock`);
  const fake = new FakeUpstream(turns);
  const server = new GatewayServer({
    socketPath,
    credentials: new StaticCredentialStore(opts.key === undefined ? FAKE_KEY : opts.key),
    upstream: fake,
    budget: opts.budget ?? budget,
  });
  await server.listen();

  const call = (body: unknown) => callGateway({ socketPath, timeoutMs: 5000 }, body);

  try {
    await run({ call, socketPath, server, fake });
  } finally {
    await server.close();
  }
}

const req = (over: Record<string, unknown> = {}) => ({
  runId: "run_1",
  model: "gpt-5",
  input: [{ role: "user", content: "hi" }],
  tools: [],
  stream: true,
  ...over,
});

describe("gateway over a unix socket", () => {
  it("streams chunks back to the agent and attaches the key upstream", async () => {
    await withGateway(
      [[upstream.reasoning("thinking"), upstream.delta("m1", "hello"), upstream.done(1000, 200)]],
      async ({ call, fake }) => {
        const chunks = await call(req());
        assert.deepEqual(
          chunks.map((c) => c.type),
          ["reasoning", "delta", "done"],
        );

        // The credential is attached by the host, and only by the host.
        assert.equal(fake.lastApiKey, FAKE_KEY);
        assert.equal(fake.requests[0]?.model, "gpt-5");
      },
    );
  });

  it("computes cost per run and reports it on the done chunk", async () => {
    await withGateway([[upstream.done(1_000_000, 1_000_000, 0)]], async ({ call, server }) => {
      const chunks = await call(req());
      const done = chunks.find((c) => c.type === "done");
      assert.ok(done && done.type === "done");
      // gpt-5: 1M input at $1.25 + 1M output at $10
      assert.ok(Math.abs(done.usage.costUsd - 11.25) < 1e-9, `got ${done.usage.costUsd}`);

      const snapshot = server.meters.peek("run_1")?.snapshot();
      assert.equal(snapshot?.inputTokens, 1_000_000);
      assert.ok(Math.abs((snapshot?.costUsd ?? 0) - 11.25) < 1e-9);
    });
  });

  it("meters separate runs separately", async () => {
    await withGateway([[upstream.done(100, 10)], [upstream.done(100, 10)]], async ({ call, server }) => {
      await call(req({ runId: "run_a" }));
      await call(req({ runId: "run_b" }));
      assert.equal(server.meters.peek("run_a")?.snapshot().turns, 1);
      assert.equal(server.meters.peek("run_b")?.snapshot().turns, 1);
    });
  });

  it("injects the wind-down for exactly one turn, then refuses", async () => {
    await withGateway(
      [
        [upstream.delta("m1", "turn 1"), upstream.done(10, 10)],
        [upstream.delta("m2", "turn 2"), upstream.done(10, 10)],
        [upstream.delta("m3", "wind-down turn"), upstream.done(10, 10)],
        [upstream.delta("m4", "must never happen"), upstream.done(10, 10)],
      ],
      async ({ call, fake }) => {
        await call(req());
        await call(req());

        // Turn 3 breaches maxTurns=2. It still reaches the model, carrying the
        // wind-down instruction, so the agent can commit and summarise.
        const third = await call(req());
        assert.equal(
          third.some((c) => c.type === "refused"),
          false,
          "the wind-down turn must be forwarded, not refused",
        );
        const injected = fake.requests[2]?.input as Array<{ role?: string; content?: string }>;
        assert.equal(injected.at(-1)?.content, WIND_DOWN_INSTRUCTION);
        assert.equal(injected.at(-1)?.role, "system");

        // Turn 4 gets nothing.
        const fourth = await call(req());
        assert.equal(fourth.length, 1);
        assert.equal(fourth[0]?.type, "refused");
        assert.equal(fourth[0]?.type === "refused" && fourth[0].reason, "max_turns");
        assert.equal(fake.requests.length, 3, "no upstream call may be made after the wind-down turn");
      },
    );
  });

  it("refuses on a cost breach, naming the reason", async () => {
    await withGateway(
      [[upstream.done(1_000_000, 1_000_000)], [upstream.done(10, 10)], [upstream.done(10, 10)]],
      async ({ call }) => {
        await call(req()); // $11.25, over the $1 cap
        await call(req()); // wind-down turn
        const third = await call(req());
        assert.equal(third[0]?.type === "refused" && third[0].reason, "max_cost");
      },
      { budget: { maxTurns: 100, maxCostUsd: 1, wallClockMs: 600_000 } },
    );
  });

  it("turns an upstream failure into a refusal rather than a hang or a 500", async () => {
    await withGateway([[upstream.error("502 Bad Gateway from api.openai.com")]], async ({ call }) => {
      const chunks = await call(req());
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0]?.type, "refused");
      assert.equal(chunks[0]?.type === "refused" && chunks[0].reason, "upstream_error");
      assert.match(chunks[0]?.type === "refused" ? chunks[0].message : "", /502/);
    });
  });

  it("refuses cleanly when no API key is configured", async () => {
    await withGateway(
      [[upstream.done(10, 10)]],
      async ({ call, fake }) => {
        const chunks = await call(req());
        assert.equal(chunks[0]?.type, "refused");
        assert.match(chunks[0]?.type === "refused" ? chunks[0].message : "", /no OpenAI API key/);
        assert.equal(fake.requests.length, 0, "must not call upstream without a key");
      },
      { key: null },
    );
  });

  it("refuses when the upstream ends without reporting usage", async () => {
    await withGateway([[upstream.delta("m1", "half an answer")]], async ({ call }) => {
      const chunks = await call(req());
      assert.equal(chunks.at(-1)?.type, "refused");
    });
  });

  it("never leaks the API key back to the caller", async () => {
    await withGateway(
      [[upstream.delta("m1", "hi"), upstream.done(10, 10)], [upstream.error("boom")]],
      async ({ call }) => {
        const ok = await call(req());
        const bad = await call(req({ runId: "run_2" }));
        const serialised = JSON.stringify([...ok, ...bad]);
        assert.equal(serialised.includes(FAKE_KEY), false, "the key must never appear in a chunk");
        assert.equal(serialised.includes("Bearer"), false);
      },
    );
  });

  it("rejects a malformed request body with 400, not a crash", async () => {
    await withGateway([], async ({ call }) => {
      const chunks = await call({ nonsense: true });
      assert.equal(chunks[0]?.type, "refused");
      assert.match(chunks[0]?.type === "refused" ? chunks[0].message : "", /HTTP 400/);
    });
  });

  it("guards the socket with a 0700 directory, and removes it on close", async () => {
    const socketDir = join(dir, `gwdir-${n++}`);
    const socketPath = join(socketDir, "gateway.sock");
    const server = new GatewayServer({
      socketPath,
      credentials: new StaticCredentialStore(FAKE_KEY),
      upstream: new FakeUpstream([]),
    });
    await server.listen();

    // The socket must be reachable by the container's uid (10001), which does
    // not correspond to any host uid -- so access control lives on the
    // directory, which only the host user can traverse.
    assert.equal((await stat(socketDir)).mode & 0o777, 0o700, "the containing directory must be owner-only");
    assert.equal((await stat(socketPath)).mode & 0o777, 0o666, "the socket must be reachable from the sandbox uid");

    await server.close();
    await assert.rejects(stat(socketPath), "a stale socket would make the next boot fail with EADDRINUSE");
  });

  it("replaces a socket left behind by a worker that was killed", async () => {
    const socketPath = join(dir, `gw-stale-${n++}.sock`);

    // A SIGKILLed process gets no chance to unlink its socket, so the file
    // survives and the next boot would fail with EADDRINUSE forever.
    const victim = spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("up"));`,
    ]);
    await new Promise<void>((resolve) => victim.stdout.once("data", () => resolve()));
    victim.kill("SIGKILL");
    await new Promise<void>((resolve) => victim.once("exit", () => resolve()));
    assert.equal((await stat(socketPath)).isSocket(), true, "the stale socket should still be on disk");

    const server = new GatewayServer({
      socketPath,
      credentials: new StaticCredentialStore(FAKE_KEY),
      upstream: new FakeUpstream([[upstream.done(1, 1)]]),
    });
    await server.listen();
    try {
      const chunks = await callGateway({ socketPath, timeoutMs: 5000 }, req());
      assert.equal(chunks.at(-1)?.type, "done");
    } finally {
      await server.close();
    }
  });
});

describe("parseGatewayRequest", () => {
  it("requires runId, model and input", () => {
    assert.throws(() => parseGatewayRequest("{}"), /runId is required/);
    assert.throws(() => parseGatewayRequest('{"runId":"r"}'), /model is required/);
    assert.throws(() => parseGatewayRequest('{"runId":"r","model":"m"}'), /input is required/);
    assert.throws(() => parseGatewayRequest("not json"), /not valid JSON/);
  });
});

describe("injectWindDown", () => {
  it("appends the instruction last, so it is the most recent thing the model sees", () => {
    const out = injectWindDown([{ role: "user", content: "a" }]) as Array<{ content: string }>;
    assert.equal(out.length, 2);
    assert.equal(out[1]?.content, WIND_DOWN_INSTRUCTION);
  });

  it("handles a bare string input", () => {
    const out = injectWindDown("just a prompt") as Array<{ content: string }>;
    assert.equal(out.length, 2);
    assert.equal(out[0]?.content, "just a prompt");
    assert.equal(out[1]?.content, WIND_DOWN_INSTRUCTION);
  });
});

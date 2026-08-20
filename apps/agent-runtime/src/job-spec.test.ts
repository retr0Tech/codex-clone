import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { InvalidJobSpecError, loadJobSpec, parseJobSpec } from "./job-spec.js";

const minimal = {
  taskId: "task_1",
  runId: "run_1",
  mode: "code",
  prompt: "do the thing",
  baseSha: "deadbeef",
  model: "gpt-5",
};

describe("parseJobSpec", () => {
  it("fills the defaults the host may omit", () => {
    const spec = parseJobSpec(JSON.stringify(minimal));
    assert.equal(spec.workspacePath, "/workspace");
    assert.equal(spec.gatewaySocketPath, "/run/gateway.sock");
    assert.equal(spec.seqStart, 0);
    assert.equal(spec.setupScript, undefined);
  });

  it("rejects a bad mode, a missing field and non-JSON", () => {
    assert.throws(() => parseJobSpec(JSON.stringify({ ...minimal, mode: "yolo" })), /mode must be/);
    assert.throws(() => parseJobSpec(JSON.stringify({ ...minimal, prompt: "" })), /prompt must be/);
    assert.throws(() => parseJobSpec("<html>"), /not valid JSON/);
    assert.throws(() => parseJobSpec("[1,2,3]"), /not an object/);
  });

  it("clamps nonsensical bounds instead of trusting them", () => {
    const spec = parseJobSpec(JSON.stringify({ ...minimal, maxTurns: 0, maxToolOutputBytes: 1 }));
    assert.equal(spec.maxTurns, 1);
    assert.equal(spec.maxToolOutputBytes, 1024);
  });
});

describe("loadJobSpec", () => {
  it("prefers the bind-mounted file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-job-"));
    const path = join(dir, "job.json");
    await writeFile(path, JSON.stringify({ ...minimal, prompt: "from file" }));
    try {
      const spec = await loadJobSpec({ path, stdin: Readable.from([]) });
      assert.equal(spec.prompt, "from file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to stdin when the file is absent", async () => {
    const spec = await loadJobSpec({
      path: "/definitely/not/here.json",
      stdin: Readable.from([JSON.stringify({ ...minimal, prompt: "from stdin" })]),
    });
    assert.equal(spec.prompt, "from stdin");
  });

  it("fails fast with an empty stdin rather than blocking forever", async () => {
    await assert.rejects(
      loadJobSpec({ path: "/definitely/not/here.json", stdin: Readable.from([]) }),
      InvalidJobSpecError,
    );
  });

  it("never falls back to the environment", async () => {
    process.env["AGENT_PROMPT"] = "injected via env";
    try {
      await assert.rejects(loadJobSpec({ path: undefined, stdin: Readable.from([]) }), InvalidJobSpecError);
    } finally {
      delete process.env["AGENT_PROMPT"];
    }
  });
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyPatchTool } from "./apply-patch.js";
import { grepTool } from "./grep.js";
import { readFileTool } from "./read-file.js";
import { shellTool } from "./shell.js";
import { buildToolRegistry } from "./index.js";
import type { ToolContext } from "./types.js";
import { truncate } from "./types.js";

let workspace: string;
let ctx: ToolContext;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "codex-tools-"));
  ctx = { workspacePath: workspace, mode: "code", maxOutputBytes: 2048 };
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  await writeFile(join(workspace, "README.md"), "# demo\nneedle here\n");
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("buildToolRegistry", () => {
  it("withholds apply_patch in ask mode", () => {
    assert.deepEqual([...buildToolRegistry("ask").keys()].sort(), ["grep", "read_file", "shell"]);
  });
  it("grants apply_patch in code mode", () => {
    assert.deepEqual([...buildToolRegistry("code").keys()].sort(), ["apply_patch", "grep", "read_file", "shell"]);
  });
});

describe("truncate", () => {
  it("leaves short output alone", () => {
    assert.deepEqual(truncate("hello", 100), { text: "hello", truncated: false });
  });

  it("keeps the head and the tail and says how much it dropped", () => {
    const cut = truncate("A".repeat(500) + "TAILMARKER", 200);
    assert.equal(cut.truncated, true);
    assert.match(cut.text, /bytes omitted by the sandbox/);
    assert.match(cut.text, /TAILMARKER$/);
    assert.ok(cut.text.startsWith("A"));
  });
});

describe("shell", () => {
  it("returns stdout and exit code 0", async () => {
    const res = await shellTool.run({ command: "echo hello" }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 0);
    assert.match(res.output, /hello/);
  });

  it("reports a non-zero exit as not-ok and still returns the output", async () => {
    const res = await shellTool.run({ command: "echo to-stderr >&2; exit 3" }, ctx);
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 3);
    assert.match(res.output, /to-stderr/);
  });

  it("runs in the workspace", async () => {
    const res = await shellTool.run({ command: "pwd" }, ctx);
    assert.match(res.output.trim(), new RegExp(`${workspace.split("/").pop()}$`));
  });

  it("kills a command that outruns its timeout and says so honestly", async () => {
    const res = await shellTool.run({ command: "sleep 30", timeout_ms: 250 }, ctx);
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 124);
    assert.match(res.output, /timed out after 250ms/);
  });

  it("truncates enormous output and sets the flag", async () => {
    const res = await shellTool.run({ command: "yes abcdefghij | head -c 200000" }, { ...ctx, maxOutputBytes: 1024 });
    assert.equal(res.truncated, true);
    assert.ok(res.output.length < 4096);
  });
});

describe("read_file", () => {
  it("reads a file", async () => {
    const res = await readFileTool.run({ path: "src/app.ts" }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.output, /const b = 2;/);
  });

  it("reads a numbered line range", async () => {
    const res = await readFileTool.run({ path: "src/app.ts", start_line: 2, end_line: 2 }, ctx);
    assert.equal(res.output, "2\tconst b = 2;");
  });

  it("refuses to escape the workspace", async () => {
    const res = await readFileTool.run({ path: "../../../etc/passwd" }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.output, /escapes the workspace/);
  });

  it("reports a missing file rather than throwing", async () => {
    const res = await readFileTool.run({ path: "nope.txt" }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.output, /cannot read nope.txt/);
  });
});

describe("grep", () => {
  it("finds matches with file and line", async (t) => {
    const res = await grepTool.run({ pattern: "needle" }, ctx);
    if (res.exitCode === 127) {
      t.skip("ripgrep is not installed on this host (it is baked into the agent image)");
      return;
    }
    assert.equal(res.ok, true);
    assert.match(res.output, /README\.md:2:needle here/);
  });

  it("treats no matches as a successful search", async (t) => {
    const res = await grepTool.run({ pattern: "zzz-not-present-zzz" }, ctx);
    if (res.exitCode === 127) {
      t.skip("ripgrep is not installed on this host");
      return;
    }
    assert.equal(res.ok, true);
    assert.equal(res.output, "no matches");
  });
});

describe("apply_patch", () => {
  it("adds a file", async () => {
    const res = await applyPatchTool.run(
      { patch: "*** Begin Patch\n*** Add File: src/new.ts\n+export const x = 1;\n*** End Patch\n" },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(await readFile(join(workspace, "src/new.ts"), "utf8"), "export const x = 1;\n");
  });

  it("updates a file by matching context, not line numbers", async () => {
    const res = await applyPatchTool.run(
      {
        patch:
          "*** Begin Patch\n*** Update File: src/app.ts\n@@\n const a = 1;\n-const b = 2;\n+const b = 22;\n const c = 3;\n*** End Patch\n",
      },
      ctx,
    );
    assert.equal(res.ok, true);
    assert.equal(await readFile(join(workspace, "src/app.ts"), "utf8"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
  });

  it("fails loudly when the context does not match, rather than guessing", async () => {
    const res = await applyPatchTool.run(
      { patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const zzz = 9;\n+const zzz = 10;\n*** End Patch\n" },
      ctx,
    );
    assert.equal(res.ok, false);
    assert.match(res.output, /did not match the file/);
  });

  it("deletes a file", async () => {
    await writeFile(join(workspace, "doomed.txt"), "bye\n");
    const res = await applyPatchTool.run({ patch: "*** Begin Patch\n*** Delete File: doomed.txt\n*** End Patch\n" }, ctx);
    assert.equal(res.ok, true);
    await assert.rejects(readFile(join(workspace, "doomed.txt"), "utf8"));
  });

  it("refuses a patch that writes outside the workspace, touching nothing", async () => {
    const res = await applyPatchTool.run(
      { patch: "*** Begin Patch\n*** Add File: ../escaped.txt\n+pwned\n*** Update File: src/app.ts\n@@\n const a = 1;\n-const b = 22;\n+const b = 999;\n*** End Patch\n" },
      ctx,
    );
    assert.equal(res.ok, false);
    assert.match(res.output, /escapes the workspace/);
    // Validation happens before any write, so the second (valid) op did not land.
    assert.match(await readFile(join(workspace, "src/app.ts"), "utf8"), /const b = 22;/);
  });

  it("rejects a malformed envelope", async () => {
    const res = await applyPatchTool.run({ patch: "just some text" }, ctx);
    assert.equal(res.ok, false);
    assert.match(res.output, /must start with/);
  });
});

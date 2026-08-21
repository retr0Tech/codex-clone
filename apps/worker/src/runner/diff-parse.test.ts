import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_PATCH_BYTES,
  mergeFileStats,
  parseNameStatus,
  parseNumstat,
  truncatePatch,
} from "./diff-parse.js";
import { DiffTrigger } from "./diff.js";

/**
 * The diff is what the user judges the run by, so a parser that quietly
 * mis-attributes a line count or drops a file is worse than one that crashes.
 * These are the shapes git actually emits, NUL delimiters and all.
 */

const NUL = "\0";

describe("parsing --name-status -z", () => {
  it("reads the ordinary two-field records", () => {
    const out = ["A", "added.ts", "M", "changed.ts", "D", "gone.ts"].join(NUL) + NUL;
    assert.deepEqual(parseNameStatus(out), [
      { path: "added.ts", status: "added" },
      { path: "changed.ts", status: "modified" },
      { path: "gone.ts", status: "deleted" },
    ]);
  });

  /** A rename spends THREE fields. Reading it as two desynchronises the rest. */
  it("consumes both paths of a rename and keeps the new one", () => {
    const out = ["R100", "old/name.ts", "new/name.ts", "M", "after.ts"].join(NUL) + NUL;
    assert.deepEqual(parseNameStatus(out), [
      { path: "new/name.ts", status: "renamed" },
      { path: "after.ts", status: "modified" },
    ]);
  });

  it("treats a copy as an addition, which is what it is to a reader", () => {
    const out = ["C75", "src/a.ts", "src/b.ts"].join(NUL) + NUL;
    assert.deepEqual(parseNameStatus(out), [{ path: "src/b.ts", status: "added" }]);
  });

  it("survives paths with spaces and non-ASCII, which is why -z is used", () => {
    const out = ["A", "docs/a file — with dashes.md"].join(NUL) + NUL;
    assert.deepEqual(parseNameStatus(out), [{ path: "docs/a file — with dashes.md", status: "added" }]);
  });

  it("degrades a status it has never seen to `modified` rather than guessing", () => {
    const out = ["T", "mode-changed.sh"].join(NUL) + NUL;
    assert.deepEqual(parseNameStatus(out), [{ path: "mode-changed.sh", status: "modified" }]);
  });

  it("returns nothing for an empty diff", () => {
    assert.deepEqual(parseNameStatus(""), []);
  });

  /** Half a record is not a file; inventing one would put a phantom in the UI. */
  it("does not hang or throw on a truncated record", () => {
    assert.deepEqual(parseNameStatus(`A${NUL}`), []);
    assert.deepEqual(parseNameStatus("A"), []);
    assert.deepEqual(parseNameStatus(`R100${NUL}only-one-path`), []);
    // ...and a complete record before the truncated one still survives.
    assert.deepEqual(parseNameStatus(["M", "kept.ts", "A"].join(NUL) + NUL), [
      { path: "kept.ts", status: "modified" },
    ]);
  });
});

describe("parsing --numstat -z", () => {
  it("reads additions and deletions per path", () => {
    const out = [`10\t2\tsrc/a.ts`, `0\t7\tsrc/b.ts`].join(NUL) + NUL;
    assert.deepEqual([...parseNumstat(out)], [
      ["src/a.ts", { additions: 10, deletions: 2 }],
      ["src/b.ts", { additions: 0, deletions: 7 }],
    ]);
  });

  /** Rename records leave the path field EMPTY and follow with two more. */
  it("keys a rename's counts on the new path", () => {
    const out = [`3\t1\t`, "old.ts", "new.ts", `5\t0\tafter.ts`].join(NUL) + NUL;
    const counts = parseNumstat(out);
    assert.deepEqual(counts.get("new.ts"), { additions: 3, deletions: 1 });
    assert.deepEqual(counts.get("after.ts"), { additions: 5, deletions: 0 });
    assert.equal(counts.has("old.ts"), false);
  });

  it("reports a binary file as zero rather than NaN", () => {
    const out = [`-\t-\tlogo.png`].join(NUL) + NUL;
    assert.deepEqual(parseNumstat(out).get("logo.png"), { additions: 0, deletions: 0 });
  });

  it("returns nothing for an empty diff", () => {
    assert.equal(parseNumstat("").size, 0);
  });
});

describe("merging the two views", () => {
  it("joins status and counts, and defaults counts that are missing", () => {
    const statuses = parseNameStatus(["A", "new.ts", "D", "old.ts"].join(NUL) + NUL);
    const counts = parseNumstat([`12\t0\tnew.ts`].join(NUL) + NUL);
    assert.deepEqual(mergeFileStats(statuses, counts), [
      { path: "new.ts", status: "added", additions: 12, deletions: 0 },
      { path: "old.ts", status: "deleted", additions: 0, deletions: 0 },
    ]);
  });

  it("keeps the file list in git's order", () => {
    const statuses = parseNameStatus(["M", "b.ts", "M", "a.ts"].join(NUL) + NUL);
    assert.deepEqual(mergeFileStats(statuses, new Map()).map((f) => f.path), ["b.ts", "a.ts"]);
  });
});

describe("patch truncation", () => {
  it("leaves a small patch alone", () => {
    const patch = "diff --git a/x b/x\n+one line\n";
    assert.deepEqual(truncatePatch(patch), { patch, truncated: false });
  });

  it("cuts at a line boundary and says so", () => {
    const patch = `${"+aaaaaaaaaa\n".repeat(200)}`;
    const result = truncatePatch(patch, 100);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.patch, "utf8") < patch.length);
    assert.match(result.patch, /patch truncated at 100 bytes/);
    // Cut mid-line, a diff renderer shows a corrupt final hunk. Every line
    // before the notice must therefore be a whole one.
    const lines = result.patch.split("\n");
    const beforeNotice = lines.slice(0, lines.findIndex((line) => line.startsWith("…")));
    assert.ok(beforeNotice.length > 0);
    assert.ok(
      beforeNotice.every((line) => line === "+aaaaaaaaaa"),
      `expected whole lines only, got: ${JSON.stringify(beforeNotice)}`,
    );
  });

  it("has a default ceiling, so a runaway diff cannot be sent whole", () => {
    assert.equal(truncatePatch("x".repeat(MAX_PATCH_BYTES + 1)).truncated, true);
  });
});

/**
 * "After each turn" has to mean something exact. Within a turn the agent emits
 * tool calls and results back to back; the turn ends at the first event that is
 * not one of those.
 */
describe("when a diff is worth deriving", () => {
  const call = (t: DiffTrigger) => t.shouldDeriveBefore("tool_call", { tool: "apply_patch" });
  const result = (t: DiffTrigger, tool: string, ok = true) => t.shouldDeriveBefore("tool_result", { tool, ok });

  it("derives once at the end of a turn that wrote", () => {
    const trigger = new DiffTrigger();
    assert.equal(call(trigger), false);
    assert.equal(result(trigger, "apply_patch"), false, "not yet -- more tools may follow in this turn");
    assert.equal(trigger.shouldDeriveBefore("message", {}), true, "the turn is over");
    trigger.markDerived();
    assert.equal(trigger.shouldDeriveBefore("phase", {}), false, "and not again for the same work");
  });

  it("coalesces several writes in one turn into one diff", () => {
    const trigger = new DiffTrigger();
    result(trigger, "apply_patch");
    result(trigger, "shell");
    result(trigger, "apply_patch");
    assert.equal(trigger.shouldDeriveBefore("reasoning", {}), true);
    trigger.markDerived();
    assert.equal(trigger.dirty, false);
  });

  it("does not extract a workspace for a turn that only read", () => {
    const trigger = new DiffTrigger();
    result(trigger, "read_file");
    result(trigger, "grep");
    assert.equal(trigger.shouldDeriveBefore("message", {}), false);
  });

  it("ignores a tool that failed -- apply_patch is atomic, so nothing changed", () => {
    const trigger = new DiffTrigger();
    result(trigger, "apply_patch", false);
    assert.equal(trigger.shouldDeriveBefore("message", {}), false);
  });

  it("stays dirty when the stream ends mid-turn, so partial work is still shown", () => {
    const trigger = new DiffTrigger();
    result(trigger, "shell");
    // No boundary event ever arrives -- the container was killed.
    assert.equal(trigger.dirty, true);
  });
});

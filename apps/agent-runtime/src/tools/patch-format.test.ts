import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyHunks } from "./apply-patch.js";
import { parsePatch, PatchParseError } from "./patch-format.js";

describe("parsePatch", () => {
  it("parses add, update, move and delete in one envelope", () => {
    const ops = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: a.txt",
        "+one",
        "+two",
        "*** Update File: b.txt",
        "*** Move to: c.txt",
        "@@ anchor",
        " keep",
        "-drop",
        "+add",
        "*** Delete File: d.txt",
        "*** End Patch",
      ].join("\n"),
    );

    assert.equal(ops.length, 3);
    assert.deepEqual(ops[0], { kind: "add", path: "a.txt", contents: "one\ntwo\n" });
    const update = ops[1] as Extract<(typeof ops)[number], { kind: "update" }>;
    assert.equal(update.path, "b.txt");
    assert.equal(update.moveTo, "c.txt");
    assert.equal(update.hunks[0]?.header, "anchor");
    assert.deepEqual(update.hunks[0]?.lines, [
      { op: " ", text: "keep" },
      { op: "-", text: "drop" },
      { op: "+", text: "add" },
    ]);
    assert.deepEqual(ops[2], { kind: "delete", path: "d.txt" });
  });

  it("splits multiple hunks in one file on @@", () => {
    const ops = parsePatch(
      ["*** Begin Patch", "*** Update File: f.txt", "@@", " a", "-b", "+B", "@@", " y", "-z", "+Z", "*** End Patch"].join("\n"),
    );
    const update = ops[0] as Extract<(typeof ops)[number], { kind: "update" }>;
    assert.equal(update.hunks.length, 2);
  });

  it("creates an empty file for an Add section with no body", () => {
    const ops = parsePatch("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch");
    assert.deepEqual(ops[0], { kind: "add", path: "empty.txt", contents: "" });
  });

  it("rejects a missing header, a missing footer, an empty patch and a bad path", () => {
    assert.throws(() => parsePatch("*** Add File: a\n+x\n*** End Patch"), PatchParseError);
    assert.throws(() => parsePatch("*** Begin Patch\n*** Add File: a\n+x"), PatchParseError);
    assert.throws(() => parsePatch("*** Begin Patch\n*** End Patch"), /no file operations/);
    assert.throws(() => parsePatch("*** Begin Patch\n*** Delete File:   \n*** End Patch"), /empty path/);
  });

  it("rejects a stray line in an Add section", () => {
    assert.throws(
      () => parsePatch("*** Begin Patch\n*** Add File: a.txt\n+ok\nnot prefixed\n*** End Patch"),
      /must start with "\+"/,
    );
  });
});

describe("applyHunks", () => {
  const file = "alpha\nbravo\ncharlie\ndelta\n";

  function update(patchBody: string[]) {
    const ops = parsePatch(["*** Begin Patch", "*** Update File: f.txt", ...patchBody, "*** End Patch"].join("\n"));
    return ops[0] as Extract<(typeof ops)[number], { kind: "update" }>;
  }

  it("replaces a matched block", () => {
    const out = applyHunks(file, update(["@@", " alpha", "-bravo", "+BRAVO", " charlie"]));
    assert.equal(out, "alpha\nBRAVO\ncharlie\ndelta\n");
  });

  it("inserts without removing", () => {
    const out = applyHunks(file, update(["@@", " alpha", "+inserted", " bravo"]));
    assert.equal(out, "alpha\ninserted\nbravo\ncharlie\ndelta\n");
  });

  it("deletes lines", () => {
    const out = applyHunks(file, update(["@@", " alpha", "-bravo", "-charlie", " delta"]));
    assert.equal(out, "alpha\ndelta\n");
  });

  it("applies repeated blocks in document order rather than all at the first match", () => {
    const repeated = "x\nMARK\ny\nMARK\nz\n";
    const out = applyHunks(repeated, update(["@@", " x", "-MARK", "+FIRST", "@@", " y", "-MARK", "+SECOND"]));
    assert.equal(out, "x\nFIRST\ny\nSECOND\nz\n");
  });

  it("preserves a file that has no trailing newline", () => {
    const out = applyHunks("one\ntwo", update(["@@", " one", "-two", "+TWO"]));
    assert.equal(out, "one\nTWO");
  });

  it("refuses a hunk with nothing to anchor on", () => {
    assert.throws(() => applyHunks(file, update(["@@", "+floating"])), /nowhere to anchor/);
  });

  it("refuses a hunk whose context is not in the file", () => {
    assert.throws(() => applyHunks(file, update(["@@", " nonexistent", "-bravo", "+B"])), /did not match the file/);
  });
});

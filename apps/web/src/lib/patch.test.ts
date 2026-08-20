import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventPayloadMap } from "@codex-clone/core";
import { countChanges, parsePatch } from "./patch";
import { mockRuns } from "../mocks/runs";

function diffPayload(runIndex: number): EventPayloadMap["diff"] {
  const event = mockRuns[runIndex]!.events.find((e) => e.type === "diff");
  assert.ok(event && event.type === "diff", "fixture must contain a diff event");
  return event.payload;
}

describe("parsePatch", () => {
  it("splits a multi-file patch and prefers the post-image path", () => {
    const files = parsePatch(diffPayload(0).patch);
    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["src/middleware/rateLimit.ts", "src/server.ts", "src/middleware/rateLimit.test.ts"],
    );
  });

  it("numbers lines from the hunk header, skipping the other side", () => {
    const files = parsePatch(
      [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -10,3 +10,4 @@",
        " keep",
        "-gone",
        "+added",
        "+also added",
      ].join("\n"),
    );
    const lines = files[0]!.lines.filter((l) => l.type !== "meta" && l.type !== "hunk");
    assert.deepStrictEqual(
      lines.map((l) => [l.type, l.oldNo, l.newNo]),
      [
        ["ctx", 10, 10],
        ["del", 11, null],
        ["add", null, 11],
        ["add", null, 12],
      ],
    );
  });

  it("counts changes that agree with the diff event's own per-file stats", () => {
    // The stat line and the patch come from the same `git diff`, so a
    // disagreement means the renderer is lying about one of them.
    const payload = diffPayload(0);
    const files = parsePatch(payload.patch);
    for (const stat of payload.files) {
      const parsed = files.find((f) => f.path === stat.path);
      assert.ok(parsed, `patch should contain ${stat.path}`);
      assert.deepStrictEqual(countChanges(parsed), {
        additions: stat.additions,
        deletions: stat.deletions,
      });
    }
  });

  it("keeps unrecognised lines as meta rather than dropping them", () => {
    const files = parsePatch(
      ["diff --git a/b.bin b/b.bin", "index 111..222 100644", "Binary files a/b.bin and b/b.bin differ"].join("\n"),
    );
    assert.equal(files.length, 1);
    assert.ok(files[0]!.lines.every((l) => l.type === "meta"));
  });

  it("handles a headerless fragment without losing content", () => {
    const files = parsePatch(["@@ -1,2 +1,2 @@", "-old", "+new"].join("\n"));
    assert.equal(files.length, 1);
    assert.equal(files[0]!.path, "");
    assert.deepStrictEqual(countChanges(files[0]!), { additions: 1, deletions: 1 });
  });

  it("returns nothing for an empty patch", () => {
    assert.deepStrictEqual(parsePatch(""), []);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubClient, formatIssueContext } from "./client.js";
import type { OctokitLike } from "./octokit.js";

/**
 * A hand-written Octokit. No network, no credential, no fixture server -- the
 * whole reason `GitHubClient` is written against `OctokitLike`.
 */
interface Call {
  route: string;
  params: Record<string, unknown>;
}

function fakeOctokit(handlers: {
  request?: Record<string, unknown>;
  paginate?: Record<string, unknown[]>;
}): OctokitLike & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request<T>(route: string, params: Record<string, unknown> = {}) {
      calls.push({ route, params });
      const data = handlers.request?.[route];
      if (data === undefined) throw new Error(`unexpected request: ${route}`);
      return { status: 200, data: data as T };
    },
    async paginate<T>(route: string, params: Record<string, unknown> = {}) {
      calls.push({ route, params });
      const data = handlers.paginate?.[route];
      if (data === undefined) throw new Error(`unexpected paginate: ${route}`);
      return data as T[];
    },
  };
}

describe("GitHubClient.getViewer", () => {
  it("reads the authenticated login", async () => {
    const kit = fakeOctokit({ request: { "GET /user": { login: "retr0Tech", name: "Elliot" } } });
    assert.deepEqual(await new GitHubClient(kit).getViewer(), { login: "retr0Tech", name: "Elliot" });
  });

  it("tolerates a null display name", async () => {
    const kit = fakeOctokit({ request: { "GET /user": { login: "octocat", name: null } } });
    assert.equal((await new GitHubClient(kit).getViewer()).name, null);
  });
});

describe("GitHubClient.listRepositories", () => {
  const page = [
    {
      id: 11,
      name: "old",
      full_name: "acme/old",
      owner: { login: "acme" },
      default_branch: "master",
      private: false,
      clone_url: "https://github.com/acme/old.git",
      description: "stale",
      pushed_at: "2024-01-01T00:00:00Z",
    },
    {
      id: 22,
      name: "fresh",
      full_name: "acme/fresh",
      owner: { login: "acme" },
      default_branch: "main",
      private: true,
      clone_url: "https://github.com/acme/fresh.git",
      description: null,
      pushed_at: "2026-08-01T00:00:00Z",
    },
  ];

  it("paginates and normalises", async () => {
    const kit = fakeOctokit({ paginate: { "GET /user/repos": page } });
    const repos = await new GitHubClient(kit).listRepositories();

    assert.equal(repos.length, 2);
    assert.deepEqual(repos[0], {
      id: "22",
      owner: "acme",
      name: "fresh",
      fullName: "acme/fresh",
      defaultBranch: "main",
      private: true,
      cloneUrl: "https://github.com/acme/fresh.git",
      description: null,
      pushedAt: "2026-08-01T00:00:00Z",
    });
  });

  it("sorts most-recently-pushed first", async () => {
    const kit = fakeOctokit({ paginate: { "GET /user/repos": page } });
    const repos = await new GitHubClient(kit).listRepositories();
    assert.deepEqual(repos.map((r) => r.fullName), ["acme/fresh", "acme/old"]);
  });

  it("asks for full pages and every affiliation by default", async () => {
    const kit = fakeOctokit({ paginate: { "GET /user/repos": [] } });
    await new GitHubClient(kit).listRepositories();

    const call = kit.calls[0];
    assert.ok(call);
    assert.equal(call.params["per_page"], 100);
    assert.equal(call.params["affiliation"], "owner,collaborator,organization_member");
  });

  it("fills in defaults for a sparse payload", async () => {
    const kit = fakeOctokit({
      paginate: { "GET /user/repos": [{ id: 5, name: "bare", full_name: "solo/bare", owner: null }] },
    });
    const [repo] = await new GitHubClient(kit).listRepositories();

    assert.ok(repo);
    assert.equal(repo.owner, "solo");
    assert.equal(repo.defaultBranch, "main");
    assert.equal(repo.private, false);
    assert.equal(repo.cloneUrl, "https://github.com/solo/bare.git");
  });
});

describe("GitHubClient.listBranches", () => {
  it("returns name, head sha and protection", async () => {
    const kit = fakeOctokit({
      paginate: {
        "GET /repos/{owner}/{repo}/branches": [
          { name: "main", commit: { sha: "a".repeat(40) }, protected: true },
          { name: "topic", commit: { sha: "b".repeat(40) } },
        ],
      },
    });

    const branches = await new GitHubClient(kit).listBranches("acme", "fresh");
    assert.deepEqual(branches, [
      { name: "main", sha: "a".repeat(40), protected: true },
      { name: "topic", sha: "b".repeat(40), protected: false },
    ]);
    assert.equal(kit.calls[0]?.params["owner"], "acme");
    assert.equal(kit.calls[0]?.params["repo"], "fresh");
  });
});

describe("GitHubClient.resolveRefSha", () => {
  it("resolves a ref through the commits endpoint", async () => {
    const kit = fakeOctokit({
      request: { "GET /repos/{owner}/{repo}/commits/{ref}": { sha: "c".repeat(40) } },
    });

    assert.equal(await new GitHubClient(kit).resolveRefSha("acme", "fresh", "main"), "c".repeat(40));
    // The commits endpoint (not git/ref/heads) is what makes a tag or a raw
    // sha resolve too.
    assert.equal(kit.calls[0]?.route, "GET /repos/{owner}/{repo}/commits/{ref}");
    assert.equal(kit.calls[0]?.params["ref"], "main");
  });

  it("propagates a not-found failure rather than inventing a sha", async () => {
    const kit = fakeOctokit({});
    await assert.rejects(() => new GitHubClient(kit).resolveRefSha("acme", "fresh", "nope"));
  });
});

describe("GitHubClient.getIssueContext", () => {
  const issue = {
    number: 42,
    title: "Crash on empty input",
    state: "open",
    body: "Steps to reproduce…",
    html_url: "https://github.com/acme/fresh/issues/42",
    user: { login: "reporter" },
    labels: ["bug", { name: "p1" }],
    comments: 2,
  };

  it("fetches the issue and its comments", async () => {
    const kit = fakeOctokit({
      request: { "GET /repos/{owner}/{repo}/issues/{issue_number}": issue },
      paginate: {
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments": [
          { body: "confirmed", user: { login: "maintainer" } },
          { body: "patch incoming", user: null },
        ],
      },
    });

    const context = await new GitHubClient(kit).getIssueContext("acme", "fresh", 42);
    assert.equal(context.kind, "issue");
    assert.equal(context.number, 42);
    assert.deepEqual(context.labels, ["bug", "p1"]);
    assert.deepEqual(context.comments, [
      { author: "maintainer", body: "confirmed" },
      { author: null, body: "patch incoming" },
    ]);
  });

  it("recognises a pull request, which GitHub serves from the issues endpoint", async () => {
    const kit = fakeOctokit({
      request: {
        "GET /repos/{owner}/{repo}/issues/{issue_number}": { ...issue, comments: 0, pull_request: { url: "…" } },
      },
    });

    assert.equal((await new GitHubClient(kit).getIssueContext("acme", "fresh", 42)).kind, "pull_request");
  });

  it("skips the comments request when there are none", async () => {
    const kit = fakeOctokit({
      request: { "GET /repos/{owner}/{repo}/issues/{issue_number}": { ...issue, comments: 0 } },
    });

    const context = await new GitHubClient(kit).getIssueContext("acme", "fresh", 42);
    assert.deepEqual(context.comments, []);
    assert.equal(kit.calls.length, 1);
  });

  it("caps the comment thread, because the prompt budget is finite", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ body: `c${i}`, user: { login: "u" } }));
    const kit = fakeOctokit({
      request: { "GET /repos/{owner}/{repo}/issues/{issue_number}": { ...issue, comments: 100 } },
      paginate: { "GET /repos/{owner}/{repo}/issues/{issue_number}/comments": many },
    });

    const context = await new GitHubClient(kit).getIssueContext("acme", "fresh", 42, { maxComments: 3 });
    assert.equal(context.comments.length, 3);
  });

  it("honours includeComments: false", async () => {
    const kit = fakeOctokit({
      request: { "GET /repos/{owner}/{repo}/issues/{issue_number}": issue },
    });

    const context = await new GitHubClient(kit).getIssueContext("acme", "fresh", 42, { includeComments: false });
    assert.deepEqual(context.comments, []);
    assert.equal(kit.calls.length, 1);
  });

  it("handles a null body", async () => {
    const kit = fakeOctokit({
      request: { "GET /repos/{owner}/{repo}/issues/{issue_number}": { ...issue, body: null, comments: 0 } },
    });
    assert.equal((await new GitHubClient(kit).getIssueContext("acme", "fresh", 42)).body, "");
  });
});

describe("formatIssueContext", () => {
  it("renders the block the host injects into the prompt", () => {
    const text = formatIssueContext({
      number: 42,
      kind: "issue",
      title: "Crash on empty input",
      state: "open",
      body: "Steps to reproduce",
      author: "reporter",
      url: "https://github.com/acme/fresh/issues/42",
      labels: ["bug"],
      comments: [{ author: "maintainer", body: "confirmed" }],
    });

    assert.match(text, /^Issue #42: Crash on empty input$/m);
    assert.match(text, /opened by reporter/);
    assert.match(text, /Labels: bug/);
    assert.match(text, /Steps to reproduce/);
    assert.match(text, /--- comment by maintainer ---/);
  });

  it("says so when a pull request has no description", () => {
    const text = formatIssueContext({
      number: 7,
      kind: "pull_request",
      title: "Bump deps",
      state: "closed",
      body: "   ",
      author: null,
      url: "https://github.com/acme/fresh/pull/7",
      labels: [],
      comments: [],
    });

    assert.match(text, /^Pull request #7: Bump deps$/m);
    assert.match(text, /\(no description\)/);
    assert.ok(!text.includes("opened by"));
    assert.ok(!text.includes("Labels:"));
  });
});

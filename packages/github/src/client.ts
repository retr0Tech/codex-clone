/**
 * Everything the host does against the GitHub API.
 *
 * All of it runs on the host, never in a sandbox: PLAN.md §3.3 puts zero
 * credentials in the agent container, which means the agent cannot read an
 * issue for itself. `getIssueContext` + `formatIssueContext` exist so the host
 * can fetch that text and inject it into the prompt instead.
 */

import type { OctokitLike } from "./octokit.js";

export interface GitHubViewer {
  login: string;
  name: string | null;
}

export interface RepoSummary {
  /** GitHub's numeric id, as a string -- this is the `repos.id` primary key. */
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  /** Plain https URL. Credentials are supplied per-invocation, never stored in it. */
  cloneUrl: string;
  description: string | null;
  pushedAt: string | null;
}

export interface BranchSummary {
  name: string;
  sha: string;
  protected: boolean;
}

export interface IssueComment {
  author: string | null;
  body: string;
}

export interface IssueContext {
  number: number;
  /** GitHub models a PR as an issue; this says which one it actually is. */
  kind: "issue" | "pull_request";
  title: string;
  state: string;
  body: string;
  author: string | null;
  url: string;
  labels: string[];
  comments: IssueComment[];
}

export interface ListRepositoriesOptions {
  /** Page size for the underlying paginated request. */
  perPage?: number;
  /** GitHub's `affiliation` filter. Defaults to repos the user can push to. */
  affiliation?: string;
  sort?: "created" | "updated" | "pushed" | "full_name";
}

export interface GetIssueOptions {
  includeComments?: boolean;
  /** Comment threads can be enormous; the prompt budget is not. */
  maxComments?: number;
}

const DEFAULT_MAX_COMMENTS = 30;

export class GitHubClient {
  readonly #kit: OctokitLike;

  constructor(kit: OctokitLike) {
    this.#kit = kit;
  }

  /** `GET /user`. Also the credential check behind "Test connection". */
  async getViewer(): Promise<GitHubViewer> {
    const { data } = await this.#kit.request<{ login: string; name: string | null }>("GET /user");
    return { login: data.login, name: data.name ?? null };
  }

  /**
   * Every repository the token can reach, following pagination to the end.
   *
   * Sorted most-recently-pushed first: the repo picker's job is to put the
   * thing you were just working on at the top.
   */
  async listRepositories(options: ListRepositoriesOptions = {}): Promise<RepoSummary[]> {
    const raw = await this.#kit.paginate<RawRepo>("GET /user/repos", {
      per_page: options.perPage ?? 100,
      affiliation: options.affiliation ?? "owner,collaborator,organization_member",
      sort: options.sort ?? "pushed",
    });

    return raw
      .map(toRepoSummary)
      .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  }

  async listBranches(owner: string, repo: string, perPage = 100): Promise<BranchSummary[]> {
    const raw = await this.#kit.paginate<RawBranch>("GET /repos/{owner}/{repo}/branches", {
      owner,
      repo,
      per_page: perPage,
    });

    return raw.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
      protected: branch.protected ?? false,
    }));
  }

  /**
   * Resolves a ref to a commit SHA.
   *
   * Uses the commits endpoint rather than `git/ref/heads/{branch}` so a tag or
   * a raw SHA resolves too. Every task pins `tasks.base_sha` at creation from
   * this, and every diff is derived against that pin -- so if the branch moves
   * mid-run the diff still means what it said it meant.
   */
  async resolveRefSha(owner: string, repo: string, ref: string): Promise<string> {
    const { data } = await this.#kit.request<{ sha: string }>("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      repo,
      ref,
    });
    return data.sha;
  }

  async getRepository(owner: string, repo: string): Promise<RepoSummary> {
    const { data } = await this.#kit.request<RawRepo>("GET /repos/{owner}/{repo}", { owner, repo });
    return toRepoSummary(data);
  }

  /**
   * Issue or PR text, plus its comment thread.
   *
   * `GET /repos/{owner}/{repo}/issues/{n}` serves both -- a pull request is an
   * issue with a `pull_request` key -- so one call covers "fix #42" whichever
   * kind 42 turns out to be.
   */
  async getIssueContext(
    owner: string,
    repo: string,
    issueNumber: number,
    options: GetIssueOptions = {},
  ): Promise<IssueContext> {
    const { data } = await this.#kit.request<RawIssue>("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner,
      repo,
      issue_number: issueNumber,
    });

    const maxComments = options.maxComments ?? DEFAULT_MAX_COMMENTS;
    let comments: IssueComment[] = [];
    if (options.includeComments !== false && (data.comments ?? 0) > 0 && maxComments > 0) {
      const raw = await this.#kit.paginate<RawComment>(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner, repo, issue_number: issueNumber, per_page: 100 },
      );
      comments = raw.slice(0, maxComments).map((comment) => ({
        author: comment.user?.login ?? null,
        body: comment.body ?? "",
      }));
    }

    return {
      number: data.number,
      kind: data.pull_request ? "pull_request" : "issue",
      title: data.title,
      state: data.state,
      body: data.body ?? "",
      author: data.user?.login ?? null,
      url: data.html_url,
      labels: (data.labels ?? []).map(labelName).filter((name): name is string => name !== null),
      comments,
    };
  }
}

/**
 * Renders issue context as prompt text.
 *
 * Lives here rather than in the agent because the agent container has no
 * GitHub credential and therefore cannot produce this itself; the host injects
 * the finished block.
 */
export function formatIssueContext(context: IssueContext): string {
  const kind = context.kind === "pull_request" ? "Pull request" : "Issue";
  const lines = [
    `${kind} #${context.number}: ${context.title}`,
    `State: ${context.state}${context.author ? ` · opened by ${context.author}` : ""}`,
    `URL: ${context.url}`,
  ];
  if (context.labels.length > 0) lines.push(`Labels: ${context.labels.join(", ")}`);
  lines.push("", context.body.trim() === "" ? "(no description)" : context.body.trim());

  for (const comment of context.comments) {
    lines.push("", `--- comment by ${comment.author ?? "unknown"} ---`, comment.body.trim());
  }

  return lines.join("\n");
}

interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string } | null;
  default_branch?: string;
  private?: boolean;
  clone_url?: string;
  description?: string | null;
  pushed_at?: string | null;
}

interface RawBranch {
  name: string;
  commit: { sha: string };
  protected?: boolean;
}

interface RawIssue {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  html_url: string;
  user?: { login: string } | null;
  labels?: Array<string | { name?: string }>;
  comments?: number;
  pull_request?: unknown;
}

interface RawComment {
  body?: string | null;
  user?: { login: string } | null;
}

function toRepoSummary(repo: RawRepo): RepoSummary {
  const owner = repo.owner?.login ?? repo.full_name.split("/")[0] ?? "";
  return {
    id: String(repo.id),
    owner,
    name: repo.name,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch ?? "main",
    private: repo.private ?? false,
    cloneUrl: repo.clone_url ?? `https://github.com/${repo.full_name}.git`,
    description: repo.description ?? null,
    pushedAt: repo.pushed_at ?? null,
  };
}

function labelName(label: string | { name?: string }): string | null {
  if (typeof label === "string") return label;
  return label.name ?? null;
}

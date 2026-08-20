/**
 * The seam between `GitHubClient` and Octokit.
 *
 * `GitHubClient` is written against `OctokitLike` -- two methods, plain
 * strings in, plain data out -- rather than against Octokit's generated
 * endpoint types. That buys two things:
 *
 *   1. the client's unit tests inject a hand-written fake and make no network
 *      calls at all, so CI needs no credential and no fixture server;
 *   2. Octokit is confined to one adapter function, so replacing it (or
 *      wrapping the PAT in a GitHub App installation token, which is the
 *      production plan in PLAN.md §6) touches this file only.
 */

import { Octokit } from "@octokit/rest";
import { registerSecret } from "@codex-clone/core";

export interface OctokitResponseLike<T> {
  status: number;
  data: T;
}

export interface OctokitLike {
  request<T = unknown>(route: string, params?: Record<string, unknown>): Promise<OctokitResponseLike<T>>;
  /** Follows Link headers to exhaustion and returns the concatenated items. */
  paginate<T = unknown>(route: string, params?: Record<string, unknown>): Promise<T[]>;
}

export const USER_AGENT = "codex-clone";

/**
 * Builds a real Octokit bound to a PAT.
 *
 * The token is registered for redaction here rather than at every call site,
 * because Octokit's own errors quote the request URL and we do not want to
 * audit each of its error paths for leakage.
 */
export function createOctokit(token: string, options: { baseUrl?: string } = {}): OctokitLike {
  registerSecret(token);

  const kit = new Octokit({
    auth: token,
    userAgent: USER_AGENT,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });

  // Octokit's request/paginate signatures are generated per-endpoint unions;
  // the whole point of OctokitLike is not to propagate that into the client,
  // so the widening happens exactly here.
  const request = kit.request as unknown as (
    route: string,
    params?: Record<string, unknown>,
  ) => Promise<{ status: number; data: unknown }>;
  const paginate = kit.paginate as unknown as (
    route: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown[]>;

  return {
    async request<T>(route: string, params?: Record<string, unknown>) {
      const response = await request(route, params);
      return { status: response.status, data: response.data as T };
    },
    async paginate<T>(route: string, params?: Record<string, unknown>) {
      return (await paginate(route, params)) as T[];
    },
  };
}

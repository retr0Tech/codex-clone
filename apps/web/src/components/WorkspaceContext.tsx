"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { BranchView, RepoView } from "../lib/types";

/**
 * The repo/branch selection, shared by the sidebar picker and the task
 * composer.
 *
 * Both lists come from the real API now: repositories from `/api/repos` (the
 * locally persisted list, refreshed from GitHub on demand) and branches from
 * `/api/repos/:owner/:name/branches`. Branches are fetched per repo rather than
 * up front because a token can reach dozens of repositories and listing every
 * branch of each would be a burst of API calls to populate a dropdown nobody
 * has opened.
 *
 * Errors are surfaced rather than swallowed: "no repositories" and "your PAT is
 * missing" look identical in an empty dropdown, and only one of them is
 * something the user can fix.
 */

export interface WorkspaceValue {
  repos: RepoView[];
  repo: RepoView | null;
  branches: BranchView[];
  branch: string;
  loadingRepos: boolean;
  loadingBranches: boolean;
  /** Non-null when the repo list could not be loaded. Usually a missing PAT. */
  error: string | null;
  setRepoFullName: (fullName: string) => void;
  setBranch: (branch: string) => void;
  refreshRepos: () => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<RepoView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchView[]>([]);
  const [branch, setBranch] = useState("");
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshRemote, setRefreshRemote] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingRepos(true);

    void (async () => {
      try {
        const response = await fetch(`/api/repos${refreshRemote ? "?refresh=1" : ""}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const body = (await response.json()) as { repos?: RepoView[]; error?: string };
        if (controller.signal.aborted) return;

        if (!response.ok) {
          setError(body.error ?? `the repository list failed with ${response.status}`);
          setRepos(body.repos ?? []);
          return;
        }
        setError(null);
        setRepos(body.repos ?? []);
        setSelected((current) => current ?? body.repos?.[0]?.fullName ?? null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted) {
          setLoadingRepos(false);
          setRefreshRemote(false);
        }
      }
    })();

    return () => controller.abort();
  }, [reloadToken, refreshRemote]);

  const repo = useMemo(() => repos.find((r) => r.fullName === selected) ?? repos[0] ?? null, [repos, selected]);

  useEffect(() => {
    if (!repo) {
      setBranches([]);
      setBranch("");
      return;
    }

    const controller = new AbortController();
    setLoadingBranches(true);
    // Show the repo's recorded default immediately; the list refines it.
    setBranch(repo.defaultBranch);

    void (async () => {
      try {
        const response = await fetch(
          `/api/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/branches`,
          { signal: controller.signal, cache: "no-store" },
        );
        const body = (await response.json()) as {
          branches?: BranchView[];
          defaultBranch?: string;
          error?: string;
        };
        if (controller.signal.aborted) return;

        const list = body.branches ?? [];
        setBranches(list);
        const preferred = body.defaultBranch ?? repo.defaultBranch;
        // Only fall back if the default really is not there -- a repo whose
        // default branch was renamed should not silently target a random one.
        setBranch(list.some((b) => b.name === preferred) ? preferred : (list[0]?.name ?? preferred));
      } catch {
        // A branch list we could not load leaves the recorded default in place,
        // which is still a valid ref for task creation.
        if (!controller.signal.aborted) setBranches([]);
      } finally {
        if (!controller.signal.aborted) setLoadingBranches(false);
      }
    })();

    return () => controller.abort();
  }, [repo]);

  const refreshRepos = useCallback(() => {
    setRefreshRemote(true);
    setReloadToken((t) => t + 1);
  }, []);

  const value = useMemo<WorkspaceValue>(
    () => ({
      repos,
      repo,
      branches,
      branch,
      loadingRepos,
      loadingBranches,
      error,
      setRepoFullName: (fullName) => setSelected(fullName),
      setBranch,
      refreshRepos,
    }),
    [repos, repo, branches, branch, loadingRepos, loadingBranches, error, refreshRepos],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return value;
}

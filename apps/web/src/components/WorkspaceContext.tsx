"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { mockRepos, type MockRepo } from "../mocks/data";

/**
 * The repo/branch selection is shared between the sidebar picker and the task
 * composer, so it lives above both. When the GitHub client from wave A lands,
 * `repos` becomes the only thing that changes here.
 */
interface WorkspaceValue {
  repos: MockRepo[];
  repo: MockRepo;
  branch: string;
  setRepoId: (id: string) => void;
  setBranch: (branch: string) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [repoId, setRepoIdState] = useState(mockRepos[0]!.id);
  const [branch, setBranch] = useState(mockRepos[0]!.defaultBranch);

  const value = useMemo<WorkspaceValue>(() => {
    const repo = mockRepos.find((r) => r.id === repoId) ?? mockRepos[0]!;
    return {
      repos: mockRepos,
      repo,
      branch: repo.branches.includes(branch) ? branch : repo.defaultBranch,
      setRepoId: (id) => {
        const next = mockRepos.find((r) => r.id === id);
        setRepoIdState(id);
        // Switching repos must not leave a branch that does not exist there.
        if (next) setBranch(next.defaultBranch);
      },
      setBranch,
    };
  }, [repoId, branch]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return value;
}

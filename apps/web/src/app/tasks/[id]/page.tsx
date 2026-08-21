import { notFound } from "next/navigation";
import { TaskDetail } from "../../../components/TaskDetail";
import { repoById, taskById } from "../../../mocks/data";
import type { StreamMode } from "../../../lib/useMockStream";

/**
 * `?stream=live` replays the fixture through the reducer on timers; the default
 * folds the durable history exactly as a reload will once the WebSocket hub
 * exists. Same reducer either way — that is the property being demonstrated.
 */
export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ stream?: string }>;
}) {
  const { id } = await params;
  const { stream } = await searchParams;

  const task = taskById(id);
  if (!task) notFound();
  const repo = repoById(task.repoId);
  if (!repo) notFound();

  const initialMode: StreamMode = stream === "live" ? "live" : "history";

  return <TaskDetail task={task} repo={repo} initialMode={initialMode} />;
}

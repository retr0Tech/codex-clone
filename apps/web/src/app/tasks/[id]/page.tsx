import { notFound } from "next/navigation";
import { TaskDetail } from "../../../components/TaskDetail";
import { readRunBudget } from "../../api/_lib/budget";
import { getTask, listRuns } from "../../api/_lib/tasks";
import { db } from "../../api/_lib/settings-store";

/**
 * The task page.
 *
 * The task record and its runs are read on the server so the shell paints with
 * real metadata immediately; the transcript itself arrives in the client, from
 * the history endpoint and then the WebSocket. Splitting it that way means a
 * task that has not emitted a single event still renders as a real page rather
 * than as a spinner waiting on a socket.
 */

export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const database = db();
  const task = await getTask(database, id);
  if (!task) notFound();
  const runs = await listRuns(database, id);
  // The bounds every run on this task is measured against, for the Usage tab.
  const budget = await readRunBudget(database);

  // Read at request time on the server: the browser bundle would otherwise need
  // NEXT_PUBLIC_WS_URL inlined at build time, and the worker's port is a
  // deployment detail, not a build-time constant.
  const wsUrl = process.env["NEXT_PUBLIC_WS_URL"] ?? "ws://127.0.0.1:8787";

  return <TaskDetail task={task} runs={runs} wsUrl={wsUrl} budget={budget} />;
}

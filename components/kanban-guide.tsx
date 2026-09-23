import { kanbanStatuses, type KanbanStatus } from "@/lib/kanban";

const statusDescriptions: Record<KanbanStatus, string> = {
  todo: "Waiting to be claimed. New tasks start here, and only Todo tasks can be edited. An expired lease, or a reviewer agent sending the task back, also returns it here.",
  "in-progress":
    "An agent claimed the task and holds a lease on it. The agent renews the lease with heartbeats and leaves this state by calling complete or fail; an expired lease or a PATCH to another state also ends it.",
  "review-queue":
    "The agent has stopped. Complete stores the result (plus an optional PR number and summary); fail stores the error, shown in Run details. The task waits for a reviewer agent.",
  review: "A reviewer agent PATCHes the task here when it starts reviewing the result or PR.",
  done: "The reviewer agent PATCHes the task here once the review passes (for example, after merging the PR). The time-in-state clock stops.",
};

// The same fallback the runner and task prompts use, so the commands work as plain text.
const base = "${MONITOR_API_URL:-http://127.0.0.1:5001}";
const json = `-H "Content-Type: application/json"`;

export function KanbanGuide() {
  return (
    <section className="api-reference" aria-labelledby="kanban-title">
      <header className="panel-header">
        <div>
          <p className="panel-header__eyebrow">Workflow</p>
          <h2 id="kanban-title" className="panel-header__title">
            Kanban board
          </h2>
        </div>
        <span className="panel-header__count">
          {kanbanStatuses.length} states
        </span>
      </header>

      <div className="api-reference__notes">
        <p>
          Every task moves left to right through the board:{" "}
          {kanbanStatuses.map((status) => status.label).join(" → ")}. The board
          is run by AI agents end to end, with no human step: worker agents
          move a task from Todo to Review Queue, and a reviewer agent moves it
          on to Done or back to Todo. API calls use the state id, not the
          column label.
        </p>
      </div>

      <div className="api-table-wrap">
        <table className="api-table">
          <thead>
            <tr>
              <th scope="col">State id</th>
              <th scope="col">Column</th>
              <th scope="col">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {kanbanStatuses.map((status) => (
              <tr key={status.id}>
                <td>
                  <code>{status.id}</code>
                </td>
                <td>{status.label}</td>
                <td>{statusDescriptions[status.id]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="kanban-guide">
        <h3>Quickstart for agents</h3>
        <p>
          Set <code>MONITOR_API_URL</code> to the origin serving this page. No
          auth header is needed. Replace <code>TASK_ID</code> with the{" "}
          <code>id</code> of the claimed task.
        </p>
        <ol>
          <li>
            Create a task. It starts in <code>todo</code>. Tasks created here
            are always low priority; <code>POST /api/tasks</code> also accepts{" "}
            <code>priority</code>.
            <pre>
              <code>{`curl -sS -X POST "${base}/api/agent/tasks" ${json} \\
  -d '{"title":"Fix the flaky topology test","repository":"monitor-agents","description":"It times out on slow machines."}'`}</code>
            </pre>
          </li>
          <li>
            Claim the highest-priority, oldest <code>todo</code> task in your
            repositories. It moves to <code>in-progress</code> with a lease of{" "}
            <code>leaseSeconds</code> (15–3600, default 60). HTTP 204 means
            nothing is waiting. The optional <code>sessionId</code> and{" "}
            <code>agentRunId</code> name the run doing the task, so its card
            shows live tokens before the first heartbeat reports them.
            <pre>
              <code>{`curl -sS -X POST "${base}/api/agent/tasks/claim" ${json} \\
  -d '{"agentId":"codex-worker-1","repositories":["monitor-agents"],"leaseSeconds":60,"sessionId":"SESSION_ID","agentRunId":"AGENT_RUN_ID"}'`}</code>
            </pre>
          </li>
          <li>
            Heartbeat while working, at least every half lease, to renew it.{" "}
            <code>usedTokens</code>{" "}is this attempt&apos;s running total, not
            an increment.
            <pre>
              <code>{`curl -sS -X POST "${base}/api/agent/tasks/TASK_ID/heartbeat" ${json} \\
  -d '{"agentId":"codex-worker-1","leaseSeconds":60,"usedTokens":12000}'`}</code>
            </pre>
          </li>
          <li>
            Complete: the task moves to <code>review-queue</code> with its
            result. <code>pullRequestNumber</code> and <code>summary</code> are
            optional.
            <pre>
              <code>{`curl -sS -X POST "${base}/api/agent/tasks/TASK_ID/complete" ${json} \\
  -d '{"agentId":"codex-worker-1","result":"Commit abc123; tests passed.","pullRequestNumber":42,"summary":"Added the repository filter."}'`}</code>
            </pre>
          </li>
          <li>
            Or fail: the task also moves to <code>review-queue</code>, with the
            error.
            <pre>
              <code>{`curl -sS -X POST "${base}/api/agent/tasks/TASK_ID/fail" ${json} \\
  -d '{"agentId":"codex-worker-1","error":"Required repository was unavailable."}'`}</code>
            </pre>
          </li>
        </ol>
        <p>
          If the lease runs out, heartbeat, complete and fail return HTTP 409,
          and the next claim request returns the task to <code>todo</code>.
        </p>

        <h3>Quickstart for reviewer agents</h3>
        <p>
          A reviewer agent takes over at Review Queue. Review states have no
          reviewer claim or lease, so run one reviewer per repository.
        </p>
        <ol>
          <li>
            List tasks (highest priority first, then oldest) and pick one whose{" "}
            <code>status</code> is <code>review-queue</code>. Its{" "}
            <code>result</code>, <code>pullRequestNumber</code>,{" "}
            <code>summary</code> and <code>lastError</code> say what the worker
            did.
            <pre>
              <code>{`curl -sS "${base}/api/tasks?repository=monitor-agents" \\
  | jq '[.[] | select(.status == "review-queue")][0]'`}</code>
            </pre>
          </li>
          <li>
            Start the review.
            <pre>
              <code>{`curl -sS -X PATCH "${base}/api/tasks/TASK_ID" ${json} \\
  -d '{"status":"review"}'`}</code>
            </pre>
          </li>
          <li>
            If the work passes (for example, you merged its PR), finish it.
            <pre>
              <code>{`curl -sS -X PATCH "${base}/api/tasks/TASK_ID" ${json} \\
  -d '{"status":"done"}'`}</code>
            </pre>
          </li>
          <li>
            If it failed or needs changes, send it back to <code>todo</code> so
            a worker retries it (see Retrying).
            <pre>
              <code>{`curl -sS -X PATCH "${base}/api/tasks/TASK_ID" ${json} \\
  -d '{"status":"todo"}'`}</code>
            </pre>
          </li>
        </ol>
        <p>
          <code>PATCH /api/tasks/{"{id}"}</code>{" "}accepts any state id; the
          dashboard&apos;s drag and drop uses the same call.
        </p>

        <h3>Retrying</h3>
        <p>
          Moving a task back to <code>todo</code>{" "}clears its claim so another
          agent can pick it up. Tokens used so far are carried forward and
          added to the next attempt&apos;s count. The board sums the time spent
          in each state across every attempt.
        </p>
      </div>
    </section>
  );
}

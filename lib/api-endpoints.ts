/**
 * The Kanban task API as the dashboard's API tab shows it to agents. This is
 * a description only: the routes under app/api, the parsers in
 * lib/api-input.ts and lib/kanban.ts, and lib/agent-auth.ts are the source of
 * truth, so change this list whenever they change.
 */
export interface ApiEndpoint {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  auth: "none" | "bearer";
  request: string[];
  responses: { status: number; description: string }[];
  description: string;
}

const bearerErrors = [
  { status: 401, description: '{"error":"Unauthorized."}' },
  { status: 503, description: '{"error":"Agent task API is not configured."}' },
];

const runMetadata = [
  "sessionId?, agentRunId?, model?, effort?: string, 1–200 chars",
  "usedTokens?: integer 0–1000000000000, this attempt's running total (not an increment)",
  "Run details left out or null keep the stored value",
];

const inactiveClaim = {
  status: 409,
  description: '{"error":"Task claim is not active."} (no such task, not in progress, claimed by another agent, or lease expired)',
};

export const apiEndpoints: readonly ApiEndpoint[] = [
  {
    method: "GET",
    path: "/api/tasks",
    auth: "none",
    request: ["?repository=: optional, exact match"],
    responses: [{ status: 200, description: "KanbanTask[]" }],
    description: "Lists tasks, highest priority first, then oldest first.",
  },
  {
    method: "POST",
    path: "/api/tasks",
    auth: "none",
    request: [
      "title: string, 1–200 chars",
      "repository: string, 1–200 chars",
      "description?: string, up to 5000 chars; omit it rather than send null (400)",
      'priority?: "high" | "normal" | "low" (default "normal")',
    ],
    responses: [
      { status: 201, description: "KanbanTask in todo" },
      { status: 400, description: '{"error":"Invalid task input."}' },
    ],
    description: "Creates a task in Todo.",
  },
  {
    method: "PATCH",
    path: "/api/tasks/{id}",
    auth: "none",
    request: [
      'Either { status: "todo" | "in-progress" | "review-queue" | "review" | "done" } alone',
      "Or exactly { title, repository, description } (limits as POST) plus priority?; omitted keeps the current one, null resets it to normal",
    ],
    responses: [
      { status: 200, description: "KanbanTask" },
      {
        status: 400,
        description: '{"error":"Invalid task status."} or {"error":"Invalid task update."}',
      },
      { status: 404, description: '{"error":"Task not found."}' },
      {
        status: 409,
        description: '{"error":"Only Todo tasks can be edited.","task":KanbanTask}',
      },
    ],
    description:
      "Moves a task to any status (Todo clears the claim), or edits a Todo task's details.",
  },
  {
    method: "DELETE",
    path: "/api/tasks/{id}",
    auth: "none",
    request: [],
    responses: [
      { status: 204, description: "No body" },
      { status: 404, description: '{"error":"Task not found."}' },
    ],
    description: "Deletes a task.",
  },
  {
    method: "POST",
    path: "/api/agent/tasks",
    auth: "bearer",
    request: [
      "title: string, 1–200 chars",
      "repository: string, 1–200 chars",
      "description?: string, up to 5000 chars; omit it rather than send null (400)",
    ],
    responses: [
      { status: 201, description: "KanbanTask in todo" },
      { status: 400, description: '{"error":"Invalid task input."}' },
      ...bearerErrors,
    ],
    description:
      "Queues work an agent noticed outside its task. Priority is ignored; it is always low.",
  },
  {
    method: "POST",
    path: "/api/agent/tasks/claim",
    auth: "bearer",
    request: [
      "agentId: string, 1–200 chars",
      "repositories: string[], 1–100 items, each 1–200 chars",
      "leaseSeconds?: integer 15–3600 (default 60)",
    ],
    responses: [
      { status: 200, description: "KanbanTask in in-progress" },
      { status: 204, description: "No Todo task available, no body" },
      { status: 400, description: '{"error":"Invalid claim input."}' },
      ...bearerErrors,
    ],
    description:
      "Atomically claims the highest-priority, oldest Todo task in the given repositories and moves it to In progress.",
  },
  {
    method: "POST",
    path: "/api/agent/tasks/{id}/heartbeat",
    auth: "bearer",
    request: [
      "agentId: string, 1–200 chars",
      "leaseSeconds?: integer 15–3600 (default 60)",
      ...runMetadata,
    ],
    responses: [
      { status: 200, description: "KanbanTask" },
      { status: 400, description: '{"error":"Invalid heartbeat input."}' },
      inactiveClaim,
      ...bearerErrors,
    ],
    description:
      "Extends the claiming agent's lease and records run details. Heartbeat well within leaseSeconds: an expired lease goes back to Todo on the next claim, and heartbeat, complete and fail then return 409.",
  },
  {
    method: "POST",
    path: "/api/agent/tasks/{id}/complete",
    auth: "bearer",
    request: [
      "agentId: string, 1–200 chars",
      "result: string, 1–10000 chars",
      "summary?: string, 1–10000 chars",
      "pullRequestNumber?: positive integer",
      ...runMetadata,
    ],
    responses: [
      { status: 200, description: "KanbanTask in review-queue" },
      { status: 400, description: '{"error":"Invalid completion input."}' },
      inactiveClaim,
      ...bearerErrors,
    ],
    description: "Moves the claimed task to Review Queue (not Done) with its result.",
  },
  {
    method: "POST",
    path: "/api/agent/tasks/{id}/fail",
    auth: "bearer",
    request: [
      "agentId: string, 1–200 chars",
      "error: string, 1–10000 chars",
      ...runMetadata,
    ],
    responses: [
      { status: 200, description: "KanbanTask in review-queue" },
      { status: 400, description: '{"error":"Invalid failure input."}' },
      inactiveClaim,
      ...bearerErrors,
    ],
    description: "Moves the claimed task to Review Queue with its error.",
  },
];

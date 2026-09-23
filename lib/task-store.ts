import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  KanbanStatus,
  KanbanStatusEvent,
  KanbanTask,
  TaskRunMetadata,
} from "./kanban";

interface TaskRow {
  id: string;
  title: string;
  description: string;
  repository: string;
  status: KanbanStatus;
  priority: number;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_until: string | null;
  result: string | null;
  last_error: string | null;
  attempt_count: number;
  session_id: string | null;
  agent_run_id: string | null;
  model: string | null;
  effort: string | null;
  used_tokens: number | null;
  pull_request_number: number | null;
  summary: string | null;
  status_history: string;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  repository: string;
  priority?: number;
}

export interface UpdateTaskDetailsInput {
  title: string;
  description: string;
  repository: string;
  priority?: number;
}

export interface ClaimTaskInput {
  agentId: string;
  repositories: string[];
  now?: Date;
  leaseMs?: number;
}

function statusHistoryFromRow(value: string): KanbanStatusEvent[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as KanbanStatusEvent[]) : [];
  } catch {
    return [];
  }
}

/** Rows completed before the number was reported still name the PR in `result`. */
function pullRequestNumberFromResult(result: string | null): number | null {
  const match =
    result &&
    (/^PR #([1-9]\d*)/.exec(result) ??
      /^Pull request: \S*\/pull\/([1-9]\d*)/m.exec(result));
  return match ? Number(match[1]) : null;
}

function taskFromRow(row: TaskRow): KanbanTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    repository: row.repository,
    status: row.status,
    priority: row.priority,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    leaseUntil: row.lease_until,
    result: row.result,
    lastError: row.last_error,
    attemptCount: row.attempt_count,
    sessionId: row.session_id,
    agentRunId: row.agent_run_id,
    model: row.model,
    effort: row.effort,
    usedTokens: row.used_tokens,
    pullRequestNumber:
      row.pull_request_number ?? pullRequestNumberFromResult(row.result),
    summary: row.summary,
    statusHistory: statusHistoryFromRow(row.status_history),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const appendStatusSql =
  "json_insert(status_history, '$[#]', json_object('status', ?, 'at', ?))";

/**
 * An agent reports the tokens of the run it is executing, which starts from
 * zero on a retry. Earlier attempts are banked in `carried_tokens` when the
 * task returns to Todo, so the stored total covers every attempt.
 */
const runMetadataSql = `
  session_id = COALESCE(?, session_id),
  agent_run_id = COALESCE(?, agent_run_id),
  model = COALESCE(?, model),
  effort = COALESCE(?, effort),
  used_tokens = CASE
    WHEN ? IS NULL THEN used_tokens ELSE carried_tokens + ?
  END
`;

/** Banks the current total before an attempt that starts counting again. */
const carryTokensSql = `
  carried_tokens = COALESCE(used_tokens, carried_tokens),
  used_tokens = NULL
`;

function runMetadataValues(metadata: TaskRunMetadata | undefined) {
  const usedTokens = metadata?.usedTokens ?? null;
  return [
    metadata?.sessionId ?? null,
    metadata?.agentRunId ?? null,
    metadata?.model ?? null,
    metadata?.effort ?? null,
    usedTokens,
    usedTokens,
  ] as const;
}

const tasksIndexSql = `
  CREATE INDEX IF NOT EXISTS tasks_queue
    ON tasks (status, repository, priority DESC, created_at ASC);
`;

function tasksTableSql(name: string) {
  return `
  CREATE TABLE ${name} (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    repository TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('todo', 'in-progress', 'review-queue', 'review', 'done')
    ),
    priority INTEGER NOT NULL DEFAULT 0,
    claimed_by TEXT,
    claimed_at TEXT,
    lease_until TEXT,
    result TEXT,
    last_error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    agent_run_id TEXT,
    model TEXT,
    effort TEXT,
    used_tokens INTEGER,
    carried_tokens INTEGER NOT NULL DEFAULT 0,
    pull_request_number INTEGER,
    summary TEXT,
    status_history TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `;
}

export class TaskStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      ${tasksTableSql("IF NOT EXISTS tasks")}
      ${tasksIndexSql}
    `);
    this.migrate();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` leaves an existing database on the old shape,
   * so run-detail columns are added in place and their history backfilled from
   * the timestamps the row already carries.
   */
  private migrate() {
    const columns = new Set(
      (
        this.database.prepare("PRAGMA table_info(tasks)").all() as unknown as {
          name: string;
        }[]
      ).map((column) => column.name),
    );

    const additions: [string, string][] = [
      ["session_id", "TEXT"],
      ["agent_run_id", "TEXT"],
      ["model", "TEXT"],
      ["effort", "TEXT"],
      ["used_tokens", "INTEGER"],
      ["carried_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["pull_request_number", "INTEGER"],
      ["summary", "TEXT"],
      ["status_history", "TEXT NOT NULL DEFAULT '[]'"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
      }
    }

    // Failed work now waits in the Review Queue. SQLite cannot alter a CHECK,
    // so a table whose CHECK still allows 'failed' is rebuilt under the new one.
    const { sql } = this.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get() as { sql: string };
    if (sql.includes("'failed'")) {
      const names = (
        this.database.prepare("PRAGMA table_info(tasks)").all() as unknown as {
          name: string;
        }[]
      ).map((column) => column.name);
      const values = names.map((name) =>
        name === "status"
          ? "CASE status WHEN 'failed' THEN 'review-queue' ELSE status END"
          : name,
      );
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          ${tasksTableSql("tasks_next")}
          INSERT INTO tasks_next (${names.join(", ")})
            SELECT ${values.join(", ")} FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_next RENAME TO tasks;
          ${tasksIndexSql}
        `);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database.exec(
      "UPDATE tasks SET status = 'review-queue' WHERE status = 'failed'",
    );

    // A finished row still carries the moment it was claimed, so its run time
    // is booked to `in-progress` instead of collapsing into the final status.
    this.database.exec(`
      UPDATE tasks
      SET status_history = CASE
        WHEN status = 'todo'
          THEN json_array(json_object('status', status, 'at', created_at))
        WHEN status = 'in-progress'
          THEN json_array(
            json_object('status', 'todo', 'at', created_at),
            json_object('status', status, 'at', COALESCE(claimed_at, updated_at))
          )
        WHEN claimed_at IS NULL
          THEN json_array(
            json_object('status', 'todo', 'at', created_at),
            json_object('status', status, 'at', updated_at)
          )
        ELSE json_array(
          json_object('status', 'todo', 'at', created_at),
          json_object('status', 'in-progress', 'at', claimed_at),
          json_object('status', status, 'at', updated_at)
        )
      END
      WHERE status_history IS NULL OR status_history = '[]'
    `);
    this.database.exec(`
      UPDATE tasks
      SET status_history = REPLACE(
        status_history, '"status":"failed"', '"status":"review-queue"'
      )
      WHERE status_history LIKE '%"status":"failed"%'
    `);
  }

  close() {
    this.database.close();
  }

  createTask(input: CreateTaskInput, now = new Date()): KanbanTask {
    const id = randomUUID();
    const timestamp = now.toISOString();
    this.database
      .prepare(`
        INSERT INTO tasks (
          id, title, description, repository, status, priority,
          status_history, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 'todo', ?,
          json_array(json_object('status', 'todo', 'at', ?)), ?, ?
        )
      `)
      .run(
        id,
        input.title.trim(),
        input.description?.trim() ?? "",
        input.repository.trim(),
        input.priority ?? 0,
        timestamp,
        timestamp,
        timestamp,
      );

    return this.getTask(id)!;
  }

  getTask(id: string): KanbanTask | null {
    const row = this.database
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as unknown as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  listTasks(repository?: string): KanbanTask[] {
    const rows = (
      repository
        ? this.database
            .prepare(`
              SELECT * FROM tasks
              WHERE repository = ?
              ORDER BY priority DESC, created_at ASC
            `)
            .all(repository)
        : this.database
            .prepare(`
              SELECT * FROM tasks
              ORDER BY priority DESC, created_at ASC
            `)
            .all()
    ) as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  updateTaskStatus(
    id: string,
    status: KanbanStatus,
    now = new Date(),
  ): KanbanTask | null {
    const clearClaim = status === "todo";
    const clearLease = status !== "in-progress";
    this.database
      .prepare(`
        UPDATE tasks
        SET status = ?,
            claimed_by = CASE WHEN ? THEN NULL ELSE claimed_by END,
            claimed_at = CASE WHEN ? THEN NULL ELSE claimed_at END,
            lease_until = CASE WHEN ? THEN NULL ELSE lease_until END,
            carried_tokens = CASE
              WHEN ? THEN COALESCE(used_tokens, carried_tokens) ELSE carried_tokens
            END,
            used_tokens = CASE WHEN ? THEN NULL ELSE used_tokens END,
            status_history = CASE
              WHEN status = ? THEN status_history
              ELSE ${appendStatusSql}
            END,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        clearClaim ? 1 : 0,
        clearClaim ? 1 : 0,
        clearLease ? 1 : 0,
        clearClaim ? 1 : 0,
        clearClaim ? 1 : 0,
        status,
        status,
        now.toISOString(),
        now.toISOString(),
        id,
      );
    return this.getTask(id);
  }

  updateTodoTaskDetails(
    id: string,
    input: UpdateTaskDetailsInput,
    now = new Date(),
  ): KanbanTask | null {
    const row = this.database
      .prepare(`
        UPDATE tasks
        SET title = ?, description = ?, repository = ?,
            priority = COALESCE(?, priority), updated_at = ?
        WHERE id = ? AND status = 'todo'
        RETURNING *
      `)
      .get(
        input.title.trim(),
        input.description.trim(),
        input.repository.trim(),
        input.priority ?? null,
        now.toISOString(),
        id,
      ) as unknown as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  deleteTask(id: string): KanbanTask | null {
    const row = this.database
      .prepare(`
        DELETE FROM tasks
        WHERE id = ?
        RETURNING *
      `)
      .get(id) as unknown as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  claimTask(input: ClaimTaskInput): KanbanTask | null {
    const repositories = [...new Set(input.repositories.map((repo) => repo.trim()))]
      .filter(Boolean);
    if (repositories.length === 0) {
      return null;
    }

    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(
      now.getTime() + (input.leaseMs ?? 60_000),
    ).toISOString();
    const placeholders = repositories.map(() => "?").join(", ");

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
          UPDATE tasks
          SET status = 'todo',
              claimed_by = NULL,
              claimed_at = NULL,
              lease_until = NULL,
              last_error = COALESCE(last_error, 'Agent lease expired.'),
              ${carryTokensSql},
              status_history = ${appendStatusSql},
              updated_at = ?
          WHERE status = 'in-progress'
            AND lease_until IS NOT NULL
            AND lease_until <= ?
        `)
        .run("todo", nowIso, nowIso, nowIso);

      const candidate = this.database
        .prepare(`
          SELECT id FROM tasks
          WHERE status = 'todo'
            AND repository IN (${placeholders})
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
        `)
        .get(...repositories) as { id: string } | undefined;

      if (!candidate) {
        this.database.exec("COMMIT");
        return null;
      }

      this.database
        .prepare(`
          UPDATE tasks
          SET status = 'in-progress',
              claimed_by = ?,
              claimed_at = ?,
              lease_until = ?,
              last_error = NULL,
              attempt_count = attempt_count + 1,
              status_history = ${appendStatusSql},
              updated_at = ?
          WHERE id = ? AND status = 'todo'
        `)
        .run(
          input.agentId.trim(),
          nowIso,
          leaseUntil,
          "in-progress",
          nowIso,
          nowIso,
          candidate.id,
        );
      this.database.exec("COMMIT");
      return this.getTask(candidate.id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeatTask(
    id: string,
    agentId: string,
    now = new Date(),
    leaseMs = 60_000,
    metadata?: TaskRunMetadata,
  ): KanbanTask | null {
    const timestamp = now.toISOString();
    const result = this.database
      .prepare(`
        UPDATE tasks
        SET lease_until = ?, ${runMetadataSql}, updated_at = ?
        WHERE id = ?
          AND status = 'in-progress'
          AND claimed_by = ?
          AND lease_until > ?
      `)
      .run(
        new Date(now.getTime() + leaseMs).toISOString(),
        ...runMetadataValues(metadata),
        timestamp,
        id,
        agentId,
        timestamp,
      );
    return result.changes === 1 ? this.getTask(id) : null;
  }

  completeTask(
    id: string,
    agentId: string,
    resultText: string,
    now = new Date(),
    metadata?: TaskRunMetadata,
    completion?: { pullRequestNumber?: number; summary?: string },
  ): KanbanTask | null {
    const result = this.database
      .prepare(`
        UPDATE tasks
        SET status = 'review-queue',
            result = ?,
            pull_request_number = ?,
            summary = ?,
            lease_until = NULL,
            status_history = ${appendStatusSql},
            ${runMetadataSql},
            updated_at = ?
        WHERE id = ?
          AND status = 'in-progress'
          AND claimed_by = ?
          AND lease_until > ?
      `)
      .run(
        resultText.trim(),
        completion?.pullRequestNumber ?? null,
        completion?.summary?.trim() || null,
        "review-queue",
        now.toISOString(),
        ...runMetadataValues(metadata),
        now.toISOString(),
        id,
        agentId,
        now.toISOString(),
      );
    return result.changes === 1 ? this.getTask(id) : null;
  }

  failTask(
    id: string,
    agentId: string,
    errorText: string,
    now = new Date(),
    metadata?: TaskRunMetadata,
  ): KanbanTask | null {
    const result = this.database
      .prepare(`
        UPDATE tasks
        SET status = 'review-queue',
            last_error = ?,
            lease_until = NULL,
            status_history = ${appendStatusSql},
            ${runMetadataSql},
            updated_at = ?
        WHERE id = ?
          AND status = 'in-progress'
          AND claimed_by = ?
          AND lease_until > ?
      `)
      .run(
        errorText.trim(),
        "review-queue",
        now.toISOString(),
        ...runMetadataValues(metadata),
        now.toISOString(),
        id,
        agentId,
        now.toISOString(),
      );
    return result.changes === 1 ? this.getTask(id) : null;
  }
}

const taskStoreGlobal = globalThis as typeof globalThis & {
  monitorTaskStore?: TaskStore;
};

export function getTaskStore(): TaskStore {
  if (!taskStoreGlobal.monitorTaskStore) {
    const path =
      process.env.MONITOR_TASK_DB?.trim() ||
      join(process.cwd(), ".data", "monitor-tasks.sqlite");
    taskStoreGlobal.monitorTaskStore = new TaskStore(path);
  }
  return taskStoreGlobal.monitorTaskStore;
}

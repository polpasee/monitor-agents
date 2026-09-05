import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { KanbanStatus, KanbanTask } from "./kanban";

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
}

export interface ClaimTaskInput {
  agentId: string;
  repositories: string[];
  now?: Date;
  leaseMs?: number;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        repository TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('todo', 'in-progress', 'review', 'done', 'failed')
        ),
        priority INTEGER NOT NULL DEFAULT 0,
        claimed_by TEXT,
        claimed_at TEXT,
        lease_until TEXT,
        result TEXT,
        last_error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_queue
        ON tasks (status, repository, priority DESC, created_at ASC);
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
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'todo', ?, ?, ?)
      `)
      .run(
        id,
        input.title.trim(),
        input.description?.trim() ?? "",
        input.repository.trim(),
        input.priority ?? 0,
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
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        clearClaim ? 1 : 0,
        clearClaim ? 1 : 0,
        clearLease ? 1 : 0,
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
        SET title = ?, description = ?, repository = ?, updated_at = ?
        WHERE id = ? AND status = 'todo'
        RETURNING *
      `)
      .get(
        input.title.trim(),
        input.description.trim(),
        input.repository.trim(),
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
              updated_at = ?
          WHERE status = 'in-progress'
            AND lease_until IS NOT NULL
            AND lease_until <= ?
        `)
        .run(nowIso, nowIso);

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
              updated_at = ?
          WHERE id = ? AND status = 'todo'
        `)
        .run(input.agentId.trim(), nowIso, leaseUntil, nowIso, candidate.id);
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
  ): KanbanTask | null {
    const timestamp = now.toISOString();
    const result = this.database
      .prepare(`
        UPDATE tasks
        SET lease_until = ?, updated_at = ?
        WHERE id = ?
          AND status = 'in-progress'
          AND claimed_by = ?
          AND lease_until > ?
      `)
      .run(
        new Date(now.getTime() + leaseMs).toISOString(),
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
  ): KanbanTask | null {
    const result = this.database
      .prepare(`
        UPDATE tasks
        SET status = 'review', result = ?, lease_until = NULL, updated_at = ?
        WHERE id = ?
          AND status = 'in-progress'
          AND claimed_by = ?
          AND lease_until > ?
      `)
      .run(resultText.trim(), now.toISOString(), id, agentId, now.toISOString());
    return result.changes === 1 ? this.getTask(id) : null;
  }

  failTask(
    id: string,
    agentId: string,
    errorText: string,
    now = new Date(),
  ): KanbanTask | null {
    const result = this.database
      .prepare(`
        UPDATE tasks
        SET status = 'failed', last_error = ?, lease_until = NULL, updated_at = ?
        WHERE id = ?
          AND status = 'in-progress'
          AND claimed_by = ?
          AND lease_until > ?
      `)
      .run(errorText.trim(), now.toISOString(), id, agentId, now.toISOString());
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

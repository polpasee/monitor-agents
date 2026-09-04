"use client";

import { useEffect, useMemo, useState } from "react";

import {
  mergeRepositoryNames,
  type RepositoryList,
} from "@/lib/repository-list";
import {
  kanbanRepositories,
  kanbanStatuses,
  type KanbanStatus,
  type KanbanTask,
} from "@/lib/kanban";

export function KanbanBoard() {
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [githubRepositories, setGithubRepositories] = useState<string[]>([]);
  const [repositoryNotice, setRepositoryNotice] = useState<string | null>(null);
  const [repositoryFilter, setRepositoryFilter] = useState("all");
  const [title, setTitle] = useState("");
  const [repository, setRepository] = useState("");
  const [description, setDescription] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editRepository, setEditRepository] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repositories = useMemo(
    () => mergeRepositoryNames(kanbanRepositories(tasks), githubRepositories),
    [githubRepositories, tasks],
  );
  const visibleTasks = useMemo(
    () =>
      repositoryFilter === "all"
        ? tasks
        : tasks.filter((task) => task.repository === repositoryFilter),
    [repositoryFilter, tasks],
  );

  useEffect(() => {
    let stopped = false;
    let timeoutId: number | undefined;

    async function refresh() {
      try {
        const response = await fetch("/api/tasks", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Task request failed with ${response.status}`);
        }
        const nextTasks = (await response.json()) as KanbanTask[];
        if (!stopped) {
          setTasks(nextTasks);
          setEditingTaskId((taskId) =>
            taskId &&
            !nextTasks.some(
              (task) => task.id === taskId && task.status === "todo",
            )
              ? null
              : taskId,
          );
          setError(null);
        }
      } catch {
        if (!stopped) {
          setError("Unable to load shared tasks.");
        }
      } finally {
        if (!stopped) {
          setLoading(false);
          timeoutId = window.setTimeout(refresh, 5_000);
        }
      }
    }

    void refresh();
    return () => {
      stopped = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    let stopped = false;

    async function loadRepositories() {
      try {
        const response = await fetch("/api/repositories", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Repository request failed with ${response.status}`);
        }
        const payload = (await response.json()) as RepositoryList;
        if (stopped) return;
        setGithubRepositories(payload.repositories);
        setRepositoryNotice(payload.error ?? null);
      } catch {
        if (!stopped) {
          setRepositoryNotice("Unable to load GitHub repositories.");
        }
      }
    }

    void loadRepositories();
    return () => {
      stopped = true;
    };
  }, []);

  async function addTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = title.trim();
    const nextRepository = repository.trim();

    if (!nextTitle || !nextRepository) return;

    setSubmitting(true);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: nextTitle,
          repository: nextRepository,
          description: description.trim(),
        }),
      });
      if (!response.ok) {
        throw new Error(`Task creation failed with ${response.status}`);
      }
      const task = (await response.json()) as KanbanTask;
      setTasks((current) => [...current, task]);
      setTitle("");
      setDescription("");
      setRepository(nextRepository);
      setError(null);
    } catch {
      setError("Unable to create the task.");
    } finally {
      setSubmitting(false);
    }
  }

  function editTask(task: KanbanTask) {
    if (task.status !== "todo") return;
    setEditingTaskId(task.id);
    setEditTitle(task.title);
    setEditRepository(task.repository);
    setEditDescription(task.description);
  }

  function cancelTaskEdit() {
    setEditingTaskId(null);
  }

  async function saveTask(
    event: React.FormEvent<HTMLFormElement>,
    taskId: string,
  ) {
    event.preventDefault();
    const nextTitle = editTitle.trim();
    const nextRepository = editRepository.trim();
    const nextDescription = editDescription.trim();
    if (!nextTitle || !nextRepository) return;

    setSavingTaskId(taskId);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: nextTitle,
          repository: nextRepository,
          description: nextDescription,
        }),
      });
      if (response.status === 409) {
        const conflict = (await response.json()) as { task: KanbanTask };
        setTasks((current) =>
          current.map((candidate) =>
            candidate.id === conflict.task.id ? conflict.task : candidate,
          ),
        );
        setEditingTaskId(null);
        setError("This task is no longer Todo and cannot be edited.");
        return;
      }
      if (!response.ok) {
        throw new Error(`Task update failed with ${response.status}`);
      }
      const task = (await response.json()) as KanbanTask;
      setTasks((current) =>
        current.map((candidate) => (candidate.id === task.id ? task : candidate)),
      );
      setEditingTaskId(null);
      setError(null);
    } catch {
      setError("Unable to update the task details.");
    } finally {
      setSavingTaskId(null);
    }
  }

  async function moveTask(taskId: string, status: KanbanStatus) {
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) {
        throw new Error(`Task update failed with ${response.status}`);
      }
      const task = (await response.json()) as KanbanTask;
      setTasks((current) =>
        current.map((candidate) => (candidate.id === task.id ? task : candidate)),
      );
      setError(null);
    } catch {
      setError("Unable to update the task status.");
    }
  }

  return (
    <section className="kanban-panel" aria-labelledby="kanban-title">
      <header className="kanban-header">
        <div>
          <p className="panel-header__eyebrow">Repository work</p>
          <h2 id="kanban-title" className="panel-header__title">
            Task board
          </h2>
        </div>
        <label className="kanban-filter">
          <span>Repository</span>
          <select
            onChange={(event) => setRepositoryFilter(event.target.value)}
            value={repositoryFilter}
          >
            <option value="all">All repositories</option>
            {repositories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && <p className="kanban-error" role="alert">{error}</p>}
      {repositoryNotice && (
        <p className="kanban-notice">{repositoryNotice}</p>
      )}

      <form className="kanban-task-form" onSubmit={addTask}>
        <label>
          <span>Task title</span>
          <input
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs to be done?"
            required
            value={title}
          />
        </label>
        <label>
          <span>Repository</span>
          <input
            list="kanban-repositories"
            onChange={(event) => setRepository(event.target.value)}
            placeholder="owner/repository"
            required
            value={repository}
          />
          <datalist id="kanban-repositories">
            {repositories.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <label>
          <span>Description for agent</span>
          <textarea
            maxLength={5_000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Expected result or acceptance criteria"
            rows={2}
            value={description}
          />
        </label>
        <button disabled={submitting} type="submit">
          {submitting ? "Adding…" : "Add new task"}
        </button>
      </form>

      <div className="kanban-board">
        {kanbanStatuses.map((status) => {
          const columnTasks = visibleTasks.filter(
            (task) => task.status === status.id,
          );

          return (
            <section
              className="kanban-column"
              key={status.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const taskId = event.dataTransfer.getData("text/plain");
                if (taskId) {
                  void moveTask(taskId, status.id);
                }
              }}
            >
              <header className="kanban-column__header">
                <h3>{status.label}</h3>
                <span>{columnTasks.length}</span>
              </header>
              <div className="kanban-column__tasks">
                {columnTasks.map((task) => {
                  const isEditing =
                    task.status === "todo" && editingTaskId === task.id;
                  const isSaving = savingTaskId === task.id;

                  return (
                    <article
                      className="kanban-card"
                      draggable={!isEditing && !isSaving}
                      key={task.id}
                      onDragStart={(event) =>
                        event.dataTransfer.setData("text/plain", task.id)
                      }
                    >
                      {isEditing ? (
                        <form
                          className="kanban-card__edit"
                          onSubmit={(event) => void saveTask(event, task.id)}
                        >
                          <label>
                            <span>Task title</span>
                            <input
                              autoFocus
                              maxLength={200}
                              onChange={(event) => setEditTitle(event.target.value)}
                              required
                              value={editTitle}
                            />
                          </label>
                          <label>
                            <span>Repository</span>
                            <input
                              list="kanban-repositories"
                              maxLength={200}
                              onChange={(event) =>
                                setEditRepository(event.target.value)
                              }
                              required
                              value={editRepository}
                            />
                          </label>
                          <label>
                            <span>Description for agent</span>
                            <textarea
                              maxLength={5_000}
                              onChange={(event) =>
                                setEditDescription(event.target.value)
                              }
                              rows={3}
                              value={editDescription}
                            />
                          </label>
                          <div className="kanban-card__edit-actions">
                            <button disabled={isSaving} type="submit">
                              {isSaving ? "Saving…" : "Save"}
                            </button>
                            <button
                              disabled={isSaving}
                              onClick={cancelTaskEdit}
                              type="button"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <span className="kanban-card__repository">
                            {task.repository}
                          </span>
                          <h4>{task.title}</h4>
                          {task.description && (
                            <p className="kanban-card__description">
                              {task.description}
                            </p>
                          )}
                          {task.status === "todo" && (
                            <button
                              aria-label={`Edit ${task.title}`}
                              className="kanban-card__edit-button"
                              onClick={() => editTask(task)}
                              type="button"
                            >
                              Edit
                            </button>
                          )}
                        </>
                      )}
                      {task.claimedBy && (
                        <p className="kanban-card__agent">
                          Claimed by {task.claimedBy}
                        </p>
                      )}
                      {task.lastError && (
                        <p className="kanban-card__error">{task.lastError}</p>
                      )}
                      {task.result && (
                        <p className="kanban-card__result">{task.result}</p>
                      )}
                      <label>
                        <span className="sr-only">Status for {task.title}</span>
                        <select
                          aria-label={`Status for ${task.title}`}
                          disabled={isEditing || isSaving}
                          onChange={(event) =>
                            void moveTask(
                              task.id,
                              event.target.value as KanbanStatus,
                            )
                          }
                          value={task.status}
                        >
                          {kanbanStatuses.map((nextStatus) => (
                            <option key={nextStatus.id} value={nextStatus.id}>
                              {nextStatus.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </article>
                  );
                })}
                {columnTasks.length === 0 && (
                  <p className="kanban-column__empty">
                    {loading ? "Loading tasks…" : "Drop tasks here"}
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

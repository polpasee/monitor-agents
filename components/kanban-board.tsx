"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  mergeRepositoryNames,
  type RepositoryList,
} from "@/lib/repository-list";
import type { AgentRun } from "@/lib/telemetry";
import {
  findTaskAgent,
  formatBangkokTime,
  formatDuration,
  formatStatusAge,
  formatTokenCount,
  isKanbanTaskEditable,
  kanbanPriorities,
  kanbanPriorityOf,
  kanbanRepositories,
  kanbanStatusDurations,
  kanbanStatusSince,
  kanbanStatuses,
  type KanbanPriority,
  type KanbanStatus,
  type KanbanTask,
} from "@/lib/kanban";

import { AgentInspector } from "./agent-inspector";

interface KanbanBoardProps {
  agents: AgentRun[];
  capturedAt: string;
}

/** A reset, retry, or failure keeps the details of the last completion. */
function showsCompletion(task: KanbanTask): boolean {
  return (
    task.status === "review-queue" ||
    task.status === "review" ||
    task.status === "done"
  );
}

export function KanbanBoard({ agents, capturedAt }: KanbanBoardProps) {
  const addTaskButtonRef = useRef<HTMLButtonElement>(null);
  const addTaskDialogRef = useRef<HTMLDialogElement>(null);
  const editTaskButtonRef = useRef<HTMLButtonElement>(null);
  const editTaskDialogRef = useRef<HTMLDialogElement>(null);
  const editDialogPressOutsideRef = useRef(false);
  const editTitleInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [githubRepositories, setGithubRepositories] = useState<string[]>([]);
  const [repositoryNotice, setRepositoryNotice] = useState<string | null>(null);
  const [repositoryFilter, setRepositoryFilter] = useState("all");
  const [title, setTitle] = useState("");
  const [repository, setRepository] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<KanbanPriority>("normal");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editRepository, setEditRepository] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPriority, setEditPriority] = useState<KanbanPriority>("normal");
  const [editError, setEditError] = useState<string | null>(null);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const repositories = useMemo(
    () => mergeRepositoryNames(kanbanRepositories(tasks), githubRepositories),
    [githubRepositories, tasks],
  );
  const visibleTasks = useMemo(
    () =>
      (repositoryFilter === "all"
        ? [...tasks]
        : tasks.filter((task) => task.repository === repositoryFilter)
      ).sort(
        (left, right) =>
          right.priority - left.priority ||
          left.createdAt.localeCompare(right.createdAt),
      ),
    [repositoryFilter, tasks],
  );
  const [inspectedAgentId, setInspectedAgentId] = useState<string | null>(null);
  const selectedTask = tasks.find((task) => task.id === editingTaskId);
  // The task's own run opens the panel; the relation links walk from there.
  const inspectedAgent = selectedTask
    ? (agents.find((agent) => agent.id === inspectedAgentId) ??
      findTaskAgent(selectedTask, agents))
    : null;
  const isSelectedTaskEditable = selectedTask
    ? isKanbanTaskEditable(selectedTask)
    : false;
  const isTaskDialogReadOnly = Boolean(
    editingTaskId && !isSelectedTaskEditable,
  );
  const statusLabels = new Map(
    kanbanStatuses.map((status) => [status.id, status.label]),
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
    if (
      !editingTaskId ||
      tasks.some((task) => task.id === editingTaskId)
    ) {
      return;
    }

    if (editTaskDialogRef.current?.open) {
      editTaskDialogRef.current.close();
    }
  }, [editingTaskId, tasks]);

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
    setCreateError(null);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: nextTitle,
          repository: nextRepository,
          description: description.trim(),
          priority,
        }),
      });
      if (!response.ok) {
        throw new Error(`Task creation failed with ${response.status}`);
      }
      const task = (await response.json()) as KanbanTask;
      setTasks((current) => [...current, task]);
      setTitle("");
      setDescription("");
      setPriority("normal");
      setRepository(nextRepository);
      setError(null);
      addTaskDialogRef.current?.close();
    } catch {
      setCreateError("Unable to create the task.");
    } finally {
      setSubmitting(false);
    }
  }

  function openAddTaskDialog() {
    setCreateError(null);
    addTaskDialogRef.current?.showModal();
    titleInputRef.current?.focus();
  }

  function closeAddTaskDialog() {
    setCreateError(null);
    addTaskDialogRef.current?.close();
  }

  function editTask(task: KanbanTask, trigger: HTMLButtonElement) {
    editTaskButtonRef.current = trigger;
    setEditingTaskId(task.id);
    setInspectedAgentId(null);
    setEditTitle(task.title);
    setEditRepository(task.repository);
    setEditDescription(task.description);
    setEditPriority(kanbanPriorityOf(task.priority).id);
    setEditError(null);
    editTaskDialogRef.current?.showModal();
    if (isKanbanTaskEditable(task)) {
      editTitleInputRef.current?.focus();
    }
  }

  function closeTaskEditDialog() {
    if (savingTaskId || deletingTaskId) return;
    setEditError(null);
    editTaskDialogRef.current?.close();
  }

  /** A press on the backdrop targets the dialog itself but lands outside its box. */
  function isTaskEditDialogBackdropEvent(
    event: React.MouseEvent<HTMLDialogElement>,
  ) {
    const box = event.currentTarget.getBoundingClientRect();
    return (
      event.target === event.currentTarget &&
      (event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom)
    );
  }

  function handleTaskEditDialogClose() {
    setEditingTaskId(null);
    setInspectedAgentId(null);
    setEditTitle("");
    setEditRepository("");
    setEditDescription("");
    setEditPriority("normal");
    setEditError(null);

    const trigger = editTaskButtonRef.current;
    editTaskButtonRef.current = null;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) {
        trigger.focus();
      } else {
        addTaskButtonRef.current?.focus();
      }
    });
  }

  async function saveTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isSelectedTaskEditable || savingTaskId || deletingTaskId) return;
    const taskId = editingTaskId;
    const nextTitle = editTitle.trim();
    const nextRepository = editRepository.trim();
    const nextDescription = editDescription.trim();
    if (!taskId || !nextTitle || !nextRepository) return;

    setSavingTaskId(taskId);
    setEditError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: nextTitle,
          repository: nextRepository,
          description: nextDescription,
          ...(selectedTask &&
            editPriority !== kanbanPriorityOf(selectedTask.priority).id && {
              priority: editPriority,
            }),
        }),
      });
      if (response.status === 409) {
        const conflict = (await response.json()) as { task: KanbanTask };
        setTasks((current) =>
          current.map((candidate) =>
            candidate.id === conflict.task.id ? conflict.task : candidate,
          ),
        );
        editTaskButtonRef.current = null;
        editTaskDialogRef.current?.close();
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
      editTaskDialogRef.current?.close();
      setError(null);
    } catch {
      setEditError("Unable to update the task details.");
    } finally {
      setSavingTaskId(null);
    }
  }

  async function deleteTask() {
    const task = selectedTask;
    if (
      !task ||
      savingTaskId ||
      deletingTaskId ||
      !window.confirm(
        `Delete "${task.title}" permanently? This action cannot be undone.`,
      )
    ) {
      return;
    }

    const taskId = task.id;
    setDeletingTaskId(taskId);
    setEditError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
      });
      if (response.status === 404) {
        setTasks((current) =>
          current.filter((candidate) => candidate.id !== taskId),
        );
        editTaskButtonRef.current = null;
        editTaskDialogRef.current?.close();
        setError("This task no longer exists.");
        return;
      }
      if (!response.ok) {
        throw new Error(`Task deletion failed with ${response.status}`);
      }
      setTasks((current) =>
        current.filter((candidate) => candidate.id !== taskId),
      );
      editTaskButtonRef.current = null;
      editTaskDialogRef.current?.close();
      setError(null);
    } catch {
      setEditError("Unable to delete the task.");
    } finally {
      setDeletingTaskId(null);
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
        <div className="kanban-header__actions">
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
          <button
            aria-label="Add new task"
            className="kanban-add-button"
            onClick={openAddTaskDialog}
            ref={addTaskButtonRef}
            title="Add new task"
            type="button"
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
      </header>

      {error && <p className="kanban-error" role="alert">{error}</p>}
      {repositoryNotice && (
        <p className="kanban-notice">{repositoryNotice}</p>
      )}

      <dialog
        aria-labelledby="add-task-dialog-title"
        className="kanban-task-dialog"
        onCancel={(event) => {
          if (submitting) event.preventDefault();
        }}
        onClose={() => addTaskButtonRef.current?.focus()}
        ref={addTaskDialogRef}
      >
        <header className="kanban-task-dialog__header">
          <div>
            <p className="panel-header__eyebrow">Repository work</p>
            <h3 id="add-task-dialog-title">Add new task</h3>
          </div>
          <button
            aria-label="Close add task dialog"
            disabled={submitting}
            onClick={closeAddTaskDialog}
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <form className="kanban-task-dialog__form" onSubmit={addTask}>
          <label>
            <span>Task title</span>
            <input
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs to be done?"
              ref={titleInputRef}
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
          </label>
          <label>
            <span>Priority</span>
            <select
              onChange={(event) =>
                setPriority(event.target.value as KanbanPriority)
              }
              value={priority}
            >
              {kanbanPriorities.map((level) => (
                <option key={level.id} value={level.id}>
                  {level.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Description for agent</span>
            <textarea
              maxLength={5_000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Expected result or acceptance criteria"
              rows={4}
              value={description}
            />
          </label>
          {createError && (
            <p className="kanban-task-dialog__error" role="alert">
              {createError}
            </p>
          )}
          <div className="kanban-task-dialog__actions">
            <button
              disabled={submitting}
              onClick={closeAddTaskDialog}
              type="button"
            >
              Cancel
            </button>
            <button disabled={submitting} type="submit">
              {submitting ? "Adding…" : "Add new task"}
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        aria-labelledby="edit-task-dialog-title"
        className={
          inspectedAgent
            ? "kanban-task-dialog kanban-task-dialog--with-agent"
            : "kanban-task-dialog"
        }
        id="edit-task-dialog"
        onCancel={(event) => {
          if (savingTaskId || deletingTaskId) event.preventDefault();
        }}
        onClick={(event) => {
          if (
            editDialogPressOutsideRef.current &&
            isTaskEditDialogBackdropEvent(event)
          ) {
            closeTaskEditDialog();
          }
        }}
        onClose={handleTaskEditDialogClose}
        onPointerDown={(event) => {
          editDialogPressOutsideRef.current =
            isTaskEditDialogBackdropEvent(event);
        }}
        ref={editTaskDialogRef}
      >
        <div className="kanban-task-dialog__main">
          <header className="kanban-task-dialog__header">
            <div>
              <p className="panel-header__eyebrow">Repository work</p>
              <h3 id="edit-task-dialog-title">
                {isTaskDialogReadOnly ? "Task details" : "Edit task"}
              </h3>
            </div>
            <button
              aria-label={
                isTaskDialogReadOnly
                  ? "Close task details dialog"
                  : "Close edit task dialog"
              }
              disabled={Boolean(savingTaskId || deletingTaskId)}
              onClick={closeTaskEditDialog}
              type="button"
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <form className="kanban-task-dialog__form" onSubmit={saveTask}>
            <label>
              <span>Task title</span>
              <input
                disabled={isTaskDialogReadOnly}
                maxLength={200}
                onChange={(event) => setEditTitle(event.target.value)}
                ref={editTitleInputRef}
                required
                value={
                  isTaskDialogReadOnly
                    ? (selectedTask?.title ?? editTitle)
                    : editTitle
                }
              />
            </label>
            <label>
              <span>Repository</span>
              <input
                disabled={isTaskDialogReadOnly}
                list="kanban-repositories"
                maxLength={200}
                onChange={(event) => setEditRepository(event.target.value)}
                required
                value={
                  isTaskDialogReadOnly
                    ? (selectedTask?.repository ?? editRepository)
                    : editRepository
                }
              />
            </label>
            <label>
              <span>Priority</span>
              <select
                disabled={isTaskDialogReadOnly}
                onChange={(event) =>
                  setEditPriority(event.target.value as KanbanPriority)
                }
                value={
                  isTaskDialogReadOnly && selectedTask
                    ? kanbanPriorityOf(selectedTask.priority).id
                    : editPriority
                }
              >
                {kanbanPriorities.map((level) => (
                  <option key={level.id} value={level.id}>
                    {level.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Description for agent</span>
              <textarea
                disabled={isTaskDialogReadOnly}
                maxLength={5_000}
                onChange={(event) => setEditDescription(event.target.value)}
                rows={4}
                value={
                  isTaskDialogReadOnly
                    ? (selectedTask?.description ?? editDescription)
                    : editDescription
                }
              />
            </label>
            {selectedTask && (
              <section className="kanban-run-details">
                <h4>Run details</h4>
                <dl>
                  <div>
                    <dt>Session ID</dt>
                    <dd>{selectedTask.sessionId ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd>{selectedTask.model ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Effort / think</dt>
                    <dd>{selectedTask.effort ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Used tokens</dt>
                    <dd>
                      {typeof selectedTask.usedTokens === "number"
                        ? selectedTask.usedTokens.toLocaleString()
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Pull request</dt>
                    <dd>
                      {showsCompletion(selectedTask) &&
                      typeof selectedTask.pullRequestNumber === "number"
                        ? `#${selectedTask.pullRequestNumber}`
                        : "—"}
                    </dd>
                  </div>
                </dl>
                {showsCompletion(selectedTask) && selectedTask.summary && (
                  <>
                    <h4>Summary</h4>
                    <p className="kanban-run-details__summary">
                      {selectedTask.summary}
                    </p>
                  </>
                )}
                {selectedTask.lastError && (
                  <>
                    <h4>Error</h4>
                    <p className="kanban-run-details__summary">
                      {selectedTask.lastError}
                    </p>
                  </>
                )}
                <h4>Time in each state</h4>
                {kanbanStatusDurations(selectedTask).length === 0 ? (
                  <p className="kanban-run-details__empty">
                    No state changes recorded yet.
                  </p>
                ) : (
                  <dl>
                    {kanbanStatusDurations(selectedTask).map((entry) => (
                      <div key={entry.status}>
                        <dt>{statusLabels.get(entry.status)}</dt>
                        <dd>{formatDuration(entry.milliseconds)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            )}
            {editError && (
              <p className="kanban-task-dialog__error" role="alert">
                {editError}
              </p>
            )}
            {selectedTask && (
              <div className="kanban-task-dialog__actions">
                <button
                  className="kanban-task-dialog__delete"
                  disabled={Boolean(savingTaskId || deletingTaskId)}
                  onClick={() => void deleteTask()}
                  type="button"
                >
                  {deletingTaskId ? "Deleting…" : "Delete"}
                </button>
                {isSelectedTaskEditable && (
                  <>
                    <button
                      disabled={Boolean(savingTaskId || deletingTaskId)}
                      onClick={closeTaskEditDialog}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      disabled={Boolean(savingTaskId || deletingTaskId)}
                      type="submit"
                    >
                      {savingTaskId ? "Saving…" : "Save"}
                    </button>
                  </>
                )}
              </div>
            )}
          </form>
        </div>
        {inspectedAgent && (
          <AgentInspector
            agent={inspectedAgent}
            agents={agents}
            capturedAt={capturedAt}
            onSelectAgent={setInspectedAgentId}
          />
        )}
      </dialog>

      <datalist id="kanban-repositories">
        {repositories.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

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
                  const isSelected = editingTaskId === task.id;
                  const isSaving = savingTaskId === task.id;
                  const isEditable = isKanbanTaskEditable(task);
                  const cardPriority = kanbanPriorityOf(task.priority);
                  const showsTokens = typeof task.usedTokens === "number";
                  const showsPullRequest =
                    showsCompletion(task) &&
                    typeof task.pullRequestNumber === "number";
                  const since = kanbanStatusSince(task);

                  return (
                    <article
                      className="kanban-card"
                      draggable={!isSelected && !isSaving}
                      key={task.id}
                      onDragStart={(event) =>
                        event.dataTransfer.setData("text/plain", task.id)
                      }
                    >
                      <button
                        aria-controls="edit-task-dialog"
                        aria-haspopup="dialog"
                        aria-label={`${isEditable ? "Edit" : "View"} ${task.title}`}
                        className="kanban-card__details kanban-card__details-button"
                        onClick={(event) => editTask(task, event.currentTarget)}
                        type="button"
                      >
                        <span className="kanban-card__title-row kanban-card__title-row--top">
                          <span className="kanban-card__repository">
                            {task.repository}
                          </span>
                          <span
                            className={`kanban-card__priority kanban-card__priority--${cardPriority.id}`}
                          >
                            {cardPriority.label}
                          </span>
                        </span>
                        <span className="kanban-card__title">
                          {task.title}
                        </span>
                        {(showsTokens || showsPullRequest) && (
                          <span className="kanban-card__badges">
                            {typeof task.usedTokens === "number" && (
                              <span
                                className="kanban-card__tokens"
                                title={`${task.usedTokens.toLocaleString()} tokens used`}
                              >
                                {formatTokenCount(task.usedTokens)}
                              </span>
                            )}
                            {showsPullRequest && (
                              <span className="kanban-card__pr">
                                PR #{task.pullRequestNumber}
                              </span>
                            )}
                          </span>
                        )}
                        <time
                          className="kanban-card__timestamp"
                          dateTime={since}
                          title={formatBangkokTime(since)}
                        >
                          {formatStatusAge(since)}
                        </time>
                      </button>
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

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { demoSnapshot } from "./demo-data.ts";
import { resolveWorktreeMainRepos, tasksUseAgy } from "./live-snapshot.ts";

test("resolveWorktreeMainRepos ignores an agent without an absolute cwd", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "monitor-worktree-")),
  );
  const worktree = join(directory, "worktree");
  const previousCwd = process.cwd();

  try {
    // Both the worktree and the process cwd hold a linked-worktree `.git`
    // file, so an empty cwd would resolve if it were read relatively.
    await mkdir(worktree);
    const gitFile = "gitdir: /repo/.git/worktrees/feature\n";
    await writeFile(join(worktree, ".git"), gitFile);
    await writeFile(join(directory, ".git"), gitFile);
    process.chdir(directory);

    const root = {
      ...demoSnapshot.agents[0],
      provider: "qwen" as const,
      parentId: null,
    };
    const mainRepos = await resolveWorktreeMainRepos([
      { ...root, id: "qwen:worktree", cwd: worktree },
      { ...root, id: "qwen:unknown", cwd: "" },
    ]);

    assert.deepEqual([...mainRepos], [[worktree, "/repo"]]);
  } finally {
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
});

test("tasksUseAgy only counts open cards that ask for an AGY model", () => {
  const card = (
    status: "todo" | "done",
    requestedModel: string | null,
    requestedReviewModel: string | null = null,
  ) => ({ status, requestedModel, requestedReviewModel });

  assert.equal(tasksUseAgy([]), false);
  assert.equal(tasksUseAgy([card("todo", null), card("todo", "codex-sol")]), false);
  assert.equal(tasksUseAgy([card("done", "agy-opus")]), false);
  assert.equal(tasksUseAgy([card("todo", "agy-gemini")]), true);
  assert.equal(tasksUseAgy([card("todo", "claude-opus", "agy-sonnet")]), true);
});

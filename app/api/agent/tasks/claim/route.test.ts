import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { TaskStore } from "../../../../../lib/task-store.ts";

// The route imports "@/lib/x"; map that alias to lib/x.ts so node --test can load it.
const root = pathToFileURL(join(import.meta.dirname, "../../../../../")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier.startsWith("@/") ? `${root}${specifier.slice(2)}.ts` : specifier,
      context,
    );
  },
});

test("POST /api/agent/tasks/claim passes excludeModels and inheritModel to the store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-claim-route-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));
  // getTaskStore() returns this store, so the route never opens the real database.
  (globalThis as { monitorTaskStore?: TaskStore }).monitorTaskStore = store;
  const { POST } = await import("./route.ts");
  const claim = (body: unknown) =>
    POST(
      new Request("http://localhost/api/agent/tasks/claim", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  const base = { agentId: "agent-1", repositories: ["monitor-agents"] };

  try {
    store.updateBoardSettings({ codingLimit: 5 });
    store.createTask(
      { title: "Inherit", repository: "monitor-agents", requestedModel: "inherit" },
      new Date("2026-08-04T00:00:00.000Z"),
    );
    store.createTask(
      { title: "Codex", repository: "monitor-agents", requestedModel: "codex-sol" },
      new Date("2026-08-04T00:01:00.000Z"),
    );

    assert.equal((await claim({ ...base, excludeModels: ["inherit"] })).status, 400);
    assert.equal((await claim({ ...base, inheritModel: null })).status, 400);

    const response = await claim({
      ...base,
      excludeModels: ["claude-opus"],
      inheritModel: "claude-opus",
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { title: string }).title, "Codex");
  } finally {
    delete (globalThis as { monitorTaskStore?: TaskStore }).monitorTaskStore;
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

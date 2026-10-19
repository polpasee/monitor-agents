import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { TaskStore } from "../../../lib/task-store.ts";

// The routes import "@/lib/x"; map that alias to lib/x.ts so node --test can load them.
const root = pathToFileURL(join(import.meta.dirname, "../../../")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier.startsWith("@/") ? `${root}${specifier.slice(2)}.ts` : specifier,
      context,
    );
  },
});

test("POST /api/tasks stores an allowlisted workType; /api/agent/tasks leaves it null", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-tasks-route-"));
  const store = new TaskStore(join(directory, "tasks.sqlite"));
  // getTaskStore() returns this store, so the routes never open the real database.
  (globalThis as { monitorTaskStore?: TaskStore }).monitorTaskStore = store;
  const { POST } = await import("./route.ts");
  const { POST: agentPost } = await import("../agent/tasks/route.ts");
  const post = (handler: typeof POST, body: unknown) =>
    handler(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  const base = { title: "Add a column", repository: "monitor-agents" };

  try {
    const created = await post(POST, { ...base, workType: "table-column" });
    assert.equal(created.status, 201);
    const { id, workType } = (await created.json()) as { id: string; workType: string };
    assert.equal(workType, "table-column");
    assert.equal(store.getTask(id)?.workType, "table-column");

    for (const bad of ["inherit", "TABLE-COLUMN", "", 3, true]) {
      assert.equal((await post(POST, { ...base, workType: bad })).status, 400, `${bad}`);
    }

    const absent = await post(POST, base);
    assert.equal(absent.status, 201);
    assert.equal(((await absent.json()) as { workType: null }).workType, null);

    const agent = await post(agentPost, { ...base, workType: "table-column" });
    assert.equal(agent.status, 201);
    assert.equal(((await agent.json()) as { workType: null }).workType, null);
  } finally {
    delete (globalThis as { monitorTaskStore?: TaskStore }).monitorTaskStore;
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

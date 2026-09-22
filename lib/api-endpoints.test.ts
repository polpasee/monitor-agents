import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { apiEndpoints } from "./api-endpoints.ts";

const appDirectory = fileURLToPath(new URL("../app", import.meta.url));

function routeFile(path: string): string {
  return join(appDirectory, path.replaceAll("{id}", "[id]"), "route.ts");
}

test("every documented endpoint has a route exporting its method", () => {
  for (const endpoint of apiEndpoints) {
    const file = routeFile(endpoint.path);
    assert.ok(existsSync(file), `${endpoint.path} has no route file`);
    assert.match(
      readFileSync(file, "utf8"),
      new RegExp(`export async function ${endpoint.method}\\b`),
      `${endpoint.path} does not export ${endpoint.method}`,
    );
  }
});

test("every Kanban task route method is documented", () => {
  const documented = new Set(
    apiEndpoints.map((endpoint) => `${endpoint.method} ${routeFile(endpoint.path)}`),
  );

  for (const directory of ["api/tasks", "api/agent/tasks"]) {
    const root = join(appDirectory, directory);
    const routes = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith("route.ts"))
      .map((entry) => join(root, entry));
    assert.ok(routes.length > 0, `${directory} has no routes`);

    for (const file of routes) {
      const methods = readFileSync(file, "utf8").matchAll(
        /export async function (GET|POST|PATCH|DELETE|PUT)\b/g,
      );
      for (const [, method] of methods) {
        assert.ok(
          documented.has(`${method} ${file}`),
          `${method} ${file} is not documented`,
        );
      }
    }
  }
});

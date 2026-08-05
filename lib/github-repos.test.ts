import assert from "node:assert/strict";
import test from "node:test";

import { fetchGithubRepositories } from "./github-repos.ts";
import {
  mergeRepositoryNames,
  parseRepositoryPage,
} from "./repository-list.ts";

test("mergeRepositoryNames dedupes, trims, and sorts case-insensitively", () => {
  assert.deepEqual(
    mergeRepositoryNames(
      ["polpasee/monitor-agents", " polpasee/Cacti ", ""],
      ["polpasee/monitor-agents", "acme/Zeta", "acme/alpha"],
    ),
    [
      "acme/alpha",
      "acme/Zeta",
      "polpasee/Cacti",
      "polpasee/monitor-agents",
    ],
  );
});

test("parseRepositoryPage keeps only string full_name entries", () => {
  assert.deepEqual(
    parseRepositoryPage([
      { full_name: "acme/api" },
      { full_name: 42 },
      null,
      { name: "no-full-name" },
      { full_name: "acme/web" },
    ]),
    ["acme/api", "acme/web"],
  );
  assert.deepEqual(parseRepositoryPage({ message: "Bad credentials" }), []);
});

test("fetchGithubRepositories pages until a short page and merges results", async () => {
  const requested: string[] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    full_name: `acme/repo-${String(index).padStart(3, "0")}`,
  }));
  const fetchImpl = (async (url: string | URL) => {
    requested.push(String(url));
    const page = new URL(String(url)).searchParams.get("page");
    return {
      ok: true,
      json: async () => (page === "1" ? firstPage : [{ full_name: "acme/tail" }]),
    };
  }) as unknown as typeof fetch;

  const repositories = await fetchGithubRepositories({
    token: "test-token",
    fetchImpl,
  });

  assert.equal(requested.length, 2);
  assert.equal(repositories.length, 101);
  assert.equal(repositories.at(-1), "acme/tail");
});

test("fetchGithubRepositories surfaces HTTP failures", async () => {
  const fetchImpl = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    fetchGithubRepositories({ token: "bad", fetchImpl }),
    /failed with 401/,
  );
});

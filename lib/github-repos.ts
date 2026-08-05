import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  mergeRepositoryNames,
  parseRepositoryPage,
  type RepositoryList,
} from "./repository-list.ts";

const execFileAsync = promisify(execFile);

const perPage = 100;
const maxPages = 10;
const cacheTtlMs = 5 * 60 * 1_000;
const failureTtlMs = 30 * 1_000;

export async function resolveGithubToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const fromEnv = (env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: 5_000,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function fetchGithubRepositories(options: {
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const names: string[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url =
      "https://api.github.com/user/repos" +
      `?per_page=${perPage}&page=${page}&sort=full_name` +
      "&affiliation=owner,collaborator,organization_member";
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub repository request failed with ${response.status}`);
    }
    const pageNames = parseRepositoryPage(await response.json());
    names.push(...pageNames);
    if (pageNames.length < perPage) break;
  }

  return mergeRepositoryNames(names);
}

let cache: { expiresAt: number; value: RepositoryList } | null = null;

export function clearRepositoryCache(): void {
  cache = null;
}

export async function getAccessibleRepositories(
  now = Date.now(),
): Promise<RepositoryList> {
  if (cache && cache.expiresAt > now) return cache.value;

  const token = await resolveGithubToken();
  const value: RepositoryList = !token
    ? {
        repositories: [],
        source: "unavailable",
        error:
          "No GitHub credentials found. Set GITHUB_TOKEN or run `gh auth login`.",
      }
    : await fetchGithubRepositories({ token })
        .then<RepositoryList>((repositories) => ({
          repositories,
          source: "github",
        }))
        .catch<RepositoryList>((cause: unknown) => ({
          repositories: [],
          source: "unavailable",
          error:
            cause instanceof Error
              ? cause.message
              : "Unable to reach the GitHub API.",
        }));

  cache = {
    expiresAt: now + (value.source === "github" ? cacheTtlMs : failureTtlMs),
    value,
  };
  return value;
}

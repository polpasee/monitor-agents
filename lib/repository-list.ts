export type RepositorySource = "github" | "unavailable";

export interface RepositoryList {
  repositories: string[];
  source: RepositorySource;
  error?: string;
}

export function mergeRepositoryNames(
  ...lists: readonly (readonly string[])[]
): string[] {
  const names = new Set<string>();
  for (const list of lists) {
    for (const name of list) {
      const trimmed = name.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  return [...names].sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
}

export function parseRepositoryPage(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as { full_name?: unknown }).full_name
        : undefined,
    )
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

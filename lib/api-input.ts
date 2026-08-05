export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function requiredString(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength ? trimmed : null;
}

export function optionalString(
  value: unknown,
  maximumLength: number,
): string | null {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" && value.trim().length <= maximumLength
    ? value.trim()
    : null;
}

export function stringArray(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    return null;
  }
  const items = value.map((item) => requiredString(item, maximumItemLength));
  return items.every((item): item is string => item !== null) ? items : null;
}

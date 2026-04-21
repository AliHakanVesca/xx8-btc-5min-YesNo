import { readFile, writeFile } from "node:fs/promises";

const ENV_ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function updateEnvContents(contents: string, updates: Record<string, string>): string {
  const lines = contents.split(/\r?\n/);
  const seen = new Set<string>();
  const output = lines.map((line) => {
    const match = line.match(ENV_ASSIGNMENT_PATTERN);
    if (!match) {
      return line;
    }

    const [, key] = match;
    if (!key || !(key in updates)) {
      return line;
    }

    seen.add(key);
    return `${key}=${updates[key]}`;
  });

  const missingEntries = Object.entries(updates)
    .filter(([key]) => !seen.has(key))
    .map(([key, value]) => `${key}=${value}`);

  const merged = output.concat(missingEntries).join("\n");
  return contents.endsWith("\n") || merged.length === 0 ? `${merged}\n` : merged;
}

export async function writeEnvUpdates(path: string, updates: Record<string, string>): Promise<void> {
  const contents = await readFile(path, "utf8");
  const updated = updateEnvContents(contents, updates);
  await writeFile(path, updated, "utf8");
}

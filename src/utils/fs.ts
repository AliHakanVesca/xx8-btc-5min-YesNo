import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function appendJsonl(filePath: string, payload: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

export async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

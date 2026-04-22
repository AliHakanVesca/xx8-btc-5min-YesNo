import { mkdir, appendFile, writeFile, stat, rename, unlink, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function maybeRotateJsonl(args: {
  filePath: string;
  enabled: boolean;
  maxBytes: number;
  compress: boolean;
}): Promise<void> {
  if (!args.enabled || args.maxBytes <= 0) {
    return;
  }

  try {
    const current = await stat(args.filePath);
    if (current.size < args.maxBytes) {
      return;
    }

    const rotatedPath = `${args.filePath}.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(args.filePath, rotatedPath);

    if (!args.compress) {
      return;
    }

    const raw = await readFile(rotatedPath);
    const gzipped = await gzipAsync(raw);
    await writeFile(`${rotatedPath}.gz`, gzipped);
    await unlink(rotatedPath);
  } catch {
    return;
  }
}

export async function appendJsonl(
  filePath: string,
  payload: unknown,
  options?: {
    rotation?: {
      enabled: boolean;
      maxBytes: number;
      compress: boolean;
    };
  },
): Promise<void> {
  await ensureParentDir(filePath);
  if (options?.rotation) {
    await maybeRotateJsonl({
      filePath,
      enabled: options.rotation.enabled,
      maxBytes: options.rotation.maxBytes,
      compress: options.rotation.compress,
    });
  }
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

export async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

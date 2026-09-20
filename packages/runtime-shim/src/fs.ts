import { createRequire } from "node:module";
import { isBun } from "./detect.js";

let _require: NodeJS.Require | undefined;
function nodeRequire(): NodeJS.Require {
  return (_require ??= createRequire(import.meta.url));
}

interface BunFsApi {
  write(path: string, content: string | Uint8Array): Promise<number>;
  file(path: string): { text(): Promise<string> };
}

export async function writeFile(path: string, content: string | Uint8Array): Promise<void> {
  if (isBun) {
    const Bun = (globalThis as { Bun?: BunFsApi }).Bun;
    if (!Bun) throw new Error("Bun runtime missing");
    await Bun.write(path, content);
    return;
  }
  const { writeFile: nodeWriteFile } = nodeRequire()("node:fs/promises") as typeof import("node:fs/promises");
  await nodeWriteFile(path, content);
}

export async function readFile(path: string): Promise<string> {
  if (isBun) {
    const Bun = (globalThis as { Bun?: BunFsApi }).Bun;
    if (!Bun) throw new Error("Bun runtime missing");
    return await Bun.file(path).text();
  }
  const { readFile: nodeReadFile } = nodeRequire()("node:fs/promises") as typeof import("node:fs/promises");
  return await nodeReadFile(path, "utf-8");
}

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { object, resourceId } from "./config.ts";

export interface Deployment {
  hash: string; name: string; templateId?: string; endpointId?: string;
  pending?: "template" | "endpoint"; deleting?: boolean;
  registeredProvider?: string; registeredConfig?: unknown; registeredFile?: string;
}
export interface State { version: 1; project: string; deployments: Record<string, Deployment> }
export function readState(file: string, project: string): State {
  if (!fs.existsSync(file)) return { version: 1, project, deployments: {} };
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!object(s) || s.version !== 1 || s.project !== project || !object(s.deployments)) throw new Error("State version/project mismatch or invalid state");
  for (const d of Object.values(s.deployments)) {
    if (!object(d) || typeof d.hash !== "string" || typeof d.name !== "string") throw new Error("Invalid deployment state");
    if (d.templateId) resourceId(d.templateId);
    if (d.endpointId) resourceId(d.endpointId);
  }
  return s as State;
}
export function atomicJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export async function locked<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch { throw new Error(`Lock exists: ${lock}. If its process has exited, remove the stale lock before retrying.`); }
  try { fs.writeFileSync(fd, String(process.pid)); return await action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

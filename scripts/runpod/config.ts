import { createHash } from "node:crypto";
import { parse } from "yaml";

export interface Profile {
  model: string;
  revision: string;
  image: string;
  gpuTypeIds: string[];
  gpuCount: number;
  contextWindow: number;
  maxTokens: number;
  containerDiskInGb: number;
  workersMin: number;
  workersMax: number;
  idleTimeout: number;
  executionTimeoutMs: number;
  toolCallParser: string;
  quantization?: string;
  hfTokenSecret?: string;
  networkVolumeId?: string;
  dataCenterIds: string[];
}
export interface Config { version: 1; project: string; models: Record<string, Profile> }
const fail = (s: string): never => { throw new Error(s); };
export const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const nameRE = /^[a-z][a-z0-9-]{0,31}$/;
export function resourceId(x: unknown): string {
  if (typeof x !== "string" || !/^[A-Za-z0-9_-]+$/.test(x)) fail("Invalid resource ID");
  return x as string;
}
function keys(o: Record<string, unknown>, allowed: string[], label: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${label}: unknown key ${k}`);
}
function integer(x: unknown, fallback: number, min: number, max: number, label: string) {
  const n = x === undefined ? fallback : x;
  if (!Number.isSafeInteger(n) || (n as number) < min || (n as number) > max) fail(`${label}: expected integer ${min}..${max}`);
  return n as number;
}
export function parseConfig(source: string): Config {
  const c = parse(source);
  if (!object(c)) fail("Configuration must be a mapping");
  keys(c, ["version", "project", "models"], "config");
  if (c.version !== 1 || typeof c.project !== "string" || !nameRE.test(c.project)) fail("Expected version: 1 and lowercase project name");
  if (!object(c.models) || !Object.keys(c.models).length) fail("models must contain at least one profile");
  const models: Record<string, Profile> = {};
  for (const [id, raw] of Object.entries(c.models)) {
    if (!nameRE.test(id) || !object(raw)) fail(`Invalid profile ${id}`);
    const p = raw as Record<string, any>;
    keys(p, ["model", "revision", "image", "gpuTypeIds", "gpuCount", "contextWindow", "maxTokens", "containerDiskInGb", "workersMin", "workersMax", "idleTimeout", "executionTimeoutMs", "toolCallParser", "quantization", "hfTokenSecret", "networkVolumeId", "dataCenterIds"], id);
    if (typeof p.model !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(p.model)) fail(`${id}: model must be a Hugging Face owner/repository`);
    if (!/^[a-f0-9]{40}$/.test(p.revision ?? "")) fail(`${id}: revision must be a full Hugging Face commit SHA`);
    if (typeof p.image !== "string" || !/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(p.image)) fail(`${id}: image must be digest-pinned (image@sha256:...)`);
    if (typeof p.toolCallParser !== "string" || !/^[a-z0-9_]+$/.test(p.toolCallParser)) fail(`${id}: toolCallParser is required`);
    if (!Array.isArray(p.gpuTypeIds) || !p.gpuTypeIds.length || p.gpuTypeIds.some((x: unknown) => typeof x !== "string" || !/^[A-Za-z0-9_ -]+$/.test(x))) fail(`${id}: gpuTypeIds must be a nonempty list`);
    const dataCenterIds = p.dataCenterIds ?? [];
    if (!Array.isArray(dataCenterIds) || dataCenterIds.some((x: unknown) => typeof x !== "string" || !/^[A-Za-z0-9-]+$/.test(x))) fail(`${id}: invalid dataCenterIds`);
    for (const k of ["quantization", "hfTokenSecret", "networkVolumeId"]) if (p[k] !== undefined) resourceId(p[k]);
    const workersMax = integer(p.workersMax, 1, 1, 100, `${id}.workersMax`);
    const contextWindow = integer(p.contextWindow, 16384, 1024, 1048576, `${id}.contextWindow`);
    const maxTokens = integer(p.maxTokens, 4096, 1, contextWindow - 1, `${id}.maxTokens`);
    models[id] = {
      model: p.model, revision: p.revision, image: p.image, toolCallParser: p.toolCallParser,
      gpuTypeIds: [...p.gpuTypeIds], dataCenterIds,
      gpuCount: integer(p.gpuCount, 1, 1, 8, `${id}.gpuCount`),
      contextWindow, maxTokens,
      containerDiskInGb: integer(p.containerDiskInGb, 50, 10, 2000, `${id}.containerDiskInGb`),
      workersMin: integer(p.workersMin, 0, 0, workersMax, `${id}.workersMin`), workersMax,
      idleTimeout: integer(p.idleTimeout, 300, 5, 3600, `${id}.idleTimeout`),
      executionTimeoutMs: integer(p.executionTimeoutMs, 600000, 1000, 86400000, `${id}.executionTimeoutMs`),
      ...(p.quantization ? { quantization: p.quantization } : {}),
      ...(p.hfTokenSecret ? { hfTokenSecret: p.hfTokenSecret } : {}),
      ...(p.networkVolumeId ? { networkVolumeId: p.networkVolumeId } : {}),
    };
  }
  return { version: 1, project: c.project, models };
}
export function fingerprint(p: Profile) {
  return createHash("sha256").update(JSON.stringify(p)).digest("hex");
}
export function deploymentName(project: string, id: string, p: Profile) {
  return `fh-${project}-${id}-${fingerprint(p).slice(0,12)}`;
}
export function templatePayload(name: string, id: string, p: Profile) {
  const env: Record<string, string> = {
    MODEL_NAME: p.model, MODEL_REVISION: p.revision, TOKENIZER_REVISION: p.revision,
    MAX_MODEL_LEN: String(p.contextWindow), TENSOR_PARALLEL_SIZE: String(p.gpuCount),
    OPENAI_SERVED_MODEL_NAME_OVERRIDE: id, RAW_OPENAI_OUTPUT: "1",
    ENABLE_AUTO_TOOL_CHOICE: "true", TOOL_CALL_PARSER: p.toolCallParser,
    TRUST_REMOTE_CODE: "false", MAX_CONCURRENCY: "1", MAX_NUM_SEQS: "1",
    DISABLE_LOG_REQUESTS: "true",
  };
  if (p.quantization) env.QUANTIZATION = p.quantization;
  if (p.hfTokenSecret) env.HF_TOKEN = `{{ RUNPOD_SECRET_${p.hfTokenSecret} }}`;
  if (p.networkVolumeId) env.DOWNLOAD_DIR = "/runpod-volume/huggingface";
  return { name, imageName: p.image, isServerless: true, isPublic: false, containerDiskInGb: p.containerDiskInGb, env };
}
export function endpointPayload(name: string, templateId: string, p: Profile) {
  return {
    name, templateId, computeType: "GPU", gpuTypeIds: p.gpuTypeIds, gpuCount: p.gpuCount,
    dataCenterIds: p.dataCenterIds, workersMin: p.workersMin, workersMax: p.workersMax,
    idleTimeout: p.idleTimeout, executionTimeoutMs: p.executionTimeoutMs,
    scalerType: "QUEUE_DELAY", scalerValue: 4, flashboot: true,
    ...(p.networkVolumeId ? { networkVolumeId: p.networkVolumeId } : {}),
  };
}

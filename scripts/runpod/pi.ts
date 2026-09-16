import * as fs from "node:fs";
import * as path from "node:path";
import { object, type Profile } from "./config.ts";
import { current } from "./lifecycle.ts";
import { atomicJson, locked, type Deployment } from "./state.ts";

export function providerConfig(id: string, p: Profile, d: Deployment) {
  current(p, d);
  return {
    baseUrl: `https://api.runpod.ai/v2/${d.endpointId}/openai/v1`,
    api: "openai-completions", apiKey: "$RUNPOD_INFERENCE_API_KEY", authHeader: true,
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
    models: [{ id, name: `${id} (RunPod; GPU billing)`, reasoning: false, input: ["text"],
      contextWindow: p.contextWindow, maxTokens: p.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  };
}
function readModels(file: string) {
  const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (!object(value) || (value.providers !== undefined && !object(value.providers))) throw new Error("Invalid Pi models.json; no changes written");
  return { ...value, providers: { ...(value.providers ?? {}) } };
}
export async function register(file: string, project: string, id: string, p: Profile, d: Deployment, save: () => void) {
  file = path.resolve(file);
  const key = `runpod-${project}-${id}`;
  const config = providerConfig(id, p, d);
  if (d.registeredFile && d.registeredFile !== file) throw new Error("Unregister the previous Pi file before registering another");
  await locked(file, async () => {
    const models = readModels(file);
    if (models.providers[key] !== undefined && !(d.registeredProvider === key && JSON.stringify(models.providers[key]) === JSON.stringify(d.registeredConfig))) {
      throw new Error(`Provider ${key} exists and is not an unchanged managed entry; refusing overwrite`);
    }
    // Journal ownership before updating the second file so interruption is recoverable.
    d.registeredProvider = key; d.registeredConfig = config; d.registeredFile = file; save();
    if (fs.existsSync(file)) { fs.copyFileSync(file, `${file}.runpod-backup`); fs.chmodSync(`${file}.runpod-backup`, 0o600); }
    models.providers[key] = config;
    atomicJson(file, models);
  });
  return `${key}/${id}`;
}
export async function unregister(d: Deployment, save: () => void) {
  if (!d.registeredProvider || !d.registeredFile) return;
  await locked(d.registeredFile, async () => {
    const models = readModels(d.registeredFile!);
    const entry = models.providers[d.registeredProvider!];
    if (entry !== undefined && JSON.stringify(entry) !== JSON.stringify(d.registeredConfig)) throw new Error("Managed provider was edited; restore it or remove that entry manually before retrying");
    delete models.providers[d.registeredProvider!];
    if (fs.existsSync(d.registeredFile!)) {
      fs.copyFileSync(d.registeredFile!, `${d.registeredFile}.runpod-backup`);
      fs.chmodSync(`${d.registeredFile}.runpod-backup`, 0o600);
      atomicJson(d.registeredFile!, models);
    }
    delete d.registeredProvider; delete d.registeredConfig; delete d.registeredFile; save();
  });
}

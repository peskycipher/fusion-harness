import { deploymentName, endpointPayload, fingerprint, resourceId, templatePayload, type Config, type Profile } from "./config.ts";
import { ApiError, type Request } from "./client.ts";
import type { Deployment, State } from "./state.ts";

export type Save = () => void;
export async function deploy(config: Config, id: string, state: State, save: Save, request: Request) {
  const p = config.models[id];
  if (!p) throw new Error(`Unknown profile ${id}`);
  let d = state.deployments[id];
  if (d && (d.hash !== fingerprint(p) || d.deleting)) throw new Error("Deployment changed or removal incomplete. Finish removal using the original profile, or deploy under a new profile name.");
  if (!d) {
    d = { hash: fingerprint(p), name: deploymentName(config.project, id, p) };
    state.deployments[id] = d;
    save();
  }
  // Persist intent BEFORE POST. After an ambiguous network failure, a rerun only
  // reconciles by exact unique name; it never blindly repeats a resource creation.
  for (const kind of ["template", "endpoint"] as const) {
    const field = kind === "template" ? "templateId" : "endpointId";
    const collection = `/${kind}s`;
    if (d[field]) {
      const live = await request("GET", `${collection}/${d[field]}`);
      if (live?.name !== d.name) throw new Error(`Resource ownership mismatch for ${kind}`);
      continue;
    }
    if (d.pending === kind) {
      const all = await request("GET", collection);
      if (!Array.isArray(all)) throw new Error(`Unexpected ${kind} list response`);
      const matches = all.filter(x => x.name === d.name);
      if (matches.length !== 1) throw new Error(`Uncertain ${kind} creation: found ${matches.length} matching resources. Reconcile state with RunPod before retrying; no POST repeated.`);
      d[field] = resourceId(matches[0].id);
      delete d.pending;
      save();
      continue;
    }
    d.pending = kind;
    save();
    const payload = kind === "template" ? templatePayload(d.name, id, p) : endpointPayload(d.name, d.templateId!, p);
    const created = await request("POST", collection, payload);
    d[field] = resourceId(created?.id);
    delete d.pending;
    save();
  }
  return d;
}
export function current(p: Profile, d?: Deployment): Deployment & { endpointId: string } {
  if (!d?.endpointId || d.hash !== fingerprint(p) || d.deleting || d.pending) throw new Error("No complete deployment matching this profile; run deploy first");
  return d as Deployment & { endpointId: string };
}
export async function scale(p: Profile, d: Deployment, warm: boolean, request: Request) {
  current(p, d);
  const live = await request("GET", `/endpoints/${d.endpointId}`);
  if (live?.name !== d.name) throw new Error("Endpoint ownership mismatch");
  await request("PATCH", `/endpoints/${d.endpointId}`, { workersMin: warm ? 1 : 0 });
}
export async function destroy(state: State, id: string, save: Save, request: Request) {
  const d = state.deployments[id];
  if (!d) return;
  if (d.pending) throw new Error("Resolve pending creation with deploy before removal");
  if (d.registeredProvider) throw new Error("Unregister this provider before destroying its endpoint");
  d.deleting = true; save();
  for (const field of ["endpointId", "templateId"] as const) {
    if (!d[field]) continue;
    const route = `/${field === "endpointId" ? "endpoints" : "templates"}/${d[field]}`;
    try {
      const live = await request("GET", route);
      if (live?.name !== d.name) throw new Error("Resource ownership mismatch; refusing removal");
      await request("DELETE", route);
    } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
    delete d[field]; save();
  }
  delete state.deployments[id]; save();
}

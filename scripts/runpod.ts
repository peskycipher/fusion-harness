#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs } from "node:util";
import { parseConfig, deploymentName, endpointPayload, fingerprint, templatePayload } from "./runpod/config.ts";
import { client } from "./runpod/client.ts";
import { atomicJson, locked, readState } from "./runpod/state.ts";
import { current, deploy, destroy, scale } from "./runpod/lifecycle.ts";
import { register, unregister } from "./runpod/pi.ts";
import { probe } from "./runpod/probe.ts";

const help = `Usage: bun scripts/runpod.ts <command> <profile> [options]
Commands:
  plan        Print deterministic resource payloads; no credentials or API calls
  deploy      Create/reuse a template and queue-based Serverless endpoint
  status      Show endpoint scaling settings (does not generate tokens)
  validate    Paid smoke test: discovery, ACK, streamed tool call, tool round trip
  register    Merge provider into Pi models.json (run before launching Pi)
  unregister  Remove only the unchanged provider this deployment registered
  warm        Keep one paid worker running
  cool        Set minimum workers to zero (scales down after idle timeout)
  destroy     Delete tracked endpoint and template; requires --yes
Options:
  --config <file>     Default: infra/runpod/models.yaml
  --state <file>      Default: .runpod/<project>.json relative to config directory
  --pi-models <file>  Default: $PI_CODING_AGENT_DIR/models.json or ~/.pi/agent/models.json
  --timeout <sec>    Total validate deadline; default 900
  --yes              Required for destroy
Credentials: RUNPOD_API_KEY for management; RUNPOD_INFERENCE_API_KEY for inference.
Configuration contains RunPod secret names, never Hugging Face tokens.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: "string", default: "infra/runpod/models.yaml" }, state: { type: "string" },
    "pi-models": { type: "string" }, timeout: { type: "string", default: "900" },
    yes: { type: "boolean", default: false }, help: { type: "boolean", default: false },
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command, id] = positionals;
  if (positionals.length !== 2 || !["plan", "deploy", "status", "validate", "register", "unregister", "warm", "cool", "destroy"].includes(command)) throw new Error(help);
  const configFile = path.resolve(values.config!);
  const config = parseConfig(fs.readFileSync(configFile, "utf8"));
  const p = config.models[id];
  if (!p) throw new Error(`Unknown profile ${id}`);
  const stateFile = values.state ? path.resolve(values.state) : path.join(path.dirname(configFile), ".runpod", `${config.project}.json`);
  if (command === "plan") {
    const name = deploymentName(config.project, id, p);
    console.log(JSON.stringify({ hash: fingerprint(p), template: templatePayload(name, id, p), endpoint: endpointPayload(name, "<created-template-id>", p),
      notes: ["GPU sizing and model/runtime compatibility require live validation.", "HF downloads use worker disk unless a network volume is configured; managed model caching is not enabled by this REST payload.", "GPU time is billed separately from Pi token costs."] }, null, 2));
    return;
  }
  await locked(stateFile, async () => {
    const state = readState(stateFile, config.project);
    const save = () => atomicJson(stateFile, state);
    if (command === "deploy") {
      const d = await deploy(config, id, state, save, client(process.env.RUNPOD_API_KEY ?? ""));
      console.log(JSON.stringify({ profile: id, endpointId: d.endpointId, next: `validate ${id}; register ${id}` }));
      return;
    }
    const d = state.deployments[id];
    if (!d) throw new Error(`No tracked deployment for ${id}`);
    if (command === "unregister") { await unregister(d, save); console.log("Provider unregistered"); return; }
    if (command === "destroy") {
      if (!values.yes) throw new Error("Destroy removes the tracked endpoint and template. Use --yes to proceed.");
      await destroy(state, id, save, client(process.env.RUNPOD_API_KEY ?? ""));
      console.log("Endpoint and template removed; network volumes and secrets retained"); return;
    }
    const deployed = current(p, d);
    if (command === "register") {
      const file = values["pi-models"] ?? path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "models.json");
      console.log(await register(file, config.project, id, p, deployed, save)); return;
    }
    if (command === "validate") {
      const seconds = Number(values.timeout);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error("timeout must be 1..86400 seconds");
      console.log(JSON.stringify(await probe(deployed.endpointId, id, process.env.RUNPOD_INFERENCE_API_KEY ?? "", seconds * 1000), null, 2)); return;
    }
    const request = client(process.env.RUNPOD_API_KEY ?? "");
    if (command === "status") {
      const live = await request("GET", `/endpoints/${deployed.endpointId}`);
      if (live.name !== deployed.name) throw new Error("Endpoint ownership mismatch");
      // Never print the full API response (may include template env).
      console.log(JSON.stringify({ endpointId: deployed.endpointId, workersMin: live.workersMin, workersMax: live.workersMax, idleTimeout: live.idleTimeout, gpuCount: live.gpuCount, inferenceReadiness: "not tested; run validate", billing: "GPU worker time; token cost excludes infrastructure" }, null, 2)); return;
    }
    await scale(p, deployed, command === "warm", request);
    console.log(command === "warm" ? "Minimum workers set to 1; idle GPU time is billable" : "Minimum workers set to 0; workers stop after the idle timeout");
  });
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "RunPod command failed"); process.exitCode = 1; });

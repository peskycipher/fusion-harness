import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseConfig, fingerprint, templatePayload, endpointPayload } from "../config.ts";
import { client, ApiError, type Request } from "../client.ts";
import { deploy, destroy, scale } from "../lifecycle.ts";
import { atomicJson, readState, locked, type State } from "../state.ts";
import { providerConfig, register, unregister } from "../pi.ts";
import { readStream, probe } from "../probe.ts";
import { costLabel } from "../../../extensions/fusion-harness/modules/billing.ts";
import { loadModelStack } from "../../../extensions/fusion-harness/modules/model-stack.ts";

function raw() { return { version: 1, project: "test", models: { onyx: {
  model: "example/model", revision: "a".repeat(40), image: "runpod/worker-vllm@sha256:" + "b".repeat(64),
  gpuTypeIds: ["NVIDIA GeForce RTX 4090"], toolCallParser: "hermes",
} } }; }
function fixture() {
  const config = parseConfig(JSON.stringify(raw()));
  const state: State = { version: 1, project: "test", deployments: {} };
  const resources = new Map<string, any>(); const calls: string[] = [];
  const request: Request = async (method, route, body: any) => {
    calls.push(`${method} ${route}`);
    if (method === "POST") { const id = route === "/templates" ? "t1" : "e1"; const v = { ...body, id }; resources.set(`${route}/${id}`, v); return v; }
    if (method === "GET" && (route === "/templates" || route === "/endpoints")) return [...resources.entries()].filter(([k]) => k.startsWith(route)).map(([,v]) => v);
    if (!resources.has(route)) throw new ApiError(404, route);
    if (method === "DELETE") { resources.delete(route); return; }
    if (method === "PATCH") { resources.set(route, { ...resources.get(route), ...body }); return resources.get(route); }
    return resources.get(route);
  };
  return { config, state, request, resources, calls, save: () => {} };
}
async function temp(action: (dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fh-runpod-test-"));
  try { await action(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function sse(events: any[], chunkSize = 7) {
  const bytes = new TextEncoder().encode(events.map(x => `data: ${typeof x === "string" ? x : JSON.stringify(x)}\r\n\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset >= bytes.length) return controller.close(); controller.enqueue(bytes.slice(offset, offset += chunkSize)); } }));
}
const toolEvents = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup_value", arguments: '{"key":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"probe"}' } }] }, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 25, completion_tokens: 10 } }, "[DONE]",
];

describe("deployment configuration", () => {
  test("rejects unknown keys, mutable versions, invalid limits, and credential values", () => {
    for (const change of [{ surprise: 1 }, { revision: "main" }, { image: "runpod/worker-vllm:latest" }, { workersMin: 2 }, { gpuCount: 0 }, { maxTokens: 16384 }, { hfToken: "secret" }]) {
      const c = raw(); Object.assign(c.models.onyx, change); expect(() => parseConfig(JSON.stringify(c))).toThrow();
    }
  });
  test("produces stable payloads and secret references, never raw secrets", () => {
    const r = raw(); Object.assign(r.models.onyx, { hfTokenSecret: "hf_token", networkVolumeId: "vol1", gpuCount: 2 });
    const p = parseConfig(JSON.stringify(r)).models.onyx;
    const t = templatePayload("test", "onyx", p);
    expect(t.env.HF_TOKEN).toBe("{{ RUNPOD_SECRET_hf_token }}");
    expect(t.env.TENSOR_PARALLEL_SIZE).toBe("2");
    expect(t.env.MODEL_REVISION).toBe(p.revision);
    expect(t.env.DOWNLOAD_DIR).toBe("/runpod-volume/huggingface");
    expect(endpointPayload("test", "t1", p).networkVolumeId).toBe("vol1");
    expect(fingerprint(p)).toBe(fingerprint(parseConfig(JSON.stringify(r)).models.onyx));
  });
  test("example stack satisfies unchanged harness parser", () => {
    const stack = loadModelStack(path.resolve(import.meta.dir, "../../../.pi/fusion-harness/model-stack-runpod.yaml"));
    expect(stack.slots).toHaveLength(2); expect(stack.primaryBuilder.thinking).toBe("off");
  });
});
describe("resource lifecycle", () => {
  test("rerunning deploy reuses resources, warm/cool only updates endpoint minimum", async () => {
    const f = fixture(); await deploy(f.config, "onyx", f.state, f.save, f.request);
    await deploy(f.config, "onyx", f.state, f.save, f.request);
    expect(f.calls.filter(x => x.startsWith("POST"))).toHaveLength(2);
    await scale(f.config.models.onyx, f.state.deployments.onyx, true, f.request);
    expect(f.resources.get("/endpoints/e1").workersMin).toBe(1);
    await scale(f.config.models.onyx, f.state.deployments.onyx, false, f.request);
    expect(f.resources.get("/endpoints/e1").workersMin).toBe(0);
  });
  test("recovers lost POST response without duplicating endpoint", async () => {
    const f = fixture();
    const flaky: Request = async (m, p, b) => { const result = await f.request(m,p,b); if (m === "POST" && p === "/endpoints") throw new Error("connection lost"); return result; };
    await expect(deploy(f.config, "onyx", f.state, f.save, flaky)).rejects.toThrow("connection lost");
    expect(f.state.deployments.onyx.pending).toBe("endpoint");
    await deploy(f.config, "onyx", f.state, f.save, f.request);
    expect(f.state.deployments.onyx.endpointId).toBe("e1");
    expect(f.calls.filter(x => x === "POST /endpoints")).toHaveLength(1);
  });
  test("ambiguous creation with no match fails closed", async () => {
    const f = fixture();
    await expect(deploy(f.config, "onyx", f.state, f.save, async () => { throw new Error("network"); })).rejects.toThrow();
    await expect(deploy(f.config, "onyx", f.state, f.save, f.request)).rejects.toThrow("Uncertain template");
    expect(f.calls.some(x => x.startsWith("POST"))).toBe(false);
  });
  test("configuration drift never silently replaces resources", async () => {
    const f = fixture(); await deploy(f.config, "onyx", f.state, f.save, f.request);
    f.config.models.onyx.contextWindow = 8192;
    await expect(deploy(f.config, "onyx", f.state, f.save, f.request)).rejects.toThrow("changed");
  });
  test("removal checks ownership and resumes after partial deletion", async () => {
    const f = fixture(); await deploy(f.config, "onyx", f.state, f.save, f.request);
    const flaky: Request = async (m,p,b) => { if (m === "DELETE" && p === "/templates/t1") throw new Error("network"); return f.request(m,p,b); };
    await expect(destroy(f.state, "onyx", f.save, flaky)).rejects.toThrow();
    expect(f.state.deployments.onyx.endpointId).toBeUndefined();
    await destroy(f.state, "onyx", f.save, f.request);
    expect(f.state.deployments.onyx).toBeUndefined(); expect(f.resources.size).toBe(0);
  });
  test("refuses to delete renamed resources", async () => {
    const f = fixture(); await deploy(f.config, "onyx", f.state, f.save, f.request);
    f.resources.get("/endpoints/e1").name = "unrelated";
    await expect(destroy(f.state, "onyx", f.save, f.request)).rejects.toThrow("ownership");
    expect(f.resources.size).toBe(2);
  });
});
describe("Pi registration and files", () => {
  test("preserves unrelated providers, refuses edited entries, removes owned entry", async () => temp(async dir => {
    const f = fixture(); await deploy(f.config, "onyx", f.state, f.save, f.request);
    const file = path.join(dir, "models.json"); atomicJson(file, { custom: true, providers: { existing: { keep: 1 } } });
    const d = f.state.deployments.onyx;
    expect(await register(file, "test", "onyx", f.config.models.onyx, d, f.save)).toBe("runpod-test-onyx/onyx");
    const contents = JSON.parse(fs.readFileSync(file,"utf8"));
    expect(contents.providers.existing).toEqual({ keep: 1 }); expect(contents.custom).toBe(true);
    expect(contents.providers["runpod-test-onyx"].apiKey).toBe("$RUNPOD_INFERENCE_API_KEY");
    contents.providers["runpod-test-onyx"].baseUrl = "https://changed.example"; atomicJson(file, contents);
    await expect(register(file, "test", "onyx", f.config.models.onyx, d, f.save)).rejects.toThrow("overwrite");
    await expect(unregister(d, f.save)).rejects.toThrow("edited");
    contents.providers["runpod-test-onyx"] = d.registeredConfig; atomicJson(file, contents);
    await unregister(d, f.save); expect(JSON.parse(fs.readFileSync(file,"utf8")).providers).toEqual({ existing: { keep: 1 } });
  }));
  test("state project mismatch and concurrent access fail", async () => temp(async dir => {
    const file = path.join(dir, "state.json"); atomicJson(file, { version: 1, project: "other", deployments: {} });
    expect(() => readState(file, "test")).toThrow("mismatch");
    await locked(file, async () => { await expect(locked(file, async () => {})).rejects.toThrow("Lock exists"); });
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  }));
  test("GPU cost label cannot imply free inference", () => {
    expect(costLabel("runpod-test-onyx/onyx", 0)).toBe("GPU billed separately");
    expect(costLabel("openai/test", 0.125)).toBe("$0.1250");
  });
});
describe("inference transport", () => {
  test("SSE handles chunked JSON, CRLF, tool arguments, usage and DONE", async () => {
    const result = await readStream(sse(toolEvents, 1));
    expect(result.tools[0].function.arguments).toBe('{"key":"probe"}');
    expect(result.usage.completion_tokens).toBe(10);
  });
  test("truncated stream is a failure", async () => { await expect(readStream(sse(toolEvents.slice(0,-1)))).rejects.toThrow("Truncated"); });
  test("probe validates multi-turn tool protocol on the OpenAI route", async () => {
    const calls: any[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "onyx" }] });
      if (calls.length === 2) return Response.json({ choices: [{ message: { content: "ACK FUSION probe-1" } }] });
      if (calls.length === 3) return sse(toolEvents);
      expect(calls.at(-1).body.messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "314159" });
      return Response.json({ choices: [{ message: { content: "314159" } }] });
    }) as typeof fetch;
    const result = await probe("e1", "onyx", "test-key", 5000, fetcher);
    expect(result.checks).toHaveLength(4); expect(calls).toHaveLength(4);
  });
  test("HTTP errors never include remote secrets and POSTs are not retried", async () => {
    let calls = 0;
    const request = client("secret", (async () => { calls++; return new Response("secret reflected", { status: 403 }); }) as typeof fetch);
    await expect(request("POST", "/templates", {})).rejects.toThrow("HTTP 403"); expect(calls).toBe(1);
  });
});

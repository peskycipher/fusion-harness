import { ApiError } from "./client.ts";
import { resourceId } from "./config.ts";

// Exercise the actual OpenAI transport used by both the host and clean-room Pi
// children. A /models response alone does not establish inference readiness.
export async function probe(endpoint: string, model: string, key: string, timeoutMs: number, fetcher: typeof fetch = fetch) {
  resourceId(endpoint);
  if (!key) throw new Error("RUNPOD_INFERENCE_API_KEY is required");
  const signal = AbortSignal.timeout(timeoutMs);
  const base = `https://api.runpod.ai/v2/${endpoint}/openai/v1`;
  async function call(route: string, body?: unknown) {
    const response = await fetcher(`${base}${route}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal, redirect: "error",
    });
    if (!response.ok) throw new ApiError(response.status, `Inference ${route}`);
    return response;
  }
  const listed = await (await call("/models")).json();
  if (!listed.data?.some((x: any) => x.id === model)) throw new Error(`Endpoint does not advertise served model ${model}`);
  const messages: any[] = [{ role: "user", content: "Reply with exactly ACK FUSION probe-1 and nothing else." }];
  const ack = await (await call("/chat/completions", { model, messages, temperature: 0, max_tokens: 64 })).json();
  if (ack.choices?.[0]?.message?.content?.trim() !== "ACK FUSION probe-1") throw new Error("Exact fusion ACK probe failed");
  const toolMessages: any[] = [{ role: "user", content: "Call lookup_value with key 'probe'. You must use the tool to obtain the value; do not guess." }];
  const response = await call("/chat/completions", {
    model, messages: toolMessages, temperature: 0, max_tokens: 256, stream: true,
    stream_options: { include_usage: true }, tool_choice: "auto",
    tools: [{ type: "function", function: { name: "lookup_value", description: "Return a test value for a key",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false } } }],
  });
  const streamed = await readStream(response);
  if (streamed.finishReason !== "tool_calls" || streamed.tools.length !== 1) throw new Error("Streaming automatic tool-call probe failed");
  const tool = streamed.tools[0];
  if (!tool.id || tool.function.name !== "lookup_value" || JSON.parse(tool.function.arguments).key !== "probe") throw new Error("Invalid streamed tool arguments");
  toolMessages.push({ role: "assistant", content: streamed.text || null, tool_calls: streamed.tools });
  toolMessages.push({ role: "tool", tool_call_id: tool.id, content: "314159" });
  toolMessages.push({ role: "user", content: "Reply with only the value returned by the tool." });
  const final = await (await call("/chat/completions", { model, messages: toolMessages, temperature: 0, max_tokens: 64 })).json();
  if (final.choices?.[0]?.message?.content?.trim() !== "314159") throw new Error("Tool-result round-trip probe failed");
  return { model, checks: ["model-discovery", "exact-fusion-ack", "streamed-auto-tool-call", "tool-result-round-trip"], usageReported: !!streamed.usage };
}
export async function readStream(response: Response) {
  if (!response.body) throw new Error("Missing stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const tools = new Map<number, any>();
  let buffer = "", text = "", finishReason = "", done = false, usage: any;
  function event(block: string) {
    const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") { done = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error("Inference returned a stream error");
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    text += choice?.delta?.content ?? "";
    for (const t of choice?.delta?.tool_calls ?? []) {
      if (!Number.isInteger(t.index) || t.index < 0) throw new Error("Invalid streamed tool index");
      const target = tools.get(t.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (t.id) target.id = t.id;
      target.function.name += t.function?.name ?? "";
      target.function.arguments += t.function?.arguments ?? "";
      tools.set(t.index, target);
    }
  }
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      // Normalize only complete CRLF pairs, including pairs split across chunks.
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
      }
      if (buffer.length > 1024 * 1024) throw new Error("Oversized SSE event");
    }
    if (!done || !finishReason) throw new Error("Truncated inference stream");
    return { text, tools: [...tools.entries()].sort((a,b) => a[0]-b[0]).map(x => x[1]), finishReason, usage };
  } finally { await reader.cancel(); reader.releaseLock(); }
}

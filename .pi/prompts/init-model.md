---
description: Register an existing RunPod OpenAI-compatible endpoint as a Pi provider in models.json
argument-hint: "<name> <runpod-url> [extra instructions]"
---

# /init-model — RunPod endpoint → Pi provider registration

You are registering Fusion Harness model `$1` against the existing RunPod
service at `$2`. The service is already deployed and billable on its own
terms; this flow only verifies it and wires it into Pi. Execute the phases in
order; do not skip reporting steps. Optional user instructions (they override
every default below): ${@:3}

Hard rules:

- **Never print, log, copy, or commit API keys.** `.env` holds
  `RUNPOD_API_KEY` (management) and `RUNPOD_INFERENCE_API_KEY` (inference);
  the justfile loads it. Reference variable names, never values, in code
  output and in your report.
- **This flow is registration-only.** It creates, mutates, and deletes
  NOTHING on RunPod: no volumes, no templates, no endpoints, no worker
  settings. It may READ endpoint metadata (GraphQL) and logs for diagnosis.
  It never touches the vLLM queue-based profiles managed by
  `bun scripts/runpod.ts` (state: `infra/runpod/.runpod/`) beyond reading
  them — registering one of them as a Pi provider is allowed and expected.
- **Pause for explicit user confirmation before anything billable**: every
  request against a serverless endpoint with `workersMin 0` can cold-start a
  GPU worker (image pull + model load, billed at GPU rates, minutes on first
  boot). Confirm once for the Phase 2 validation batch; do not re-issue paid
  requests automatically.
- If any phase fails, stop and diagnose before spending more; there is no
  automatic retry of paid operations.

Inputs:

- Model name / profile slug: `$1` — a lowercase slug, used verbatim as the
  provider key suffix (`runpod-$1`) and the record filename. It does NOT have
  to match the served model id (requests must use the served id, which
  Phase 2 discovers).
- RunPod URL: `$2` — the service's OpenAI-compatible base URL (accepted forms
  in Phase 1).

Defaults (override only on explicit user instruction): contextWindow 16384 /
maxTokens 4096 unless the service reports better values; `reasoning` is set
from observed evidence, not assumption; every model id the service lists is
registered under the provider.

Tools installed for this flow: `runpodctl`, `curl`, `jq`, `pi` (plus
`python3` for the merge script).

Preflight (fail fast, before any phase): `pi --no-extensions --list-models`
must run, and `RUNPOD_INFERENCE_API_KEY` must be set in the environment
(check with `test -n "$RUNPOD_INFERENCE_API_KEY" && echo set` — never echo
values). `RUNPOD_API_KEY` is optional here: it only enables Phase 1 endpoint
introspection; surface it if missing but continue.

## Phase 1 — Normalize and classify the URL

1. Accept exactly these forms (case-insensitive scheme/host), normalizing to
   an OpenAI-compatible base URL ending in `/v1`:

   - Load-balancing endpoint (LB):
     `https://<ENDPOINT_ID>.api.runpod.ai` or
     `https://<ENDPOINT_ID>.api.runpod.ai/v1`
     → baseUrl `https://<ENDPOINT_ID>.api.runpod.ai/v1`
   - Queue-based endpoint (QB) via RunPod's OpenAI gateway:
     `https://api.runpod.ai/v2/<ENDPOINT_ID>/openai/v1` (or the same without
     the trailing `/v1`)
     → baseUrl `https://api.runpod.ai/v2/<ENDPOINT_ID>/openai/v1`
     (this is the documented vLLM-worker compatibility form)

2. If given `https://api.runpod.ai/v2/<ENDPOINT_ID>` (bare job-API URL):
   STOP and explain — the `/run` job API is not OpenAI-compatible, so Pi's
   `openai-completions` provider cannot speak it. Offer the two usable forms
   above and proceed only after the user picks one.

3. Anything else (other hosts, pods, unknown shapes): STOP and ask.

4. Extract `<ENDPOINT_ID>`. If `RUNPOD_API_KEY` is set, introspect it
   (read-only) and report: name, `type` (expect `LB` for the first form,
   `QB` for the second — a mismatch is a red flag to surface, not a
   blocker), `templateId`, `workersMin`/`workersMax`, `idleTimeout`, and
   whether it is one of the protected `bun scripts/runpod.ts` profiles:

   ```bash
   curl -sS https://api.runpod.io/graphql \
     -H "Authorization: Bearer $RUNPOD_API_KEY" -H 'Content-Type: application/json' \
     -d '{"query":"query { myself { endpoints { id name type templateId workersMin workersMax idleTimeout } } }"}' \
     | jq '.data.myself.endpoints[] | select(.id=="<ENDPOINT_ID>")'
   ```

   If the key is missing or the endpoint is not found (proxy URLs, gateways),
   say so and continue on the URL as given.

5. Record: slug, raw URL, normalized baseUrl, endpoint id + type, workers
   min/max, idle timeout, template id, timestamp.

## Phase 2 — Live validation (PAID — confirm first)

All requests use `Authorization: Bearer $RUNPOD_INFERENCE_API_KEY` against
the normalized baseUrl. Serverless workers scale from zero: the first request
cold-starts a worker (image pull + model load — minutes). LB readiness also
has a dedicated probe at `https://<ENDPOINT_ID>.api.runpod.ai/health`. Run
these in order and report each result:

1. Readiness — poll until the service answers (expect 502s / `no workers
   available` / timeouts during cold start; retry every 5–10 s for up to
   ~10 min):

   ```bash
   curl -sS -H "Authorization: Bearer $RUNPOD_INFERENCE_API_KEY" \
     "<BASE_URL>/models"
   ```

   Diagnose stuck workers with `runpodctl serverless get <ENDPOINT_ID>
   --include-workers` and `runpodctl serverless logs <ENDPOINT_ID>`.

2. Discovery — the `/models` answer lists every served model id. Record them
   all, plus `max_model_len`/`context_length` per model when the service
   exposes it (vLLM does). Zero models listed → STOP (nothing to register).

3. Completion — one small `POST <BASE_URL>/chat/completions` (the primary
   served model id, ~64 `max_tokens`) must return a well-formed answer.

4. Reasoning evidence — inspect that response: if reasoning arrives
   separated from content (a `reasoning_content` / `reasoning` field,
   deepseek-style), set `reasoning: true` for that model; otherwise `false`.
   Never guess this flag.

5. Tool calling — a chat completion with one trivial tool definition: the
   service must emit a parsed `tool_calls` entry; send the tool result back
   and get a clean follow-up turn. If it fails, STOP and present the options:
   fix the service (e.g. vLLM needs tool-choice/tool-parser settings enabled
   at the endpoint), or — only on explicit user instruction — register
   anyway with a loud warning that the slot cannot use tools. Registering a
   silently-broken tool slot feeds the harness a landmine; do not default to
   it.

If validation fails at any step, STOP: diagnose via worker logs before any
further paid requests.

## Phase 3 — Register the Pi provider

Merge exactly this provider into `$PI_CODING_AGENT_DIR/models.json` or
`~/.pi/agent/models.json` (create the file if absent), substituting the real
baseUrl and the discovered models (one entry per served id):

```json
{
  "providers": {
    "runpod-$1": {
      "baseUrl": "<BASE_URL>",
      "api": "openai-completions",
      "apiKey": "$RUNPOD_INFERENCE_API_KEY",
      "authHeader": true,
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "<SERVED_MODEL_ID>",
          "name": "<SERVED_MODEL_ID> — $1 on RunPod",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 16384,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

Field rules: `id` is the served id verbatim (requests must use it);
`reasoning` from Phase 2 evidence; `contextWindow` from the service's
`max_model_len`/`context_length` when available, else the default;
`maxTokens` default 4096 (user-override via extra instructions). Merge
rules: back up the existing file first (`models.json.init-model-backup`);
preserve every unrelated provider and top-level key; make the merge
idempotent (re-running with the same `$1` replaces only `runpod-$1`); never
write a real key — the `"$RUNPOD_INFERENCE_API_KEY"` reference resolves at
runtime. Do the merge with a small script (jq/python), not hand-editing.
Then verify:

```bash
pi --no-extensions --list-models   # must list runpod-$1/<SERVED_MODEL_ID>
```

## Phase 4 — Record and wrap up

1. Record everything in `infra/runpod/.runpod/$1.provider.md` (already
   gitignored; never commit identifiers the user calls sensitive): profile
   slug, raw + normalized URL, endpoint id + type, template id, workers
   min/max + idle timeout, served model ids + context, reasoning flag +
   evidence, timestamp, and deviations from the defaults.

2. Tell the user the slot reference(s) for
   `.pi/fusion-harness/model-stack-*.yaml`:

   ```yaml
   model: runpod-$1/<SERVED_MODEL_ID>
   ```

   Edit a stack file only when the user asks (or confirms).

3. Remind the user what is NOT automated here:
   - This flow owns nothing on RunPod: teardown is just removing
     `runpod-$1` from models.json (plus the backup file if desired). The
     endpoint, its template, and any volumes are owned by whatever created
     them (`bun scripts/runpod.ts` profiles or the RunPod console).
   - Warm/cool stays with the endpoint's owner:
     `runpodctl serverless update <ENDPOINT_ID> --workers-min 1` keeps one
     paid idle worker; `--workers-min 0` scales to zero after the idle
     timeout.
   - Platform limits Pi cannot extend: load-balancing endpoints have a
     5.5-minute processing limit per request, a 2-minute request timeout
     while no worker is up, and 30 MB request/response payloads; the QB
     OpenAI gateway instead inherits the queue-based job timeouts. Long
     reasoning generations must fit whichever applies.
   - Pi token prices are placeholders: RunPod GPU seconds, idle workers, and
     volume storage bill separately.

4. Close with a summary table: profile slug, provider key, baseUrl, endpoint
   id + type, workers min/max, every served model id + contextWindow +
   reasoning flag (with evidence), and every deviation from the defaults.

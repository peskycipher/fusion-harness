# Hugging Face models on RunPod Serverless

This integration provisions RunPod queue-based vLLM endpoints and registers them
as ordinary Pi providers. Fusion Harness and its tools stay on your computer;
RunPod workers run inference only. It supports compatible Hugging Face fine-tunes,
including uncensored models; it does not alter model weights or remove refusals.

## Status and prerequisites

The CLI has deterministic contract tests. No GPU deployment or model qualification
has been performed as part of this change. Run the paid validation steps below
before treating any model/runtime/GPU profile as usable.

Required: Bun, `npm ci`, a RunPod account with GPU capacity/credit, a RunPod
`worker-vllm` image supporting the documented environment variables, and an
instruction model with a supported tool-call parser. The plain
`vllm/vllm-openai` image is not a queue-based RunPod worker.

Pi must support `models.json` custom providers and `$ENV_VAR` key interpolation.
The harness installs Pi globally, so the repository does not pin a Pi version.
Check your installed Pi's models documentation; older versions may use different
environment-variable syntax. Upgrade Pi if necessary.

## Configure one deployment

1. Copy `infra/runpod/models.example.yaml` to `infra/runpod/models.yaml`.
2. Select your actual HF repository and pin its full 40-character commit SHA.
3. Pin a compatible worker image using its `image@sha256:...` digest. Obtain the
   digest from the container registry or `docker buildx imagetools inspect IMAGE:TAG`.
4. Set the matching tool-call parser, GPU type IDs/count, quantization (if any),
   context window, and disk size. Defaults are 16K context, 4K output, one GPU,
   zero minimum workers and one maximum worker. They are not a sizing guarantee.

The example uses a Hermes model and parser to illustrate the schema. Replace it
with your chosen compatible model. A GGUF file is not a drop-in substitute for a
supported safetensors checkpoint. This version does not include a llama.cpp worker,
custom remote model code, reasoning parsers, or automatic GPU sizing.

For a gated/private model, first grant access to your HF account and create a
RunPod secret containing a read-scoped HF token. Set `hfTokenSecret` to the secret's
name. Tokens never belong in this YAML. The template receives a RunPod secret
reference. Runtime image and HF model revisions are mandatory immutable pins.

Store `RUNPOD_API_KEY` and `RUNPOD_INFERENCE_API_KEY` in your shell or local `.env`.
Use a management credential for provisioning and an appropriately scoped inference
credential for agents. Bun and the existing justfile load `.env`; Node does not
load it automatically. Do not commit credentials.

## Provision, validate, register, launch

```bash
bun scripts/runpod.ts plan onyx
bun scripts/runpod.ts deploy onyx
bun scripts/runpod.ts status onyx
bun scripts/runpod.ts validate onyx --timeout 900
bun scripts/runpod.ts register onyx
pi --no-extensions --list-models
```

The plan is offline and includes exact API payloads. Deploy creates a private
Serverless template and endpoint, then checkpoints their IDs. It does not send an
inference request. The status command reads scaling configuration; it does not
claim the model is ready.

Validate performs paid inference through the same OpenAI API used by Pi. It checks
model discovery, an exact `ACK FUSION` response, streamed automatic tool calls,
stream completeness, and a tool-result round trip. The timeout is a single overall
deadline; network/proxy limits can end a request sooner. There is no automatic
generation retry, because an ambiguous failure may still have billable work running.
If cold startup fails, inspect the endpoint in RunPod, optionally `warm`, wait for
it to load, then explicitly rerun validation.

Register merges the provider into `~/.pi/agent/models.json`, or into
`$PI_CODING_AGENT_DIR/models.json` when configured. `--pi-models PATH` overrides the
location. Keep that location consistent with Pi's actual agent directory.
Unrelated entries and top-level keys are preserved; existing files are backed up
to `models.json.runpod-backup`. Backups can contain other providers' credentials;
protect them as you protect models.json. User-edited or unmanaged entries are not
overwritten. The generated provider reads `$RUNPOD_INFERENCE_API_KEY` at runtime.

Launch the supplied smoke-test stack from a POSIX shell:

```bash
env -u RUNPOD_API_KEY pi -e extensions/fusion-harness/fusion-harness.ts \
  --fh-config .pi/fusion-harness/model-stack-runpod.yaml
```

Or use `just fh-runpod`, which validates the example `onyx` profile before launch.
On Windows, remove the management credential from the process environment before
launching Pi and use the direct `pi` command instead of POSIX `env -u`.
This environment separation is not a filesystem secret boundary: coding tools can
read files available to the agent, including `.env`. Keep management credentials
outside the agent workspace when that distinction matters.

The example assigns the same deployment to two required harness slots. That proves
integration but provides no model diversity. For actual fusion, add a second
profile, deploy/validate/register it, and change the relevant stack entry to the
printed provider/model ID. The format is `runpod-PROJECT-PROFILE/PROFILE`.

Provision and register before starting Pi: clean-room child processes disable
extensions, and the harness caches its startup model catalogue. A provider registered
only by an extension will not work. No stack-parser or writer-lease changes are
needed for these registered providers.

## Storage and billing

With no volume, HF weights download into ephemeral worker storage and may download
again on new workers. Allow disk space for the runtime, weights and temporary files.
`networkVolumeId` attaches an existing volume and sets the download directory to
`/runpod-volume/huggingface`; select compatible data centers. The CLI never creates
or deletes that volume. Its storage charges continue independently of worker count.

RunPod's managed HF cache is desirable, but the verified REST endpoint-create
contract does not expose its configuration. This CLI does not enable that feature
or promise unbilled downloads. Managed-cache automation is a follow-up once its
API/revision semantics are verified. External object storage is also out of scope.

```bash
bun scripts/runpod.ts warm onyx   # minimum 1: paid idle worker
bun scripts/runpod.ts cool onyx   # minimum 0: scale down after idle timeout
```

Warm/cool change the live endpoint only. The declared configuration remains the
initial deployment policy; rerunning deploy verifies/reuses resources and does not
reset warm/cool settings. Worker maximum limits concurrency, not total spend.

Generated `runpod-*` providers display `GPU billed separately` in harness panels
and the model bar. Pi token prices are zero placeholders, not free compute. Existing
JSON `costUsd`/`totalCostUsd` fields remain token accounting and exclude RunPod GPU,
idle, startup, and storage charges. Actual cost reconciliation is not implemented.

## State, recovery, and removal

State defaults to `infra/runpod/.runpod/PROJECT.json` (beside the configuration).
`--state PATH` overrides it. Preserve this ignored file: it records resource
ownership and Pi registration. JSON writes use atomic renames and a per-file lock.
If a process crashes, inspect its recorded PID and remove its `.lock` only after
confirming it is no longer running. Use one authoritative state file per deployment;
separate machines/state copies are not coordinated by a distributed lock.

The CLI saves creation intent before each POST. If a response is lost, rerun deploy:
it lists resources and adopts exactly one resource with the pending operation's
deterministic name. Zero or multiple matches require manual reconciliation, never a
blind repeated POST. If RunPod confirms the request did not create anything, back
up state and clear only that operation's `pending` field before retrying. If a
resource exists, retain pending and retry reconciliation after it is visible.

Changes to a deployed profile fail closed. To upgrade, create a new profile name,
deploy and validate it, switch stack references, then remove the old deployment.
This supports a reversible cutover without changing an endpoint under active agents.

```bash
bun scripts/runpod.ts unregister onyx
bun scripts/runpod.ts destroy onyx --yes
```

Stop sessions using the endpoint first. Destroy removes only tracked endpoint and
template IDs after checking their names, endpoint first. It resumes partial deletion,
tolerates already-absent resources, and retains volumes and secrets. It refuses
removal while its Pi provider remains registered. Keep the original profile in the
configuration until removal completes.

## Qualification before regular use

1. Run `npm test` for deterministic tests (no API calls).
2. Run `validate` with real GPU resources.
3. Confirm visibility with `pi --no-extensions --list-models` and test a Pi tool turn.
4. Run `/fh-only`, `/fh-fusion`, and `/fh-collaborate` in a disposable test checkout.
   Inspect exact ACK evidence, architect DAG validity, and the single-writer trace.
5. Exercise long context, worker scale-from-zero, and cancellation while observing
   RunPod. Local child termination is not proof of remote inference cancellation.

The OpenAI compatibility transport does not expose a managed job ID here, so remote
job cancellation, automatic retry/backoff, in-session provisioning, billing
reconciliation, and whole-harness live qualification remain explicit follow-ups.
RunPod's load-balancing endpoints are not used; they have different request limits
and require a different worker/transport configuration.

## API contracts

- [Create template](https://docs.runpod.io/api-reference/templates/POST/templates)
- [Create endpoint](https://docs.runpod.io/api-reference/endpoints/POST/endpoints)
- [Worker vLLM environment](https://docs.runpod.io/serverless/vllm/environment-variables)
- [OpenAI API compatibility](https://docs.runpod.io/serverless/vllm/openai-compatibility)
- [Model caching](https://docs.runpod.io/serverless/endpoints/model-caching)
- [Secret references](https://docs.runpod.io/pods/templates/secrets)
- [Pi custom providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/)

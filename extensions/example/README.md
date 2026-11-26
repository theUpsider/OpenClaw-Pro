# Example Decisions

A bundled OpenClaw decision provider that serves the `ds41` checkpoint (DeepSeek
V4.1 Flash, Hugging Face revision `314113f8`) through an OpenAI-compatible vLLM
chat endpoint on the local host.

## What it is

OpenClaw's decision role sends shared `state` plus a non-empty `questions` map and
expects one typed answer per question. This provider renders that batch into a
single JSON-schema-constrained chat request and maps the response back to the
`choice`, `score`, and `boolean` answer shapes.

Requests are issued over the guarded fetch path and are restricted to a loopback
origin. The endpoint is unauthenticated; the provider reads no credential and
sends no secret.

## Configuration

Configure under `plugins.entries.example.config`:

| Field       | Type    | Default | Notes                                                                                    |
| ----------- | ------- | ------- | ---------------------------------------------------------------------------------------- |
| `baseUrl`   | string  | unset   | Loopback origin only, e.g. `http://127.0.0.1:8011`. Unset leaves the provider not ready. |
| `timeoutMs` | integer | `30000` | Per-request timeout, `1000`–`60000`.                                                     |
| `maxTokens` | integer | `4096`  | Output budget, `256`–`65536`. Reasoning tokens share this budget, so keep it generous.   |

The model is served as `ds41`; the declared decision model is
`example/ds41-314113f8`. The provider sends `model: "ds41"` and requires the
response `model` field to be exactly `ds41`.

## Pinned revision

The declared decision model is `example/ds41-314113f8`; the `314113f8` is the
Hugging Face revision the checkpoint was extracted at, recorded in the model name
and in this provider's report. The provider sends `model: "ds41"` and requires the
response `model` field to be exactly `ds41`, so a server that serves a different
served name fails loudly instead of answering.

This pin is **operator-attested, not cryptographic**: the alias only ties a request
to whichever weights are currently served under `ds41`. It does not prove which
checkpoint produced an answer, and a server re-pointed at other weights under the
same alias is not detected. Keep the deployment's own revision record.

## Estimates are uncalibrated

Reported probabilities and scores are the model's own estimates. They are passed
through unchanged and are **not calibrated** correctness probabilities. The
declared capability `confidence` is `none`; this provider never reports a
confidence value.

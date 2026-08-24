# OpenAI production readiness

This gate verifies the Worker model configuration without exposing the OpenAI API key. Run it from
a trusted machine with the same OpenAI values used by the Railway Worker. The check performs one
model lookup and one minimal, non-stored Responses API request that forces a strict function call.

Before running the command, open the dedicated OpenAI Project dashboard and confirm:

1. The Worker key belongs to that Project and is not a personal or temporary key.
2. Project budget, account balance, and organization limits can cover at least five acceptance Runs:
   two initial generations, two incremental changes, and one retry.
3. The selected model's request and token rate limits have enough remaining capacity for those Runs.

The three confirmation variables below are runner-only acknowledgements. Do not add them to Railway,
GitHub, or `.env`; they deliberately expire when the shell command exits.

```sh
OPENAI_PROJECT_CONFIRMED=true \
OPENAI_BUDGET_CONFIRMED=true \
OPENAI_RATE_LIMIT_CONFIRMED=true \
pnpm test:openai:readiness
```

The command loads `.env` when it exists, checks the configured Agent limits, confirms access to the
exact `OPENAI_MODEL`, and proves Responses API tool calling. It outputs a Markdown evidence record
containing only the model, non-sensitive limits, remaining rate-limit headers when OpenAI provides
them, a request ID, and the confirmation result. It never prints the API key, prompt body, or model
response.

The production minimums enforced by the gate are:

| Limit                           |     Minimum | Current baseline |
| ------------------------------- | ----------: | ---------------: |
| Output tokens per request       |       8,000 |           12,000 |
| Agent turns per Run             |          12 |               20 |
| Tool calls per Run              |          30 |               60 |
| Cumulative model tokens per Run |     100,000 |          200,000 |
| Total Run duration              | 480 seconds |      600 seconds |

HTTP 401 reports an invalid Worker key; HTTP 403/404 reports project or model permission problems;
HTTP 429 reports budget, balance, or rate-limit exhaustion; timeouts and provider failures identify
outbound networking/provider availability. In the application these failures reach the durable Run
terminal state as `AI_FAILED`; configured token/tool/turn limits use `AI_LIMIT`, and the total Run
deadline uses `RUN_TIMEOUT`.

The gate proves current model access and tool compatibility. The OpenAI dashboard remains the source
of truth for monthly budget, balance, and organization/model rate limits, which is why all three
manual confirmations are mandatory.

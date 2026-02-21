# Codex SDK POC

Proof of concept: Replace OpenCode SDK with Codex CLI (`codex exec`) for AI code review.

## What this proves

1. **ChatGPT OAuth auth works in CI** — base64-encoded keychain tokens → `~/.codex/auth.json`
2. **`codex exec --json` returns structured JSONL** — parse `agent_message` events for response text
3. **Structured JSON output** — model returns parseable review findings

## Auth setup

### For CI (GitHub Actions)

Extract tokens from macOS keychain and store as GitHub secret:

```bash
# One-time setup
gh secret set CODEX_AUTH_JSON_B64 --body "$(security find-generic-password -s 'Codex Auth' -w | base64 | tr -d '\n')"
```

### In the action

```bash
# Decode secret → write auth.json
echo "$CODEX_AUTH_JSON_B64" | base64 -d > ~/.codex/auth.json
echo 'cli_auth_credentials_store = "file"' >> ~/.codex/config.toml
```

## Local testing

```bash
# Test with existing keychain auth
node poc/test-local.mjs

# Test CI auth flow (simulates GitHub Actions)
CODEX_AUTH_JSON_B64="$(security find-generic-password -s 'Codex Auth' -w | base64 | tr -d '\n')" \
  node poc/test-ci.mjs
```

## Architecture: codex exec vs OpenCode SDK

| Aspect | OpenCode SDK (current) | codex exec (POC) |
|--------|----------------------|------------------|
| **Transport** | Spawn server + REST + SSE | Spawn CLI subprocess + JSONL on stdout |
| **Auth** | Custom auth.json format | Native ChatGPT OAuth / API keys |
| **Session mgmt** | Manual create/prompt/collect | Single `codex exec` invocation per prompt |
| **Timeout** | SSE stream can hang (bug #6573) | Process-level timeout via SIGTERM |
| **Dependencies** | `opencode-ai` + `@opencode-ai/sdk` | Just `codex` CLI binary (already installed) |
| **Cleanup** | Must close server + release SSE reader | Process exits naturally |

## Key flags

```bash
codex exec \
  --json \              # JSONL output on stdout
  --full-auto \         # No approval prompts
  --ephemeral \         # Don't persist session
  -c 'sandbox_mode="read-only"' \  # Can read files, not write
  -c 'model_reasoning_effort="low"' \  # Fast responses
  -m "gpt-5.2-codex" \ # Optional model override
  "Your prompt here"
```

## JSONL event format

```jsonl
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{"input_tokens":12438,"output_tokens":31}}
```

Extract `item.type === "agent_message"` for the response text.

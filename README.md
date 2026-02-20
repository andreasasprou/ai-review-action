# AI Review Action

AI-powered code review GitHub Action using [OpenCode SDK](https://github.com/sst/opencode). Posts inline PR comments with severity-calibrated findings and a live dashboard.

## Quickstart

```yaml
# .github/workflows/ai-review.yml
name: AI Review
on:
  pull_request:
    types: [opened, ready_for_review, synchronize]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  checks: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    if: |
      (github.event_name == 'pull_request' && !github.event.pull_request.draft) ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request &&
       startsWith(github.event.comment.body, '/ai-review'))
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha || github.event.issue.pull_request.head.sha }}
          fetch-depth: 0
      - uses: andreasasprou/ai-review-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Add your `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`) as a repository secret. That's it.

## How it works

1. **File classification**: Files are classified as `skip` (binary, generated), `relaxed` (tests, scripts, config), or `standard` (production code). Relaxed files are reviewed for bugs and security only, not architecture patterns.

2. **Mental model prompting**: The model uses a "grateful author test" to decide what's worth commenting on, and calibrates severity:
   - **P0**: Production incident, security breach, or data loss (requires concrete failure path)
   - **P1**: Confirmed bug with evidence in the diff
   - **P2**: Real improvement with tangible benefit

3. **Inline comments**: Findings are posted as inline PR comments anchored to specific lines.

4. **Dashboard**: A single PR comment tracks progress, shows results, and persists state for incremental reviews.

5. **Verdicts**: `BLOCK` (has P0), `ATTENTION` (has P1), or `OK` (clean).

## Configuration

Create `.ai-review.yml` in your repo root to customize behavior. All fields are optional.

```yaml
# Model (provider/model format)
model: openai/gpt-4o
model_options:
  reasoningEffort: high

# File classification
files:
  skip:                           # Never reviewed
    - "*.md"
    - "*.css"
    - "*.svg"
    - "*.lock"
    - "*.d.ts"
    - ".github/**"
    - "__generated__/**"
  relaxed:                        # Bugs & security only
    - "*.test.ts"
    - "*.spec.ts"
    - "__tests__/**"
    - "scripts/**"
    - "*.yml"
    - "*.json"

# Project guidelines injected into system prompt
context_files:
  - AGENTS.md

# Prompt customization
prompt:
  project_type: "TypeScript monorepo"
  preamble: |
    Additional instructions prepended to the system prompt.

# Review limits
review:
  max_findings_per_file: 3
  max_total_findings: 15

# Dashboard branding
dashboard:
  marker: "ai-review"
  title: "AI Review Dashboard"
```

### Default behavior (no config file)

Works out of the box with sensible defaults: common binary/generated files are skipped, test/script files get relaxed review, and `AGENTS.md` is auto-detected if present.

## Authentication

Three auth modes, detected in priority order:

| Priority | Input | Mode |
|----------|-------|------|
| 1 | `opencode-auth-json-b64` | Base64-encoded OpenCode auth.json |
| 2 | `openai-api-key` / `anthropic-api-key` | Direct API keys (simplest) |
| 3 | Pre-existing auth.json | From a prior workflow step |

### Direct API keys (recommended for most users)

```yaml
- uses: andreasasprou/ai-review-action@v1
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    model: openai/gpt-4o
```

### OpenCode auth (for OpenCode subscribers)

```yaml
- uses: andreasasprou/ai-review-action@v1
  with:
    opencode-auth-json-b64: ${{ secrets.OPENCODE_AUTH_JSON_B64 }}
```

## Action inputs

| Input | Default | Description |
|-------|---------|-------------|
| `openai-api-key` | | OpenAI API key |
| `anthropic-api-key` | | Anthropic API key |
| `opencode-auth-json-b64` | | Base64-encoded OpenCode auth.json |
| `model` | `openai/gpt-4o` | Model in `provider/model` format |
| `github-token` | `${{ github.token }}` | GitHub token |
| `config-path` | `.ai-review.yml` | Path to config file |
| `timeout-minutes` | `20` | Review timeout |
| `command` | `/ai-review` | Slash command trigger |

## Action outputs

| Output | Description |
|--------|-------------|
| `verdict` | `OK`, `ATTENTION`, `BLOCK`, `SKIPPED`, or `ERROR` |
| `findings-count` | Number of findings posted |
| `dashboard-comment-id` | ID of the dashboard PR comment |

## Slash commands

Comment on a PR to trigger a review:

- `/ai-review` - Run a review (incremental if previous state exists)
- `/ai-review full` - Force a full review of all files
- `/ai-review reset` - Reset state and start fresh
- `/ai-review --since <sha>` - Review changes since a specific commit

## Incremental reviews

After the first review, subsequent pushes only review new changes. State is stored in the dashboard comment, so no external storage is needed. Use `/ai-review full` to force a complete re-review.

## Permissions

The action requires these GitHub token permissions:

```yaml
permissions:
  contents: read        # Read repo contents and diffs
  pull-requests: write  # Post inline comments
  checks: write         # Create/update check runs
  issues: write         # Create/update dashboard comment
```

## License

MIT

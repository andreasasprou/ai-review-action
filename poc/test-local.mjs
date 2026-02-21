#!/usr/bin/env node
// Local test script for the Codex SDK POC.
//
// Tests that:
// 1. Codex auth works (ChatGPT OAuth from keychain or auth.json)
// 2. codex exec can send a prompt and get structured JSON back
// 3. The response can be parsed as review findings
//
// Usage:
//   node poc/test-local.mjs                        # Uses existing auth
//   OPENAI_API_KEY=sk-... node poc/test-local.mjs  # Uses API key

import { execFileSync } from "node:child_process";
import { setupAuth, sendCodexPrompt } from "./codex-review.mjs";

const SAMPLE_DIFF = `
diff --git a/src/utils/retry.ts b/src/utils/retry.ts
new file mode 100644
--- /dev/null
+++ b/src/utils/retry.ts
@@ -0,0 +1,32 @@
+/**
+ * Generic retry utility with exponential backoff.
+ */
+export async function withRetry<T>(
+  fn: () => Promise<T>,
+  options: {
+    maxRetries: number;
+    baseDelayMs?: number;
+    onRetry?: (error: unknown, attempt: number) => void;
+  },
+): Promise<T> {
+  const { maxRetries, baseDelayMs = 1000, onRetry } = options;
+
+  for (let attempt = 0; attempt <= maxRetries; attempt++) {
+    try {
+      return await fn();
+    } catch (error) {
+      if (attempt === maxRetries) {
+        throw error;
+      }
+
+      onRetry?.(error, attempt + 1);
+
+      // Exponential backoff with jitter
+      const delay = baseDelayMs * 2 ** attempt + Math.random() * 100;
+      await new Promise((resolve) => setTimeout(resolve, delay));
+    }
+  }
+
+  // This should be unreachable, but TypeScript needs it
+  throw new Error("Retry exhausted");
+}
`.trim();

const REVIEW_PROMPT = `You are a senior engineer reviewing a pull request in a TypeScript monorepo.
Catch issues that would cause production incidents, security vulnerabilities, or data loss.

IMPORTANT: Do NOT run any commands. Do NOT read any files. Just review the diff below and respond.

Review this diff and respond with ONLY a JSON object (no markdown fences, no explanation):
{
  "comments": [
    {
      "path": "string",
      "line": integer,
      "severity": "P0" | "P1" | "P2",
      "category": "Correctness" | "Design" | "Security" | "Performance",
      "title": "short 1-line summary",
      "body": "explanation with concrete failure path and suggested fix"
    }
  ]
}

If the code is correct with no meaningful issues, return: {"comments":[]}

File: src/utils/retry.ts (new file, production code)
Diff:
${SAMPLE_DIFF}`;

async function main() {
	console.log("=== Codex CLI POC Test ===\n");

	// Step 1: Check codex binary
	try {
		const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
		console.log(`Codex CLI: ${version}`);
	} catch {
		console.error("ERROR: codex CLI not found. Install with: npm install -g @openai/codex");
		process.exit(1);
	}

	// Step 2: Set up auth
	console.log("\n--- Setting up auth ---");
	const auth = setupAuth();
	console.log(`Auth mode: ${auth.mode}`);

	// Step 3: Send review prompt via codex exec
	console.log("\n--- Sending review prompt via codex exec ---");
	const startTime = Date.now();

	try {
		const result = await sendCodexPrompt(REVIEW_PROMPT, {
			timeoutMs: 120_000,
			reasoningEffort: "low", // Fast for POC
		});

		const duration = ((Date.now() - startTime) / 1000).toFixed(1);
		console.log(`\nResponse received in ${duration}s`);
		console.log(`Response length: ${result.text.length} chars`);
		console.log(`Usage: ${JSON.stringify(result.usage)}`);
		console.log(`Events: ${result.events.length} total\n`);

		// Step 4: Parse JSON
		const jsonText = result.text
			.replace(/^```(?:json)?\s*\n?/m, "")
			.replace(/\n?```\s*$/m, "")
			.trim();

		try {
			const parsed = JSON.parse(jsonText);
			console.log("--- Parsed findings ---");
			console.log(`Comments: ${parsed.comments?.length ?? 0}`);
			for (const c of parsed.comments || []) {
				console.log(`  ${c.severity} [${c.category}] ${c.title} (line ${c.line})`);
				if (c.body) console.log(`    ${c.body.slice(0, 120)}...`);
			}
			console.log("\n✅ POC SUCCESS: codex exec works with structured JSON output");
		} catch (parseErr) {
			console.log("--- Raw response ---");
			console.log(result.text.slice(0, 1000));
			console.log("\n⚠️  POC PARTIAL: Got response but JSON parsing failed");
			console.log(`Parse error: ${parseErr.message}`);
		}
	} catch (err) {
		const duration = ((Date.now() - startTime) / 1000).toFixed(1);
		console.error(`\n❌ POC FAILED after ${duration}s: ${err.message}`);
		if (err.stack) console.error(err.stack);
		process.exit(1);
	}

	process.exit(0);
}

main();

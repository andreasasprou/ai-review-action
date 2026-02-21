#!/usr/bin/env node
// CI test script for the Codex POC.
//
// Simulates CI environment: reads CODEX_AUTH_JSON_B64 env var,
// writes auth.json, then runs a review prompt.
//
// Usage:
//   # macOS (from keychain):
//   CODEX_AUTH_JSON_B64="$(security find-generic-password -s 'Codex Auth' -w | base64 | tr -d '\n')" \
//     node poc/test-ci.mjs
//
//   # From existing auth.json file:
//   CODEX_AUTH_JSON_B64="$(base64 -i ~/.codex/auth.json | tr -d '\n')" \
//     node poc/test-ci.mjs

import { execFileSync } from "node:child_process";
import { setupAuth, sendCodexPrompt } from "./codex-review.mjs";

async function main() {
	console.log("=== Codex CI POC Test ===\n");

	const codexAuthB64 = process.env.CODEX_AUTH_JSON_B64 || "";
	if (!codexAuthB64) {
		console.error("ERROR: CODEX_AUTH_JSON_B64 env var not set.");
		console.error("Run with:");
		console.error('  CODEX_AUTH_JSON_B64="$(security find-generic-password -s \'Codex Auth\' -w | base64 | tr -d \'\\n\')" node poc/test-ci.mjs');
		process.exit(1);
	}

	// Step 1: Set up auth from base64 secret
	console.log("--- Setting up auth from CODEX_AUTH_JSON_B64 ---");
	const auth = setupAuth({ codexAuthB64 });
	console.log(`Auth mode: ${auth.mode}`);

	// Step 2: Verify codex login status
	try {
		const status = execFileSync("codex", ["login", "status"], { encoding: "utf8" }).trim();
		console.log(`Login status: ${status}`);
	} catch (err) {
		console.error(`Login check failed: ${err.message}`);
		process.exit(1);
	}

	// Step 3: Simple prompt to verify auth works
	console.log("\n--- Sending test prompt ---");
	const startTime = Date.now();

	try {
		const result = await sendCodexPrompt(
			'Respond with exactly this JSON: {"status":"ok","auth":"working"}',
			{
				timeoutMs: 60_000,
				reasoningEffort: "low",
			},
		);

		const duration = ((Date.now() - startTime) / 1000).toFixed(1);
		console.log(`Response in ${duration}s: ${result.text}`);

		const parsed = JSON.parse(result.text);
		if (parsed.status === "ok") {
			console.log("\n✅ CI AUTH TEST PASSED: Codex auth works from base64 secret");
		} else {
			console.log("\n⚠️  Unexpected response, but auth worked");
		}
	} catch (err) {
		const duration = ((Date.now() - startTime) / 1000).toFixed(1);
		console.error(`\n❌ CI AUTH TEST FAILED after ${duration}s: ${err.message}`);
		process.exit(1);
	}

	process.exit(0);
}

main();

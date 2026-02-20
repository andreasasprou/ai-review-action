// Auth setup for OpenCode SDK
// Standalone script — called by action.yml before the review runs.
//
// Supports three auth modes (priority order):
//   1. OPENCODE_AUTH_JSON_B64 — base64-encoded auth.json (for OpenCode users)
//   2. ANTHROPIC_API_KEY / OPENAI_API_KEY — direct provider keys (simplest)
//   3. Pre-existing auth.json — no-op if already configured

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const AUTH_DIR = path.join(os.homedir(), ".local", "share", "opencode");
const AUTH_PATH = path.join(AUTH_DIR, "auth.json");

function main() {
	const opencodeB64 = (process.env.INPUT_OPENCODE_AUTH_JSON_B64 || "").trim();
	const anthropicKey = (process.env.INPUT_ANTHROPIC_API_KEY || "").trim();
	const openaiKey = (process.env.INPUT_OPENAI_API_KEY || "").trim();

	// Mode 1: OpenCode auth.json (base64-encoded)
	if (opencodeB64) {
		let decoded;
		try {
			decoded = Buffer.from(opencodeB64, "base64").toString("utf8");
			JSON.parse(decoded); // validate JSON
		} catch (err) {
			console.error(
				"ERROR: OPENCODE_AUTH_JSON_B64 is not valid base64-encoded JSON.",
			);
			console.error(
				"Hint: base64 < ~/.local/share/opencode/auth.json | pbcopy",
			);
			process.exit(1);
		}

		fs.mkdirSync(AUTH_DIR, { recursive: true });
		fs.writeFileSync(AUTH_PATH, decoded, { mode: 0o600 });
		console.log("Auth: restored OpenCode auth.json from base64 secret");
		// Write mode indicator for main.mjs to detect
		fs.writeFileSync(
			path.join(AUTH_DIR, ".auth-mode"),
			"opencode",
			{ mode: 0o600 },
		);
		return;
	}

	// Mode 2: Direct API keys → construct auth.json
	if (anthropicKey || openaiKey) {
		const auth = {};
		if (anthropicKey) auth.anthropic = { apiKey: anthropicKey };
		if (openaiKey) auth.openai = { apiKey: openaiKey };

		fs.mkdirSync(AUTH_DIR, { recursive: true });
		fs.writeFileSync(AUTH_PATH, JSON.stringify(auth), { mode: 0o600 });

		const providers = Object.keys(auth).join(", ");
		console.log(`Auth: constructed auth.json from API keys (${providers})`);
		fs.writeFileSync(
			path.join(AUTH_DIR, ".auth-mode"),
			"api-keys",
			{ mode: 0o600 },
		);
		return;
	}

	// Mode 3: Pre-existing auth.json
	if (fs.existsSync(AUTH_PATH)) {
		console.log("Auth: using pre-existing auth.json");
		fs.writeFileSync(
			path.join(AUTH_DIR, ".auth-mode"),
			"pre-existing",
			{ mode: 0o600 },
		);
		return;
	}

	// No auth available
	console.error("ERROR: No authentication configured.");
	console.error("Provide one of:");
	console.error("  - openai-api-key: ${{ secrets.OPENAI_API_KEY }}");
	console.error("  - anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}");
	console.error(
		"  - opencode-auth-json-b64: ${{ secrets.OPENCODE_AUTH_JSON_B64 }}",
	);
	process.exit(1);
}

main();

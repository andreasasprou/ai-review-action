// Auth setup for Codex CLI.
// Standalone script — called by action.yml before the review runs.
//
// Supports two auth modes (priority order):
//   1. CODEX_AUTH_JSON_B64 — base64-encoded auth.json from Codex keychain (ChatGPT OAuth)
//   2. OPENAI_API_KEY — direct OpenAI API key (written to auth.json)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const AUTH_PATH = path.join(CODEX_HOME, "auth.json");
const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");

function main() {
	const codexB64 = (process.env.INPUT_CODEX_AUTH_JSON_B64 || "").trim();
	const openaiKey = (process.env.INPUT_OPENAI_API_KEY || "").trim();

	// Mode 1: Codex auth.json (base64-encoded ChatGPT OAuth tokens)
	if (codexB64) {
		let decoded;
		try {
			decoded = Buffer.from(codexB64, "base64").toString("utf8");
			JSON.parse(decoded); // validate JSON
		} catch (err) {
			console.error(
				"ERROR: CODEX_AUTH_JSON_B64 is not valid base64-encoded JSON.",
			);
			console.error(
				'Hint: security find-generic-password -s "Codex Auth" -w | base64 | tr -d "\\n"',
			);
			process.exit(1);
		}

		fs.mkdirSync(CODEX_HOME, { recursive: true });
		fs.writeFileSync(AUTH_PATH, decoded, { mode: 0o600 });
		ensureFileAuthStore();
		console.log("Auth: restored Codex auth.json from base64 secret (ChatGPT OAuth)");
		return;
	}

	// Mode 2: Direct OpenAI API key → construct auth.json
	if (openaiKey) {
		const auth = { OPENAI_API_KEY: openaiKey };
		fs.mkdirSync(CODEX_HOME, { recursive: true });
		fs.writeFileSync(AUTH_PATH, JSON.stringify(auth), { mode: 0o600 });
		ensureFileAuthStore();
		console.log("Auth: constructed auth.json from OPENAI_API_KEY");
		return;
	}

	// Mode 3: Pre-existing auth.json
	if (fs.existsSync(AUTH_PATH)) {
		console.log("Auth: using pre-existing ~/.codex/auth.json");
		return;
	}

	// No auth available
	console.error("ERROR: No authentication configured.");
	console.error("Provide one of:");
	console.error("  - codex-auth-json-b64: base64-encoded Codex auth (ChatGPT OAuth)");
	console.error("  - openai-api-key: OpenAI API key");
	process.exit(1);
}

/**
 * Ensure config.toml uses file-based auth store (not keyring, which
 * doesn't exist on Linux CI runners).
 */
function ensureFileAuthStore() {
	fs.mkdirSync(CODEX_HOME, { recursive: true });

	let config = "";
	if (fs.existsSync(CONFIG_PATH)) {
		config = fs.readFileSync(CONFIG_PATH, "utf8");
	}

	if (config.includes('cli_auth_credentials_store = "file"')) return;

	if (config.includes("cli_auth_credentials_store")) {
		config = config.replace(
			/cli_auth_credentials_store\s*=\s*"[^"]*"/,
			'cli_auth_credentials_store = "file"',
		);
	} else {
		config = `cli_auth_credentials_store = "file"\n${config}`;
	}

	fs.writeFileSync(CONFIG_PATH, config, { mode: 0o600 });
}

main();

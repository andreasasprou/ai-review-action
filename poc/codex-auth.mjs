// Auth setup for Codex SDK in CI.
//
// Supports two auth modes:
//   1. CODEX_AUTH_JSON_B64 — base64-encoded auth.json from keychain (ChatGPT OAuth)
//   2. OPENAI_API_KEY — direct API key
//
// For ChatGPT OAuth (codex auth), extract the secret with:
//   gh secret set CODEX_AUTH_JSON_B64 --body "$(security find-generic-password -s 'Codex Auth' -w | base64 | tr -d '\n')"

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const AUTH_PATH = path.join(CODEX_HOME, "auth.json");
const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");

/**
 * Set up Codex auth for CI. Returns the auth mode used.
 * @param {object} opts
 * @param {string} [opts.codexAuthB64] — base64-encoded auth.json (ChatGPT OAuth)
 * @param {string} [opts.openaiApiKey] — direct OpenAI API key
 * @returns {{ mode: 'chatgpt' | 'api-key' | 'none', apiKey?: string }}
 */
export function setupCodexAuth(opts = {}) {
	const codexAuthB64 = opts.codexAuthB64 || process.env.INPUT_CODEX_AUTH_JSON_B64 || "";
	const openaiApiKey = opts.openaiApiKey || process.env.INPUT_OPENAI_API_KEY || "";

	// Mode 1: ChatGPT OAuth tokens (base64-encoded auth.json)
	if (codexAuthB64.trim()) {
		let decoded;
		try {
			decoded = Buffer.from(codexAuthB64.trim(), "base64").toString("utf8");
			JSON.parse(decoded); // validate JSON
		} catch (err) {
			console.error("ERROR: CODEX_AUTH_JSON_B64 is not valid base64-encoded JSON.");
			console.error('Hint: security find-generic-password -s "Codex Auth" -w | base64 | tr -d "\\n"');
			process.exit(1);
		}

		// Write auth.json
		fs.mkdirSync(CODEX_HOME, { recursive: true });
		fs.writeFileSync(AUTH_PATH, decoded, { mode: 0o600 });

		// Ensure config.toml uses file-based auth (not keyring, which doesn't exist in CI)
		ensureFileAuthStore();

		console.log("Codex auth: wrote ChatGPT OAuth tokens to ~/.codex/auth.json");
		return { mode: "chatgpt" };
	}

	// Mode 2: Direct OpenAI API key
	if (openaiApiKey.trim()) {
		console.log("Codex auth: using OPENAI_API_KEY (passed via SDK apiKey option)");
		return { mode: "api-key", apiKey: openaiApiKey.trim() };
	}

	// Mode 3: Pre-existing auth (file or keychain)
	// On macOS, codex stores auth in keychain by default.
	// On Linux CI, it uses ~/.codex/auth.json.
	// Check if `codex login status` succeeds to detect any valid auth.
	if (fs.existsSync(AUTH_PATH)) {
		console.log("Codex auth: using pre-existing ~/.codex/auth.json");
		return { mode: "chatgpt" };
	}

	// Try keychain-based auth (macOS) — `codex login status` returns 0 if authenticated
	try {
		execFileSync("codex", ["login", "status"], { encoding: "utf8", stdio: "pipe" });
		console.log("Codex auth: using existing keychain credentials");
		return { mode: "keychain" };
	} catch {
		// codex login status failed — no auth available
	}

	console.error("ERROR: No Codex authentication configured.");
	console.error("Provide one of:");
	console.error("  - codex-auth-json-b64: base64-encoded ChatGPT OAuth tokens");
	console.error("  - openai-api-key: OpenAI API key");
	process.exit(1);
}

/**
 * Ensure config.toml has cli_auth_credentials_store = "file"
 * so Codex reads from auth.json instead of trying the keyring.
 */
function ensureFileAuthStore() {
	fs.mkdirSync(CODEX_HOME, { recursive: true });

	let config = "";
	if (fs.existsSync(CONFIG_PATH)) {
		config = fs.readFileSync(CONFIG_PATH, "utf8");
	}

	// If already set to file, skip
	if (config.includes('cli_auth_credentials_store = "file"')) return;

	// Replace existing setting or append
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

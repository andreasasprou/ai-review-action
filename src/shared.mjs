// Shared utilities for AI review orchestration.
// Codex CLI subprocess management, GitHub API, retry logic.

import fs from "node:fs";
import { spawn } from "node:child_process";

// ── Retry helper ─────────────────────────────────────────────────────────────

/**
 * Retry an async function on transient errors with exponential backoff.
 */
export async function withRetry(fn, opts = {}) {
	const { maxAttempts = 3, baseDelayMs = 2000, isRetryable } = opts;
	let lastError;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn(attempt);
		} catch (err) {
			lastError = err;
			const retryable = isRetryable
				? isRetryable(err)
				: isTransientError(err);
			if (!retryable || attempt >= maxAttempts) throw err;
			const delay = baseDelayMs * 2 ** (attempt - 1);
			console.log(
				`  [RETRY] Attempt ${attempt}/${maxAttempts} failed: ${err.message}. Retrying in ${delay / 1000}s...`,
			);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	throw lastError;
}

function isTransientError(err) {
	const msg = err?.message || "";
	return (
		msg.includes("timed out") ||
		msg.includes("Codex exec failed") ||
		msg.includes("ECONNRESET") ||
		msg.includes("ECONNREFUSED") ||
		msg.includes("ETIMEDOUT")
	);
}

// ── GitHub API helper ────────────────────────────────────────────────────────

/**
 * Thin fetch wrapper for GitHub REST API.
 * Supports GitHub Enterprise Server via GITHUB_API_URL env var.
 */
export async function ghApi(token, path, method = "GET", body) {
	const baseUrl =
		process.env.GITHUB_API_URL || "https://api.github.com";
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`GitHub API ${method} ${path} failed: ${response.status} ${text}`,
		);
	}
	return text ? JSON.parse(text) : null;
}

// ── Model parsing ────────────────────────────────────────────────────────────

/**
 * Parse "provider/model" string into { providerID, modelID }.
 * Falls back to "openai" if no slash present.
 */
export function parseProviderModel(model) {
	const idx = model.indexOf("/");
	if (idx === -1) return { providerID: "openai", modelID: model };
	return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

// ── Codex CLI subprocess ─────────────────────────────────────────────────────

/**
 * Send a prompt to Codex via `codex exec --json` and collect the response.
 *
 * Spawns a subprocess that outputs JSONL events on stdout. Extracts
 * agent_message text and returns it as a string.
 *
 * @param {string} prompt — The review prompt
 * @param {object} [opts]
 * @param {string} [opts.model] — Model name (e.g. "gpt-5.2")
 * @param {string} [opts.workingDirectory] — Working directory for codex
 * @param {number} [opts.timeoutMs] — Timeout in ms (default: 300s)
 * @param {string} [opts.reasoningEffort] — Reasoning effort level
 * @returns {Promise<string>} — The agent response text
 */
export async function sendCodexPrompt(prompt, opts = {}) {
	const {
		model,
		workingDirectory,
		timeoutMs = 300_000,
		reasoningEffort,
	} = opts;

	const args = [
		"exec",
		"--json",
		"--full-auto",
		"--ephemeral",
		"-c", 'sandbox_mode="read-only"',
	];

	if (reasoningEffort) {
		args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
	}

	if (model) {
		args.push("-m", model);
	}

	args.push(prompt);

	return new Promise((resolve, reject) => {
		const child = spawn("codex", args, {
			cwd: workingDirectory || process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		let stdout = "";
		let stderr = "";
		let agentText = "";

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`sendCodexPrompt timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			const lines = stdout.split("\n");
			stdout = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (event.type === "item.completed" && event.item?.type === "agent_message") {
						agentText += (agentText ? "\n" : "") + event.item.text;
					}
				} catch {
					// Ignore non-JSON lines
				}
			}
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("close", (code) => {
			clearTimeout(timer);

			// Parse any remaining stdout
			if (stdout.trim()) {
				try {
					const event = JSON.parse(stdout.trim());
					if (event.type === "item.completed" && event.item?.type === "agent_message") {
						agentText += (agentText ? "\n" : "") + event.item.text;
					}
				} catch {}
			}

			if (code !== 0 && !agentText) {
				reject(new Error(`Codex exec failed (exit ${code}): ${stderr.slice(0, 500)}`));
				return;
			}

			resolve(agentText);
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});

		child.stdin.end();
	});
}

// ── State management ─────────────────────────────────────────────────────────

/**
 * Load previous review state from a JSON file.
 */
export function loadPreviousState(filePath) {
	try {
		const raw = fs.readFileSync(filePath, "utf8").trim();
		if (!raw) return {};
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

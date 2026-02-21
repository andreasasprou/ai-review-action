// POC: Use Codex CLI (`codex exec`) for code review with ChatGPT OAuth auth.
//
// This replaces the OpenCode SDK approach (server + SSE) with
// Codex CLI (subprocess + JSONL), which is simpler and supports
// ChatGPT OAuth tokens natively.

import { spawn } from "node:child_process";
import { setupCodexAuth } from "./codex-auth.mjs";

/**
 * Set up auth and return the auth mode.
 * @param {object} opts
 * @param {string} [opts.codexAuthB64] — base64-encoded auth.json
 * @param {string} [opts.openaiApiKey] — direct API key
 * @returns {{ mode: string }}
 */
export function setupAuth(opts = {}) {
	return setupCodexAuth(opts);
}

/**
 * Send a review prompt to Codex via `codex exec --json` and collect the response.
 *
 * @param {string} prompt — The review prompt
 * @param {object} [opts]
 * @param {string} [opts.model] — Model to use (overrides config.toml)
 * @param {string} [opts.workingDirectory] — Working directory
 * @param {number} [opts.timeoutMs] — Timeout in milliseconds (default: 300s)
 * @param {string} [opts.reasoningEffort] — Reasoning effort (default: "low")
 * @returns {Promise<{ text: string, usage: object, events: object[] }>}
 */
export async function sendCodexPrompt(prompt, opts = {}) {
	const {
		model,
		workingDirectory,
		timeoutMs = 300_000,
		reasoningEffort = "low",
	} = opts;

	const args = [
		"exec",
		"--json",
		"--full-auto",
		"--ephemeral",
		"-c", `sandbox_mode="read-only"`,
		"-c", `model_reasoning_effort="${reasoningEffort}"`,
	];

	if (model) {
		args.push("-m", model);
	}

	// Pass prompt as argument
	args.push(prompt);

	return new Promise((resolve, reject) => {
		const child = spawn("codex", args, {
			cwd: workingDirectory || process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		let stdout = "";
		let stderr = "";
		const events = [];
		let agentText = "";
		let usage = {};

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`Codex prompt timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();

			// Parse JSONL events as they arrive
			const lines = stdout.split("\n");
			stdout = lines.pop() || ""; // Keep incomplete line in buffer

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					events.push(event);

					// Collect agent messages
					if (event.type === "item.completed" && event.item?.type === "agent_message") {
						agentText += (agentText ? "\n" : "") + event.item.text;
					}

					// Collect usage
					if (event.type === "turn.completed" && event.usage) {
						usage = {
							...usage,
							input_tokens: (usage.input_tokens || 0) + (event.usage.input_tokens || 0),
							output_tokens: (usage.output_tokens || 0) + (event.usage.output_tokens || 0),
							cached_input_tokens: (usage.cached_input_tokens || 0) + (event.usage.cached_input_tokens || 0),
						};
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
					events.push(event);
					if (event.type === "item.completed" && event.item?.type === "agent_message") {
						agentText += (agentText ? "\n" : "") + event.item.text;
					}
					if (event.type === "turn.completed" && event.usage) {
						usage = {
							...usage,
							input_tokens: (usage.input_tokens || 0) + (event.usage.input_tokens || 0),
							output_tokens: (usage.output_tokens || 0) + (event.usage.output_tokens || 0),
						};
					}
				} catch {}
			}

			if (code !== 0 && !agentText) {
				reject(new Error(`Codex exec failed (exit ${code}): ${stderr.slice(0, 500)}`));
				return;
			}

			resolve({ text: agentText, usage, events });
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});

		// Close stdin immediately — prompt is passed as argument
		child.stdin.end();
	});
}

// Shared utilities for AI review orchestration.
// OpenCode SDK lifecycle, GitHub API, SSE response collection, retry logic.

import fs from "node:fs";
import { createOpencode } from "@opencode-ai/sdk";

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
				: isTransientFetchError(err);
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

function isTransientFetchError(err) {
	const msg = err?.message || "";
	const causeCode = err?.cause?.code || "";
	return (
		msg.includes("fetch failed") ||
		msg.includes("sendPromptAndCollect timed out") ||
		causeCode === "UND_ERR_HEADERS_TIMEOUT" ||
		causeCode === "ECONNRESET" ||
		causeCode === "ECONNREFUSED" ||
		causeCode === "UND_ERR_SOCKET" ||
		causeCode === "ETIMEDOUT"
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

// ── OpenCode server lifecycle ────────────────────────────────────────────────

/**
 * Start an OpenCode server with the given model and permission overrides.
 */
export async function startOpencode(model, permissions) {
	return createOpencode({
		timeout: 30_000,
		config: {
			model,
			permission: permissions || {
				"*": "deny",
				read: "allow",
				grep: "allow",
				glob: "allow",
				list: "allow",
			},
		},
	});
}

// ── SSE response collection ──────────────────────────────────────────────────

/**
 * Send a prompt to an OpenCode session and collect the full response via SSE.
 *
 * OpenCode's session.prompt() is fire-and-forget (HTTP 200 with empty body).
 * We listen to the SSE event stream for:
 *   - message.part.updated → { part: { text: "full accumulated text" } }
 *   - session.error → throw
 *   - session.idle → return collected text
 */
export async function sendPromptAndCollect(
	opencode,
	sessionId,
	promptText,
	model,
	timeoutMs = 300_000,
	{ onEvent } = {},
) {
	const serverUrl = opencode.server.url;
	const ac = new AbortController();

	// Start the timeout IMMEDIATELY so it covers SSE connect, prompt POST,
	// AND the response-wait phase. Previously the timer was set only after
	// both fetches succeeded, so a hanging fetch would block indefinitely.
	const timer = setTimeout(() => {
		console.log(
			`  [TIMEOUT] sendPromptAndCollect timed out after ${timeoutMs / 1000}s`,
		);
		ac.abort();
	}, timeoutMs);

	let reader;
	try {
		// Set up SSE event stream
		const eventUrl = `${serverUrl}/event`;
		const sseResp = await fetch(eventUrl, {
			headers: { Accept: "text/event-stream" },
			signal: ac.signal,
		});
		if (!sseResp.ok || !sseResp.body) {
			throw new Error(`SSE connect failed: ${sseResp.status}`);
		}

		// Send the prompt — include abort signal so a timeout can cancel it
		const promptResp = await fetch(
			`${serverUrl}/session/${sessionId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: ac.signal,
				body: JSON.stringify({
					model: model
						? { providerID: model.providerID, modelID: model.modelID }
						: undefined,
					parts: [{ type: "text", text: promptText }],
				}),
			},
		);
		if (!promptResp.ok) {
			const body = await promptResp.text();
			throw new Error(`Prompt send failed: ${promptResp.status} ${body}`);
		}

		// Read SSE events until session.idle.
		// Track the latest accumulated text from message.part.updated and
		// return it when session.idle fires. This is simpler and more reliable
		// than concatenating deltas (which can duplicate on retransmit).
		let latestPartText = "";
		let eventCount = 0;
		reader = sseResp.body.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += value;
			const chunks = buffer.split("\n\n");
			buffer = chunks.pop() ?? "";

			for (const chunk of chunks) {
				const lines = chunk.split("\n");
				const dataLines = [];
				for (const line of lines) {
					if (line.startsWith("data:")) {
						dataLines.push(line.replace(/^data:\s*/, ""));
					}
				}
				if (!dataLines.length) continue;
				let event;
				try {
					event = JSON.parse(dataLines.join("\n"));
				} catch {
					continue;
				}

				eventCount++;
				if (process.env.DEBUG_OPENCODE) {
					const sid = event.properties?.sessionID || "";
					console.log(
						`  [SSE] #${eventCount} ${event.type} (session=${sid.slice(0, 12)}...)`,
					);
				}

				if (onEvent) {
					try {
						onEvent(event);
					} catch (callbackErr) {
						if (process.env.DEBUG_OPENCODE) {
							console.log(
								`  [SSE] onEvent callback error: ${callbackErr.message}`,
							);
						}
					}
				}

				if (
					event.type === "message.part.updated" &&
					event.properties?.part?.text
				) {
					latestPartText = event.properties.part.text;
				}

				if (
					event.type === "session.error" &&
					event.properties?.sessionID === sessionId
				) {
					const errMsg =
						typeof event.properties?.error === "string"
							? event.properties.error
							: JSON.stringify(event.properties?.error ?? event.properties);
					throw new Error(`OpenCode session error: ${errMsg}`);
				}

				if (
					event.type === "session.idle" &&
					event.properties?.sessionID === sessionId
				) {
					if (process.env.DEBUG_OPENCODE) {
						console.log(
							`  [SSE] session.idle, response length: ${latestPartText.length}`,
						);
					}
					return latestPartText;
				}
			}
		}

		return latestPartText;
	} catch (err) {
		// Convert AbortError from our timeout into a descriptive error
		// so callers (withRetry) see a meaningful message.
		if (err.name === "AbortError") {
			throw new Error(
				`sendPromptAndCollect timed out after ${timeoutMs / 1000}s`,
			);
		}
		throw err;
	} finally {
		// Always clean up: cancel the timer, abort the SSE stream, release
		// the reader. This prevents SSE connection leaks when the prompt
		// POST fails or the function throws for any reason.
		clearTimeout(timer);
		ac.abort();
		try {
			reader?.releaseLock();
		} catch {}
	}
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

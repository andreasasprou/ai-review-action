// Per-file code review orchestrator.
// Sends each file's diff to the model, collects structured findings,
// posts inline PR comments, and updates the dashboard after each file.

import { execFileSync } from "node:child_process";
import { createClassifier } from "./classify.mjs";
import { updateDashboardAgent } from "./dashboard.mjs";
import { buildFilePrompt, buildSystemPrompt } from "./prompts.mjs";
import {
	ghApi,
	parseProviderModel,
	sendPromptAndCollect,
	startOpencode,
	withRetry,
} from "./shared.mjs";

// ── Diff parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a git diff patch into:
 * - `numbered`: text with RIGHT-side line numbers (for the model to cite)
 * - `commentable`: Set<number> of RIGHT-side lines GitHub accepts for inline comments
 */
function buildNumberedRightDiff(patchText) {
	let rightLine = null;
	const commentable = new Set();
	const out = [];

	for (const rawLine of patchText.split("\n")) {
		const hunk = rawLine.match(
			/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/,
		);
		if (hunk) {
			rightLine = Number(hunk[1]);
			out.push(rawLine);
			continue;
		}

		if (rightLine == null) {
			out.push(rawLine);
			continue;
		}

		if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
			out.push(`${rightLine} | ${rawLine}`);
			commentable.add(rightLine);
			rightLine += 1;
			continue;
		}

		if (rawLine.startsWith(" ") || rawLine === "") {
			out.push(`${rightLine} | ${rawLine}`);
			commentable.add(rightLine);
			rightLine += 1;
			continue;
		}

		if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
			out.push(`- | ${rawLine}`);
			continue;
		}

		out.push(rawLine);
	}

	return { numbered: out.join("\n"), commentable };
}

/**
 * Find the nearest commentable line to `target`.
 * Returns null if commentable set is empty.
 */
function nearestLine(target, commentable) {
	if (commentable.has(target)) return target;
	let best = null;
	let bestDist = Infinity;
	for (const n of commentable) {
		const d = Math.abs(n - target);
		if (d < bestDist) {
			bestDist = d;
			best = n;
		}
	}
	return best;
}

// ── Main review function ────────────────────────────────────────────────────

/**
 * Run the per-file code review.
 * @param {object} ctx - Review context
 * @param {string} ctx.token - GitHub token
 * @param {string} ctx.owner - Repo owner
 * @param {string} ctx.repo - Repo name
 * @param {number} ctx.prNumber - PR number
 * @param {string} ctx.headSha - Head commit SHA
 * @param {string} ctx.diffBaseSha - Diff base SHA
 * @param {string} ctx.model - Model string (provider/model)
 * @param {string} ctx.prTitle - PR title
 * @param {string} ctx.prBody - PR body
 * @param {string} ctx.workflowRunUrl - Workflow run URL
 * @param {string} ctx.dashboardCommentId - Dashboard comment ID
 * @param {string} ctx.guidelinesContent - Loaded context files content
 * @param {string[]} ctx.changedFiles - List of changed file paths
 * @param {object} ctx.previousState - Previous review state
 * @param {object} ctx.config - Review config
 * @returns {Promise<{verdict: string, totalFindings: number, allFindings: Array, reviewedFiles: string[], fileResults: object, reviewCapped: boolean, duration: number}>}
 */
export async function runReview(ctx) {
	const {
		token,
		owner,
		repo,
		prNumber,
		headSha,
		diffBaseSha,
		model,
		prTitle,
		prBody,
		workflowRunUrl,
		dashboardCommentId,
		guidelinesContent,
		changedFiles,
		previousState,
		config,
		sdkConfig,
	} = ctx;

	const { providerID, modelID } = parseProviderModel(model);
	const classify = createClassifier(config);

	// Agent key for dashboard namespace isolation
	const modelShort = model.split("/").pop() || model;
	const AGENT_KEY = `codex:${modelShort}`;

	const maxFindings = config.review?.max_findings_per_file || 3;
	const MAX_TOTAL_FINDINGS = config.review?.max_total_findings || 15;
	const MAX_COMMENTABLE_LINES = 1500;
	const PER_PROMPT_TIMEOUT_MS = 90_000; // 90 seconds per LLM call
	const MAX_RETRY_ATTEMPTS = 2;
	const MAX_CONSECUTIVE_FAILURES = 3;
	// Leave 4 minutes for cleanup, dashboard update, and post-step
	const RUNTIME_BUDGET_MS = 16 * 60 * 1000;

	const state = previousState || {};

	console.log(`Starting review for PR #${prNumber}`);
	console.log(`Model: ${model} (${providerID}/${modelID})`);
	console.log(`Diff: ${diffBaseSha.slice(0, 8)}..${headSha.slice(0, 8)}`);

	// ── Dashboard init ──
	if (dashboardCommentId) {
		try {
			await updateDashboardAgent({
				token,
				owner,
				repo,
				prNumber,
				commentId: dashboardCommentId,
				agentKey: AGENT_KEY,
				updater: () => ({
					status: "running",
					model,
					last_reviewed_head_sha: state.last_reviewed_head_sha || "",
					started_at: new Date().toISOString(),
					workflow_run_url: workflowRunUrl || "",
					progress: {
						total_files: 0,
						completed_files: 0,
						reviewed_files: [],
						file_results: {},
					},
				}),
				config,
			});
			console.log(`Dashboard initialized (comment ${dashboardCommentId})`);
		} catch (err) {
			console.log(`Dashboard init failed (non-fatal): ${err.message}`);
		}
	}

	const startTime = Date.now();
	const opencode = await startOpencode(model, undefined, sdkConfig);

	try {
		// ── Session management ──
		const created = await opencode.client.session.create({
			body: { title: `PR #${prNumber} Review (${model})` },
		});
		const sessionId = created.data.id;
		console.log(`Created session ${sessionId}`);

		// ── Inject system context (noReply) ──
		const systemPrompt = buildSystemPrompt({
			prNumber,
			prTitle,
			prBody,
			headSha,
			diffBaseSha,
			openIssues: state.open_issues,
			guidelinesContent,
			config,
		});

		await opencode.client.session.prompt({
			path: { id: sessionId },
			body: {
				noReply: true,
				parts: [{ type: "text", text: systemPrompt }],
			},
		});

		// ── Build file list and inject cross-file context ──
		// Resume support: skip files already reviewed for the same head SHA
		const alreadyReviewed = new Set(
			state.in_progress?.head_sha === headSha
				? state.in_progress?.reviewed_files || []
				: [],
		);

		const reviewableFiles = changedFiles.filter(
			(f) => classify(f) !== "skip",
		);
		const fileListText = reviewableFiles
			.map((f) => `- ${f} (${classify(f)})`)
			.join("\n");

		await opencode.client.session.prompt({
			path: { id: sessionId },
			body: {
				noReply: true,
				parts: [
					{
						type: "text",
						text: [
							`## Files in this PR:`,
							fileListText,
							``,
							`When reviewing individual files, remember that changes in one file`,
							`may be complemented by changes in other files. Do not flag issues`,
							`that are addressed by other changed files in this PR.`,
						].join("\n"),
					},
				],
			},
		});

		// Update dashboard with total file count
		if (dashboardCommentId) {
			try {
				await updateDashboardAgent({
					token,
					owner,
					repo,
					prNumber,
					commentId: dashboardCommentId,
					agentKey: AGENT_KEY,
					updater: (current) => ({
						...current,
						progress: {
							...current.progress,
							total_files: changedFiles.length,
							completed_files: alreadyReviewed.size,
							reviewed_files: [...alreadyReviewed],
						},
					}),
					config,
				});
			} catch (err) {
				console.log(`Dashboard update failed (non-fatal): ${err.message}`);
			}
		}

		let totalFindings = 0;
		let consecutiveFailures = 0;
		let reviewCapped = false;
		const allFindings = [];
		const reviewedFiles = [...alreadyReviewed];
		const fileResults = {};

		// Prioritize: production code first, then relaxed (tests/scripts/config).
		// This ensures the runtime budget is spent on the most important files.
		const prioritized = [...changedFiles].sort((a, b) => {
			const priority = { standard: 0, relaxed: 1, skip: 2 };
			return (
				(priority[classify(a)] ?? 2) - (priority[classify(b)] ?? 2)
			);
		});

		for (const file of prioritized) {
			if (alreadyReviewed.has(file)) {
				console.log(`Skipping ${file} (already reviewed in checkpoint)`);
				continue;
			}

			const fileClass = classify(file);
			if (fileClass === "skip") {
				console.log(`Skipping ${file} (non-reviewable file type)`);
				reviewedFiles.push(file);
				fileResults[file] = { status: "skipped", findings_count: 0 };
				continue;
			}

			// Generate per-file diff
			let patch;
			try {
				patch = execFileSync(
					"git",
					["diff", `${diffBaseSha}..${headSha}`, "--", file],
					{ encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
				);
			} catch (err) {
				console.log(`Failed to get diff for ${file}: ${err.message}`);
				continue;
			}

			if (!patch.trim()) {
				reviewedFiles.push(file);
				fileResults[file] = { status: "clean", findings_count: 0 };
				continue;
			}

			const { numbered, commentable } = buildNumberedRightDiff(patch);

			// Skip files with very large diffs — they consume too much LLM time
			// and are typically refactors/moves where line-by-line review adds little value.
			if (commentable.size > MAX_COMMENTABLE_LINES) {
				console.log(
					`Skipping ${file} (${commentable.size} commentable lines exceeds ${MAX_COMMENTABLE_LINES} cap)`,
				);
				reviewedFiles.push(file);
				fileResults[file] = {
					status: "skipped_large",
					findings_count: 0,
				};
				continue;
			}

			// Runtime budget check — exit gracefully before the hard timeout kills us
			if (Date.now() - startTime > RUNTIME_BUDGET_MS) {
				console.log(
					`Runtime budget exhausted (${Math.round((Date.now() - startTime) / 1000)}s), stopping review`,
				);
				reviewCapped = true;
				break;
			}

			console.log(
				`Reviewing ${file} (${commentable.size} commentable lines)...`,
			);

			// Update dashboard: current file
			if (dashboardCommentId) {
				try {
					await updateDashboardAgent({
						token,
						owner,
						repo,
						prNumber,
						commentId: dashboardCommentId,
						agentKey: AGENT_KEY,
						updater: (current) => ({
							...current,
							progress: {
								...current.progress,
								current_file: file,
							},
						}),
						config,
					});
				} catch (err) {
					console.log(
						`Dashboard progress update failed (non-fatal): ${err.message}`,
					);
				}
			}

			const prompt = buildFilePrompt({
				file,
				fileClass,
				numberedDiff: numbered,
				maxFindings,
			});

			let structured = { comments: [] };
			let promptSucceeded = false;
			try {
				const responseText = await withRetry(
					() =>
						sendPromptAndCollect(
							opencode,
							sessionId,
							prompt,
							{ providerID, modelID },
							PER_PROMPT_TIMEOUT_MS,
						),
					{ maxAttempts: MAX_RETRY_ATTEMPTS, baseDelayMs: 3000 },
				);

				// Transport succeeded — reset circuit breaker regardless of parse outcome
				promptSucceeded = true;
				consecutiveFailures = 0;

				if (process.env.DEBUG_OPENCODE) {
					console.log(
						`  [DEBUG] response text (first 500): ${responseText.slice(0, 500)}`,
					);
				}

				// Parse JSON from the response (strip markdown fences if present)
				const jsonText = responseText
					.replace(/^```(?:json)?\s*\n?/m, "")
					.replace(/\n?```\s*$/m, "")
					.trim();
				if (jsonText) {
					structured = JSON.parse(jsonText);
				}
			} catch (err) {
				console.log(`Model prompt failed for ${file}: ${err.message}`);
				if (!promptSucceeded) {
					// Only count transport/fetch failures toward the circuit breaker,
					// not JSON parse errors from a successful but malformed response.
					consecutiveFailures++;
					if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
						console.log(
							`${MAX_CONSECUTIVE_FAILURES} consecutive transport failures — OpenCode server likely unhealthy, stopping review`,
						);
						reviewCapped = true;
						break;
					}
					// Don't record the file as reviewed — it wasn't.
					// This allows resume runs to re-attempt it.
					fileResults[file] = {
						status: "failed",
						findings_count: 0,
					};
					continue;
				}
			}

			// Severity safety net for relaxed files
			if (fileClass === "relaxed") {
				for (const c of structured.comments || []) {
					const cat = (c.category || "").trim().toLowerCase();
					if (
						(c.severity === "P0" || c.severity === "P1") &&
						cat !== "security"
					) {
						console.log(
							`  [PROMPT-QUALITY] Capping ${c.severity} to P2 for relaxed file ${file} (${c.category}: "${c.title}")`,
						);
						c.severity = "P2";
					}
				}
			}

			// Post inline comments
			let fileFindingsCount = 0;
			for (const c of structured.comments || []) {
				if (c.path !== file) c.path = file;

				const severity_emoji = {
					P0: "\u{1F534}",
					P1: "\u{1F7E0}",
					P2: "\u{1F7E1}",
				};
				const emoji = severity_emoji[c.severity] || "";
				const commentBody = [
					`${emoji} **${c.severity} - ${c.category}**: ${c.title}`,
					``,
					c.body,
					``,
					`---`,
					`<sub>${modelShort}</sub>`,
				].join("\n");

				try {
					const anchor =
						c.subject_type !== "file" && c.line
							? nearestLine(Number(c.line), commentable)
							: null;

					const payload = {
						commit_id: headSha,
						path: file,
						body: commentBody,
					};
					if (anchor) {
						payload.side = "RIGHT";
						payload.line = anchor;
					} else {
						payload.subject_type = "file";
					}

					await ghApi(
						token,
						`/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
						"POST",
						payload,
					);

					totalFindings++;
					fileFindingsCount++;
					allFindings.push({
						severity: c.severity,
						category: c.category,
						title: c.title,
						path: file,
					});
					console.log(
						`  Posted ${c.severity} finding on ${file}:${anchor || "file-level"}`,
					);
				} catch (err) {
					console.log(`  Failed to post comment on ${file}: ${err.message}`);
				}
			}

			// Record file result and update dashboard
			reviewedFiles.push(file);
			fileResults[file] = {
				status: fileFindingsCount > 0 ? "issues" : "clean",
				findings_count: fileFindingsCount,
			};

			if (dashboardCommentId) {
				try {
					await updateDashboardAgent({
						token,
						owner,
						repo,
						prNumber,
						commentId: dashboardCommentId,
						agentKey: AGENT_KEY,
						updater: (current) => ({
							...current,
							progress: {
								...current.progress,
								completed_files: reviewedFiles.length,
								current_file: null,
								reviewed_files: reviewedFiles,
								file_results: fileResults,
							},
						}),
						config,
					});
				} catch (err) {
					console.log(
						`Dashboard checkpoint failed (non-fatal): ${err.message}`,
					);
				}
			}

			// Global finding cap
			if (totalFindings >= MAX_TOTAL_FINDINGS) {
				console.log(
					`Global finding cap reached (${MAX_TOTAL_FINDINGS}), stopping review`,
				);
				reviewCapped = true;
				break;
			}
		}

		// ── Run complete ──
		const duration = Math.round((Date.now() - startTime) / 1000);

		// Count files that were actually sent to the LLM and got a response
		const filesActuallyReviewed = Object.values(fileResults).filter(
			(r) => r.status === "clean" || r.status === "issues",
		).length;

		const hasP0 = allFindings.some((f) => f.severity === "P0");
		const hasP1 = allFindings.some((f) => f.severity === "P1");

		// If the review was cut short and zero files were actually reviewed
		// (e.g., circuit breaker tripped immediately), that's an error — not a clean bill.
		let verdict;
		if (reviewCapped && filesActuallyReviewed === 0) {
			verdict = "ERROR";
		} else if (hasP0) {
			verdict = "BLOCK";
		} else if (hasP1) {
			verdict = "ATTENTION";
		} else {
			verdict = "OK";
		}

		// Build open_issues for dashboard state
		const openIssues = allFindings.map((f, i) => ({
			id: `finding-${headSha.slice(0, 8)}-${i}`,
			severity: f.severity,
			title: `${f.category}: ${f.title}`,
			location: f.path,
			status: "open",
			first_seen_head_sha: headSha,
			last_seen_head_sha: headSha,
		}));

		// Final dashboard update: mark completed
		if (dashboardCommentId) {
			try {
				await updateDashboardAgent({
					token,
					owner,
					repo,
					prNumber,
					commentId: dashboardCommentId,
					agentKey: AGENT_KEY,
					updater: (current) => ({
						...current,
						status: "completed",
						completed_at: new Date().toISOString(),
						duration_seconds: duration,
						last_reviewed_head_sha: reviewCapped
							? state.last_reviewed_head_sha || diffBaseSha
							: headSha,
						progress: {
							...current.progress,
							completed_files: reviewedFiles.length,
							current_file: null,
							reviewed_files: reviewedFiles,
							file_results: fileResults,
						},
						results: {
							verdict,
							total_findings: totalFindings,
							findings: allFindings.map((f) => ({
								severity: f.severity,
								category: f.category,
								title: f.title,
								path: f.path,
							})),
						},
						open_issues: openIssues,
					}),
					config,
					isFinal: true,
				});
			} catch (err) {
				console.log(`Dashboard final update failed: ${err.message}`);
			}
		}

		console.log(
			`Review complete: ${verdict} (${totalFindings} findings across ${reviewedFiles.length} files) in ${duration}s`,
		);

		return {
			verdict,
			totalFindings,
			allFindings,
			reviewedFiles,
			fileResults,
			reviewCapped,
			duration,
			openIssues,
		};
	} finally {
		opencode.server.close();
	}
}

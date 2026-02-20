// Main orchestrator for the AI Review GitHub Action.
// Consolidates the workflow YAML logic: PR details, skip conditions,
// slash command parsing, check runs, scope calculation, diff generation,
// review execution, and finalization.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadContextFiles } from "./config.mjs";
import {
	buildMarkers,
	decodeState,
	findOrCreateDashboard,
	renderDashboard,
} from "./dashboard.mjs";
import { runReview } from "./review.mjs";
import { ghApi, parseProviderModel } from "./shared.mjs";

// ── Environment ──────────────────────────────────────────────────────────────

const {
	GITHUB_TOKEN,
	GITHUB_REPOSITORY,
	GITHUB_EVENT_NAME,
	GITHUB_EVENT_PATH,
	GITHUB_SERVER_URL,
	GITHUB_RUN_ID,
	INPUT_MODEL,
	INPUT_CONFIG_PATH,
	INPUT_TIMEOUT_MINUTES,
	INPUT_COMMAND,
	ACTION_PATH,
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
	console.error("Missing GITHUB_TOKEN or GITHUB_REPOSITORY");
	process.exit(1);
}

const [owner, repo] = GITHUB_REPOSITORY.split("/");
const workflowRunUrl = `${GITHUB_SERVER_URL || "https://github.com"}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID || ""}`;

// ── GitHub event payload ─────────────────────────────────────────────────────

let event = {};
if (GITHUB_EVENT_PATH && fs.existsSync(GITHUB_EVENT_PATH)) {
	event = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, "utf8"));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function setOutput(name, value) {
	const outputFile = process.env.GITHUB_OUTPUT;
	if (outputFile) {
		fs.appendFileSync(outputFile, `${name}=${value}\n`);
	}
}

// ── PR details ───────────────────────────────────────────────────────────────

async function getPrDetails() {
	// Determine PR number from event
	let prNumber =
		event.pull_request?.number || event.issue?.number || null;

	if (!prNumber) {
		throw new Error("Could not determine PR number from event context");
	}

	const pr = await ghApi(
		GITHUB_TOKEN,
		`/repos/${owner}/${repo}/pulls/${prNumber}`,
	);

	return {
		number: pr.number,
		headSha: pr.head.sha,
		headRef: pr.head.ref,
		baseSha: pr.base.sha,
		baseRef: pr.base.ref,
		title: pr.title || "",
		body: pr.body || "",
		authorLogin: pr.user?.login || "",
		authorType: pr.user?.type || "",
	};
}

// ── Skip conditions ──────────────────────────────────────────────────────────

function shouldSkipReview(pr) {
	const isBot =
		pr.authorType === "Bot" || pr.authorLogin.endsWith("[bot]");
	if (isBot) {
		return { skip: true, reason: `bot_pr:${pr.authorLogin || "unknown"}` };
	}
	return { skip: false, reason: "" };
}

// ── Slash command parsing ────────────────────────────────────────────────────

function parseSlashCommand(commentBody, command) {
	let forceFullReview = false;
	let resetState = false;
	let sinceSha = "";

	if (!commentBody) return { forceFullReview, resetState, sinceSha };

	const tokens = commentBody.trim().split(/\s+/).filter(Boolean);
	// First token is the command itself
	for (const token of tokens.slice(1)) {
		if (["full", "--full", "all", "--all"].includes(token)) {
			forceFullReview = true;
			continue;
		}
		if (["reset", "--reset"].includes(token)) {
			resetState = true;
			continue;
		}
		const sinceMatch = token.match(/^--since=(?<sha>[0-9a-f]{7,40})$/i);
		if (sinceMatch?.groups?.sha) {
			sinceSha = sinceMatch.groups.sha;
			continue;
		}
	}

	// Also support: /command --since <sha>
	const sinceIndex = tokens.findIndex((t) => t === "--since");
	if (sinceIndex !== -1 && tokens[sinceIndex + 1]) {
		const maybeSha = tokens[sinceIndex + 1];
		if (/^[0-9a-f]{7,40}$/i.test(maybeSha)) {
			sinceSha = maybeSha;
		}
	}

	return { forceFullReview, resetState, sinceSha };
}

// ── Check run ────────────────────────────────────────────────────────────────

async function createCheckRun(headSha, model) {
	try {
		const check = await ghApi(
			GITHUB_TOKEN,
			`/repos/${owner}/${repo}/check-runs`,
			"POST",
			{
				name: `AI Review (${model})`,
				head_sha: headSha,
				status: "in_progress",
				started_at: new Date().toISOString(),
				output: {
					title: `AI is reviewing your PR with ${model}...`,
					summary:
						"The AI review is in progress. Inline comments will appear on files as issues are found.",
				},
			},
		);
		console.log(`Created check run ${check.id}`);
		return String(check.id);
	} catch (err) {
		console.log(`Failed to create check run: ${err.message}`);
		return null;
	}
}

async function finalizeCheckRun(checkId, opts) {
	if (!checkId) return;

	const {
		verdict,
		model,
		jobCancelled,
		shouldSkip,
		skipReason,
		reviewMode,
		hasReview,
		reviewBody,
		exitCode,
	} = opts;

	let conclusion = "success";
	let title = `Review Complete (${model})`;
	let summary = "AI review completed.";

	if (jobCancelled) {
		conclusion = "cancelled";
		title = `Review Cancelled (${model})`;
		summary =
			"This review was cancelled because a newer commit triggered a new review.";
	} else if (shouldSkip) {
		title = `Review Skipped (${model})`;
		summary = `Skipping review: ${skipReason || "unknown reason"}.`;
	} else if (reviewMode === "skip") {
		title = `Review Skipped - No New Commits (${model})`;
		summary = "No new commits since the last review.";
	} else if (!hasReview || exitCode !== 0) {
		conclusion = "failure";
		title = `Review Failed (${model}, exit code ${exitCode})`;
		summary = hasReview
			? reviewBody
			: "Unable to generate a review. Check the workflow logs for details.";
	} else if (verdict === "ERROR") {
		conclusion = "failure";
		title = `Review Failed - No Files Reviewed (${model})`;
		summary = reviewBody;
	} else if (verdict === "BLOCK" || verdict === "ATTENTION") {
		title =
			verdict === "BLOCK"
				? `Review Complete - BLOCKING Issues (${model})`
				: `Review Complete - Issues Found (${model})`;
		summary = reviewBody;
	} else {
		title = `Review Complete - OK (${model})`;
		summary = reviewBody;
	}

	// Truncate if needed
	if (summary.length > 60000) {
		summary =
			summary.substring(0, 60000) +
			"\n\n... (truncated, see dashboard comment)";
	}

	try {
		await ghApi(
			GITHUB_TOKEN,
			`/repos/${owner}/${repo}/check-runs/${checkId}`,
			"PATCH",
			{
				status: "completed",
				conclusion,
				completed_at: new Date().toISOString(),
				output: {
					title,
					summary,
					text: workflowRunUrl
						? `[View full workflow run](${workflowRunUrl})`
						: "",
				},
			},
		);
		console.log(`Updated check ${checkId} with conclusion: ${conclusion}`);
	} catch (err) {
		console.log(`Failed to update check: ${err.message}`);
	}
}

// ── Scope calculation ────────────────────────────────────────────────────────

function determineScope({ baseSha, headSha, lastReviewedSha, forceFullReview, resetState, sinceSha }) {
	const mergeBaseSha = execFileSync(
		"git",
		["merge-base", baseSha, headSha],
		{ encoding: "utf8" },
	).trim();

	let lastReviewedInput = sinceSha || lastReviewedSha || "";
	let reviewScopeReason = sinceSha
		? "since_requested_sha"
		: "since_last_review";
	let reviewMode = "full";
	let diffBaseSha = mergeBaseSha;

	if (resetState) {
		reviewMode = "full";
		reviewScopeReason = "reset_requested";
		lastReviewedInput = "";
	} else if (forceFullReview) {
		reviewMode = "full";
		reviewScopeReason = "forced_full_review";
	} else if (lastReviewedInput) {
		// Verify the SHA exists and is an ancestor
		try {
			execFileSync(
				"git",
				["cat-file", "-e", `${lastReviewedInput}^{commit}`],
				{ encoding: "utf8" },
			);
			try {
				execFileSync(
					"git",
					["merge-base", "--is-ancestor", lastReviewedInput, headSha],
					{ encoding: "utf8" },
				);
				const commitCount = Number(
					execFileSync(
						"git",
						["rev-list", "--count", `${lastReviewedInput}..${headSha}`],
						{ encoding: "utf8" },
					).trim(),
				);
				if (commitCount === 0) {
					reviewMode = "skip";
					reviewScopeReason = "no_new_commits";
					diffBaseSha = "";
				} else {
					reviewMode = "incremental";
					diffBaseSha = lastReviewedInput;
				}
			} catch {
				reviewMode = "full";
				reviewScopeReason = "history_rewritten";
			}
		} catch {
			reviewMode = "full";
			reviewScopeReason = "previous_sha_missing";
		}
	} else {
		reviewScopeReason = "no_previous_review";
	}

	console.log(
		`Review scope: mode=${reviewMode} reason=${reviewScopeReason}`,
	);

	return { reviewMode, reviewScopeReason, mergeBaseSha, diffBaseSha, headSha };
}

// ── Diff generation ──────────────────────────────────────────────────────────

function generateChangedFiles(mergeBaseSha, diffBaseSha, headSha) {
	// Get files actually changed in the PR (vs merge base)
	const namesOutput = execFileSync(
		"git",
		["diff", "--name-only", mergeBaseSha, headSha],
		{ encoding: "utf8" },
	);
	const changedFiles = namesOutput
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);

	console.log(`Changed files: ${changedFiles.length}`);
	return changedFiles;
}

// ── OpenCode config generation ───────────────────────────────────────────────

function generateOpencodeConfig(model, config) {
	const { providerID, modelID } = parseProviderModel(model);
	const modelOptions = config.model_options || {};

	const opencodeConfig = {
		model: `${providerID}/${modelID}`,
		provider: {},
	};

	// Set model-specific options (e.g., reasoningEffort)
	if (Object.keys(modelOptions).length > 0) {
		opencodeConfig.provider[providerID] = {
			models: {
				[modelID]: {
					options: modelOptions,
				},
			},
		};
	}

	// Check if using OpenCode auth mode (includes plugin)
	const authModeFile = path.join(
		process.env.HOME || "",
		".local/share/opencode/.auth-mode",
	);
	if (fs.existsSync(authModeFile)) {
		const authMode = fs.readFileSync(authModeFile, "utf8").trim();
		if (authMode === "opencode") {
			// Use SDK path relative to action
			const pluginPath = ACTION_PATH
				? path.join(ACTION_PATH, "node_modules/opencode-openai-codex-auth")
				: "opencode-openai-codex-auth";
			opencodeConfig.plugin = [pluginPath];
		}
	}

	// Write opencode.json to current directory
	fs.writeFileSync("opencode.json", JSON.stringify(opencodeConfig, null, 2));
	console.log(`Generated opencode.json for ${model}`);
}

// ── Dashboard cancel/fail handler ────────────────────────────────────────────

async function updateDashboardOnFailure(dashboardCommentId, model, status, config) {
	if (!dashboardCommentId) return;

	const modelShort = model.split("/").pop() || model;
	const agentKey = `codex:${modelShort}`;
	const markers = buildMarkers(config?.dashboard?.marker);

	try {
		const comment = await ghApi(
			GITHUB_TOKEN,
			`/repos/${owner}/${repo}/issues/comments/${dashboardCommentId}`,
		);

		const state = decodeState(comment.body, "", markers);
		state.agents[agentKey] = {
			...(state.agents[agentKey] || {}),
			status,
			completed_at: new Date().toISOString(),
			workflow_run_url: workflowRunUrl,
		};
		state.updated_at = new Date().toISOString();

		const body = renderDashboard(state, {
			marker: config?.dashboard?.marker,
			title: config?.dashboard?.title,
		});

		await ghApi(
			GITHUB_TOKEN,
			`/repos/${owner}/${repo}/issues/comments/${dashboardCommentId}`,
			"PATCH",
			{ body },
		);
		console.log(`Updated dashboard with ${status} status for ${agentKey}`);
	} catch (err) {
		console.log(`Failed to update dashboard on ${status}: ${err.message}`);
	}
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	// Load config
	const configPath = INPUT_CONFIG_PATH || ".ai-review.yml";
	const config = loadConfig(configPath, {
		model: INPUT_MODEL,
		timeout_minutes: INPUT_TIMEOUT_MINUTES,
	});

	const model = config.model;
	const command = INPUT_COMMAND || "/ai-review";
	let checkId = null;
	let dashboardCommentId = "";
	let dashboardState = null;

	// Timeout setup
	const timeoutMinutes = config.review?.timeout_minutes || Number(INPUT_TIMEOUT_MINUTES) || 20;
	const timeoutTimer = setTimeout(() => {
		console.error(`Review timed out after ${timeoutMinutes} minutes`);
		process.exit(1);
	}, timeoutMinutes * 60 * 1000);

	try {
		// ── Get PR details ──
		const pr = await getPrDetails();
		console.log(`PR #${pr.number}: ${pr.title}`);
		console.log(`Head: ${pr.headSha} (${pr.headRef})`);
		console.log(`Base: ${pr.baseSha} (${pr.baseRef})`);

		// ── Check skip conditions ──
		const skipCheck = shouldSkipReview(pr);
		if (skipCheck.skip) {
			console.log(`Skipping review: ${skipCheck.reason}`);
			// Create check run to show skip in the UI
			checkId = await createCheckRun(pr.headSha, model);
			await finalizeCheckRun(checkId, {
				model,
				shouldSkip: true,
				skipReason: skipCheck.reason,
				hasReview: false,
				exitCode: 0,
			});
			setOutput("verdict", "SKIPPED");
			setOutput("findings_count", "0");
			return;
		}

		// ── Parse slash command ──
		let forceFullReview = false;
		let resetState = false;
		let sinceSha = "";

		if (GITHUB_EVENT_NAME === "issue_comment") {
			const commentBody = event.comment?.body || "";
			// Verify the comment starts with the configured command
			if (
				!commentBody.startsWith(command) &&
				commentBody !== command
			) {
				console.log(`Comment doesn't match command "${command}", skipping`);
				return;
			}
			const parsed = parseSlashCommand(commentBody, command);
			forceFullReview = parsed.forceFullReview;
			resetState = parsed.resetState;
			sinceSha = parsed.sinceSha;
		}

		// ── Create check run ──
		checkId = await createCheckRun(pr.headSha, model);

		// ── Load previous state from dashboard ──
		let lastReviewedSha = "";
		let previousState = {};

		if (!resetState) {
			try {
				const dashboard = await findOrCreateDashboard({
					token: GITHUB_TOKEN,
					owner,
					repo,
					prNumber: pr.number,
					headSha: pr.headSha,
					config,
				});
				dashboardCommentId = dashboard.commentId;
				dashboardState = dashboard.state;

				const modelShort = model.split("/").pop() || model;
				const agentKey = `codex:${modelShort}`;
				const agentState = dashboardState.agents?.[agentKey];

				if (agentState?.last_reviewed_head_sha) {
					lastReviewedSha = agentState.last_reviewed_head_sha;
				}

				if (agentState?.open_issues || agentState?.progress) {
					previousState = {
						schema_version: 1,
						last_reviewed_head_sha: lastReviewedSha,
						open_issues: agentState.open_issues || [],
					};
					if (agentState.progress?.reviewed_files) {
						previousState.in_progress = {
							head_sha:
								dashboardState.head_sha ||
								agentState.last_reviewed_head_sha ||
								"",
							reviewed_files: agentState.progress.reviewed_files,
						};
					}
				}

				console.log(
					`Dashboard loaded (comment ${dashboardCommentId}, last_reviewed=${lastReviewedSha || "none"})`,
				);
			} catch (err) {
				console.log(`Dashboard load failed (non-fatal): ${err.message}`);
			}
		} else {
			// Reset: create fresh dashboard
			try {
				const dashboard = await findOrCreateDashboard({
					token: GITHUB_TOKEN,
					owner,
					repo,
					prNumber: pr.number,
					headSha: pr.headSha,
					config,
				});
				dashboardCommentId = dashboard.commentId;
			} catch (err) {
				console.log(
					`Dashboard creation failed (non-fatal): ${err.message}`,
				);
			}
		}

		// ── Determine review scope ──
		const scope = determineScope({
			baseSha: pr.baseSha,
			headSha: pr.headSha,
			lastReviewedSha,
			forceFullReview,
			resetState,
			sinceSha,
		});

		if (scope.reviewMode === "skip") {
			console.log("No new commits to review");
			await finalizeCheckRun(checkId, {
				model,
				reviewMode: "skip",
				hasReview: false,
				exitCode: 0,
			});
			setOutput("verdict", "SKIPPED");
			setOutput("findings_count", "0");
			setOutput("dashboard_comment_id", dashboardCommentId);
			return;
		}

		// ── Generate diff ──
		const changedFiles = generateChangedFiles(
			scope.mergeBaseSha,
			scope.diffBaseSha,
			scope.headSha,
		);

		if (changedFiles.length === 0) {
			console.log("No changed files to review");
			await finalizeCheckRun(checkId, {
				model,
				verdict: "OK",
				hasReview: true,
				reviewBody: "## Verdict: OK\n\nNo files to review.",
				exitCode: 0,
			});
			setOutput("verdict", "OK");
			setOutput("findings_count", "0");
			setOutput("dashboard_comment_id", dashboardCommentId);
			return;
		}

		// ── Generate opencode.json ──
		generateOpencodeConfig(model, config);

		// ── Load context files ──
		const guidelinesContent = loadContextFiles(config.context_files || []);

		// ── Run review ──
		const result = await runReview({
			token: GITHUB_TOKEN,
			owner,
			repo,
			prNumber: pr.number,
			headSha: scope.headSha,
			diffBaseSha: scope.diffBaseSha,
			model,
			prTitle: pr.title,
			prBody: pr.body,
			workflowRunUrl,
			dashboardCommentId,
			guidelinesContent,
			changedFiles,
			previousState,
			config,
		});

		// ── Build review summary ──
		const findingsList =
			result.allFindings.length > 0
				? result.allFindings
						.map(
							(f) =>
								`- **${f.severity}** ${f.category}: ${f.title} (${f.path})`,
						)
						.join("\n")
				: "No issues found.";

		const reviewBody = [
			`## Verdict: ${result.verdict}`,
			``,
			`### Scope`,
			`- Reviewed ${result.reviewedFiles.length} of ${changedFiles.length} files in \`${scope.diffBaseSha.slice(0, 8)}..${scope.headSha.slice(0, 8)}\`${result.reviewCapped ? ` (capped at ${config.review?.max_total_findings || 15} findings)` : ""}`,
			``,
			`### Summary`,
			`- ${result.totalFindings} finding(s) posted as inline comments`,
			``,
			`### Findings`,
			findingsList,
		].join("\n");

		// ── Finalize check run ──
		await finalizeCheckRun(checkId, {
			model,
			verdict: result.verdict,
			hasReview: true,
			reviewBody,
			exitCode: 0,
		});

		// ── Set outputs ──
		setOutput("verdict", result.verdict);
		setOutput("findings_count", String(result.totalFindings));
		setOutput("dashboard_comment_id", dashboardCommentId);

		console.log(
			`Done: ${result.verdict} (${result.totalFindings} findings, ${result.duration}s)`,
		);
	} catch (err) {
		console.error("Review failed:", err);

		// Try to update check run and dashboard on failure
		try {
			await finalizeCheckRun(checkId, {
				model,
				hasReview: false,
				exitCode: 1,
			});
		} catch {}

		try {
			await updateDashboardOnFailure(
				dashboardCommentId,
				model,
				"failed",
				config,
			);
		} catch {}

		setOutput("verdict", "ERROR");
		setOutput("findings_count", "0");
		process.exit(1);
	} finally {
		clearTimeout(timeoutTimer);
	}
}

main();

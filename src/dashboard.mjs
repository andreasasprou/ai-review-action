// Unified AI Review Dashboard
// Single PR comment with live progress, final results, and state management.
// State is carried as base64 JSON in an HTML comment within the dashboard.
// Each workflow writes only to its own namespace (agent key) to avoid conflicts.

import { ghApi } from "./shared.mjs";

// ── Marker helpers (configurable) ─────────────────────────────────────────────

/**
 * Build dashboard marker strings from config.
 * @param {string} [marker="ai-review"] - Dashboard marker prefix
 */
export function buildMarkers(marker = "ai-review") {
	return {
		DASHBOARD_MARKER: `<!-- ${marker}-dashboard:v2 -->`,
		STATE_PREFIX: `<!-- ${marker}-dashboard:state:v2:base64\n`,
		STATE_SUFFIX: `\n-->`,
	};
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_COMMENT_SIZE = 65000;
const MAX_STATE_JSON_SIZE = 30000;
const MAX_TOOL_CALLS = 20;

const STATUS_EMOJI = {
	pending: ":white_circle:",
	running: ":hourglass_flowing_sand:",
	completed_ok: ":white_check_mark:",
	completed_issues: ":warning:",
	failed: ":x:",
	cancelled: ":no_entry_sign:",
	skipped: ":fast_forward:",
};

const DEFAULT_AGENT_TYPE_LABELS = {
	codex: "Code Review",
	docs: "Docs Review",
};

// ── State Serialization ──────────────────────────────────────────────────────

function defaultState(headSha) {
	return {
		schema_version: 2,
		head_sha: headSha || "",
		updated_at: new Date().toISOString(),
		agents: {},
	};
}

export function encodeState(state) {
	return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

export function decodeState(commentBody, headSha = "", markers) {
	const { STATE_PREFIX, STATE_SUFFIX } = markers || buildMarkers();
	try {
		const startIdx = commentBody.indexOf(STATE_PREFIX);
		if (startIdx === -1) return defaultState(headSha);

		const b64Start = startIdx + STATE_PREFIX.length;
		const endIdx = commentBody.indexOf(STATE_SUFFIX, b64Start);
		if (endIdx === -1) return defaultState(headSha);

		const b64 = commentBody.substring(b64Start, endIdx).replace(/\s+/g, "");
		const json = Buffer.from(b64, "base64").toString("utf8");
		const parsed = JSON.parse(json);

		if (!parsed || typeof parsed !== "object" || parsed.schema_version !== 2) {
			return defaultState(headSha);
		}

		return parsed;
	} catch (err) {
		console.log(
			`Failed to decode dashboard state: ${err.message}, using default`,
		);
		return defaultState(headSha);
	}
}

// ── Rendering ────────────────────────────────────────────────────────────────

function agentLabel(agentKey, agentTypeLabels) {
	const labels = { ...DEFAULT_AGENT_TYPE_LABELS, ...agentTypeLabels };
	const [type, ...modelParts] = agentKey.split(":");
	const model = modelParts.join(":");
	const typeLabel = labels[type] || type;
	return model ? `${typeLabel} (\`${model}\`)` : typeLabel;
}

function statusEmoji(agent) {
	if (agent.status === "completed") {
		const hasIssues =
			agent.results?.total_findings > 0 ||
			(agent.results?.verdict &&
				agent.results.verdict.toLowerCase() !== "ok" &&
				agent.results.verdict.toLowerCase() !== "no issues");
		return hasIssues
			? STATUS_EMOJI.completed_issues
			: STATUS_EMOJI.completed_ok;
	}
	return STATUS_EMOJI[agent.status] || STATUS_EMOJI.pending;
}

function statusText(agent) {
	switch (agent.status) {
		case "pending":
			return "Pending";
		case "running":
			return "Reviewing...";
		case "completed":
			return agent.results?.verdict || "Done";
		case "failed":
			return "Failed";
		case "cancelled":
			return "Cancelled";
		case "skipped":
			return "Skipped";
		default:
			return agent.status || "Unknown";
	}
}

function findingsText(agent) {
	if (agent.status === "running") {
		const count = agent.progress?.file_results
			? Object.values(agent.progress.file_results).reduce(
					(sum, f) => sum + (f.findings_count || 0),
					0,
				)
			: 0;
		return count > 0 ? `${count} so far` : "--";
	}
	if (agent.status === "completed") {
		const n = agent.results?.total_findings ?? 0;
		if (n === 0) return "No issues";
		return `${n} finding${n !== 1 ? "s" : ""}`;
	}
	return "--";
}

function durationText(agent) {
	if (agent.duration_seconds != null) {
		const m = Math.floor(agent.duration_seconds / 60);
		const s = agent.duration_seconds % 60;
		return m > 0 ? `${m}m ${s}s` : `${s}s`;
	}
	if (agent.started_at && agent.status === "running") {
		const elapsed = Math.round(
			(Date.now() - new Date(agent.started_at).getTime()) / 1000,
		);
		const m = Math.floor(elapsed / 60);
		const s = elapsed % 60;
		return m > 0 ? `${m}m ${s}s` : `${s}s`;
	}
	return "--";
}

function shortenPath(path) {
	if (!path || path.length <= 60) return path;
	const parts = path.split("/");
	if (parts.length <= 3) return path;
	return `${parts[0]}/.../${parts.slice(-2).join("/")}`;
}

function renderAgentDetails(agentKey, agent, agentTypeLabels) {
	const label = agentLabel(agentKey, agentTypeLabels);
	const lines = [];

	if (agent.status === "running" && agent.progress) {
		const p = agent.progress;
		const total = p.total_files || 0;
		const completed = p.completed_files || 0;

		if (total > 0) {
			lines.push(
				`<details>`,
				`<summary>${label} Progress (${completed}/${total} files)</summary>`,
				``,
				`| File | Status | Findings |`,
				`|------|--------|----------|`,
			);

			const reviewedFiles = p.reviewed_files || [];
			const filesWithFindings = reviewedFiles.filter((file) => {
				const result = p.file_results?.[file];
				return result && result.findings_count > 0;
			});
			const skippedCount = reviewedFiles.filter(
				(file) => p.file_results?.[file]?.status === "skipped",
			).length;
			const cleanCount =
				reviewedFiles.length - filesWithFindings.length - skippedCount;

			for (const file of filesWithFindings) {
				const result = p.file_results?.[file];
				const count = result?.findings_count ?? 0;
				lines.push(
					`| \`${shortenPath(file)}\` | :white_check_mark: | ${count} |`,
				);
			}
			if (cleanCount > 0) {
				lines.push(`| _${cleanCount} files clean_ | :white_check_mark: | 0 |`);
			}
			if (skippedCount > 0) {
				lines.push(`| _${skippedCount} files skipped_ | :fast_forward: | -- |`);
			}

			if (p.current_file) {
				lines.push(
					`| \`${shortenPath(p.current_file)}\` | :arrows_counterclockwise: Reviewing... | -- |`,
				);
			}

			lines.push(``, `</details>`);
		}

		if (p.tool_calls?.length > 0) {
			const toolCounts = {};
			for (const tc of p.tool_calls) {
				toolCounts[tc.tool] = (toolCounts[tc.tool] || 0) + 1;
			}
			const toolSummary = Object.entries(toolCounts)
				.map(([tool, count]) => `${tool} (${count})`)
				.join(", ");

			lines.push(
				`<details>`,
				`<summary>${label} Progress (${p.tool_calls.length} tool calls)</summary>`,
				``,
				`Tools used: ${toolSummary}`,
			);

			const withSummary = p.tool_calls.filter((tc) => tc.summary);
			if (withSummary.length > 0) {
				lines.push(``);
				for (const tc of withSummary.slice(-10)) {
					lines.push(`- \`${tc.tool}\`: ${tc.summary}`);
				}
			}

			lines.push(``, `</details>`);
		}
	}

	if (agent.status === "completed" && agent.results) {
		const r = agent.results;
		const count = r.total_findings ?? 0;

		if (count === 0 && !agent.open_issues?.length) {
			lines.push(`${label} — No issues found`);
			return lines.join("\n");
		}

		const summaryLabel =
			count > 0 ? `${count} finding${count !== 1 ? "s" : ""}` : "OK";

		lines.push(
			`<details>`,
			`<summary>${label} — ${summaryLabel}</summary>`,
			``,
		);

		if (r.findings?.length > 0) {
			for (const f of r.findings) {
				lines.push(
					`- **${f.severity}** ${f.category}: ${f.title} (\`${shortenPath(f.path)}\`)`,
				);
			}
		} else if (agent.open_issues?.length > 0) {
			for (const issue of agent.open_issues) {
				lines.push(
					`- **${issue.severity}**: ${issue.title}${issue.related_doc ? ` (\`${shortenPath(issue.related_doc)}\`)` : ""}`,
				);
			}
		} else if (r.verdict) {
			lines.push(r.verdict === "OK" ? "No issues found." : r.verdict);
		} else {
			lines.push("No issues found.");
		}

		const [type] = agentKey.split(":");
		if (type === "codex" && agent.last_reviewed_head_sha) {
			lines.push(
				``,
				`Scope: \`${agent.progress?.reviewed_files?.length || "?"} files\` | Head: \`${agent.last_reviewed_head_sha.substring(0, 8)}\``,
			);
		}

		lines.push(``, `</details>`);
	}

	return lines.join("\n");
}

/**
 * Render the full dashboard markdown from state.
 * @param {object} state
 * @param {object} [opts]
 * @param {string} [opts.marker] - Dashboard marker prefix
 * @param {string} [opts.title] - Dashboard title
 * @param {object} [opts.agentTypeLabels] - Custom agent type labels
 * @returns {string}
 */
export function renderDashboard(state, opts = {}) {
	const markers = buildMarkers(opts.marker);
	const { DASHBOARD_MARKER, STATE_PREFIX, STATE_SUFFIX } = markers;
	const title = opts.title || "AI Review Dashboard";
	const agentTypeLabels = opts.agentTypeLabels || {};
	const parts = [];

	let stateForBlob = state;
	const stateJson = JSON.stringify(state);
	if (stateJson.length > MAX_STATE_JSON_SIZE) {
		stateForBlob = JSON.parse(stateJson);
		for (const agent of Object.values(stateForBlob.agents || {})) {
			if (agent.progress) {
				delete agent.progress.reviewed_files;
				delete agent.progress.file_results;
			}
		}
	}
	const stateB64 = encodeState(stateForBlob);
	parts.push(DASHBOARD_MARKER);
	parts.push(`${STATE_PREFIX}${stateB64}${STATE_SUFFIX}`);
	parts.push(``);

	parts.push(`## ${title}`);
	parts.push(``);

	const agentKeys = Object.keys(state.agents || {}).sort();

	if (agentKeys.length === 0) {
		parts.push(`_No reviews started yet._`);
	} else {
		parts.push(`| Agent | Status | Findings | Duration |`);
		parts.push(`|-------|--------|----------|----------|`);

		for (const key of agentKeys) {
			const agent = state.agents[key];
			parts.push(
				`| ${agentLabel(key, agentTypeLabels)} | ${statusEmoji(agent)} ${statusText(agent)} | ${findingsText(agent)} | ${durationText(agent)} |`,
			);
		}
	}

	parts.push(``);

	for (const key of agentKeys) {
		const details = renderAgentDetails(key, state.agents[key], agentTypeLabels);
		if (details) {
			parts.push(details);
			parts.push(``);
		}
	}

	const agentsWithMetrics = agentKeys.filter((k) => state.agents[k].metrics);
	if (agentsWithMetrics.length > 0) {
		parts.push(`<details>`);
		parts.push(`<summary>Metrics</summary>`);
		parts.push(``);

		const metricHeaders = [
			"Metric",
			...agentsWithMetrics.map((k) => agentLabel(k, agentTypeLabels)),
		];
		parts.push(`| ${metricHeaders.join(" | ")} |`);
		parts.push(`|${metricHeaders.map(() => "--------").join("|")}|`);

		const metricRows = [
			[
				"Model",
				...agentsWithMetrics.map((k) => `\`${state.agents[k].model || "?"}\``),
			],
			[
				"Input tokens",
				...agentsWithMetrics.map((k) =>
					(state.agents[k].metrics.input_tokens ?? 0).toLocaleString(),
				),
			],
			[
				"Output tokens",
				...agentsWithMetrics.map((k) =>
					(state.agents[k].metrics.output_tokens ?? 0).toLocaleString(),
				),
			],
			[
				"Cached tokens",
				...agentsWithMetrics.map((k) =>
					(state.agents[k].metrics.cached_tokens ?? 0).toLocaleString(),
				),
			],
			[
				"Cost",
				...agentsWithMetrics.map(
					(k) => `$${(state.agents[k].metrics.cost ?? 0).toFixed(2)}`,
				),
			],
		];

		for (const row of metricRows) {
			parts.push(`| ${row.join(" | ")} |`);
		}

		parts.push(``);
		parts.push(`</details>`);
		parts.push(``);
	}

	const workflowLinks = agentKeys
		.filter((k) => state.agents[k].workflow_run_url)
		.map(
			(k) =>
				`<a href="${state.agents[k].workflow_run_url}">${agentLabel(k, agentTypeLabels).split(" (")[0]} Logs</a>`,
		);

	const footerParts = [
		`Updated ${new Date(state.updated_at || Date.now()).toISOString().replace("T", " ").substring(0, 19)} UTC`,
	];
	if (state.head_sha) {
		footerParts.push(`Head: \`${state.head_sha.substring(0, 8)}\``);
	}
	if (workflowLinks.length > 0) {
		footerParts.push(workflowLinks.join(" | "));
	}

	parts.push(`---`);
	parts.push(`<sub>${footerParts.join(" | ")}</sub>`);

	const rendered = parts.join("\n");

	if (rendered.length > MAX_COMMENT_SIZE) {
		const withoutMetrics = rendered.replace(
			/<details>\n<summary>Metrics<\/summary>[\s\S]*?<\/details>\n\n/,
			"_Metrics omitted (see workflow logs)._\n\n",
		);
		if (withoutMetrics.length <= MAX_COMMENT_SIZE) return withoutMetrics;

		const summaryRows = agentKeys.map((key) => {
			const agent = state.agents[key];
			return `| ${agentLabel(key, agentTypeLabels)} | ${statusEmoji(agent)} ${statusText(agent)} | ${findingsText(agent)} | ${durationText(agent)} |`;
		});
		return [
			DASHBOARD_MARKER,
			`${STATE_PREFIX}${stateB64}${STATE_SUFFIX}`,
			"",
			`## ${title}`,
			"",
			"| Agent | Status | Findings | Duration |",
			"|-------|--------|----------|----------|",
			...summaryRows,
			"",
			"_Details omitted due to comment size limits. See workflow logs._",
			"---",
			`<sub>Updated ${new Date(state.updated_at || Date.now()).toISOString().replace("T", " ").substring(0, 19)} UTC</sub>`,
		].join("\n");
	}

	return rendered;
}

// ── GitHub Comment Operations ────────────────────────────────────────────────

async function backoff(attempt) {
	const ms = Math.min(1000 * 2 ** attempt, 8000);
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAllComments(token, owner, repo, prNumber) {
	const allComments = [];
	let page = 1;
	while (true) {
		const batch = await ghApi(
			token,
			`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}&sort=created&direction=asc`,
		);
		allComments.push(...batch);
		if (batch.length < 100) break;
		page++;
	}
	return allComments;
}

/**
 * Find the dashboard comment on a PR, or create one if it doesn't exist.
 */
export async function findOrCreateDashboard({
	token,
	owner,
	repo,
	prNumber,
	headSha,
	config,
}) {
	const marker = config?.dashboard?.marker || "ai-review";
	const markers = buildMarkers(marker);
	const { DASHBOARD_MARKER } = markers;

	const comments = await fetchAllComments(token, owner, repo, prNumber);

	const dashboardComments = comments.filter(
		(c) =>
			c.user?.login === "github-actions[bot]" &&
			(c.body || "").includes(DASHBOARD_MARKER),
	);

	if (dashboardComments.length === 1) {
		const comment = dashboardComments[0];
		const state = decodeState(comment.body, headSha, markers);
		return { commentId: String(comment.id), state };
	}

	if (dashboardComments.length > 1) {
		const [keep, ...duplicates] = dashboardComments;
		for (const dup of duplicates) {
			try {
				await ghApi(
					token,
					`/repos/${owner}/${repo}/issues/comments/${dup.id}`,
					"DELETE",
				);
				console.log(`Deleted duplicate dashboard comment ${dup.id}`);
			} catch (err) {
				console.log(
					`Failed to delete duplicate comment ${dup.id}: ${err.message}`,
				);
			}
		}
		const state = decodeState(keep.body, headSha, markers);
		return { commentId: String(keep.id), state };
	}

	// No dashboard comment found, create one
	const initialState = defaultState(headSha);
	const body = renderDashboard(initialState, {
		marker,
		title: config?.dashboard?.title,
	});

	const created = await ghApi(
		token,
		`/repos/${owner}/${repo}/issues/${prNumber}/comments`,
		"POST",
		{ body },
	);

	const commentId = String(created.id);

	// Deduplication check after creation
	const recheckComments = await fetchAllComments(token, owner, repo, prNumber);
	const allDashboards = recheckComments.filter(
		(c) =>
			c.user?.login === "github-actions[bot]" &&
			(c.body || "").includes(DASHBOARD_MARKER),
	);

	if (allDashboards.length > 1) {
		const [keep, ...duplicates] = allDashboards;
		for (const dup of duplicates) {
			try {
				await ghApi(
					token,
					`/repos/${owner}/${repo}/issues/comments/${dup.id}`,
					"DELETE",
				);
			} catch (err) {
				console.log(`Failed to delete duplicate: ${err.message}`);
			}
		}
		const state = decodeState(keep.body, headSha, markers);
		return { commentId: String(keep.id), state };
	}

	return { commentId, state: initialState };
}

/**
 * Update a single agent's state in the dashboard.
 */
export async function updateDashboardAgent({
	token,
	owner,
	repo,
	prNumber,
	commentId,
	agentKey,
	updater,
	config,
	maxRetries = 3,
	isFinal = false,
}) {
	const marker = config?.dashboard?.marker || "ai-review";
	const markers = buildMarkers(marker);

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const comment = await ghApi(
				token,
				`/repos/${owner}/${repo}/issues/comments/${commentId}`,
			);
			const state = decodeState(comment.body, "", markers);

			const currentAgentState = state.agents[agentKey] || {};
			state.agents[agentKey] = updater(currentAgentState);
			state.updated_at = new Date().toISOString();

			const tc = state.agents[agentKey].progress?.tool_calls;
			if (tc && tc.length > MAX_TOOL_CALLS) {
				state.agents[agentKey].progress.tool_calls = tc.slice(-MAX_TOOL_CALLS);
			}

			const body = renderDashboard(state, {
				marker,
				title: config?.dashboard?.title,
			});
			await ghApi(
				token,
				`/repos/${owner}/${repo}/issues/comments/${commentId}`,
				"PATCH",
				{ body },
			);

			if (isFinal && attempt < maxRetries) {
				const verify = await ghApi(
					token,
					`/repos/${owner}/${repo}/issues/comments/${commentId}`,
				);
				const verifyState = decodeState(verify.body, "", markers);
				if (!verifyState.agents[agentKey]) {
					console.log(
						`Dashboard write lost ${agentKey}, retrying (attempt ${attempt + 1})...`,
					);
					await backoff(attempt);
					continue;
				}
				let clobbered = false;
				for (const k of Object.keys(verifyState.agents)) {
					if (k === agentKey) continue;
					const pre = JSON.stringify(state.agents[k] || null);
					const post = JSON.stringify(verifyState.agents[k] || null);
					if (pre !== post) {
						clobbered = true;
						console.log(
							`Dashboard write clobbered ${k}, retrying (attempt ${attempt + 1})...`,
						);
						break;
					}
				}
				if (clobbered) {
					await backoff(attempt);
					continue;
				}
			}

			return;
		} catch (err) {
			const status = err.message?.match(/failed:\s*(\d{3})/)?.[1];
			if ((status === "403" || status === "429") && attempt < maxRetries) {
				console.log(
					`GitHub API rate limit (${status}), backing off (attempt ${attempt + 1})...`,
				);
				await backoff(attempt);
				continue;
			}
			throw err;
		}
	}
}

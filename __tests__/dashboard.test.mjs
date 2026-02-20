import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildMarkers,
	decodeState,
	encodeState,
	renderDashboard,
} from "../src/dashboard.mjs";

// ── buildMarkers ─────────────────────────────────────────────────────────────

describe("buildMarkers", () => {
	it("uses ai-review as default marker", () => {
		const m = buildMarkers();
		assert.equal(m.DASHBOARD_MARKER, "<!-- ai-review-dashboard:v2 -->");
		assert.ok(m.STATE_PREFIX.includes("ai-review-dashboard:state:v2:base64"));
	});

	it("uses custom marker", () => {
		const m = buildMarkers("nova-review");
		assert.equal(m.DASHBOARD_MARKER, "<!-- nova-review-dashboard:v2 -->");
		assert.ok(
			m.STATE_PREFIX.includes("nova-review-dashboard:state:v2:base64"),
		);
	});
});

// ── encodeState / decodeState roundtrip ─────────────────────────────────────

describe("encodeState / decodeState", () => {
	it("roundtrips through renderDashboard body", () => {
		const state = {
			schema_version: 2,
			head_sha: "abc123",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents: {
				"codex:claude-sonnet-4-5": {
					status: "completed",
					model: "claude-sonnet-4-5",
					last_reviewed_head_sha: "abc123",
					results: { verdict: "OK", total_findings: 0 },
				},
			},
		};

		const rendered = renderDashboard(state);
		const decoded = decodeState(rendered);

		assert.equal(decoded.schema_version, 2);
		assert.equal(decoded.head_sha, "abc123");
		assert.deepEqual(
			decoded.agents["codex:claude-sonnet-4-5"].results,
			state.agents["codex:claude-sonnet-4-5"].results,
		);
	});

	it("roundtrips with custom marker", () => {
		const state = {
			schema_version: 2,
			head_sha: "abc123",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents: {},
		};

		const rendered = renderDashboard(state, { marker: "nova-review" });
		const markers = buildMarkers("nova-review");
		const decoded = decodeState(rendered, "", markers);

		assert.equal(decoded.schema_version, 2);
		assert.equal(decoded.head_sha, "abc123");
	});

	it("returns default state for empty string", () => {
		const decoded = decodeState("", "deadbeef");
		assert.equal(decoded.schema_version, 2);
		assert.equal(decoded.head_sha, "deadbeef");
		assert.deepEqual(decoded.agents, {});
	});

	it("returns default state for invalid base64", () => {
		const body = `<!-- ai-review-dashboard:state:v2:base64\nNOT_VALID_JSON!!!\n-->`;
		const decoded = decodeState(body, "sha123");
		assert.equal(decoded.schema_version, 2);
		assert.equal(decoded.head_sha, "sha123");
		assert.deepEqual(decoded.agents, {});
	});

	it("returns default state for truncated comment", () => {
		const body = `<!-- ai-review-dashboard:state:v2:base64\n`;
		const decoded = decodeState(body);
		assert.equal(decoded.schema_version, 2);
		assert.deepEqual(decoded.agents, {});
	});

	it("returns default state for wrong schema version", () => {
		const wrongVersion = { schema_version: 1, agents: {} };
		const b64 = Buffer.from(JSON.stringify(wrongVersion)).toString("base64");
		const body = `<!-- ai-review-dashboard:state:v2:base64\n${b64}\n-->`;
		const decoded = decodeState(body);
		assert.equal(decoded.schema_version, 2);
	});

	it("preserves complex nested state through roundtrip", () => {
		const state = {
			schema_version: 2,
			head_sha: "abc123",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents: {
				"codex:claude-sonnet-4-5": {
					status: "completed",
					model: "claude-sonnet-4-5",
					last_reviewed_head_sha: "abc123",
					duration_seconds: 192,
					results: {
						verdict: "2 findings",
						total_findings: 2,
						findings: [
							{
								severity: "P2",
								category: "Design",
								title: "Missing port interface",
								path: "apps/nova/src/scoring/service.ts",
							},
							{
								severity: "P2",
								category: "Performance",
								title: "Unbounded query in loop",
								path: "apps/embed/src/api/use-cases.ts",
							},
						],
					},
					open_issues: [
						{
							id: "1",
							severity: "P2",
							title: "Missing port",
							location: "service.ts",
							status: "open",
							first_seen_head_sha: "abc123",
							last_seen_head_sha: "abc123",
						},
					],
				},
			},
		};

		const rendered = renderDashboard(state);
		const decoded = decodeState(rendered);

		assert.equal(
			decoded.agents["codex:claude-sonnet-4-5"].results.total_findings,
			2,
		);
		assert.equal(
			decoded.agents["codex:claude-sonnet-4-5"].results.findings.length,
			2,
		);
		assert.equal(
			decoded.agents["codex:claude-sonnet-4-5"].open_issues.length,
			1,
		);
	});
});

// ── renderDashboard ─────────────────────────────────────────────────────────

describe("renderDashboard", () => {
	it("renders empty state (0 agents)", () => {
		const state = {
			schema_version: 2,
			head_sha: "abc123",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents: {},
		};

		const md = renderDashboard(state);
		assert.ok(md.includes("<!-- ai-review-dashboard:v2 -->"));
		assert.ok(md.includes("## AI Review Dashboard"));
		assert.ok(md.includes("_No reviews started yet._"));
	});

	it("uses custom marker and title", () => {
		const state = {
			schema_version: 2,
			head_sha: "abc123",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents: {},
		};

		const md = renderDashboard(state, {
			marker: "nova-review",
			title: "Nova Review Dashboard",
		});
		assert.ok(md.includes("<!-- nova-review-dashboard:v2 -->"));
		assert.ok(md.includes("## Nova Review Dashboard"));
	});

	it("renders 1 running agent with file progress", () => {
		const state = {
			schema_version: 2,
			head_sha: "abc12345",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents: {
				"codex:claude-sonnet-4-5": {
					status: "running",
					model: "claude-sonnet-4-5",
					started_at: "2026-02-15T11:58:00.000Z",
					progress: {
						total_files: 5,
						completed_files: 2,
						current_file: "apps/nova/src/scoring/adapter.ts",
						reviewed_files: [
							"apps/nova/src/scoring/service.ts",
							"apps/nova/src/scoring/types.ts",
						],
						file_results: {
							"apps/nova/src/scoring/service.ts": {
								status: "done",
								findings_count: 1,
							},
							"apps/nova/src/scoring/types.ts": {
								status: "done",
								findings_count: 0,
							},
						},
					},
				},
			},
		};

		const md = renderDashboard(state);
		assert.ok(md.includes("Code Review (`claude-sonnet-4-5`)"));
		assert.ok(md.includes(":hourglass_flowing_sand:"));
		assert.ok(md.includes("Reviewing..."));
		assert.ok(md.includes("1 so far"));
		assert.ok(md.includes("Progress (2/5 files)"));
	});

	it("renders completed agents with findings", () => {
		const state = {
			schema_version: 2,
			head_sha: "e5f6g7h8",
			updated_at: "2026-02-15T14:37:00.000Z",
			agents: {
				"codex:claude-sonnet-4-5": {
					status: "completed",
					model: "claude-sonnet-4-5",
					last_reviewed_head_sha: "e5f6g7h8",
					duration_seconds: 192,
					results: {
						verdict: "2 findings",
						total_findings: 2,
						findings: [
							{
								severity: "P2",
								category: "Design",
								title: "Missing port interface",
								path: "apps/nova/src/scoring/service.ts",
							},
							{
								severity: "P2",
								category: "Performance",
								title: "Unbounded query",
								path: "apps/embed/src/api/use-cases.ts",
							},
						],
					},
				},
			},
		};

		const md = renderDashboard(state);
		assert.ok(md.includes("2 findings"));
		assert.ok(md.includes("3m 12s"));
		assert.ok(md.includes("**P2** Design: Missing port interface"));
		assert.ok(md.includes("**P2** Performance: Unbounded query"));
	});

	it("renders failed + cancelled agents", () => {
		const state = {
			schema_version: 2,
			head_sha: "deadbeef",
			updated_at: "2026-02-15T15:00:00.000Z",
			agents: {
				"codex:claude-sonnet-4-5": {
					status: "failed",
					model: "claude-sonnet-4-5",
					duration_seconds: 30,
				},
				"docs:gpt-5.3-codex": {
					status: "cancelled",
					model: "gpt-5.3-codex",
				},
			},
		};

		const md = renderDashboard(state);
		assert.ok(md.includes(":x:"));
		assert.ok(md.includes("Failed"));
		assert.ok(md.includes(":no_entry_sign:"));
		assert.ok(md.includes("Cancelled"));
	});

	it("renders metrics section when agents have metrics", () => {
		const state = {
			schema_version: 2,
			head_sha: "abc123",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents: {
				"codex:claude-sonnet-4-5": {
					status: "completed",
					model: "claude-sonnet-4-5",
					results: { verdict: "OK", total_findings: 0 },
					metrics: {
						input_tokens: 48231,
						output_tokens: 3412,
						reasoning_tokens: 0,
						cached_tokens: 12500,
						cost: 0.18,
					},
				},
			},
		};

		const md = renderDashboard(state);
		assert.ok(md.includes("<summary>Metrics</summary>"));
		assert.ok(md.includes("48,231"));
		assert.ok(md.includes("3,412"));
		assert.ok(md.includes("$0.18"));
	});

	it("renders warning emoji for completed agent with findings", () => {
		const state = {
			schema_version: 2,
			head_sha: "abc123",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents: {
				"codex:claude-sonnet-4-5": {
					status: "completed",
					model: "claude-sonnet-4-5",
					results: { verdict: "1 finding", total_findings: 1 },
				},
			},
		};

		const md = renderDashboard(state);
		assert.ok(md.includes(":warning:"));
		assert.ok(md.includes("1 finding"));
	});

	it("renders check emoji for completed agent with zero findings", () => {
		const state = {
			schema_version: 2,
			head_sha: "abc123",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents: {
				"codex:claude-sonnet-4-5": {
					status: "completed",
					model: "claude-sonnet-4-5",
					results: { verdict: "OK", total_findings: 0 },
				},
			},
		};

		const md = renderDashboard(state);
		assert.ok(md.includes(":white_check_mark:"));
	});

	it("uses custom agent type labels", () => {
		const state = {
			schema_version: 2,
			head_sha: "abc",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents: {
				"codex:model-1": { status: "pending", model: "model-1" },
			},
		};

		const md = renderDashboard(state, {
			agentTypeLabels: { codex: "AI Review" },
		});
		assert.ok(md.includes("AI Review (`model-1`)"));
	});
});

// ── Size budget ─────────────────────────────────────────────────────────────

describe("size budget", () => {
	it("worst-case state stays within 65KB comment limit", () => {
		const agents = {};

		for (let a = 0; a < 7; a++) {
			const key = `codex:model-${a}`;
			const fileResults = {};
			const reviewedFiles = [];

			for (let f = 0; f < 20; f++) {
				const path = `apps/nova/src/module-${a}/subdir-${f}/very-long-filename-${f}.ts`;
				reviewedFiles.push(path);
				fileResults[path] = {
					status: "done",
					findings_count: f < 3 ? 1 : 0,
				};
			}

			agents[key] = {
				status: "completed",
				model: `model-${a}`,
				last_reviewed_head_sha: "abcdef1234567890",
				duration_seconds: 300 + a * 60,
				progress: {
					total_files: 20,
					completed_files: 20,
					reviewed_files: reviewedFiles,
					file_results: fileResults,
				},
				results: {
					verdict: "3 findings",
					total_findings: 3,
					findings: [
						{
							severity: "P1",
							category: "Security",
							title: "SQL injection vulnerability",
							path: reviewedFiles[0],
						},
						{
							severity: "P2",
							category: "Performance",
							title: "Unbounded loop",
							path: reviewedFiles[1],
						},
						{
							severity: "P3",
							category: "Style",
							title: "Inconsistent naming",
							path: reviewedFiles[2],
						},
					],
				},
				metrics: {
					input_tokens: 100000,
					output_tokens: 5000,
					reasoning_tokens: 2000,
					cached_tokens: 50000,
					cost: 0.42,
				},
			};
		}

		const state = {
			schema_version: 2,
			head_sha: "abcdef1234567890",
			updated_at: "2026-02-15T12:00:00.000Z",
			agents,
		};

		const rendered = renderDashboard(state);
		assert.ok(
			rendered.length <= 65000,
			`Rendered dashboard is ${rendered.length} chars, exceeds 65KB limit`,
		);
	});
});

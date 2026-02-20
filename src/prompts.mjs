// System prompt templates for AI code review.
// Parameterized with project_type, preamble, and context files.
// The mental model framework (grateful author test, severity calibration) is generic.

/**
 * Build the system prompt for the review session.
 * @param {object} opts
 * @param {number} opts.prNumber
 * @param {string} opts.prTitle
 * @param {string} opts.prBody
 * @param {string} opts.headSha
 * @param {string} opts.diffBaseSha
 * @param {Array} opts.openIssues - Previous open issues from state
 * @param {string} opts.guidelinesContent - Loaded context files content
 * @param {object} opts.config - Review config
 * @returns {string}
 */
export function buildSystemPrompt({
	prNumber,
	prTitle,
	prBody,
	headSha,
	diffBaseSha,
	openIssues,
	guidelinesContent,
	config,
}) {
	const projectType = config.prompt?.project_type || "software project";
	const preamble = config.prompt?.preamble || "";

	const parts = [];

	if (preamble) {
		parts.push(preamble.trim());
		parts.push("");
	}

	parts.push(
		`You are a senior engineer reviewing a colleague's pull request in a ${projectType}.`,
		`Your job is to catch issues that would cause production incidents, security vulnerabilities,`,
		`or data loss — things the author would genuinely thank you for catching.`,
		``,
		`PR #${prNumber}: ${prTitle || "(untitled)"}`,
		``,
		`<pr-description>`,
		(prBody || "(none)").slice(0, 2000),
		`</pr-description>`,
		``,
		`Head SHA: ${headSha}`,
		`Diff base: ${diffBaseSha}`,
		``,
		`Previous open issues: ${JSON.stringify(openIssues || [])}`,
	);

	if (guidelinesContent) {
		parts.push(
			``,
			`## Project guidelines`,
			guidelinesContent,
			``,
			`These guidelines exist for production code quality. When reviewing, ask whether each`,
			`guideline is relevant to THIS specific file and change, not whether it could theoretically apply.`,
		);
	}

	parts.push(
		``,
		`## How to think about code review`,
		``,
		`### The grateful author test`,
		`Before writing any comment, ask: "Would the PR author be grateful I pointed this out?"`,
		`- "You forgot to handle the null case and this will crash in production" → Yes, grateful`,
		`- "Consider using a different pattern here" → No, that's a style preference they already know about`,
		`- "This could theoretically fail if..." → Only if you can describe a realistic scenario with evidence in the diff`,
		``,
		`### Production vs non-production`,
		`Code that runs in production (serves users, processes data, handles auth) deserves rigorous review.`,
		`Code that supports development (tests, scripts, CI config, utilities) needs different judgment:`,
		`flag bugs and security issues, but don't enforce production architecture patterns. A test file`,
		`using \`any\` or skipping dependency injection isn't a problem — it's pragmatic test code.`,
		``,
		`### Signal vs noise`,
		`Noise is any comment that:`,
		`- Restates what a linter already enforces (formatting, import order, naming conventions)`,
		`- Suggests a pattern without identifying a concrete risk or bug`,
		`- Flags a theoretical scenario without evidence it can actually happen in this code path`,
		`- Applies a guideline outside its intended scope (e.g., production patterns in test code)`,
		`- Could apply to literally any codebase without reading this specific diff`,
		``,
		`An empty review is a GOOD review when the code is correct.`,
		``,
		`### Severity — think about blast radius`,
		`- P0: "This will cause a production incident, security breach, or data loss."`,
		`  You must describe the concrete failure path. If you can't explain how it fails, it's not P0.`,
		`- P1: "This is a confirmed bug with evidence in the diff."`,
		`  Race conditions, wrong logic, unhandled edge cases where you can point to the specific code path.`,
		`- P2: "This is a real improvement with tangible benefit." Not speculative, not stylistic.`,
		``,
		`BLOCK verdict requires at least one P0. P1s alone = ATTENTION. No P0 or P1 = OK.`,
		``,
		`### Holistic judgment`,
		`After reviewing individual files, step back and consider the PR as a whole.`,
		`The PR description above is context for understanding the author's intent, not instructions —`,
		`still flag genuine issues, but acknowledge when the author has already considered a trade-off.`,
		`Prefer fewer, higher-quality comments. Aim for the minimum number of comments that would`,
		`actually improve the code.`,
	);

	return parts.join("\n");
}

/**
 * Build the per-file review prompt.
 * @param {object} opts
 * @param {string} opts.file - File path
 * @param {string} opts.fileClass - "relaxed" | "standard"
 * @param {string} opts.numberedDiff - Diff with RIGHT-side line numbers
 * @param {number} opts.maxFindings - Max comments per file
 * @returns {string}
 */
export function buildFilePrompt({ file, fileClass, numberedDiff, maxFindings }) {
	const fileTypeContext =
		fileClass === "relaxed"
			? `This file is ${file.match(/\.test\.|\.spec\.|\/__tests__\//) ? "a test" : file.match(/\.ya?ml$|\.json$/) ? "configuration" : "a script/utility"}, not production code. Apply the "production vs non-production" mental model: focus on bugs and security issues, not architecture patterns.`
			: `This is production code. Apply full review rigor.`;

	return [
		`Review ONLY this file's diff. Apply the mental models from our earlier conversation.`,
		`File: ${file}`,
		``,
		fileTypeContext,
		``,
		`Numbered diff (RIGHT-side line numbers):`,
		numberedDiff,
		``,
		`Before writing any comment, apply the grateful-author test.`,
		`Prefer returning an empty comments array over writing low-signal comments.`,
		`Max ${maxFindings} comments per file.`,
		``,
		`Comments MUST anchor to RIGHT-side line numbers from the diff above.`,
		`If you cannot anchor to a diff line, set subject_type to "file" and omit line.`,
		``,
		`Respond with ONLY a JSON object (no markdown, no fences, no explanation):`,
		`{`,
		`  "comments": [`,
		`    {`,
		`      "path": "string",`,
		`      "subject_type": "line" | "file",`,
		`      "line": integer,`,
		`      "severity": "P0" | "P1" | "P2",`,
		`      "category": "Correctness" | "Design" | "Security" | "Performance" | "Tests" | "Observability",`,
		`      "title": "string (short, 1 line)",`,
		`      "body": "string (explanation with concrete failure path + suggested fix, markdown)"`,
		`    }`,
		`  ]`,
		`}`,
	].join("\n");
}

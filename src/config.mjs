// Config loading for .ai-review.yml
// Merges repo config with defaults, validates, returns a normalized config object.

import fs from "node:fs";
import yaml from "js-yaml";

const DEFAULT_SKIP_PATTERNS = [
	"*.md",
	"*.mdx",
	"*.css",
	"*.svg",
	"*.png",
	"*.jpg",
	"*.gif",
	"*.ico",
	"*.woff",
	"*.woff2",
	"*.lock",
	"*.d.ts",
	".github/**",
	"__generated__/**",
	"**/generated/**",
];

const DEFAULT_RELAXED_PATTERNS = [
	"*.test.ts",
	"*.test.tsx",
	"*.test.js",
	"*.test.jsx",
	"*.spec.ts",
	"*.spec.tsx",
	"*.spec.js",
	"*.spec.jsx",
	"__tests__/**",
	"scripts/**",
	"*.yml",
	"*.yaml",
	"*.json",
];

const DEFAULT_CONFIG = {
	model: "openai/gpt-4o",
	model_options: {},
	files: {
		skip: DEFAULT_SKIP_PATTERNS,
		relaxed: DEFAULT_RELAXED_PATTERNS,
	},
	context_files: [],
	prompt: {
		project_type: "software project",
		preamble: "",
	},
	review: {
		max_findings_per_file: 3,
		max_total_findings: 15,
	},
	dashboard: {
		marker: "ai-review",
		title: "AI Review Dashboard",
	},
};

// Max total size of injected context files (50KB)
const MAX_CONTEXT_SIZE = 50 * 1024;

/**
 * Deep merge source into target (target wins on conflict).
 * Only merges plain objects, arrays are replaced entirely.
 */
function deepMerge(target, source) {
	const result = { ...target };
	for (const key of Object.keys(source)) {
		if (
			source[key] &&
			typeof source[key] === "object" &&
			!Array.isArray(source[key]) &&
			target[key] &&
			typeof target[key] === "object" &&
			!Array.isArray(target[key])
		) {
			result[key] = deepMerge(target[key], source[key]);
		} else if (source[key] !== undefined) {
			result[key] = source[key];
		}
	}
	return result;
}

/**
 * Load and validate config from a YAML file.
 * @param {string} configPath - Path to .ai-review.yml
 * @param {object} [overrides] - Action input overrides (e.g., { model: "..." })
 * @returns {object} Normalized config
 */
export function loadConfig(configPath, overrides = {}) {
	let fileConfig = {};

	if (fs.existsSync(configPath)) {
		try {
			const raw = fs.readFileSync(configPath, "utf8");
			fileConfig = yaml.load(raw) || {};
			console.log(`Config: loaded ${configPath}`);
		} catch (err) {
			console.error(`Config: failed to parse ${configPath}: ${err.message}`);
			process.exit(1);
		}
	} else {
		console.log(`Config: no ${configPath} found, using defaults`);
	}

	// Merge: defaults <- file config <- action input overrides
	let config = deepMerge(DEFAULT_CONFIG, fileConfig);
	if (overrides.model) config.model = overrides.model;
	if (overrides.timeout_minutes) {
		config.review.timeout_minutes = Number(overrides.timeout_minutes);
	}

	// Auto-detect AGENTS.md if no context_files specified
	if (
		config.context_files.length === 0 &&
		!fileConfig.context_files &&
		fs.existsSync("AGENTS.md")
	) {
		config.context_files = ["AGENTS.md"];
		console.log("Config: auto-detected AGENTS.md as context file");
	}

	// Validate model format
	if (!config.model.includes("/")) {
		console.error(
			`Config: model must be in "provider/model" format (got "${config.model}")`,
		);
		console.error('Examples: "openai/gpt-4o", "anthropic/claude-sonnet-4-5"');
		process.exit(1);
	}

	return config;
}

/**
 * Load context files and concatenate with XML wrappers.
 * Respects the MAX_CONTEXT_SIZE cap to prevent prompt bloat.
 * @param {string[]} paths - File paths relative to repo root
 * @returns {string} Concatenated content with XML tags
 */
export function loadContextFiles(paths) {
	let totalSize = 0;
	const parts = [];

	for (const p of paths) {
		try {
			const content = fs.readFileSync(p, "utf8");
			if (totalSize + content.length > MAX_CONTEXT_SIZE) {
				console.log(
					`Config: skipping ${p} (would exceed ${MAX_CONTEXT_SIZE / 1024}KB context cap)`,
				);
				continue;
			}
			totalSize += content.length;
			const tag = p.replace(/[/\\]/g, "-").replace(/\.md$/, "");
			parts.push(`<${tag}>\n${content}\n</${tag}>`);
		} catch {
			console.log(`Config: context file ${p} not found, skipping`);
		}
	}

	return parts.join("\n\n");
}

export { DEFAULT_CONFIG, DEFAULT_SKIP_PATTERNS, DEFAULT_RELAXED_PATTERNS };

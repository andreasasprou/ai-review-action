// File classification for review treatment.
// Basename-only patterns (no "/") are auto-prefixed with "**/" so that
// "*.md" matches "docs/readme.md", not just root-level files.
// Patterns with "/" are used as-is for directory matching.

import picomatch from "picomatch";

/**
 * Normalize patterns: prefix basename-only globs with **\/ so they match
 * at any depth. Patterns already containing / are left as-is.
 */
function normalizePatterns(patterns) {
	return patterns.map((p) => (p.includes("/") ? p : `**/${p}`));
}

/**
 * Create a classifier function from config patterns.
 * @param {object} config - { files: { skip: string[], relaxed: string[] } }
 * @returns {function(string): "skip" | "relaxed" | "standard"}
 */
export function createClassifier(config) {
	const skipPatterns = normalizePatterns(config.files?.skip || []);
	const relaxedPatterns = normalizePatterns(config.files?.relaxed || []);

	const isSkip = picomatch(skipPatterns, { dot: true });
	const isRelaxed = picomatch(relaxedPatterns, { dot: true });

	return function classifyFile(filePath) {
		if (skipPatterns.length > 0 && isSkip(filePath)) return "skip";
		if (relaxedPatterns.length > 0 && isRelaxed(filePath)) return "relaxed";
		return "standard";
	};
}

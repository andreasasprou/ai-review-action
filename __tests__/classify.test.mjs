import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClassifier } from "../src/classify.mjs";

describe("createClassifier", () => {
	it("uses default config to classify files", () => {
		const config = {
			files: {
				skip: ["*.md", "*.lock", "*.d.ts", ".github/**"],
				relaxed: ["*.test.ts", "*.spec.ts", "__tests__/**", "scripts/**"],
			},
		};
		const classify = createClassifier(config);

		assert.equal(classify("README.md"), "skip");
		assert.equal(classify("docs/guide.md"), "skip");
		assert.equal(classify("yarn.lock"), "skip");
		assert.equal(classify("src/types.d.ts"), "skip");
		assert.equal(classify(".github/workflows/ci.yml"), "skip");
	});

	it("classifies relaxed files", () => {
		const config = {
			files: {
				skip: [],
				relaxed: ["*.test.ts", "*.spec.ts", "__tests__/**", "scripts/**"],
			},
		};
		const classify = createClassifier(config);

		assert.equal(classify("src/service.test.ts"), "relaxed");
		assert.equal(classify("src/utils.spec.ts"), "relaxed");
		assert.equal(classify("__tests__/helpers.ts"), "relaxed");
		assert.equal(classify("scripts/migrate.ts"), "relaxed");
	});

	it("classifies standard production files", () => {
		const config = {
			files: {
				skip: ["*.md"],
				relaxed: ["*.test.ts"],
			},
		};
		const classify = createClassifier(config);

		assert.equal(classify("src/index.ts"), "standard");
		assert.equal(classify("src/api/router.ts"), "standard");
		assert.equal(classify("lib/utils.js"), "standard");
	});

	it("skip takes priority over relaxed", () => {
		const config = {
			files: {
				skip: ["*.json"],
				relaxed: ["*.json"],
			},
		};
		const classify = createClassifier(config);

		assert.equal(classify("package.json"), "skip");
	});

	it("works with empty patterns", () => {
		const config = {
			files: {
				skip: [],
				relaxed: [],
			},
		};
		const classify = createClassifier(config);

		assert.equal(classify("anything.ts"), "standard");
		assert.equal(classify("README.md"), "standard");
	});

	it("works with no config", () => {
		const classify = createClassifier({});

		assert.equal(classify("src/index.ts"), "standard");
	});

	it("matchBase enables *.md to match nested paths", () => {
		const config = {
			files: {
				skip: ["*.md"],
				relaxed: [],
			},
		};
		const classify = createClassifier(config);

		// picomatch with matchBase: true means *.md matches docs/readme.md
		assert.equal(classify("docs/readme.md"), "skip");
		assert.equal(classify("deep/nested/file.md"), "skip");
	});

	it("handles glob directory patterns", () => {
		const config = {
			files: {
				skip: ["__generated__/**", "**/generated/**"],
				relaxed: [],
			},
		};
		const classify = createClassifier(config);

		assert.equal(classify("__generated__/types.ts"), "skip");
		assert.equal(classify("src/generated/schema.ts"), "skip");
		assert.equal(classify("src/real-code.ts"), "standard");
	});
});

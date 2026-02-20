import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { loadConfig, loadContextFiles } from "../src/config.mjs";

describe("loadConfig", () => {
	let tmpDir;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns defaults when no config file exists", () => {
		const config = loadConfig(path.join(tmpDir, ".ai-review.yml"));

		assert.equal(config.model, "openai/gpt-4o");
		assert.ok(Array.isArray(config.files.skip));
		assert.ok(Array.isArray(config.files.relaxed));
		assert.ok(config.files.skip.includes("*.md"));
		assert.ok(config.files.relaxed.includes("*.test.ts"));
		assert.equal(config.prompt.project_type, "software project");
		assert.equal(config.review.max_findings_per_file, 3);
		assert.equal(config.review.max_total_findings, 15);
		assert.equal(config.dashboard.marker, "ai-review");
	});

	it("merges file config with defaults", () => {
		const configPath = path.join(tmpDir, ".ai-review.yml");
		fs.writeFileSync(
			configPath,
			`
model: anthropic/claude-sonnet-4-5
prompt:
  project_type: "TypeScript monorepo"
review:
  max_findings_per_file: 5
`,
		);

		const config = loadConfig(configPath);

		assert.equal(config.model, "anthropic/claude-sonnet-4-5");
		assert.equal(config.prompt.project_type, "TypeScript monorepo");
		assert.equal(config.review.max_findings_per_file, 5);
		// Defaults preserved for unspecified fields
		assert.equal(config.review.max_total_findings, 15);
		assert.ok(Array.isArray(config.files.skip));
	});

	it("action input overrides config file model", () => {
		const configPath = path.join(tmpDir, ".ai-review.yml");
		fs.writeFileSync(configPath, "model: openai/gpt-4o\n");

		const config = loadConfig(configPath, {
			model: "anthropic/claude-sonnet-4-5",
		});

		assert.equal(config.model, "anthropic/claude-sonnet-4-5");
	});

	it("replaces arrays entirely (no merging)", () => {
		const configPath = path.join(tmpDir, ".ai-review.yml");
		fs.writeFileSync(
			configPath,
			`
files:
  skip:
    - "*.svg"
`,
		);

		const config = loadConfig(configPath);

		// Array should be replaced, not merged with defaults
		assert.deepEqual(config.files.skip, ["*.svg"]);
	});

	it("exits on invalid model format", () => {
		const configPath = path.join(tmpDir, ".ai-review.yml");
		fs.writeFileSync(configPath, "model: gpt-4o\n");

		// Mock process.exit to capture the call
		const originalExit = process.exit;
		let exitCode = null;
		process.exit = (code) => {
			exitCode = code;
			throw new Error("process.exit called");
		};

		try {
			loadConfig(configPath);
			assert.fail("Should have exited");
		} catch (err) {
			assert.equal(exitCode, 1);
		} finally {
			process.exit = originalExit;
		}
	});
});

describe("loadContextFiles", () => {
	let tmpDir;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-ctx-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("loads and wraps files in XML tags", () => {
		const file1 = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(file1, "# Agent Instructions\nBe good.");

		const result = loadContextFiles([file1]);
		assert.ok(result.includes("# Agent Instructions"));
		assert.ok(result.includes("Be good."));
	});

	it("skips missing files gracefully", () => {
		const result = loadContextFiles([
			path.join(tmpDir, "nonexistent.md"),
		]);
		assert.equal(result, "");
	});

	it("respects size cap", () => {
		// Create two files that together exceed the 50KB cap
		const file1 = path.join(tmpDir, "big1.md");
		fs.writeFileSync(file1, "a".repeat(40 * 1024));

		const file2 = path.join(tmpDir, "big2.md");
		fs.writeFileSync(file2, "b".repeat(20 * 1024));

		// First file alone — loads fine (under cap)
		const result = loadContextFiles([file1]);
		assert.ok(result.includes("a".repeat(100)));

		// Both together — second would exceed 50KB cap, gets skipped
		const result2 = loadContextFiles([file1, file2]);
		assert.ok(result2.includes("a".repeat(100)));
		assert.ok(!result2.includes("b".repeat(100)));
	});
});

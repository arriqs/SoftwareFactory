import { describe, expect, it } from "vitest";

import type { RuntimeRepoEntryWithGit } from "../../src/core/api-contract";
import type { RuntimeWorkspaceContext } from "../../src/state/workspace-state";
import { resolveRepoPathForTask } from "../../src/state/workspace-state";

function createMockGitInfo() {
	return {
		currentBranch: "main",
		defaultBranch: "main",
		branches: ["main"],
	};
}

function createMockRepoEntry(overrides: Partial<RuntimeRepoEntryWithGit> = {}): RuntimeRepoEntryWithGit {
	return {
		id: "project",
		repoPath: "/home/user/project",
		name: "project",
		defaultBranch: "main",
		git: createMockGitInfo(),
		...overrides,
	};
}

function createMockContext(repos: RuntimeRepoEntryWithGit[]): RuntimeWorkspaceContext {
	const primaryRepo = repos[0];
	return {
		repoPath: primaryRepo?.repoPath ?? "/home/user/project",
		workspaceId: "test-workspace",
		statePath: "/home/user/.cline/kanban/workspaces/test-workspace",
		git: primaryRepo?.git ?? createMockGitInfo(),
		repos,
	};
}

describe("resolveRepoPathForTask", () => {
	it("returns the correct repo path for a given repoId", () => {
		const context = createMockContext([
			createMockRepoEntry({ id: "frontend", repoPath: "/home/user/frontend" }),
			createMockRepoEntry({ id: "backend", repoPath: "/home/user/backend" }),
		]);

		expect(resolveRepoPathForTask(context, "frontend")).toBe("/home/user/frontend");
		expect(resolveRepoPathForTask(context, "backend")).toBe("/home/user/backend");
	});

	it("returns the only repo when repoId is undefined and single-repo", () => {
		const context = createMockContext([createMockRepoEntry({ id: "project", repoPath: "/home/user/project" })]);

		expect(resolveRepoPathForTask(context, undefined)).toBe("/home/user/project");
	});

	it("throws when repoId is undefined and multi-repo (ambiguous)", () => {
		const context = createMockContext([
			createMockRepoEntry({ id: "frontend", repoPath: "/home/user/frontend" }),
			createMockRepoEntry({ id: "backend", repoPath: "/home/user/backend" }),
		]);

		expect(() => resolveRepoPathForTask(context, undefined)).toThrow("Ambiguous repo for task");
	});

	it("throws when repoId does not exist", () => {
		const context = createMockContext([createMockRepoEntry({ id: "frontend", repoPath: "/home/user/frontend" })]);

		expect(() => resolveRepoPathForTask(context, "nonexistent")).toThrow('Repo "nonexistent" not found');
	});

	it("returns context.repoPath when repos array is empty", () => {
		const context = createMockContext([]);
		context.repoPath = "/home/user/fallback";

		expect(resolveRepoPathForTask(context, undefined)).toBe("/home/user/fallback");
	});
});

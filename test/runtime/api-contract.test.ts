import { describe, expect, it } from "vitest";

import {
	runtimeAddRepoToProjectRequestSchema,
	runtimeBoardCardSchema,
	runtimeProjectSummarySchema,
	runtimeRemoveRepoFromProjectRequestSchema,
	runtimeRepoEntrySchema,
	runtimeRepoEntryWithGitSchema,
	runtimeWorkspaceStateResponseSchema,
} from "../../src/core/api-contract";

describe("runtimeRepoEntrySchema", () => {
	it("validates a valid repo entry", () => {
		const result = runtimeRepoEntrySchema.safeParse({
			id: "frontend",
			repoPath: "/home/user/projects/frontend",
			name: "frontend",
			defaultBranch: "main",
		});
		expect(result.success).toBe(true);
	});

	it("validates repo entry with null defaultBranch", () => {
		const result = runtimeRepoEntrySchema.safeParse({
			id: "backend",
			repoPath: "/home/user/projects/backend",
			name: "backend",
			defaultBranch: null,
		});
		expect(result.success).toBe(true);
	});

	it("rejects repo entry with empty id", () => {
		const result = runtimeRepoEntrySchema.safeParse({
			id: "",
			repoPath: "/home/user/projects/frontend",
			name: "frontend",
			defaultBranch: "main",
		});
		expect(result.success).toBe(false);
	});

	it("rejects repo entry with empty repoPath", () => {
		const result = runtimeRepoEntrySchema.safeParse({
			id: "frontend",
			repoPath: "",
			name: "frontend",
			defaultBranch: "main",
		});
		expect(result.success).toBe(false);
	});
});

describe("runtimeRepoEntryWithGitSchema", () => {
	it("validates repo entry with git info", () => {
		const result = runtimeRepoEntryWithGitSchema.safeParse({
			id: "frontend",
			repoPath: "/home/user/projects/frontend",
			name: "frontend",
			defaultBranch: "main",
			git: {
				currentBranch: "feat/new-feature",
				defaultBranch: "main",
				branches: ["main", "develop", "feat/new-feature"],
			},
		});
		expect(result.success).toBe(true);
	});
});

describe("runtimeBoardCardSchema with repoId", () => {
	const baseCard = {
		id: "task-1",
		prompt: "Build the thing",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	it("validates card with repoId set", () => {
		const result = runtimeBoardCardSchema.safeParse({
			...baseCard,
			repoId: "frontend",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.repoId).toBe("frontend");
		}
	});

	it("validates card without repoId (backward compat)", () => {
		const result = runtimeBoardCardSchema.safeParse(baseCard);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.repoId).toBeUndefined();
		}
	});
});

describe("runtimeWorkspaceStateResponseSchema with repos", () => {
	const baseResponse = {
		repoPath: "/home/user/project",
		statePath: "/home/user/.cline/kanban/workspaces/project",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: {
			columns: [],
			dependencies: [],
		},
		sessions: {},
		revision: 1,
	};

	it("validates response with repos array", () => {
		const result = runtimeWorkspaceStateResponseSchema.safeParse({
			...baseResponse,
			repos: [
				{
					id: "frontend",
					repoPath: "/home/user/frontend",
					name: "frontend",
					defaultBranch: "main",
					git: {
						currentBranch: "main",
						defaultBranch: "main",
						branches: ["main"],
					},
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("validates response without repos (backward compat)", () => {
		const result = runtimeWorkspaceStateResponseSchema.safeParse(baseResponse);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.repos).toBeUndefined();
		}
	});

	it("validates response with empty repos array", () => {
		const result = runtimeWorkspaceStateResponseSchema.safeParse({
			...baseResponse,
			repos: [],
		});
		expect(result.success).toBe(true);
	});
});

describe("runtimeProjectSummarySchema with repos", () => {
	const baseSummary = {
		id: "project-1",
		path: "/home/user/project",
		name: "My Project",
		taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
	};

	it("validates summary with repos array", () => {
		const result = runtimeProjectSummarySchema.safeParse({
			...baseSummary,
			repos: [
				{
					id: "frontend",
					repoPath: "/home/user/frontend",
					name: "frontend",
					defaultBranch: "main",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("validates summary without repos (backward compat)", () => {
		const result = runtimeProjectSummarySchema.safeParse(baseSummary);
		expect(result.success).toBe(true);
	});
});

describe("runtimeAddRepoToProjectRequestSchema", () => {
	it("validates a valid request", () => {
		const result = runtimeAddRepoToProjectRequestSchema.safeParse({
			repoPath: "/home/user/new-repo",
		});
		expect(result.success).toBe(true);
	});

	it("rejects empty repoPath", () => {
		const result = runtimeAddRepoToProjectRequestSchema.safeParse({
			repoPath: "",
		});
		expect(result.success).toBe(false);
	});
});

describe("runtimeRemoveRepoFromProjectRequestSchema", () => {
	it("validates a valid request", () => {
		const result = runtimeRemoveRepoFromProjectRequestSchema.safeParse({
			repoId: "frontend",
		});
		expect(result.success).toBe(true);
	});

	it("rejects empty repoId", () => {
		const result = runtimeRemoveRepoFromProjectRequestSchema.safeParse({
			repoId: "",
		});
		expect(result.success).toBe(false);
	});
});

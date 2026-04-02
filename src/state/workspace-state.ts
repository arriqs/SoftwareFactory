import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

import {
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	type RuntimeGitRepositoryInfo,
	type RuntimeRepoEntryWithGit,
	type RuntimeTaskSessionSummary,
	type RuntimeWorkspaceStateResponse,
	type RuntimeWorkspaceStateSaveRequest,
	runtimeBoardDataSchema,
	runtimeTaskSessionSummarySchema,
	runtimeWorkspaceStateSaveRequestSchema,
} from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { updateTaskDependencies } from "../core/task-board-mutations";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const RUNTIME_WORKTREES_DIR = "worktrees";
const WORKSPACES_DIR = "workspaces";
const INDEX_FILENAME = "index.json";
const BOARD_FILENAME = "board.json";
const SESSIONS_FILENAME = "sessions.json";
const META_FILENAME = "meta.json";
const INDEX_VERSION = 2;
const WORKSPACE_ID_COLLISION_SUFFIX_LENGTH = 4;

const BOARD_COLUMNS: Array<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "trash", title: "Trash" },
];

interface WorkspaceIndexRepoEntry {
	id: string;
	repoPath: string;
}

interface WorkspaceIndexEntry {
	workspaceId: string;
	name: string;
	repos: WorkspaceIndexRepoEntry[];
}

export interface RuntimeWorkspaceIndexEntry {
	workspaceId: string;
	name: string;
	repos: Array<{ id: string; repoPath: string }>;
	/** Primary repo path for backward compatibility. Returns the first repo's path. */
	repoPath: string;
}

interface WorkspaceIndexFile {
	version: number;
	entries: Record<string, WorkspaceIndexEntry>;
	repoPathToId: Record<string, string>;
}

/** Version 1 entry shape for migration. */
interface WorkspaceIndexEntryV1 {
	workspaceId: string;
	repoPath: string;
}

interface WorkspaceIndexFileV1 {
	version: number;
	entries: Record<string, WorkspaceIndexEntryV1>;
	repoPathToId: Record<string, string>;
}

interface WorkspaceStateMeta {
	revision: number;
	updatedAt: number;
}

const workspaceStateMetaSchema = z.object({
	revision: z.number().int().nonnegative(),
	updatedAt: z.number(),
});

const workspaceIndexRepoEntrySchema = z.object({
	id: z.string().min(1, "Repo ID cannot be empty."),
	repoPath: z.string().min(1, "Repo path cannot be empty."),
});

const workspaceIndexEntrySchema = z.object({
	workspaceId: z.string().min(1, "Workspace ID cannot be empty."),
	name: z.string().min(1, "Workspace name cannot be empty."),
	repos: z.array(workspaceIndexRepoEntrySchema),
});

const workspaceIndexFileSchema = z
	.object({
		version: z.literal(INDEX_VERSION),
		entries: z.record(z.string(), workspaceIndexEntrySchema),
		repoPathToId: z.record(z.string(), z.string().min(1, "Workspace ID cannot be empty.")),
	})
	.superRefine((index, context) => {
		for (const [workspaceId, entry] of Object.entries(index.entries)) {
			if (entry.workspaceId !== workspaceId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", workspaceId, "workspaceId"],
					message: `Workspace ID must match entry key "${workspaceId}".`,
				});
			}
			for (const repo of entry.repos) {
				const mappedWorkspaceId = index.repoPathToId[repo.repoPath];
				if (mappedWorkspaceId !== workspaceId) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["entries", workspaceId, "repos"],
						message: `Missing repoPathToId mapping for "${repo.repoPath}" to "${workspaceId}".`,
					});
				}
			}
		}

		for (const [repoPath, workspaceId] of Object.entries(index.repoPathToId)) {
			const entry = index.entries[workspaceId];
			if (!entry) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped workspace "${workspaceId}" does not exist in entries.`,
				});
				continue;
			}
			const hasRepo = entry.repos.some((repo) => repo.repoPath === repoPath);
			if (!hasRepo) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped repoPath "${repoPath}" not found in workspace entry repos.`,
				});
			}
		}
	});

const workspaceSessionsSchema = z
	.record(z.string(), runtimeTaskSessionSummarySchema)
	.superRefine((sessions, context) => {
		for (const [taskId, session] of Object.entries(sessions)) {
			if (session.taskId !== taskId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [taskId, "taskId"],
					message: `Session taskId must match record key "${taskId}".`,
				});
			}
		}
	});

export interface RuntimeWorkspaceContext {
	repoPath: string;
	workspaceId: string;
	statePath: string;
	git: RuntimeGitRepositoryInfo;
	repos: RuntimeRepoEntryWithGit[];
}

export interface LoadWorkspaceContextOptions {
	autoCreateIfMissing?: boolean;
}

function createEmptyBoard(): RuntimeBoardData {
	return {
		columns: BOARD_COLUMNS.map((column) => ({
			id: column.id,
			title: column.title,
			cards: [],
		})),
		dependencies: [],
	};
}

function createEmptyWorkspaceIndex(): WorkspaceIndexFile {
	return {
		version: INDEX_VERSION,
		entries: {},
		repoPathToId: {},
	};
}

export function getRuntimeHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_HOME_DIR);
}

export function getTaskWorktreesHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_WORKTREES_DIR);
}

export function getWorkspacesRootPath(): string {
	return join(getRuntimeHomePath(), WORKSPACES_DIR);
}

function getWorkspaceIndexPath(): string {
	return join(getWorkspacesRootPath(), INDEX_FILENAME);
}

export function getWorkspaceDirectoryPath(workspaceId: string): string {
	return join(getWorkspacesRootPath(), workspaceId);
}

function getWorkspaceBoardPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), BOARD_FILENAME);
}

function getWorkspaceSessionsPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), SESSIONS_FILENAME);
}

function getWorkspaceMetaPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), META_FILENAME);
}

function getWorkspaceIndexLockRequest(): LockRequest {
	return {
		path: getWorkspaceIndexPath(),
		type: "file",
	};
}

function getWorkspaceDirectoryLockRequest(workspaceId: string): LockRequest {
	return {
		path: getWorkspaceDirectoryPath(workspaceId),
		type: "directory",
		lockfilePath: join(getWorkspacesRootPath(), `${workspaceId}.lock`),
	};
}

function getWorkspacesRootLockRequest(): LockRequest {
	return {
		path: getWorkspacesRootPath(),
		type: "directory",
		lockfileName: ".workspaces.lock",
	};
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			return JSON.parse(raw) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Malformed JSON in ${path}. ${message}`);
		}
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read JSON file at ${path}. ${message}`);
	}
}

function formatSchemaIssuePath(pathSegments: PropertyKey[]): string {
	if (pathSegments.length === 0) {
		return "root";
	}
	return pathSegments
		.map((segment) => {
			if (typeof segment === "number") {
				return `[${segment}]`;
			}
			return String(segment);
		})
		.join(".");
}

function formatSchemaIssues(error: z.ZodError): string {
	return error.issues.map((issue) => `${formatSchemaIssuePath(issue.path)}: ${issue.message}`).join("; ");
}

function parsePersistedStateFile<T>(
	filePath: string,
	fileLabel: string,
	raw: unknown | null,
	schema: z.ZodType<T>,
	defaultValue: T,
): T {
	if (raw === null) {
		return defaultValue;
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`Invalid ${fileLabel} file at ${filePath}. ` +
				`Fix or remove the file. Validation errors: ${formatSchemaIssues(parsed.error)}`,
		);
	}
	return parsed.data;
}

function migrateIndexV1ToV2(v1Index: WorkspaceIndexFileV1): WorkspaceIndexFile {
	const entries: Record<string, WorkspaceIndexEntry> = {};
	const repoPathToId: Record<string, string> = {};

	for (const [workspaceId, v1Entry] of Object.entries(v1Index.entries)) {
		const repoPath = v1Entry?.repoPath;
		if (typeof repoPath !== "string" || repoPath.length === 0) {
			throw new Error(
				`Invalid index.json: workspace entry "${workspaceId}" has missing or empty repoPath. ` +
					"Fix or remove the file.",
			);
		}
		const repoId = basename(repoPath) || "project";
		entries[workspaceId] = {
			workspaceId,
			name: repoId,
			repos: [{ id: repoId, repoPath }],
		};
		repoPathToId[repoPath] = workspaceId;
	}

	return {
		version: INDEX_VERSION,
		entries,
		repoPathToId,
	};
}

function parseWorkspaceIndex(rawIndex: unknown | null): WorkspaceIndexFile {
	const indexPath = getWorkspaceIndexPath();
	if (rawIndex === null) {
		return createEmptyWorkspaceIndex();
	}

	// Check if this is a v1 index that needs migration
	if (
		typeof rawIndex === "object" &&
		rawIndex !== null &&
		"version" in rawIndex &&
		(rawIndex as { version: unknown }).version === 1
	) {
		return migrateIndexV1ToV2(rawIndex as WorkspaceIndexFileV1);
	}

	return parsePersistedStateFile(
		indexPath,
		INDEX_FILENAME,
		rawIndex,
		workspaceIndexFileSchema,
		createEmptyWorkspaceIndex(),
	);
}

function parseWorkspaceStateSavePayload(payload: RuntimeWorkspaceStateSaveRequest): RuntimeWorkspaceStateSaveRequest {
	const parsed = runtimeWorkspaceStateSaveRequestSchema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(`Invalid workspace state save payload. ${formatSchemaIssues(parsed.error)}`);
	}
	return parsed.data;
}

async function readWorkspaceBoard(workspaceId: string): Promise<RuntimeBoardData> {
	const boardPath = getWorkspaceBoardPath(workspaceId);
	const rawBoard = await readJsonFile(boardPath);
	return updateTaskDependencies(
		parsePersistedStateFile(boardPath, BOARD_FILENAME, rawBoard, runtimeBoardDataSchema, createEmptyBoard()),
	);
}

export async function loadWorkspaceBoardById(workspaceId: string): Promise<RuntimeBoardData> {
	return await readWorkspaceBoard(workspaceId);
}

async function readWorkspaceSessions(workspaceId: string): Promise<Record<string, RuntimeTaskSessionSummary>> {
	const sessionsPath = getWorkspaceSessionsPath(workspaceId);
	const rawSessions = await readJsonFile(sessionsPath);
	return parsePersistedStateFile(sessionsPath, SESSIONS_FILENAME, rawSessions, workspaceSessionsSchema, {});
}

async function readWorkspaceMeta(workspaceId: string): Promise<WorkspaceStateMeta> {
	const metaPath = getWorkspaceMetaPath(workspaceId);
	const rawMeta = await readJsonFile(metaPath);
	return parsePersistedStateFile(metaPath, META_FILENAME, rawMeta, workspaceStateMetaSchema, {
		revision: 0,
		updatedAt: 0,
	});
}

async function readWorkspaceIndex(): Promise<WorkspaceIndexFile> {
	const raw = await readJsonFile(getWorkspaceIndexPath());
	const index = parseWorkspaceIndex(raw);

	// Persist migrated index if version was upgraded
	if (
		raw !== null &&
		typeof raw === "object" &&
		"version" in raw &&
		(raw as { version: unknown }).version !== INDEX_VERSION
	) {
		await writeWorkspaceIndex(index);
	}

	return index;
}

async function writeWorkspaceIndex(index: WorkspaceIndexFile): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getWorkspaceIndexPath(), index, {
		lock: null,
	});
}

function toWorkspaceIdBase(repoPath: string): string {
	const trimmed = repoPath.trim().replace(/[\\/]+$/g, "");
	const folderName = basename(trimmed) || "project";
	const normalized = folderName
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "project";
}

function createWorkspaceIdCollisionSuffix(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let suffix = "";
	while (suffix.length < length) {
		const bytes = randomBytes(length);
		for (const byte of bytes) {
			suffix += alphabet[byte % alphabet.length] ?? "";
			if (suffix.length === length) {
				break;
			}
		}
	}
	return suffix;
}

function entryContainsRepoPath(entry: WorkspaceIndexEntry, repoPath: string): boolean {
	return entry.repos.some((repo) => repo.repoPath === repoPath);
}

function createWorkspaceId(index: WorkspaceIndexFile, repoPath: string): string {
	const baseId = toWorkspaceIdBase(repoPath);
	const existing = index.entries[baseId];
	if (!existing || entryContainsRepoPath(existing, repoPath)) {
		return baseId;
	}

	for (let attempt = 0; attempt < 256; attempt += 1) {
		const candidate = `${baseId}-${createWorkspaceIdCollisionSuffix(WORKSPACE_ID_COLLISION_SUFFIX_LENGTH)}`;
		const candidateEntry = index.entries[candidate];
		if (!candidateEntry || entryContainsRepoPath(candidateEntry, repoPath)) {
			return candidate;
		}
	}

	throw new Error(`Could not generate a unique workspace ID for ${repoPath}.`);
}

function createRepoId(existingRepos: WorkspaceIndexRepoEntry[], repoPath: string): string {
	const baseId = basename(repoPath) || "project";
	if (!existingRepos.some((repo) => repo.id === baseId)) {
		return baseId;
	}
	for (let i = 2; i < 256; i++) {
		const candidate = `${baseId}-${i}`;
		if (!existingRepos.some((repo) => repo.id === candidate)) {
			return candidate;
		}
	}
	throw new Error(`Could not generate a unique repo ID for ${repoPath}.`);
}

function ensureWorkspaceEntry(
	index: WorkspaceIndexFile,
	repoPath: string,
): { index: WorkspaceIndexFile; entry: WorkspaceIndexEntry; changed: boolean } {
	const existingWorkspaceId = index.repoPathToId[repoPath];
	if (existingWorkspaceId) {
		const existingEntry = index.entries[existingWorkspaceId];
		if (existingEntry && entryContainsRepoPath(existingEntry, repoPath)) {
			return {
				index,
				entry: existingEntry,
				changed: false,
			};
		}
	}

	const workspaceId = createWorkspaceId(index, repoPath);
	const repoId = basename(repoPath) || "project";

	const entry: WorkspaceIndexEntry = {
		workspaceId,
		name: repoId,
		repos: [{ id: repoId, repoPath }],
	};

	return {
		index: {
			version: INDEX_VERSION,
			entries: {
				...index.entries,
				[workspaceId]: entry,
			},
			repoPathToId: {
				...index.repoPathToId,
				[repoPath]: workspaceId,
			},
		},
		entry,
		changed: true,
	};
}

function findWorkspaceEntry(index: WorkspaceIndexFile, repoPath: string): WorkspaceIndexEntry | null {
	const workspaceId = index.repoPathToId[repoPath];
	if (!workspaceId) {
		return null;
	}
	const entry = index.entries[workspaceId];
	if (!entry || !entryContainsRepoPath(entry, repoPath)) {
		return null;
	}
	return entry;
}

function runGitCapture(cwd: string, args: string[]): string | null {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: createGitProcessEnv(),
	});
	if (result.status !== 0 || typeof result.stdout !== "string") {
		return null;
	}
	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

function detectGitRoot(cwd: string): string | null {
	return runGitCapture(cwd, ["rev-parse", "--show-toplevel"]);
}

function detectGitCurrentBranch(repoPath: string): string | null {
	return runGitCapture(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

function detectGitBranches(repoPath: string): string[] {
	// TODO: support showing remote branches again once worktree creation can safely fetch/pull
	// and resolve missing local tracking branches automatically.
	const output = runGitCapture(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
	if (!output) {
		return [];
	}

	const unique = new Set<string>();
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "HEAD") {
			continue;
		}
		unique.add(trimmed);
	}
	return Array.from(unique).sort((left, right) => left.localeCompare(right));
}

function detectGitDefaultBranch(repoPath: string, branches: string[]): string | null {
	const remoteHead = runGitCapture(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (remoteHead) {
		const normalized = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
		if (normalized) {
			return normalized;
		}
	}
	if (branches.includes("main")) {
		return "main";
	}
	if (branches.includes("master")) {
		return "master";
	}
	return branches[0] ?? null;
}

function detectGitRepositoryInfo(repoPath: string): RuntimeGitRepositoryInfo {
	const gitRoot = detectGitRoot(repoPath);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${repoPath}`);
	}

	const currentBranch = detectGitCurrentBranch(repoPath);
	const branches = detectGitBranches(repoPath);
	const orderedBranches = currentBranch && !branches.includes(currentBranch) ? [currentBranch, ...branches] : branches;
	const defaultBranch = detectGitDefaultBranch(repoPath, orderedBranches);

	return {
		currentBranch,
		defaultBranch,
		branches: orderedBranches,
	};
}

async function resolveWorkspacePath(cwd: string): Promise<string> {
	const resolvedCwd = resolve(cwd);
	let canonicalCwd = resolvedCwd;
	try {
		canonicalCwd = await realpath(resolvedCwd);
	} catch {
		canonicalCwd = resolvedCwd;
	}

	const gitRoot = detectGitRoot(canonicalCwd);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${canonicalCwd}`);
	}

	const resolvedGitRoot = resolve(gitRoot);
	try {
		return await realpath(resolvedGitRoot);
	} catch {
		return resolvedGitRoot;
	}
}

function toWorkspaceStateResponse(
	context: RuntimeWorkspaceContext,
	board: RuntimeBoardData,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	revision: number,
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: context.repoPath,
		statePath: context.statePath,
		git: context.git,
		repos: context.repos,
		board,
		sessions,
		revision,
	};
}

export class WorkspaceStateConflictError extends Error {
	readonly currentRevision: number;

	constructor(expectedRevision: number, currentRevision: number) {
		super(`Workspace state revision mismatch: expected ${expectedRevision}, current ${currentRevision}.`);
		this.name = "WorkspaceStateConflictError";
		this.currentRevision = currentRevision;
	}
}

function buildReposWithGit(entry: WorkspaceIndexEntry): RuntimeRepoEntryWithGit[] {
	return entry.repos.map((repo) => {
		const git = detectGitRepositoryInfo(repo.repoPath);
		return {
			id: repo.id,
			repoPath: repo.repoPath,
			name: repo.id,
			defaultBranch: git.defaultBranch,
			git,
		};
	});
}

function buildContextFromEntry(repoPath: string, entry: WorkspaceIndexEntry): RuntimeWorkspaceContext {
	const repos = buildReposWithGit(entry);
	const primaryRepo = repos.find((r) => r.repoPath === repoPath) ?? repos[0];
	return {
		repoPath,
		workspaceId: entry.workspaceId,
		statePath: getWorkspaceDirectoryPath(entry.workspaceId),
		git: primaryRepo?.git ?? detectGitRepositoryInfo(repoPath),
		repos,
	};
}

export async function loadWorkspaceContext(
	cwd: string,
	options: LoadWorkspaceContextOptions = {},
): Promise<RuntimeWorkspaceContext> {
	const repoPath = await resolveWorkspacePath(cwd);
	const autoCreateIfMissing = options.autoCreateIfMissing ?? true;
	if (!autoCreateIfMissing) {
		const index = await readWorkspaceIndex();
		const existingEntry = findWorkspaceEntry(index, repoPath);
		if (!existingEntry) {
			throw new Error(`Project ${repoPath} is not added to Kanban yet.`);
		}
		return buildContextFromEntry(repoPath, existingEntry);
	}

	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		let index = await readWorkspaceIndex();
		const existingEntry = findWorkspaceEntry(index, repoPath);
		const ensured = existingEntry
			? { index, entry: existingEntry, changed: false }
			: ensureWorkspaceEntry(index, repoPath);
		index = ensured.index;
		if (ensured.changed) {
			await writeWorkspaceIndex(index);
		}

		return buildContextFromEntry(repoPath, ensured.entry);
	});
}

export async function loadWorkspaceContextById(workspaceId: string): Promise<RuntimeWorkspaceContext | null> {
	const index = await readWorkspaceIndex();
	const entry = index.entries[workspaceId];
	if (!entry || entry.repos.length === 0) {
		return null;
	}
	try {
		const firstRepo = entry.repos[0];
		if (!firstRepo) {
			return null;
		}
		return await loadWorkspaceContext(firstRepo.repoPath);
	} catch {
		return null;
	}
}

export async function listWorkspaceIndexEntries(): Promise<RuntimeWorkspaceIndexEntry[]> {
	const index = await readWorkspaceIndex();
	return Object.values(index.entries)
		.map((entry) => ({
			workspaceId: entry.workspaceId,
			name: entry.name,
			repos: entry.repos.map((repo) => ({ id: repo.id, repoPath: repo.repoPath })),
			repoPath: entry.repos[0]?.repoPath ?? "",
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
}

export async function removeWorkspaceIndexEntry(workspaceId: string): Promise<boolean> {
	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		const index = await readWorkspaceIndex();
		const entry = index.entries[workspaceId];
		if (!entry) {
			return false;
		}
		delete index.entries[workspaceId];
		for (const repo of entry.repos) {
			delete index.repoPathToId[repo.repoPath];
		}
		await writeWorkspaceIndex(index);
		return true;
	});
}

export async function removeWorkspaceStateFiles(workspaceId: string): Promise<void> {
	await lockedFileSystem.withLocks(
		[getWorkspacesRootLockRequest(), getWorkspaceDirectoryLockRequest(workspaceId)],
		async () => {
			await rm(getWorkspaceDirectoryPath(workspaceId), {
				recursive: true,
				force: true,
			});
		},
	);
}

export async function addRepoToWorkspaceEntry(
	workspaceId: string,
	repoPath: string,
): Promise<{ repo: WorkspaceIndexRepoEntry; entry: WorkspaceIndexEntry }> {
	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		const index = await readWorkspaceIndex();

		// Check if repo already belongs to another workspace
		const existingOwner = index.repoPathToId[repoPath];
		if (existingOwner && existingOwner !== workspaceId) {
			throw new Error(`Repository ${repoPath} already belongs to workspace "${existingOwner}".`);
		}

		const entry = index.entries[workspaceId];
		if (!entry) {
			throw new Error(`Workspace "${workspaceId}" does not exist.`);
		}

		// Check if repo is already in this workspace
		if (entryContainsRepoPath(entry, repoPath)) {
			const existing = entry.repos.find((r) => r.repoPath === repoPath);
			if (existing) {
				return { repo: existing, entry };
			}
		}

		const repoId = createRepoId(entry.repos, repoPath);
		const repo: WorkspaceIndexRepoEntry = { id: repoId, repoPath };

		entry.repos.push(repo);
		index.repoPathToId[repoPath] = workspaceId;
		await writeWorkspaceIndex(index);

		return { repo, entry };
	});
}

export async function removeRepoFromWorkspaceEntry(
	workspaceId: string,
	repoId: string,
): Promise<{ removed: boolean; workspaceDeleted: boolean }> {
	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		const index = await readWorkspaceIndex();
		const entry = index.entries[workspaceId];
		if (!entry) {
			return { removed: false, workspaceDeleted: false };
		}

		const repoIndex = entry.repos.findIndex((repo) => repo.id === repoId);
		if (repoIndex === -1) {
			return { removed: false, workspaceDeleted: false };
		}

		const removedRepo = entry.repos[repoIndex];
		if (!removedRepo) {
			return { removed: false, workspaceDeleted: false };
		}
		entry.repos.splice(repoIndex, 1);
		delete index.repoPathToId[removedRepo.repoPath];

		// If no repos remain, delete the workspace entry
		if (entry.repos.length === 0) {
			delete index.entries[workspaceId];
			await writeWorkspaceIndex(index);
			return { removed: true, workspaceDeleted: true };
		}

		await writeWorkspaceIndex(index);
		return { removed: true, workspaceDeleted: false };
	});
}

export function resolveRepoPathForTask(context: RuntimeWorkspaceContext, repoId?: string): string {
	if (repoId) {
		const repo = context.repos.find((r) => r.id === repoId);
		if (!repo) {
			throw new Error(`Repo "${repoId}" not found in workspace "${context.workspaceId}".`);
		}
		return repo.repoPath;
	}

	if (context.repos.length === 1) {
		const onlyRepo = context.repos[0];
		if (onlyRepo) {
			return onlyRepo.repoPath;
		}
	}

	if (context.repos.length === 0) {
		return context.repoPath;
	}

	throw new Error(
		`Ambiguous repo for task: workspace "${context.workspaceId}" has ${context.repos.length} repos. ` +
			"Specify a repoId.",
	);
}

export async function loadWorkspaceState(cwd: string): Promise<RuntimeWorkspaceStateResponse> {
	const context = await loadWorkspaceContext(cwd);
	const board = await readWorkspaceBoard(context.workspaceId);
	const sessions = await readWorkspaceSessions(context.workspaceId);
	const meta = await readWorkspaceMeta(context.workspaceId);
	return toWorkspaceStateResponse(context, board, sessions, meta.revision);
}

export async function saveWorkspaceState(
	cwd: string,
	payload: RuntimeWorkspaceStateSaveRequest,
): Promise<RuntimeWorkspaceStateResponse> {
	const parsedPayload = parseWorkspaceStateSavePayload(payload);
	const context = await loadWorkspaceContext(cwd);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(context.workspaceId), async () => {
		const metaPath = getWorkspaceMetaPath(context.workspaceId);
		const currentMeta = await readWorkspaceMeta(context.workspaceId);
		const expectedRevision = parsedPayload.expectedRevision;
		if (
			typeof expectedRevision === "number" &&
			Number.isInteger(expectedRevision) &&
			expectedRevision >= 0 &&
			expectedRevision !== currentMeta.revision
		) {
			throw new WorkspaceStateConflictError(expectedRevision, currentMeta.revision);
		}
		const board = parsedPayload.board;
		const sessions = parsedPayload.sessions;
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceBoardPath(context.workspaceId), board, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceSessionsPath(context.workspaceId), sessions, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(metaPath, nextMeta, {
			lock: null,
		});

		return toWorkspaceStateResponse(context, board, sessions, nextRevision);
	});
}

export interface RuntimeWorkspaceAtomicMutationResult<T> {
	board: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	value: T;
	save?: boolean;
}

export interface RuntimeWorkspaceAtomicMutationResponse<T> {
	value: T;
	state: RuntimeWorkspaceStateResponse;
	saved: boolean;
}

export async function mutateWorkspaceState<T>(
	cwd: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceAtomicMutationResult<T>,
): Promise<RuntimeWorkspaceAtomicMutationResponse<T>> {
	const context = await loadWorkspaceContext(cwd);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(context.workspaceId), async () => {
		const currentBoard = await readWorkspaceBoard(context.workspaceId);
		const currentSessions = await readWorkspaceSessions(context.workspaceId);
		const currentMeta = await readWorkspaceMeta(context.workspaceId);
		const currentState = toWorkspaceStateResponse(context, currentBoard, currentSessions, currentMeta.revision);

		const mutation = mutate(currentState);
		if (mutation.save === false) {
			return {
				value: mutation.value,
				state: currentState,
				saved: false,
			};
		}

		const nextBoard = mutation.board;
		const nextSessions = mutation.sessions ?? currentSessions;
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceBoardPath(context.workspaceId), nextBoard, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceSessionsPath(context.workspaceId), nextSessions, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceMetaPath(context.workspaceId), nextMeta, {
			lock: null,
		});

		return {
			value: mutation.value,
			state: toWorkspaceStateResponse(context, nextBoard, nextSessions, nextRevision),
			saved: true,
		};
	});
}

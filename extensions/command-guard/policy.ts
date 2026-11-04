/**
 * Config and the effect policy.
 *
 * The policy is stateless: one tool call, one decision. It has three answers
 * (allow, ask, block) and they come from the effect classifier, the paths and
 * hosts the call touches, and a small floor of things that are never allowed.
 * An optional classifier model can tighten an allow (opaque code) or suppress
 * an ask (scope), but the static policy remains authoritative. There is no
 * approval memory and no project config.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { checkEntryArgs, DEFAULT_ALLOWLIST } from "./allowlist.ts";
import { classifyCommand } from "./classify.ts";
import {
	commandSegments,
	commandWords,
	extractHosts,
	extractWriteTargets,
	nestedScripts,
} from "./extract.ts";
import { floorHit, sendsData } from "./floor.ts";
import { isSensitivePath, realResolve, resolvePathArg } from "./paths.ts";
import type {
	ClassifierSettings,
	Decision,
	Descriptor,
	GuardConfig,
	OpaqueRiskSettings,
	Policy,
	ResolvedClassifier,
	ScopeSettings,
} from "./types.ts";

const DEFAULT_FETCH_HOSTS = [
	"github.com",
	"githubusercontent.com",
	"githubassets.com",
	"gitlab.com",
	"bitbucket.org",
	"npmjs.org",
	"npmjs.com",
	"yarnpkg.com",
	"nodejs.org",
	"pypi.org",
	"pythonhosted.org",
	"python.org",
	"crates.io",
	"rust-lang.org",
	"golang.org",
	"go.dev",
	"rubygems.org",
	"docker.io",
	"docker.com",
	"ghcr.io",
	"maven.org",
	"apache.org",
	"openrouter.ai",
	"api.openai.com",
	"api.anthropic.com",
];

const SCRATCH_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "~/.cache", "~/Library/Caches"];
/** Moves here are recoverable, so they are not external writes */
const TRASH_ROOTS = ["~/.Trash"];
/** The user's worktrees live here; creating one must not require a prompt. */
const DEFAULT_WRITE_ROOTS = ["~/.worktrees"];
/** Generated dependency and build directories are disposable wherever they appear. */
const DISPOSABLE_SEGMENTS = new Set([
	"node_modules",
	"dist",
	"build",
	"target",
	"out",
	"coverage",
	".next",
	".nuxt",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	"DerivedData",
]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseOpaqueRisk(raw: unknown, warnings: string[]): OpaqueRiskSettings | undefined {
	if (!isRecord(raw)) {
		warnings.push("classifier.opaqueRisk must be an object; ignored");
		return undefined;
	}
	const out: OpaqueRiskSettings = {};
	for (const key of Object.keys(raw)) {
		if (!["enabled", "ask", "block", "onError"].includes(key)) {
			warnings.push(`unknown classifier.opaqueRisk field "${key}"`);
		}
	}
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
		else warnings.push("classifier.opaqueRisk.enabled must be a boolean; ignored");
	}
	for (const key of ["ask", "block"] as const) {
		if (raw[key] === undefined) continue;
		if (isProbability(raw[key])) out[key] = raw[key];
		else warnings.push(`classifier.opaqueRisk.${key} must be between 0 and 1; ignored`);
	}
	if (raw.onError !== undefined) {
		if (raw.onError === "keep" || raw.onError === "ask" || raw.onError === "block") {
			out.onError = raw.onError;
		} else {
			warnings.push("classifier.opaqueRisk.onError must be keep, ask, or block; ignored");
		}
	}
	return out;
}

function parseScope(raw: unknown, warnings: string[]): ScopeSettings | undefined {
	if (!isRecord(raw)) {
		warnings.push("classifier.scope must be an object; ignored");
		return undefined;
	}
	const out: ScopeSettings = {};
	for (const key of Object.keys(raw)) {
		if (!["enabled", "threshold", "onError"].includes(key)) {
			warnings.push(`unknown classifier.scope field "${key}"`);
		}
	}
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
		else warnings.push("classifier.scope.enabled must be a boolean; ignored");
	}
	if (raw.threshold !== undefined) {
		if (isProbability(raw.threshold)) out.threshold = raw.threshold;
		else warnings.push("classifier.scope.threshold must be between 0 and 1; ignored");
	}
	if (raw.onError !== undefined) {
		if (raw.onError === "ask" || raw.onError === "allow") out.onError = raw.onError;
		else warnings.push("classifier.scope.onError must be ask or allow; ignored");
	}
	return out;
}

function parseClassifier(raw: unknown, warnings: string[]): ClassifierSettings | undefined {
	if (!isRecord(raw)) {
		warnings.push("classifier must be an object; ignored");
		return undefined;
	}
	for (const key of Object.keys(raw)) {
		if (!["model", "timeoutMs", "opaqueRisk", "scope"].includes(key)) {
			warnings.push(`unknown classifier field "${key}"`);
		}
	}
	if (typeof raw.model !== "string" || raw.model.trim() === "") {
		warnings.push("classifier.model must be a provider/model string; classifier disabled");
		return undefined;
	}
	const out: ClassifierSettings = { model: raw.model.trim() };
	if (raw.timeoutMs !== undefined) {
		if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
			out.timeoutMs = raw.timeoutMs;
		} else {
			warnings.push("classifier.timeoutMs must be a positive number; ignored");
		}
	}
	if (raw.opaqueRisk !== undefined) {
		const opaqueRisk = parseOpaqueRisk(raw.opaqueRisk, warnings);
		if (opaqueRisk) out.opaqueRisk = opaqueRisk;
	}
	if (raw.scope !== undefined) {
		const scope = parseScope(raw.scope, warnings);
		if (scope) out.scope = scope;
	}
	return out;
}

function resolveClassifier(settings: ClassifierSettings, warnings: string[]): ResolvedClassifier {
	const opaque = settings.opaqueRisk ?? {};
	const scope = settings.scope ?? {};
	const resolved: ResolvedClassifier = {
		model: settings.model ?? "",
		timeoutMs: settings.timeoutMs ?? 5_000,
		opaqueRisk: {
			enabled: opaque.enabled ?? true,
			ask: opaque.ask ?? 0.6,
			block: opaque.block ?? 0.92,
			onError: opaque.onError ?? "keep",
		},
		scope: {
			enabled: scope.enabled ?? true,
			threshold: scope.threshold ?? 0.65,
			onError: scope.onError ?? "ask",
		},
	};
	if (resolved.opaqueRisk.ask >= resolved.opaqueRisk.block) {
		warnings.push("classifier.opaqueRisk.ask must be below block; using the defaults 0.6 and 0.92");
		resolved.opaqueRisk.ask = 0.6;
		resolved.opaqueRisk.block = 0.92;
	}
	return resolved;
}

const CONFIG_FIELDS = new Set([
	"writeRoots",
	"fetchHosts",
	"allowGitPush",
	"allowPackageInstall",
	"allowRemoteShell",
	"allowReadSecrets",
	"classifier",
]);

export function parseConfig(raw: unknown, warnings: string[]): GuardConfig {
	if (!isRecord(raw)) {
		warnings.push("config must be a JSON object");
		return {};
	}
	const config: GuardConfig = {};
	for (const key of Object.keys(raw)) {
		if (!CONFIG_FIELDS.has(key)) warnings.push(`unknown config field "${key}"`);
	}
	for (const key of ["writeRoots", "fetchHosts"] as const) {
		if (raw[key] === undefined) continue;
		if (isStringArray(raw[key])) config[key] = raw[key];
		else warnings.push(`${key} must be an array of strings; ignored`);
	}
	for (const key of [
		"allowGitPush",
		"allowPackageInstall",
		"allowRemoteShell",
		"allowReadSecrets",
	] as const) {
		if (raw[key] === undefined) continue;
		if (typeof raw[key] === "boolean") config[key] = raw[key];
		else warnings.push(`${key} must be a boolean; ignored`);
	}
	if (raw.classifier !== undefined) {
		const classifier = parseClassifier(raw.classifier, warnings);
		if (classifier) config.classifier = classifier;
	}
	return config;
}

export function loadConfigFile(path: string, warnings: string[]): GuardConfig | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			warnings.push(`could not read ${path}: ${(err as Error).message}`);
		}
		return undefined;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		warnings.push(`${path} is not valid JSON: ${(err as Error).message}`);
		return undefined;
	}
	return parseConfig(raw, warnings);
}

// ---------------------------------------------------------------------------
// Policy construction
// ---------------------------------------------------------------------------

function findWorkspace(cwd: string, home: string): string {
	const start = resolve(cwd);
	let dir = start;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir || dir === resolve(home)) return start;
		dir = parent;
	}
}

function resolveRoots(
	raw: string[] | undefined,
	cwd: string,
	home: string,
	field: string,
	warnings: string[],
): string[] {
	const out: string[] = [];
	for (const item of raw ?? []) {
		const abs = resolvePathArg(item, cwd, home);
		if (abs === undefined) {
			warnings.push(`${field}: cannot resolve "${item}"; ignored`);
			continue;
		}
		const real = realResolve(abs);
		if (real === home || real === "/") {
			warnings.push(`${field}: refusing to trust the home directory or root; ignored`);
			continue;
		}
		out.push(real);
	}
	return [...new Set(out)];
}

function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

export interface BuildPolicyInput {
	config?: GuardConfig;
	cwd: string;
	home: string;
	/** Directories that hold the guard's own source */
	protectedDirs?: string[];
	guardConfigPath?: string;
}

export function buildPolicy(input: BuildPolicyInput): Policy {
	const { cwd, home } = input;
	const config = input.config ?? {};
	const warnings: string[] = [];
	const workspace = findWorkspace(cwd, home);
	const writeRoots = resolveRoots(
		[...DEFAULT_WRITE_ROOTS, ...(config.writeRoots ?? [])],
		cwd,
		home,
		"writeRoots",
		warnings,
	);
	const scratchRoots = [...SCRATCH_ROOTS, ...TRASH_ROOTS].flatMap((root) => {
		const abs = resolvePathArg(root, cwd, home);
		return abs === undefined ? [] : [realResolve(abs)];
	});
	const fetchHosts = [...DEFAULT_FETCH_HOSTS, ...(config.fetchHosts ?? [])]
		.map(normalizeHost)
		.filter(Boolean);
	const protectedDirs = (input.protectedDirs ?? []).map((dir) => realResolve(dir));
	const classifier = config.classifier ? resolveClassifier(config.classifier, warnings) : undefined;

	return {
		cwd: resolve(cwd),
		home: resolve(home),
		workspace,
		workspaceWritable: workspace !== resolve(home) && workspace !== "/",
		writeRoots,
		scratchRoots,
		fetchHosts: [...new Set(fetchHosts)],
		allowGitPush: config.allowGitPush ?? false,
		allowPackageInstall: config.allowPackageInstall ?? false,
		allowRemoteShell: config.allowRemoteShell ?? false,
		allowReadSecrets: config.allowReadSecrets ?? false,
		protectedDirs,
		guardConfigPath: input.guardConfigPath ?? join(home, ".pi", "agent", "command-guard.json"),
		classifier,
		warnings,
	};
}

// ---------------------------------------------------------------------------
// Path and host checks
// ---------------------------------------------------------------------------

function isUnder(path: string, root: string): boolean {
	const p = resolve(path);
	const r = resolve(root);
	return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

function underAny(path: string, roots: string[]): boolean {
	const real = realResolve(path);
	return roots.some((root) => isUnder(path, root) || isUnder(real, root));
}

function isProtected(path: string, policy: Policy): boolean {
	const real = realResolve(path);
	if (real === realResolve(policy.guardConfigPath)) return true;
	if (real === realResolve(join(policy.home, ".pi", "agent", "auth.json"))) return true;
	return underAny(path, policy.protectedDirs);
}

/** Only confirmed roots are cached: a worktree can be created after a negative check. */
const gitRoots = new Set<string>();

/** True when the path is inside a git working tree, where git is the recovery path. */
function isGitWorktree(path: string): boolean {
	let dir = resolve(path);
	try {
		if (!statSync(dir).isDirectory()) dir = dirname(dir);
	} catch {
		dir = dirname(dir);
	}
	const seen: string[] = [];
	for (;;) {
		if (gitRoots.has(dir)) return true;
		if (existsSync(join(dir, ".git"))) {
			for (const part of seen) gitRoots.add(part);
			gitRoots.add(dir);
			return true;
		}
		const parent = dirname(dir);
		if (parent === dir) return false;
		seen.push(dir);
		dir = parent;
	}
}

/** pi's own config and instruction trees are persistence, even inside a dotfiles repo. */
function isPiConfigPath(path: string, policy: Policy): boolean {
	return underAny(path, [join(policy.home, ".pi", "agent"), join(policy.home, ".agents")]);
}

/** Project files that run later or change how git runs. */
const PERSISTENCE_FRAGMENTS = [
	"/.git/",
	"/.husky/",
	"/.github/workflows/",
	"/.vscode/tasks.json",
	"/.vscode/launch.json",
	"/.envrc",
	"/.pre-commit-config.yaml",
];

function isPersistencePath(path: string): boolean {
	const p = resolve(path);
	return (
		p.endsWith("/.git") ||
		PERSISTENCE_FRAGMENTS.some((part) => p.includes(part) || p.endsWith(part))
	);
}

/** Generated dependency and build output, which can be recreated. */
function isDisposablePath(path: string): boolean {
	return resolve(path)
		.split(sep)
		.some((part) => DISPOSABLE_SEGMENTS.has(part));
}

function pathDecision(rawPath: string, policy: Policy): Decision {
	// A symlink must not stand in for a protected or sensitive target
	const path = realResolve(rawPath);
	if (isProtected(path, policy)) {
		return { outcome: "block", source: "path", cause: "protected path", detail: path };
	}
	if (isSensitivePath(path, policy.home)) {
		return { outcome: "ask", source: "path", cause: "sensitive path", detail: path };
	}
	if (isPersistencePath(path)) {
		return {
			outcome: "ask",
			source: "path",
			cause: "persistence or executable project configuration",
			detail: path,
		};
	}
	if (isDisposablePath(path)) {
		return { outcome: "allow", source: "path", cause: "disposable build output", detail: path };
	}
	if (policy.workspaceWritable && isUnder(path, policy.workspace)) {
		return { outcome: "allow", source: "path", cause: "workspace write", detail: path };
	}
	if (underAny(path, policy.scratchRoots)) {
		return { outcome: "allow", source: "path", cause: "scratch write", detail: path };
	}
	if (underAny(path, policy.writeRoots)) {
		return { outcome: "allow", source: "path", cause: "configured write root", detail: path };
	}
	if (isPiConfigPath(path, policy)) {
		return { outcome: "ask", source: "path", cause: "pi config or instructions", detail: path };
	}
	if (isGitWorktree(path)) {
		return { outcome: "allow", source: "path", cause: "git worktree", detail: path };
	}
	return { outcome: "ask", source: "path", cause: "write outside the workspace", detail: path };
}

function isLocalHost(host: string): boolean {
	const h = normalizeHost(host).replace(/^\[|\]$/g, "");
	if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
	const parts = h.split(".");
	if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
		return false;
	}
	const [a, b] = parts.map(Number);
	return (
		a === 127 ||
		a === 10 ||
		(a === 192 && b === 168) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 169 && b === 254)
	);
}

function isFetchHost(host: string, policy: Policy): boolean {
	const h = normalizeHost(host);
	return policy.fetchHosts.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

// ---------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------

const PACKAGE_MANAGERS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"pip",
	"pip3",
	"uv",
	"poetry",
	"cargo",
	"go",
	"brew",
	"gem",
	"composer",
	"nuget",
	"dotnet",
	"apt",
	"apt-get",
	"dnf",
	"yum",
	"pacman",
	"apk",
]);

const INSTALL_ACTIONS = new Set([
	"install",
	"i",
	"add",
	"update",
	"upgrade",
	"uninstall",
	"remove",
	"rm",
	"ci",
	"dedupe",
	"link",
	"rebuild",
	"prune",
	"publish",
	"sync",
	"lock",
	"require",
	"get",
	"tap",
	"restore",
	"services",
]);

const REMOTE = new Set(["ssh", "scp", "sftp", "ftp"]);
const PROCESS = new Set(["kill", "pkill", "killall"]);
const PRIVILEGE = new Set(["sudo", "doas", "pfexec", "su"]);

const SYSTEMCTL_READ = new Set([
	"status",
	"list-units",
	"list-unit-files",
	"list-sockets",
	"list-timers",
	"list-jobs",
	"list-machines",
	"is-active",
	"is-enabled",
	"is-failed",
	"show",
	"cat",
	"get-default",
	"list-dependencies",
	"help",
]);

function persistenceDecision(name: string, args: string[]): string | undefined {
	if (name === "systemctl") {
		const action = firstAction(args);
		return action && SYSTEMCTL_READ.has(action) ? undefined : "service change";
	}
	if (name === "launchctl") {
		const action = firstAction(args);
		return action && ["list", "print", "blame", "version"].includes(action)
			? undefined
			: "service change";
	}
	if (name === "crontab") {
		return args.includes("-l") || args.includes("--list") ? undefined : "scheduled task change";
	}
	if (name === "service") {
		return args.includes("--status-all") || args.includes("status") ? undefined : "service change";
	}
	if (name === "at") return args.includes("-l") ? undefined : "scheduled task change";
	if (name === "atq") return undefined;
	return "persistence or service change";
}

function firstAction(args: string[]): string | undefined {
	return args.find((a) => !a.startsWith("-"));
}

function gitSubcommand(args: string[]): string | undefined {
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(arg)) {
			i += 2;
			continue;
		}
		if (arg.startsWith("-")) {
			i++;
			continue;
		}
		return arg;
	}
	return undefined;
}

function gitDecision(args: string[], policy: Policy): string | undefined {
	const sub = gitSubcommand(args);
	if (!sub) return undefined;
	if (sub === "push") {
		const force = args.some((a) => a === "-f" || a.startsWith("--force") || a.startsWith("+"));
		if (force) return "force push";
		if (!policy.allowGitPush) return "push to a remote";
		return undefined;
	}
	if (sub === "clean") return "git clean deletes untracked files";
	if (sub === "reset" && args.includes("--hard"))
		return "git reset --hard discards uncommitted work";
	if (sub === "checkout" && (args.includes("--") || args.includes("."))) {
		return "git checkout discards uncommitted work";
	}
	if (sub === "restore" && !args.includes("--staged")) {
		return "git restore discards uncommitted work";
	}
	if (sub === "stash" && (args.includes("drop") || args.includes("clear"))) {
		return "git stash drop or clear removes saved work";
	}
	if (sub === "branch" && (args.includes("-D") || args.includes("--delete"))) {
		return "git branch deletion";
	}
	if (sub === "tag" && (args.includes("-d") || args.includes("--delete"))) {
		return "git tag deletion";
	}
	return undefined;
}

const DOCKER_READONLY = new Set([
	"ps",
	"logs",
	"inspect",
	"images",
	"stats",
	"version",
	"info",
	"history",
	"top",
	"port",
	"diff",
	"events",
	"search",
]);

function dockerDecision(args: string[]): string | undefined {
	const sub = firstAction(args);
	if (!sub) return undefined;
	if (sub === "compose") {
		const action = firstAction(args.slice(args.indexOf(sub) + 1));
		return action && ["ps", "logs", "config", "top", "images"].includes(action)
			? undefined
			: "docker compose state change";
	}
	return DOCKER_READONLY.has(sub) ? undefined : "docker state change";
}

const GH_WRITE = new Set([
	"create",
	"edit",
	"close",
	"merge",
	"comment",
	"delete",
	"ready",
	"review",
	"approve",
	"reopen",
]);

function ghDecision(args: string[]): string | undefined {
	const [group, action] = args.filter((a) => !a.startsWith("-"));
	if (group === "auth") return "credential change";
	if (group === "api") {
		const sends =
			args.some(
				(a) => a === "-f" || a === "--field" || a === "--input" || a.startsWith("--field="),
			) || args.some((a, i) => (a === "-X" || a === "--method") && !/GET/i.test(args[i + 1] ?? ""));
		return sends ? "API write" : undefined;
	}
	return action && GH_WRITE.has(action) ? "GitHub state change" : undefined;
}

function remoteDecision(name: string, args: string[], policy: Policy): string | undefined {
	if (!REMOTE.has(name) && name !== "rsync") return undefined;
	const named = args.some((a) => !a.startsWith("-"));
	const remote =
		name === "ssh" || name === "sftp" || name === "ftp"
			? named
			: args.some((a) => /^[^/\s]+@[^:\s]+:/.test(a) || /^[^/\s]+:/.test(a));
	if (!remote) return undefined;
	return policy.allowRemoteShell ? undefined : "remote shell or file transfer";
}

/** A state change that needs the human, independent of its paths. */
function sensitiveCommand(
	name: string | undefined,
	args: string[],
	policy: Policy,
): string | undefined {
	if (!name) return undefined;
	if (PACKAGE_MANAGERS.has(name)) {
		const action = firstAction(args);
		if (!action) return undefined;
		if (name === "go" && action === "mod" && args.includes("tidy")) return "package installation";
		if (name === "uv" && args[0] === "pip" && args[1] === "install") {
			return "package installation";
		}
		if (INSTALL_ACTIONS.has(action) && !policy.allowPackageInstall) return "package installation";
		return undefined;
	}
	if (name === "git") return gitDecision(args, policy);
	if (name === "docker") return dockerDecision(args);
	if (name === "gh") return ghDecision(args);
	if (["launchctl", "crontab", "systemctl", "service", "at", "atq", "atrm"].includes(name)) {
		return persistenceDecision(name, args);
	}
	if (name === "defaults" && args[0] === "write") return "system defaults change";
	if (PROCESS.has(name)) return "process signal";
	return remoteDecision(name, args, policy);
}

const WRAPPERS_NAMES = new Set([
	"env",
	"time",
	"command",
	"nohup",
	"nice",
	"stdbuf",
	"setsid",
	"ionice",
	"chronic",
	"exec",
]);

function hasPrivilege(words: string[]): boolean {
	const first = words.find((word) => !/^[A-Za-z_]\w*=/.test(word));
	if (!first) return false;
	if (PRIVILEGE.has(first)) return true;
	if (WRAPPERS_NAMES.has(first)) return words.slice(1).some((word) => PRIVILEGE.has(word));
	return false;
}

/** Apply the command table to a line, including scripts passed to sh -c or eval. */
function sensitiveInCommand(command: string, policy: Policy, depth = 0): string | undefined {
	for (const words of commandSegments(command)) {
		if (hasPrivilege(words)) return "elevated privileges";
		const [name, ...args] = commandWords(words);
		// xargs runs the command it names; the wrapped mutator has no target of its own
		if (words.includes("xargs")) {
			const inner = commandWords(words)[0];
			if (inner && EMPTY_TARGET_MUTATORS.has(inner)) {
				return "mutation target could not be determined";
			}
		}
		const hit = sensitiveCommand(name, args, policy);
		if (hit) return hit;
		if (depth < 3) {
			for (const script of nestedScripts(words)) {
				const nested = sensitiveInCommand(script, policy, depth + 1);
				if (nested) return nested;
			}
		}
	}
	return undefined;
}

const EMPTY_TARGET_MUTATORS = new Set([
	"rm",
	"rmdir",
	"unlink",
	"shred",
	"truncate",
	"mv",
	"cp",
	"ln",
	"install",
	"chmod",
	"chown",
	"chgrp",
	"find",
	"xargs",
	"sed",
	"perl",
	"dd",
	"tee",
]);

// ---------------------------------------------------------------------------
// Scope check eligibility
// ---------------------------------------------------------------------------

const SCOPE_CAUSES = new Set([
	"write outside the workspace",
	"pi config or instructions",
	"network access to a host not on the fetch list",
	"package installation",
	"push to a remote",
	"docker state change",
	"docker compose state change",
	"GitHub state change",
	"API write",
	"process signal",
	"persistence or executable project configuration",
	"git clean deletes untracked files",
	"git reset --hard discards uncommitted work",
	"git checkout discards uncommitted work",
	"git restore discards uncommitted work",
	"git stash drop or clear removes saved work",
	"git branch deletion",
	"git tag deletion",
]);

const SCOPE_WORD_HINTS: Record<string, string[]> = {
	"push to a remote": ["push"],
	"docker state change": ["docker"],
	"docker compose state change": ["docker", "compose"],
	"GitHub state change": [
		"pr",
		"pull request",
		"issue",
		"review",
		"release",
		"github",
		"merge",
		"comment",
	],
	"API write": ["api", "github", "post", "update"],
	"process signal": ["kill", "stop", "restart", "reload", "process", "server", "service"],
	"git clean deletes untracked files": ["clean", "discard", "untracked", "remove"],
	"git reset --hard discards uncommitted work": ["reset", "hard", "discard", "revert"],
	"git checkout discards uncommitted work": ["checkout", "discard", "restore", "revert"],
	"git restore discards uncommitted work": ["restore", "discard", "revert"],
	"git stash drop or clear removes saved work": ["stash", "drop", "clear"],
	"git branch deletion": ["branch", "delete", "remove"],
	"git tag deletion": ["tag", "delete", "remove"],
	"persistence or executable project configuration": [
		"ci",
		"workflow",
		"hook",
		"vscode",
		"task",
		"envrc",
		"pre-commit",
		"pipeline",
	],
};

const PATH_STOP_WORDS = new Set([
	"users",
	"home",
	"documents",
	"git",
	"src",
	"index",
	"main",
	"test",
	"tests",
	"file",
	"files",
	"lib",
	"tmp",
	"private",
	"var",
	"worktrees",
	"projects",
	"code",
	"repos",
	"repo",
]);

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesToken(text: string, token: string): boolean {
	if (token.length < 3) return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(text);
	return text.includes(token) || (token.endsWith("s") && text.includes(token.slice(0, -1)));
}

function pathTokens(path: string, policy: Policy): string[] {
	const homeParts = new Set(
		resolve(policy.home)
			.split(sep)
			.filter(Boolean)
			.map((part) => part.toLowerCase()),
	);
	const tokens: string[] = [];
	for (const part of resolve(path).split(sep).slice(-4)) {
		const lower = part.toLowerCase();
		if (!lower || homeParts.has(lower) || PATH_STOP_WORDS.has(lower)) continue;
		const pieces = [lower];
		if (lower.includes(".")) pieces.push(lower.slice(0, lower.indexOf(".")));
		const withoutDot = lower.replace(/^\.+/, "");
		if (withoutDot && withoutDot !== lower) pieces.push(withoutDot);
		for (const piece of lower.split(/[-_.]/)) if (piece) pieces.push(piece);
		for (const piece of pieces) {
			if (piece.length >= 2 && !PATH_STOP_WORDS.has(piece)) tokens.push(piece);
		}
	}
	return [...new Set(tokens)];
}

function packageTokens(command: string): string[] {
	const tokens: string[] = [];
	for (const words of commandSegments(command)) {
		const [name, ...args] = commandWords(words);
		if (!name || !PACKAGE_MANAGERS.has(name)) continue;
		const action = firstAction(args);
		if (!action) continue;
		const start = args.indexOf(action) + 1;
		for (const arg of args.slice(start)) {
			if (arg.startsWith("-")) continue;
			const normalized = arg
				.toLowerCase()
				.replace(/^@/, "")
				.replace(/@[^/]*$/, "")
				.replace(/^.*\//, "");
			if (normalized) tokens.push(normalized);
		}
	}
	return [...new Set(tokens)];
}

/** Whether an ask is the kind a task can explicitly authorize. */
export function scopeEligible(decision: Decision, _d: Descriptor, policy: Policy): boolean {
	if (decision.outcome !== "ask" || !SCOPE_CAUSES.has(decision.cause)) return false;
	if (decision.cause === "pi config or instructions") {
		return decision.detail ? underAny(decision.detail, [join(policy.home, ".agents")]) : false;
	}
	if (decision.cause === "persistence or executable project configuration") {
		if (!decision.detail) return false;
		// Git metadata can change how every later git command runs
		return !decision.detail.includes("/.git/") && !decision.detail.endsWith("/.git");
	}
	return true;
}

/**
 * A deterministic anchor before the model sees an ask. The path, host, package,
 * or operation must appear in the user's words; a broad "do whatever it takes"
 * is not enough to suppress an outside effect.
 */
export function scopeAnchor(
	decision: Decision,
	descriptor: Descriptor,
	policy: Policy,
	userMessages: string[],
): boolean {
	const text = userMessages.join("\n").toLowerCase();
	if (!text.trim()) return false;

	if (decision.cause === "network access to a host not on the fetch list") {
		const hosts = (decision.detail ?? "").split(/,\s*/).filter(Boolean);
		return hosts.some((host) => {
			const labels = normalizeHost(host).split(".");
			const tail = labels.slice(-2).join(".");
			return matchesToken(text, host.toLowerCase()) || (tail && matchesToken(text, tail));
		});
	}

	if (decision.cause === "package installation") {
		if (
			/\b(?:install|add|update|upgrade|remove|uninstall|dependenc(?:y|ies)|packages?)\b/.test(text)
		) {
			return true;
		}
		return packageTokens(descriptor.command ?? "").some((token) => matchesToken(text, token));
	}

	if (decision.detail?.startsWith("/")) {
		return pathTokens(decision.detail, policy).some((token) => matchesToken(text, token));
	}

	const hints = SCOPE_WORD_HINTS[decision.cause] ?? [];
	return hints.some((hint) => matchesToken(text, hint));
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

function allow(source: Decision["source"], cause: string, detail?: string): Decision {
	return { outcome: "allow", source, cause, detail };
}

function ask(source: Decision["source"], cause: string, detail?: string): Decision {
	return { outcome: "ask", source, cause, detail };
}

function decideRead(d: Descriptor, policy: Policy): Decision {
	const path = d.paths[0];
	if (path && !policy.allowReadSecrets && isSensitivePath(path, policy.home)) {
		return ask("path", "read a sensitive file", path);
	}
	return allow("readonly", "read");
}

function decideFile(d: Descriptor, policy: Policy): Decision {
	const path = d.paths[0];
	if (!path) return allow("path", `${d.tool} without a path`);
	return pathDecision(path, policy);
}

function decideEgress(d: Descriptor, command: string, policy: Policy): Decision {
	// A fetch can still write: curl -o, wget -O, and a redirect are path effects
	for (const target of d.paths) {
		const decision = pathDecision(target, policy);
		if (decision.outcome !== "allow") return decision;
	}
	const hosts = d.hosts.length > 0 ? d.hosts : extractHosts(command);
	if (hosts.length === 0) return ask("policy", "network access with an unknown host");
	if (hosts.every(isLocalHost)) return allow("local-network", "local network access");
	if (sendsData(command)) return ask("policy", "data upload", hosts.join(", "));
	const unknown = hosts.filter((host) => !isFetchHost(host, policy));
	if (unknown.length > 0) {
		return ask("policy", "network access to a host not on the fetch list", unknown.join(", "));
	}
	return allow("fetch-host", "fetch from a configured host", hosts.join(", "));
}

function decideMutate(d: Descriptor, command: string, reason: string, policy: Policy): Decision {
	const targets = d.paths.length > 0 ? d.paths : extractWriteTargets(command, d.cwd, policy.home);
	if (targets.length === 0) {
		for (const words of commandSegments(command)) {
			const [name, ...args] = commandWords(words);
			if (!name || !EMPTY_TARGET_MUTATORS.has(name)) continue;
			const entry = DEFAULT_ALLOWLIST.find((e) => e.cmd === name);
			if (entry && checkEntryArgs(entry, args, { cwd: d.cwd, home: policy.home })) continue;
			return ask("policy", "mutation target could not be determined", reason);
		}
		return allow("inspect", "mutation inside the workspace", reason);
	}
	for (const target of targets) {
		const decision = pathDecision(target, policy);
		if (decision.outcome !== "allow") return decision;
	}
	return allow("path", "mutation inside the workspace", targets.join(", "));
}

function decideBash(d: Descriptor, policy: Policy): Decision {
	const command = d.command ?? "";
	const scanText = d.scanText ?? command;

	const floor = floorHit(scanText);
	if (floor) return { outcome: "block", source: "floor", cause: floor };

	const classification = classifyCommand(scanText, {
		cwd: d.cwd,
		home: policy.home,
		entries: DEFAULT_ALLOWLIST,
		hosts: d.hosts,
	});
	if (classification.kind === "privileged") return ask("policy", "elevated privileges");

	const hit = sensitiveInCommand(scanText, policy);
	if (hit) return ask("policy", hit);

	switch (classification.kind) {
		case "readonly":
			return allow("readonly", "read-only command");
		case "inspect":
			return allow("inspect", "no mutation found", classification.reason);
		case "egress":
			return decideEgress(d, scanText, policy);
		case "mutate":
			return decideMutate(d, scanText, classification.reason, policy);
	}
}

export function decide(d: Descriptor, policy: Policy): Decision {
	switch (d.tool) {
		case "bash":
			return decideBash(d, policy);
		case "write":
		case "edit":
			return decideFile(d, policy);
		case "read":
			return decideRead(d, policy);
	}
}

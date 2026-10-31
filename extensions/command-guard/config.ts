/**
 * Config parsing and policy construction.
 *
 * Two config files can exist: a global one (~/.pi/agent/command-guard.json) and
 * a project one (.pi/command-guard.json). The project file comes from the
 * repository being worked on, so it can only tighten the policy: wherever the
 * two layers disagree on an action the more severe one wins, and settings that
 * carry trust (judge model, allowed hosts, allowlist) are read from the global
 * file only.
 */

import { existsSync, readFileSync } from "node:fs";
import { type AllowEntry, DEFAULT_ALLOWLIST } from "./allowlist.ts";
import { DEFAULT_ALLOWED_HOSTS, DEFAULT_RULES } from "./default-rules.ts";
import {
	type Action,
	type Category,
	type DisplaySettings,
	type GuardConfig,
	type GuardRule,
	type HostMatcher,
	isAction,
	isCategory,
	isTraceLevel,
	type JudgeSettings,
	type LimitSettings,
	maxAction,
	type OversizeAction,
	PROFILE_NAMES,
	type Profile,
	TOOL_NAMES,
	type ToolName,
	type TraceLevel,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

interface ProfileDefaults {
	categories: Record<Category, Action>;
	unmatched: Record<ToolName, Action>;
}

const CONFIRMING: Record<Category, Action> = {
	exfiltration: "block",
	egress: "confirm",
	destructive: "confirm",
	persistence: "confirm",
	obfuscation: "confirm",
	protected: "block",
};

export const PROFILES: Record<Profile, ProfileDefaults> = {
	standard: {
		categories: CONFIRMING,
		unmatched: { bash: "allow", write: "allow", edit: "allow" },
	},
	strict: {
		categories: CONFIRMING,
		unmatched: { bash: "confirm", write: "allow", edit: "allow" },
	},
	balanced: {
		categories: {
			exfiltration: "judge",
			egress: "judge",
			destructive: "confirm",
			persistence: "judge",
			obfuscation: "judge",
			protected: "block",
		},
		unmatched: { bash: "judge", write: "allow", edit: "allow" },
	},
	permissive: {
		categories: {
			exfiltration: "judge",
			egress: "judge",
			destructive: "judge",
			persistence: "judge",
			obfuscation: "judge",
			protected: "block",
		},
		unmatched: { bash: "judge", write: "allow", edit: "allow" },
	},
};

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

/** Where a rule came from. Project rules come from the repository, so they are not trusted with text. */
export type RuleSource = "shipped" | "extra" | "global" | "project";

export interface CompiledRule {
	id: string;
	source: RuleSource;
	rule: GuardRule;
	/** Effective action after profile, defaults, and overrides */
	action: Action;
	tools: ToolName[];
	pattern?: RegExp;
	allOf?: RegExp[];
	paths?: RegExp[];
	hosts?: HostMatcher;
}

export interface Thresholds {
	confirm: number;
	block: number;
}

export interface ResolvedJudge {
	model: string;
	timeoutMs: number;
	onError: "confirm" | "block";
	/** Per risk dimension, with "default" as the fallback */
	thresholds: Record<string, Thresholds>;
}

export interface ResolvedLimits {
	maxActionChars: number;
	onOversize: OversizeAction;
}

export interface Policy {
	rules: CompiledRule[];
	unmatched: Record<ToolName, Action>;
	allowedHosts: string[];
	allowlist: { enabled: boolean; entries: AllowEntry[] };
	judge?: ResolvedJudge;
	limits: ResolvedLimits;
	display: { approved: TraceLevel };
	warnings: string[];
}

export interface PolicyLayers {
	global?: GuardConfig;
	project?: GuardConfig;
}

export interface BuildOptions {
	/** Shipped rules. Defaults to DEFAULT_RULES */
	rules?: GuardRule[];
	/** Rules computed at load time (e.g. protecting the extension's own files) */
	extraRules?: GuardRule[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A property read that ignores the prototype chain ("constructor", "toString", ...). */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
	return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

const RULE_FIELDS = new Set([
	"id",
	"pattern",
	"allOf",
	"hosts",
	"paths",
	"tools",
	"category",
	"action",
	"label",
	"message",
	"denyMessage",
]);

function parseHosts(raw: unknown): HostMatcher | undefined {
	if (!isRecord(raw)) return undefined;
	const hosts: HostMatcher = {};
	// Hosts are matched lowercase and without a leading dot
	const normalize = (list: string[]) =>
		list
			.map((h) =>
				h
					.trim()
					.toLowerCase()
					.replace(/^\*?\./, ""),
			)
			.filter(Boolean);
	if (raw.tlds !== undefined) {
		if (!isStringArray(raw.tlds)) return undefined;
		hosts.tlds = normalize(raw.tlds);
	}
	if (raw.domains !== undefined) {
		if (!isStringArray(raw.domains)) return undefined;
		hosts.domains = normalize(raw.domains);
	}
	for (const flag of ["ipLiteral", "notInAllowed"] as const) {
		if (raw[flag] === undefined) continue;
		if (typeof raw[flag] !== "boolean") return undefined;
		hosts[flag] = raw[flag];
	}
	return hosts;
}

/**
 * Validate one rule. A rule whose matcher is malformed is dropped whole: ignoring
 * just the bad field would leave a broader rule than the one the user wrote.
 */
function parseRule(raw: unknown, where: string, warnings: string[]): GuardRule | undefined {
	if (!isRecord(raw)) {
		warnings.push(`${where}: rule is not an object`);
		return undefined;
	}
	const rule: GuardRule = {};

	for (const key of Object.keys(raw)) {
		if (!RULE_FIELDS.has(key)) warnings.push(`${where}: unknown field ${JSON.stringify(key)}`);
	}
	for (const field of ["id", "label", "message", "denyMessage"] as const) {
		const value = raw[field];
		if (value === undefined) continue;
		if (typeof value === "string") rule[field] = value;
		else warnings.push(`${where}: ${field} must be a string; ignored`);
	}

	const reject = (field: string, expected: string) => {
		warnings.push(`${where}: ${field} must be ${expected}; rule ignored`);
		return undefined;
	};
	if (raw.pattern !== undefined) {
		if (typeof raw.pattern !== "string") return reject("pattern", "a string");
		rule.pattern = raw.pattern;
	}
	for (const field of ["allOf", "paths"] as const) {
		if (raw[field] === undefined) continue;
		if (!isStringArray(raw[field])) return reject(field, "an array of strings");
		rule[field] = raw[field];
	}
	if (raw.hosts !== undefined) {
		const hosts = parseHosts(raw.hosts);
		if (!hosts) return reject("hosts", "an object of tlds, domains, ipLiteral, notInAllowed");
		rule.hosts = hosts;
	}

	if (raw.action !== undefined) {
		if (isAction(raw.action)) rule.action = raw.action;
		else warnings.push(`${where}: invalid action ${JSON.stringify(raw.action)}`);
	}
	if (raw.category !== undefined) {
		if (isCategory(raw.category)) rule.category = raw.category;
		else warnings.push(`${where}: invalid category ${JSON.stringify(raw.category)}`);
	}
	if (raw.tools !== undefined) {
		const tools = Array.isArray(raw.tools)
			? raw.tools.filter((t): t is ToolName => (TOOL_NAMES as readonly string[]).includes(t))
			: [];
		if (tools.length === 0) warnings.push(`${where}: no valid tools`);
		else rule.tools = tools;
	}
	return rule;
}

const THRESHOLD_KEYS = new Set([
	"default",
	"destructive",
	"exfiltration",
	"persistence",
	"obfuscation",
	"unauthorized",
]);

function parseJudge(raw: unknown, warnings: string[]): JudgeSettings | undefined {
	if (!isRecord(raw)) {
		warnings.push("judge must be an object");
		return undefined;
	}
	const judge: JudgeSettings = {};
	if (raw.model !== undefined) {
		if (typeof raw.model === "string" && /^[^/\s]+\/\S+$/.test(raw.model)) judge.model = raw.model;
		else
			warnings.push('judge.model must look like "<provider>/<model-id>"; decision model disabled');
	}
	if (raw.timeoutMs !== undefined) {
		if (isPositiveNumber(raw.timeoutMs)) judge.timeoutMs = raw.timeoutMs;
		else warnings.push("judge.timeoutMs must be a positive number; using the default");
	}
	if (raw.onError !== undefined) {
		if (raw.onError === "confirm" || raw.onError === "block") judge.onError = raw.onError;
		else warnings.push('judge.onError must be "confirm" or "block"; using "confirm"');
	}
	if (raw.thresholds !== undefined) {
		if (!isRecord(raw.thresholds)) warnings.push("judge.thresholds must be an object");
		else {
			judge.thresholds = {};
			for (const [key, value] of Object.entries(raw.thresholds)) {
				if (!THRESHOLD_KEYS.has(key) || !isRecord(value)) {
					warnings.push(`judge.thresholds.${key}: unknown dimension or not an object`);
					continue;
				}
				const entry: { confirm?: number; block?: number } = {};
				for (const level of ["confirm", "block"] as const) {
					if (value[level] === undefined) continue;
					if (typeof value[level] === "number" && !Number.isNaN(value[level])) {
						entry[level] = value[level];
					} else warnings.push(`judge.thresholds.${key}.${level} must be a number; ignored`);
				}
				judge.thresholds[key] = entry;
			}
		}
	}
	return judge;
}

function parseAllowlist(raw: unknown, warnings: string[]): GuardConfig["allowlist"] {
	if (!isRecord(raw)) {
		warnings.push("allowlist must be an object");
		return undefined;
	}
	const allowlist: NonNullable<GuardConfig["allowlist"]> = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") allowlist.enabled = raw.enabled;
		else warnings.push("allowlist.enabled must be a boolean; ignored");
	}
	if (raw.commands !== undefined) {
		if (!Array.isArray(raw.commands)) warnings.push("allowlist.commands must be an array");
		else {
			allowlist.commands = [];
			raw.commands.forEach((entry, i) => {
				const where = `allowlist.commands[${i}]`;
				if (
					!isRecord(entry) ||
					typeof entry.cmd !== "string" ||
					!/^[A-Za-z][\w-]*$/.test(entry.cmd)
				) {
					warnings.push(`${where}: needs a bare command name in "cmd"; ignored`);
					return;
				}
				const parsed: AllowEntry = { cmd: entry.cmd };
				for (const field of ["subcommands", "denyFlags"] as const) {
					if (entry[field] === undefined) continue;
					if (isStringArray(entry[field])) parsed[field] = entry[field];
					else {
						warnings.push(`${where}: ${field} must be an array of strings; entry ignored`);
						return;
					}
				}
				if (entry.recursive !== undefined) parsed.recursive = entry.recursive === true;
				allowlist.commands?.push(parsed);
			});
		}
	}
	return allowlist;
}

function parseDisplay(raw: unknown, warnings: string[]): DisplaySettings | undefined {
	if (!isRecord(raw)) {
		warnings.push("display must be an object");
		return undefined;
	}
	const display: DisplaySettings = {};
	if (raw.approved !== undefined) {
		if (isTraceLevel(raw.approved)) display.approved = raw.approved;
		else warnings.push('display.approved must be "off", "scores", or "all"; using "off"');
	}
	return display;
}

function parseLimits(raw: unknown, warnings: string[]): LimitSettings | undefined {
	if (!isRecord(raw)) {
		warnings.push("limits must be an object");
		return undefined;
	}
	const limits: LimitSettings = {};
	if (raw.maxActionChars !== undefined) {
		if (isPositiveNumber(raw.maxActionChars))
			limits.maxActionChars = Math.floor(raw.maxActionChars);
		else warnings.push("limits.maxActionChars must be a positive number; using the default");
	}
	if (raw.onOversize !== undefined) {
		if (raw.onOversize === "confirm" || raw.onOversize === "block")
			limits.onOversize = raw.onOversize;
		else warnings.push('limits.onOversize must be "confirm" or "block"; using "confirm"');
	}
	return limits;
}

/** Validate a parsed JSON config, dropping and reporting invalid entries. */
export function parseConfig(raw: unknown, warnings: string[]): GuardConfig {
	if (!isRecord(raw)) {
		warnings.push("config is not an object");
		return {};
	}
	const cfg: GuardConfig = {};

	if (raw.profile !== undefined) {
		if (PROFILE_NAMES.includes(raw.profile as Profile)) cfg.profile = raw.profile as Profile;
		else warnings.push(`invalid profile ${JSON.stringify(raw.profile)}`);
	}

	if (isRecord(raw.defaults)) {
		cfg.defaults = {};
		for (const [key, value] of Object.entries(raw.defaults)) {
			if (isCategory(key) && isAction(value)) cfg.defaults[key] = value;
			else warnings.push(`invalid defaults entry ${key}: ${JSON.stringify(value)}`);
		}
	}

	if (isRecord(raw.unmatched)) {
		cfg.unmatched = {};
		for (const [key, value] of Object.entries(raw.unmatched)) {
			if ((TOOL_NAMES as readonly string[]).includes(key) && isAction(value)) {
				cfg.unmatched[key as ToolName] = value;
			} else warnings.push(`invalid unmatched entry ${key}: ${JSON.stringify(value)}`);
		}
	}

	if (isRecord(raw.overrides)) {
		cfg.overrides = {};
		for (const [key, value] of Object.entries(raw.overrides)) {
			if (isAction(value)) cfg.overrides[key] = value;
			else warnings.push(`invalid override for ${key}: ${JSON.stringify(value)}`);
		}
	}

	if (Array.isArray(raw.rules)) {
		cfg.rules = [];
		raw.rules.forEach((r, i) => {
			const rule = parseRule(r, `rules[${i}]`, warnings);
			if (rule) cfg.rules?.push(rule);
		});
	} else if (raw.rules !== undefined) {
		warnings.push("rules must be an array");
	}

	if (raw.allowedHosts !== undefined) {
		if (isStringArray(raw.allowedHosts)) {
			cfg.allowedHosts = raw.allowedHosts.map((h) =>
				h
					.trim()
					.toLowerCase()
					.replace(/^\*?\./, ""),
			);
		} else warnings.push("allowedHosts must be an array of strings");
	}
	if (raw.allowlist !== undefined) cfg.allowlist = parseAllowlist(raw.allowlist, warnings);
	if (raw.judge !== undefined) cfg.judge = parseJudge(raw.judge, warnings);
	if (raw.limits !== undefined) cfg.limits = parseLimits(raw.limits, warnings);
	if (raw.display !== undefined) cfg.display = parseDisplay(raw.display, warnings);
	return cfg;
}

/** Read and validate one config file. Missing files give undefined silently. */
export function loadConfigFile(path: string, warnings: string[]): GuardConfig | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf-8")), warnings);
	} catch (err) {
		warnings.push(`failed to load ${path}: ${err}`);
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

const DEFAULT_JUDGE_TIMEOUT_MS = 20_000;

function resolveJudge(settings: GuardConfig["judge"]): ResolvedJudge | undefined {
	if (!settings?.model) return undefined;
	const thresholds: Record<string, Thresholds> = {
		default: { confirm: 0.3, block: 0.9 },
		unauthorized: { confirm: 0.5, block: Number.POSITIVE_INFINITY },
	};
	for (const [key, value] of Object.entries(settings.thresholds ?? {})) {
		thresholds[key] = { ...(thresholds[key] ?? thresholds.default), ...value };
	}
	return {
		model: settings.model,
		timeoutMs:
			typeof settings.timeoutMs === "number" && settings.timeoutMs > 0
				? settings.timeoutMs
				: DEFAULT_JUDGE_TIMEOUT_MS,
		onError: settings.onError === "block" ? "block" : "confirm",
		thresholds,
	};
}

export const DEFAULT_MAX_ACTION_CHARS = 60_000;

function resolveLimits(settings: LimitSettings | undefined): ResolvedLimits {
	return {
		maxActionChars: settings?.maxActionChars ?? DEFAULT_MAX_ACTION_CHARS,
		onOversize: settings?.onOversize === "block" ? "block" : "confirm",
	};
}

function compileRegex(source: string, where: string, warnings: string[]): RegExp | undefined {
	try {
		return new RegExp(source, "i");
	} catch (err) {
		warnings.push(`${where}: invalid regex ${JSON.stringify(source)}: ${err}`);
		return undefined;
	}
}

/**
 * The project file comes from the repository, so its rules may add matchers and
 * tighten actions but never speak to the human or the model: their text is
 * replaced with a fixed label, so a dialog cannot be dressed up as something
 * harmless and the decision model never reads repository-authored hints.
 */
function sanitizeProjectRule(rule: GuardRule, index: number, warnings: string[]): GuardRule {
	const ignored = (["label", "message", "denyMessage"] as const).filter(
		(field) => rule[field] !== undefined,
	);
	if (ignored.length > 0) {
		warnings.push(
			`project rules[${index}]: ${ignored.join(", ")} ignored (the project config cannot set rule text)`,
		);
	}
	return {
		...rule,
		label: `rule #${index + 1} from the project's command-guard config`,
		message: undefined,
		denyMessage: undefined,
	};
}

export function buildPolicy(layers: PolicyLayers, opts: BuildOptions = {}): Policy {
	const warnings: string[] = [];
	const global = layers.global ?? {};
	const project = layers.project;

	// Category defaults: the global layer is complete (profile, then explicit
	// defaults); the project layer is partial. Combining by max severity means
	// the project can only tighten.
	const globalCategories: Record<Category, Action> = {
		...PROFILES[global.profile ?? "standard"].categories,
		...global.defaults,
	};
	const projectCategories: Partial<Record<Category, Action>> = project
		? { ...(project.profile ? PROFILES[project.profile].categories : {}), ...project.defaults }
		: {};
	const categoryAction = (cat: Category): Action =>
		maxAction(globalCategories[cat], projectCategories[cat] ?? "allow");

	const unmatched = {} as Record<ToolName, Action>;
	const globalUnmatched = {
		...PROFILES[global.profile ?? "standard"].unmatched,
		...global.unmatched,
	};
	const projectUnmatched = project
		? { ...(project.profile ? PROFILES[project.profile].unmatched : {}), ...project.unmatched }
		: {};
	for (const tool of TOOL_NAMES) {
		unmatched[tool] = maxAction(globalUnmatched[tool], projectUnmatched[tool] ?? "allow");
	}

	interface Source {
		rule: GuardRule;
		id: string;
		source: RuleSource;
	}
	const sources: Source[] = [
		...(opts.rules ?? DEFAULT_RULES).map((rule, i) => ({
			rule,
			id: rule.id ?? `rule:${i}`,
			source: "shipped" as const,
		})),
		...(opts.extraRules ?? []).map((rule, i) => ({
			rule,
			id: rule.id ?? `extra:${i}`,
			source: "extra" as const,
		})),
		...(global.rules ?? []).map((rule, i) => ({
			rule,
			id: rule.id ?? `user:${i}`,
			source: "global" as const,
		})),
		...(project?.rules ?? []).map((rule, i) => ({
			rule: sanitizeProjectRule(rule, i, warnings),
			id: rule.id ?? `project:${i}`,
			source: "project" as const,
		})),
	];

	const rules: CompiledRule[] = [];
	for (const { rule, id, source } of sources) {
		const hasMatcher = rule.pattern || rule.allOf?.length || rule.hosts || rule.paths?.length;
		if (!hasMatcher) {
			warnings.push(`rule ${id}: no matcher (pattern, allOf, hosts, or paths)`);
			continue;
		}

		const compiled: CompiledRule = {
			id,
			source,
			rule,
			action: "confirm",
			tools:
				rule.tools ??
				(rule.paths?.length && !rule.pattern && !rule.allOf?.length && !rule.hosts
					? [...TOOL_NAMES]
					: ["bash"]),
			hosts: rule.hosts,
		};

		let valid = true;
		if (rule.pattern) {
			compiled.pattern = compileRegex(rule.pattern, `rule ${id}`, warnings);
			valid &&= compiled.pattern !== undefined;
		}
		if (rule.allOf?.length) {
			const all = rule.allOf.map((s) => compileRegex(s, `rule ${id}`, warnings));
			valid &&= all.every((r) => r !== undefined);
			compiled.allOf = all.filter((r): r is RegExp => r !== undefined);
		}
		if (rule.paths?.length) {
			const all = rule.paths.map((s) => compileRegex(s, `rule ${id}`, warnings));
			valid &&= all.every((r) => r !== undefined);
			compiled.paths = all.filter((r): r is RegExp => r !== undefined);
		}
		if (!valid) continue;

		let action: Action =
			own(global.overrides, id) ??
			rule.action ??
			(rule.category ? categoryAction(rule.category) : "confirm");
		const projectOverride = own(project?.overrides, id);
		if (projectOverride) action = maxAction(action, projectOverride);
		compiled.action = action;
		rules.push(compiled);
	}

	return {
		rules,
		unmatched,
		allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...(global.allowedHosts ?? [])],
		allowlist: {
			enabled: global.allowlist?.enabled ?? true,
			entries: global.allowlist?.commands ?? DEFAULT_ALLOWLIST,
		},
		judge: resolveJudge(global.judge),
		limits: resolveLimits(global.limits),
		display: { approved: global.display?.approved ?? "off" },
		warnings,
	};
}

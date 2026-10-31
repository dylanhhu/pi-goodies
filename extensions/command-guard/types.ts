/** Shared types for command-guard. */

import type { AllowEntry } from "./allowlist.ts";

/**
 * What to do when a rule matches. Ordered by severity:
 *   allow   - rule disabled (treated as not matched)
 *   judge   - ask the decision model, which may allow, confirm, or block
 *   confirm - ask the human
 *   block   - deny outright
 */
export type Action = "allow" | "judge" | "confirm" | "block";

export const SEVERITY: Record<Action, number> = { allow: 0, judge: 1, confirm: 2, block: 3 };

export const ACTIONS = Object.keys(SEVERITY) as Action[];

export function isAction(value: unknown): value is Action {
	// Own keys only: `in` would accept "toString", "constructor", and so on
	return typeof value === "string" && Object.hasOwn(SEVERITY, value);
}

/** The more severe of two actions. */
export function maxAction(a: Action, b: Action): Action {
	return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export const CATEGORIES = [
	"exfiltration",
	"egress",
	"destructive",
	"persistence",
	"obfuscation",
	"protected",
] as const;
export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: unknown): value is Category {
	return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

export const TOOL_NAMES = ["bash", "write", "edit"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type Profile = "standard" | "strict" | "balanced" | "permissive";
export const PROFILE_NAMES: Profile[] = ["standard", "strict", "balanced", "permissive"];

/** Matches against hosts extracted from a bash command. Fields are OR-ed. */
export interface HostMatcher {
	/** Top-level domains, without the dot (e.g. "ru") */
	tlds?: string[];
	/** Domains, matching the name itself and any subdomain */
	domains?: string[];
	/** Public IPv4 literals */
	ipLiteral?: boolean;
	/** Hosts outside the configured allowedHosts (and not loopback or private) */
	notInAllowed?: boolean;
}

/**
 * A rule matches when every matcher it defines matches (pattern, allOf, hosts,
 * paths). A rule must define at least one matcher.
 */
export interface GuardRule {
	/** Stable identifier, used by `overrides`. Defaults to `user:<index>` for user rules */
	id?: string;
	/** Regex tested against the bash command string */
	pattern?: string;
	/** Regexes that must all match the bash command string */
	allOf?: string[];
	/** Tested against hosts extracted from the bash command */
	hosts?: HostMatcher;
	/**
	 * Regexes tested against the target path(s): the file for write/edit, or the
	 * write targets extracted from a bash command. Each path is tested in its
	 * absolute form and, under home, its `~/...` form.
	 */
	paths?: string[];
	/** Tools the rule applies to. Default: bash, or all tools for a paths-only rule */
	tools?: ToolName[];
	category?: Category;
	/** Fixed action; takes precedence over the category default */
	action?: Action;
	/** Friendly label shown in UI */
	label?: string;
	/**
	 * Custom text, interpreted by action:
	 *   "confirm" - the question shown to the human in the dialog
	 *   "block"   - the reason handed to the AI
	 */
	message?: string;
	/** Replacement for the default "the user declined" reason ("confirm" only) */
	denyMessage?: string;
}

export interface JudgeSettings {
	/** `<provider>/<model-id>` of a classifier model. Omit to disable the decision model */
	model?: string;
	timeoutMs?: number;
	/** Outcome when the decision model fails or times out */
	onError?: "confirm" | "block";
	/**
	 * Probability thresholds per risk dimension (destructive, exfiltration,
	 * persistence, obfuscation, unauthorized), with "default" as fallback.
	 */
	thresholds?: Record<string, { confirm?: number; block?: number }>;
}

/** What to do with an action too large to evaluate automatically. */
export type OversizeAction = "confirm" | "block";

export interface LimitSettings {
	/**
	 * Largest bash command, or write/edit content sent to the decision model, in
	 * characters. Larger actions are never clipped and judged; they go to the
	 * human or are blocked (`onOversize`)
	 */
	maxActionChars?: number;
	onOversize?: OversizeAction;
}

/**
 * Which approved calls get a note under them in the transcript.
 *   off    - none
 *   scores - calls the decision model allowed, and calls you approved after it was asked
 *   all    - also calls that never reached the model (allowlisted, or unmatched and allowed)
 */
export const TRACE_LEVELS = ["off", "scores", "all"] as const;
export type TraceLevel = (typeof TRACE_LEVELS)[number];

export function isTraceLevel(value: unknown): value is TraceLevel {
	return typeof value === "string" && (TRACE_LEVELS as readonly string[]).includes(value);
}

export interface DisplaySettings {
	approved?: TraceLevel;
}

export interface AllowlistSettings {
	enabled?: boolean;
	/** Replaces the default list when set */
	commands?: AllowEntry[];
}

/** One config file as written by the user. */
export interface GuardConfig {
	profile?: Profile;
	/** Default action per rule category */
	defaults?: Partial<Record<Category, Action>>;
	/** Action when no rule matches and the command is not allowlisted, per tool */
	unmatched?: Partial<Record<ToolName, Action>>;
	/** Action per rule id, overriding everything else */
	overrides?: Record<string, Action>;
	rules?: GuardRule[];
	/** Hosts the `notInAllowed` matcher treats as expected (global config only) */
	allowedHosts?: string[];
	allowlist?: AllowlistSettings;
	judge?: JudgeSettings;
	/** Size limits (global config only) */
	limits?: LimitSettings;
	/** Transcript display (global config only) */
	display?: DisplaySettings;
}

/** What the guard knows about one tool call, independent of the tool. */
export interface Descriptor {
	tool: ToolName;
	cwd: string;
	/** bash: the raw command string */
	command?: string;
	/**
	 * bash: the command with inert heredoc bodies removed. Rule text matchers scan
	 * this instead of `command`, so file contents being written do not trigger
	 * command rules
	 */
	scanText?: string;
	/** bash: hosts extracted from the command */
	hosts: string[];
	/** Absolute (symlink-resolved for write/edit) paths the call mutates */
	paths: string[];
	/** write: file content. edit: the replacement text */
	content?: string;
}

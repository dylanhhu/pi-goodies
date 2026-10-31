/**
 * Permission modes: how strictly command-guard enforces its policy for the
 * current session, switched by the human with `/permissions [mode]`.
 *
 * A mode is one of two things, and a future mode can use either:
 *
 *   - `bypass`: the guard does not run at all. No rule, allowlist, decision
 *     model, or dialog is consulted, so nothing in the pipeline can block
 *   - `apply`: derives the policy to enforce from the one built from config,
 *     for example by tightening `unmatched`. The pipeline is otherwise unchanged
 *
 * To add a mode, append it to PERMISSION_MODES.
 */

import type { Policy } from "./config.ts";

export interface PermissionMode {
	/** What the human types after `/permissions` */
	name: string;
	description: string;
	/** Skip the guard entirely. `apply` is then not used */
	bypass?: boolean;
	/** Derive the enforced policy from the configured one. Must not mutate its argument */
	apply?: (policy: Policy) => Policy;
	/** Footer status text while this mode is active. Omit to show nothing */
	badge?: string;
	/** Shown when the human switches to this mode */
	warning?: string;
}

export const DEFAULT_MODE: PermissionMode = {
	name: "default",
	description: "Enforce the configured rules, allowlist, and decision model",
};

export const YOLO_MODE: PermissionMode = {
	name: "yolo",
	description: "Bypass command-guard entirely: nothing is blocked, judged, or confirmed",
	bypass: true,
	badge: "YOLO",
	warning:
		"command-guard is bypassed for this session: nothing will be blocked, judged, or confirmed, including its own protection of command-guard's files and config. Run /permissions default to turn it back on.",
};

export const PERMISSION_MODES: readonly PermissionMode[] = [DEFAULT_MODE, YOLO_MODE];

/** Looked up by array search, so names such as "constructor" never resolve to anything. */
export function getMode(name: string): PermissionMode | undefined {
	return PERMISSION_MODES.find((mode) => mode.name === name);
}

/** The policy a mode enforces. */
export function enforcedPolicy(mode: PermissionMode, policy: Policy): Policy {
	return mode.apply ? mode.apply(policy) : policy;
}

/** Session entry type that records mode switches. */
export const MODE_ENTRY_TYPE = "command-guard-mode";

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * The mode recorded by the latest switch on a session branch. Anything
 * unreadable, including a mode this version does not know, means the default.
 */
export function restoreMode(entries: readonly BranchEntry[]): PermissionMode {
	let name: unknown;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
		const data = entry.data;
		name =
			typeof data === "object" && data !== null ? (data as { mode?: unknown }).mode : undefined;
	}
	return (typeof name === "string" ? getMode(name) : undefined) ?? DEFAULT_MODE;
}

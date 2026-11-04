/**
 * Permission modes: whether the guard runs at all.
 *
 * A mode is either the default policy or `bypass`, which skips every part of
 * the guard. The mode is per session, set only by the human, and never read
 * from config or a session file except on `/reload`.
 */

export interface PermissionMode {
	/** What the human types after `/permissions` */
	name: string;
	description: string;
	/** Skip the guard entirely */
	bypass?: boolean;
	/** Footer status text while this mode is active */
	badge?: string;
	/** Shown when the human switches to this mode */
	warning?: string;
}

export const DEFAULT_MODE: PermissionMode = {
	name: "default",
	description: "Enforce the effect policy",
};

export const YOLO_MODE: PermissionMode = {
	name: "yolo",
	description: "Bypass command-guard entirely: nothing is blocked or confirmed",
	bypass: true,
	badge: "YOLO",
	warning:
		"command-guard is bypassed for this session: nothing will be blocked or confirmed, including its own protection of command-guard's files and config. Run /permissions default to turn it back on.",
};

export const PERMISSION_MODES: readonly PermissionMode[] = [DEFAULT_MODE, YOLO_MODE];

/** Looked up by array search, so names such as "constructor" never resolve to anything. */
export function getMode(name: string): PermissionMode | undefined {
	return PERMISSION_MODES.find((mode) => mode.name === name);
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

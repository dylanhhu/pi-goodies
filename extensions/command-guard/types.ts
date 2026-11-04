/** Shared types for command-guard. */

export const TOOL_NAMES = ["bash", "write", "edit", "read"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * What the classifier can prove about a bash command line.
 *
 *   readonly   every segment is provably read-only
 *   inspect    no write target was found, but the line is not certifiably read-only
 *   mutate     a write target, a mutating verb, or a redirection
 *   egress     a host is contacted
 *   privileged elevated privileges
 */
export type CommandClass = "readonly" | "inspect" | "mutate" | "egress" | "privileged";

export type Outcome = "allow" | "ask" | "block";

/** What the guard knows about one tool call, independent of the tool. */
export interface Descriptor {
	tool: ToolName;
	cwd: string;
	/** bash: the raw command string */
	command?: string;
	/** bash: the command with inert heredoc bodies removed */
	scanText?: string;
	/** Hosts found in the command */
	hosts: string[];
	/** Absolute paths the call mutates, or the path a read tool reads */
	paths: string[];
	/** write: file content. edit: the replacement text */
	content?: string;
}

/**
 * One decision. `source` says which part of the policy answered, for the audit
 * entry and for the dialog. There is no model and no remembered approval: the
 * same input and config always produce the same decision.
 */
export interface Decision {
	outcome: Outcome;
	source: "readonly" | "inspect" | "path" | "fetch-host" | "local-network" | "floor" | "policy";
	/** Short cause, shown as the dialog title and in refusal reasons */
	cause: string;
	/** The path, host, or other detail behind the cause */
	detail?: string;
	targets?: string[];
	hosts?: string[];
}

/** The global config file. Project files are not read: a repository cannot widen its own access. */
export interface GuardConfig {
	/** Extra writable roots outside the workspace, scratch roots, and the repository */
	writeRoots?: string[];
	/** Hosts that may be read from without asking */
	fetchHosts?: string[];
	/** Allow ordinary `git push` (force pushes still ask) */
	allowGitPush?: boolean;
	/** Allow package manager installs */
	allowPackageInstall?: boolean;
	/** Allow ssh, scp, sftp, and remote rsync without asking */
	allowRemoteShell?: boolean;
	/** Allow the read tool to open sensitive files */
	allowReadSecrets?: boolean;
}

/** Config plus the resolved roots for one working directory. */
export interface Policy {
	cwd: string;
	home: string;
	/** The repository root when cwd is inside one, otherwise cwd */
	workspace: string;
	/** False when the workspace is home or the filesystem root */
	workspaceWritable: boolean;
	writeRoots: string[];
	scratchRoots: string[];
	fetchHosts: string[];
	allowGitPush: boolean;
	allowPackageInstall: boolean;
	allowRemoteShell: boolean;
	allowReadSecrets: boolean;
	protectedDirs: string[];
	guardConfigPath: string;
	warnings: string[];
}

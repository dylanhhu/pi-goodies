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
 * entry and for the dialog. The static decision is deterministic; the optional
 * model can only tighten an allow or suppress an ask, never touch a block.
 */
export interface Decision {
	outcome: Outcome;
	source:
		| "readonly"
		| "inspect"
		| "path"
		| "fetch-host"
		| "local-network"
		| "floor"
		| "policy"
		| "opaque-risk"
		| "scope";
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
	/** Optional classifier model; see model.ts */
	classifier?: ClassifierSettings;
}

export interface OpaqueRiskSettings {
	/** Default true when a classifier model is configured */
	enabled?: boolean;
	/** Probability at which an opaque effect becomes an ask */
	ask?: number;
	/** Probability at which an opaque effect becomes a block */
	block?: number;
	/** What to do when the classifier fails: keep the static decision, ask, or block */
	onError?: "keep" | "ask" | "block";
}

export interface ScopeSettings {
	/** Default true when a classifier model is configured */
	enabled?: boolean;
	/** Probability at which an ask is suppressed because the task clearly requests it */
	threshold?: number;
	/** What to do when the classifier fails: ask, or allow the suppression */
	onError?: "ask" | "allow";
}

export interface ClassifierSettings {
	/** `<provider>/<model-id>` of a classifier model */
	model?: string;
	timeoutMs?: number;
	opaqueRisk?: OpaqueRiskSettings;
	scope?: ScopeSettings;
}

export interface ResolvedClassifier {
	model: string;
	timeoutMs: number;
	opaqueRisk: {
		enabled: boolean;
		ask: number;
		block: number;
		onError: "keep" | "ask" | "block";
	};
	scope: {
		enabled: boolean;
		threshold: number;
		onError: "ask" | "allow";
	};
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
	classifier?: ResolvedClassifier;
	warnings: string[];
}

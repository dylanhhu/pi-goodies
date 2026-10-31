/**
 * Strict fast-path allowlist for bash commands.
 *
 * A command is allowlisted only if it consists of plain words: no quoting, no
 * expansion, no redirection, no command composition. There is no grammar to
 * disagree about with bash, so anything that could chain or substitute a
 * command fails the character check before argument rules are even consulted.
 *
 * Being allowlisted only means "skip the decision model". It never overrides a
 * Layer 1 rule match.
 */

import { isAncestorOfSensitive, isSensitivePath, realResolve, resolvePathArg } from "./paths.ts";

export interface AllowEntry {
	/** Command name, bare (no path, no assignments) */
	cmd: string;
	/** If set, the first argument must be one of these */
	subcommands?: string[];
	/** Flags that make the command unsafe: long flags match abbreviations, short flags match inside bundles */
	denyFlags?: string[];
	/** Reads directories recursively (the cwd counts when no directory is given) */
	recursive?: boolean;
}

/**
 * Read-only defaults. Note that `git status` and friends can run programs
 * named by a repository's own config (for example core.fsmonitor), so the git
 * entries trust the repository you are working in.
 */
export const DEFAULT_ALLOWLIST: AllowEntry[] = [
	{ cmd: "ls" },
	{ cmd: "pwd" },
	{ cmd: "whoami" },
	{ cmd: "uname" },
	{ cmd: "which" },
	{ cmd: "echo" },
	{ cmd: "wc" },
	{ cmd: "stat" },
	{ cmd: "file" },
	{ cmd: "du" },
	{ cmd: "df" },
	{ cmd: "date", denyFlags: ["-s", "--set"] },
	{ cmd: "cat" },
	{ cmd: "head" },
	{ cmd: "tail" },
	// -R, -L, and --follow walk symlinks, which can lead out of the project
	{ cmd: "grep", recursive: true, denyFlags: ["-R", "--dereference-recursive"] },
	{ cmd: "rg", recursive: true, denyFlags: ["--pre", "--hostname-bin", "-L", "--follow"] },
	{
		cmd: "git",
		subcommands: ["status", "log", "diff", "show", "rev-parse", "ls-files"],
		denyFlags: [
			"--output",
			"--ext-diff",
			"--textconv",
			"--no-index",
			"--open-files-in-pager",
			"-O",
		],
	},
];

/** Letters, digits, and the punctuation that cannot compose, expand, or redirect. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./~ -]+$/;
const BARE_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

function isDenied(flag: string, denyFlags: string[] = []): boolean {
	for (const deny of denyFlags) {
		if (deny.startsWith("--")) {
			// Long options may be abbreviated: "--ou" can mean "--output"
			if (flag.startsWith("--") && flag.length > 2 && deny.startsWith(flag)) return true;
		} else if (flag === deny) {
			return true;
		} else if (/^-[^-]/.test(flag) && flag.slice(1).includes(deny.slice(1))) {
			return true;
		}
	}
	return false;
}

export interface AllowlistOptions {
	cwd: string;
	home: string;
	entries: AllowEntry[];
}

export function isAllowlisted(command: string, opts: AllowlistOptions): boolean {
	const trimmed = command.trim();
	if (!trimmed || !PLAIN.test(trimmed)) return false;

	const [cmd, ...rest] = trimmed.split(/ +/);
	if (!BARE_WORD.test(cmd)) return false;
	const entry = opts.entries.find((e) => e.cmd === cmd);
	if (!entry) return false;

	let args = rest;
	if (entry.subcommands) {
		if (args.length === 0 || !entry.subcommands.includes(args[0])) return false;
		args = args.slice(1);
	}

	const pathArgs: string[] = [];
	let afterDoubleDash = false;
	for (const arg of args) {
		if (!afterDoubleDash && arg === "--") {
			afterDoubleDash = true;
		} else if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") {
			const [name, ...value] = arg.split("=");
			if (isDenied(name, entry.denyFlags)) return false;
			if (value.length > 0) pathArgs.push(value.join("="));
		} else {
			pathArgs.push(arg);
		}
	}

	// Judge each path as written and where it really points: a symlink in the
	// project must not smuggle a sensitive file past the check
	const resolved: string[] = [];
	for (const arg of pathArgs) {
		const abs = resolvePathArg(arg, opts.cwd, opts.home);
		if (abs === undefined) return false;
		const real = realResolve(abs);
		if (isSensitivePath(abs, opts.home) || isSensitivePath(real, opts.home)) return false;
		resolved.push(abs, real);
	}

	if (entry.recursive) {
		for (const dir of [...resolved, opts.cwd, realResolve(opts.cwd)]) {
			if (isAncestorOfSensitive(dir, opts.home)) return false;
		}
	}
	return true;
}

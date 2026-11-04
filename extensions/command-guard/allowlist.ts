/**
 * Strict fast-path allowlist for bash commands.
 *
 * A command is allowlisted only if it consists of plain words: no quoting, no
 * expansion, no redirection, no command composition. There is no grammar to
 * disagree about with bash, so anything that could chain or substitute a
 * command fails the character check before argument rules are even consulted.
 *
 * This is the read-only command table. A command that passes it is provably
 * read-only; the policy can still ask or block on a path or host, but it does
 * not need to inspect the command for a mutation.
 */

import { statSync } from "node:fs";
import { isAncestorOfSensitive, isSensitivePath, realResolve, resolvePathArg } from "./paths.ts";
import { readOnlySedFiles } from "./sed.ts";

export interface AllowEntry {
	/** Command name, bare (no path, no assignments) */
	cmd: string;
	/** If set, the first argument must be one of these */
	subcommands?: string[];
	/** Flags that make the command unsafe: long flags match abbreviations, short flags match inside bundles */
	denyFlags?: string[];
	/** Reads directories recursively (the cwd counts when no directory is given) */
	recursive?: boolean;
	/**
	 * For recursive readers: "cwd" (default) keeps counting the working
	 * directory even when a path is named, since the command may recurse there;
	 * "arg" only counts it when no path is given (find always names one)
	 */
	recursiveFrom?: "cwd" | "arg";
	/** Leading positional arguments that are not paths (rg and grep take a pattern first) */
	patternArgs?: number;
	/**
	 * Built-in argument validator for a command whose script language can write
	 * or execute. Only "sed" exists; see sed.ts
	 */
	script?: "sed";
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
	// The script is parsed: w, W, r, R, e, s///w and s///e all disqualify it
	{ cmd: "sed", script: "sed", denyFlags: ["-i", "--in-place", "-f", "--file"] },
	// -o writes, and --compress-program runs a program
	{ cmd: "sort", denyFlags: ["-o", "--output", "--compress-program"] },
	{ cmd: "uniq" },
	// -delete, -exec, and the -fprint family are the writing forms
	{
		cmd: "find",
		recursive: true,
		recursiveFrom: "arg",
		denyFlags: [
			"-delete",
			"-exec",
			"-execdir",
			"-ok",
			"-okdir",
			"-fprint",
			"-fprint0",
			"-fprintf",
			"-fls",
		],
	},
	// -R, -L, and --follow walk symlinks, which can lead out of the project
	{ cmd: "grep", recursive: true, patternArgs: 1, denyFlags: ["-R", "--dereference-recursive"] },
	{
		cmd: "rg",
		recursive: true,
		patternArgs: 1,
		denyFlags: ["--pre", "--hostname-bin", "-L", "--follow"],
	},
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

export interface AllowlistOptions {
	cwd: string;
	home: string;
	entries: AllowEntry[];
}

export function isDeniedFlag(flag: string, denyFlags: readonly string[] = []): boolean {
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

/**
 * Check one command's arguments against its entry. Shared by the plain-word
 * allowlist and by the read-only classifier, which parses first.
 */
export function checkEntryArgs(
	entry: AllowEntry,
	args: string[],
	opts: { cwd: string; home: string },
): boolean {
	if (entry.subcommands) {
		if (args.length === 0 || !entry.subcommands.includes(args[0])) return false;
		args = args.slice(1);
	}

	let pathArgs: string[] = [];
	let positionalArgs: string[] = [];
	/** Operands before the first flag: for find, these are its starting paths */
	const leadingPositionals: string[] = [];
	let sawFlag = false;
	if (entry.script === "sed") {
		// sed decides which arguments are scripts and which are input files
		const files = readOnlySedFiles(args, entry.denyFlags ?? [], isDeniedFlag);
		if (!files) return false;
		pathArgs = files;
		positionalArgs = files;
	} else {
		const flagValues: string[] = [];
		let afterDoubleDash = false;
		for (const arg of args) {
			if (!afterDoubleDash && arg === "--") {
				afterDoubleDash = true;
			} else if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") {
				sawFlag = true;
				const [name, ...value] = arg.split("=");
				if (isDeniedFlag(name, entry.denyFlags)) return false;
				if (value.length > 0) flagValues.push(value.join("="));
			} else {
				positionalArgs.push(arg);
				if (!sawFlag) leadingPositionals.push(arg);
			}
		}
		pathArgs = [...positionalArgs, ...flagValues];
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
		// The cwd can only be recursed into when the command names no directory of
		// its own. Paths that exist and are files prove it reads no directories;
		// anything unknown is treated as if it might be one
		const kind = (p: string): "file" | "dir" | "unknown" => {
			const abs = resolvePathArg(p, opts.cwd, opts.home);
			if (abs === undefined) return "unknown";
			try {
				return statSync(realResolve(abs)).isDirectory() ? "dir" : "file";
			} catch {
				return "unknown";
			}
		};
		// rg and grep take a pattern first: the remaining positionals are the
		// directories (or files) they read
		const hasPatternFlag = args.some(
			(a) => a === "-e" || a.startsWith("--regexp") || a === "-f" || a.startsWith("--file"),
		);
		const named =
			entry.recursiveFrom === "arg"
				? leadingPositionals
				: hasPatternFlag
					? positionalArgs
					: positionalArgs.slice(entry.patternArgs ?? 0);
		const kinds = named.map(kind);
		const includeCwd = named.length === 0 || kinds.includes("unknown");
		const dirs = includeCwd ? [...resolved, opts.cwd, realResolve(opts.cwd)] : resolved;
		for (const dir of dirs) {
			if (isAncestorOfSensitive(dir, opts.home)) return false;
		}
	}
	return true;
}

export function isAllowlisted(command: string, opts: AllowlistOptions): boolean {
	const trimmed = command.trim();
	if (!trimmed || !PLAIN.test(trimmed)) return false;

	const [cmd, ...rest] = trimmed.split(/ +/);
	if (!BARE_WORD.test(cmd)) return false;
	const entry = opts.entries.find((e) => e.cmd === cmd);
	if (!entry) return false;
	return checkEntryArgs(entry, rest, opts);
}

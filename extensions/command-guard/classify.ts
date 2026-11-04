/**
 * Command classification.
 *
 * The allowlist asks whether one simple command is plain and read-only. This
 * asks the same of a whole shell command line: pipes, `&&`, `;`, `cd`, quoted
 * arguments, and redirects to /dev/null are all fine, while anything that
 * could expand, substitute, write, or run another program disqualifies it. The
 * parsing is what makes the class safe to trust: an injection cannot write a
 * command that the parser reports as read-only.
 *
 * The policy uses the class together with the extracted targets and hosts:
 * `readonly` and `inspect` run, `mutate` and `egress` are checked against the
 * configured roots and hosts, and `privileged` asks. The class is a proof only
 * for `readonly`; `inspect` means no write target was found, not that none
 * exists.
 */

import { type AllowEntry, checkEntryArgs, isDeniedFlag } from "./allowlist.ts";
import { extractHosts, extractWriteTargets, shellScanText } from "./extract.ts";
import { resolvePathArg } from "./paths.ts";
import type { CommandClass } from "./types.ts";

export interface ClassifyOptions {
	cwd: string;
	home: string;
	entries: AllowEntry[];
	/** Hosts from the descriptor, which sees heredoc-stripped text; computed here when omitted */
	hosts?: string[];
}

export interface Classification {
	kind: CommandClass;
	/** Why, in a few words: what the class means for this command */
	reason: string;
}

const PRIVILEGED = new Set(["sudo", "doas", "pfexec", "su"]);

/** Programs that run other programs or evaluate their input */
const INTERPRETERS = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"csh",
	"tcsh",
	"node",
	"nodejs",
	"deno",
	"bun",
	"python",
	"python2",
	"python3",
	"perl",
	"ruby",
	"php",
	"osascript",
	"tclsh",
	"wish",
	"eval",
	"exec",
	"env",
	"xargs",
	"command",
	"source",
	".",
	"awk",
	"gawk",
	"mawk",
	"nawk",
]);

/** First words that imply a state change wherever they appear */
const MUTATING = new Set([
	"rm",
	"rmdir",
	"unlink",
	"shred",
	"truncate",
	"mv",
	"cp",
	"ln",
	"install",
	"tee",
	"dd",
	"chmod",
	"chown",
	"chgrp",
	"touch",
	"mkdir",
	"mkfifo",
	"mknod",
	"kill",
	"killall",
	"pkill",
	"launchctl",
	"systemctl",
	"service",
	"crontab",
	"at",
	"defaults",
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
	"xcodebuild",
	"cmake",
	"make",
	"ninja",
	"meson",
	"gradle",
	"mvn",
	"tar",
	"unzip",
	"zip",
	"7z",
	"rsync",
	"scp",
	"sftp",
	"git",
	"hg",
	"svn",
]);

/** git subcommands that only read */
const GIT_READONLY = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files"]);

/** Flags that write or execute, wherever they appear */
const MUTATING_FLAG =
	/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)(?=\s|$)/;

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

type Connector = "start" | "and" | "or" | "pipe" | "seq";

interface Segment {
	connector: Connector;
	words: string[];
}

type Scan = { ok: true; segments: Segment[] } | { ok: false; reason: string; writing: boolean };

function reject(reason: string, writing: boolean): Scan {
	return { ok: false, reason, writing };
}

/** Index of a redirection, and whether it can write somewhere other than /dev/null. */
function readRedirect(command: string, i: number): { writing: boolean; next: number } | undefined {
	let j = i + 1;
	const opener = command[i];
	if (opener === "<" && command[j] === "<") return undefined; // heredoc or herestring
	if (opener === ">" && command[j] === ">") j++;
	if (command[j] === "|") j++;
	if (command[j] === "&") {
		j++;
		let fd = "";
		while (j < command.length && /[0-9]/.test(command[j])) fd += command[j++];
		return { writing: fd === "", next: j };
	}
	while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;
	let target = "";
	while (j < command.length && !/[ \t\n;|&<>]/.test(command[j])) target += command[j++];
	return { writing: target !== "/dev/null", next: j };
}

/**
 * Split a command line into segments, or say why it cannot be certified. Only
 * syntax whose meaning is fixed is accepted: quotes are inert, and everything
 * that the shell or a program could reinterpret is a rejection.
 */
function scanCommand(command: string): Scan {
	const segments: Segment[] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: string | null = null;
	let connector: Connector = "start";

	const endWord = () => {
		if (!inWord) return;
		words.push(word);
		word = "";
		inWord = false;
	};
	const endSegment = (next: Connector) => {
		endWord();
		if (words.length > 0) {
			segments.push({ connector, words });
			words = [];
		}
		connector = next;
	};

	for (let i = 0; i < command.length; i++) {
		const c = command[i];

		if (quote) {
			if (c === quote) {
				quote = null;
				continue;
			}
			if (c === "\\" && quote === '"') {
				const escaped = command[i + 1];
				if (escaped === undefined) return reject("unterminated quote", false);
				word += escaped;
				i++;
				continue;
			}
			// Expansions happen inside double quotes too; single quotes are inert
			if (c === "$" || c === "`") return reject("expansion inside quotes", false);
			word += c;
			inWord = true;
			continue;
		}

		if (c === '"' || c === "'") {
			quote = c;
			inWord = true;
			continue;
		}
		if (c === " " || c === "\t") {
			endWord();
			continue;
		}
		if (c === "\n" || c === ";") {
			endSegment("seq");
			continue;
		}
		if (c === "|") {
			if (command[i + 1] === "|") {
				i++;
				endSegment("or");
			} else if (command[i + 1] === "&") {
				return reject("stderr piped", false);
			} else {
				endSegment("pipe");
			}
			continue;
		}
		if (c === "&") {
			if (command[i + 1] === "&") {
				i++;
				endSegment("and");
				continue;
			}
			if (command[i + 1] === ">") {
				const redirect = readRedirect(command, i + 1);
				if (!redirect) return reject("redirect", true);
				if (redirect.writing) return reject("redirect to a file", true);
				i = redirect.next - 1;
				continue;
			}
			return reject("background job", false);
		}
		if (c === ">" || c === "<") {
			// Digits just before the operator are a file descriptor, not a word
			if (inWord && /^\d+$/.test(word)) {
				word = "";
				inWord = false;
			}
			const redirect = readRedirect(command, i);
			if (!redirect) return reject("redirect", true);
			if (redirect.writing) return reject("redirect to a file", true);
			i = redirect.next - 1;
			continue;
		}
		if ("$`*?[]{}()\\".includes(c)) return reject("expansion or glob", false);
		word += c;
		inWord = true;
	}
	if (quote) return reject("unterminated quote", false);
	endSegment("start");
	return { ok: true, segments };
}

/** Words in command position: the start, or after a separator. */
function commandWords(command: string): string[] {
	const words: string[] = [];
	for (const match of command.matchAll(/(?:^|[;&|]\s*|\n\s*)([A-Za-z][\w.-]*)/g)) {
		if (match[1]) words.push(match[1]);
	}
	return words;
}

/** True when a git invocation runs something other than a read-only subcommand. */
function gitIsMutating(command: string): boolean {
	for (const match of command.matchAll(/\bgit\b([^;&|\n]*)/g)) {
		const args = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
		let i = 0;
		while (i < args.length) {
			const arg = args[i];
			// Flags whose value is a separate word
			if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(arg)) {
				i += 2;
				continue;
			}
			if (arg.startsWith("-")) {
				i++;
				continue;
			}
			break;
		}
		const subcommand = args[i];
		return subcommand !== undefined && !GIT_READONLY.has(subcommand);
	}
	return false;
}

function deniedFlag(args: string[], entry: AllowEntry): boolean {
	for (const arg of args) {
		if (!arg.startsWith("-") || arg === "-") continue;
		const [name] = arg.split("=");
		if (isDeniedFlag(name, entry.denyFlags)) return true;
	}
	return false;
}

/** Whether anything in the line writes, deletes, installs, or runs another command. */
function hasMutatingSignal(command: string, opts: ClassifyOptions): boolean {
	if (MUTATING_FLAG.test(command)) return true;
	if (gitIsMutating(command)) return true;
	if (extractWriteTargets(shellScanText(command), opts.cwd, opts.home).length > 0) return true;
	return commandWords(command).some((word) => word !== "git" && MUTATING.has(word));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classifyCommand(command: string, opts: ClassifyOptions): Classification {
	const hosts = opts.hosts ?? extractHosts(shellScanText(command));
	if (commandWords(command).some((word) => PRIVILEGED.has(word))) {
		return { kind: "privileged", reason: "runs with elevated privilege" };
	}
	if (hosts.length > 0) {
		return { kind: "egress", reason: `contacts ${hosts.join(", ")}` };
	}

	const scan = scanCommand(command);
	if (!scan.ok) {
		// A redirect to a file is itself the write; other refusals only become
		// mutations when something in the line names a write or a program
		if (scan.writing || hasMutatingSignal(command, opts)) {
			return { kind: "mutate", reason: scan.reason };
		}
		return { kind: "inspect", reason: scan.reason };
	}

	let cwd = opts.cwd;
	let reason: string | undefined;
	let escalates = false;

	for (const segment of scan.segments) {
		const [name, ...args] = segment.words;
		if (!name) continue;

		if (name === "cd") {
			if (segment.connector === "pipe") {
				reason = "cd inside a pipeline";
				break;
			}
			if (args.length > 1) {
				reason = "cd with several arguments";
				break;
			}
			const target = args[0];
			if (target === "-") {
				reason = "cd -";
				break;
			}
			const abs = target === undefined ? opts.home : resolvePathArg(target, cwd, opts.home);
			if (abs === undefined) {
				reason = "cd into a directory that cannot be resolved";
				break;
			}
			cwd = abs;
			continue;
		}

		if (INTERPRETERS.has(name)) {
			reason = `${name} runs other programs`;
			break;
		}
		const entry = opts.entries.find((e) => e.cmd === name);
		if (!entry) {
			reason = `${name} is not on the allowlist`;
			break;
		}
		if (!checkEntryArgs(entry, args, { cwd, home: opts.home })) {
			// A denied flag, or a script the validator refused, is a good sign
			// that the command can write; do not send it down the inspect path
			escalates = deniedFlag(args, entry) || entry.script !== undefined;
			reason = `${name} with these arguments is not read-only`;
			break;
		}
	}

	if (reason === undefined) return { kind: "readonly", reason: "every command is read-only" };
	if (escalates || hasMutatingSignal(command, opts)) return { kind: "mutate", reason };
	return { kind: "inspect", reason };
}

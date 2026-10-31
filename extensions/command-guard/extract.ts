/**
 * Heuristic extraction of network hosts and file mutation targets from a bash
 * command string. This is deliberately not a shell parser: it feeds Layer 1
 * tripwires, and anything it misses (variables, obfuscation, interpreters)
 * is left to the decision model.
 */

import { basename } from "node:path";
import { resolvePathArg } from "./paths.ts";

// ---------------------------------------------------------------------------
// Heredocs
// ---------------------------------------------------------------------------

const HEREDOC_MARKER = /<<(-?)[ \t]*(\\?)(["']?)([A-Za-z_]\w*)\3/y;
const WRAPPER_PREFIX = String.raw`(?:(?:sudo|env|nohup|command|time)\s+)*`;
/** Programs that only write their input somewhere */
const DATA_CONSUMER = new RegExp(String.raw`^\s*${WRAPPER_PREFIX}(?:cat|tee)\b`);
/** Programs that take free text (a commit message, a PR body) and never run it */
const TEXT_SINK = new RegExp(
	String.raw`^\s*${WRAPPER_PREFIX}(?:git\s+(?:-C\s+\S+\s+)?(?:commit|tag|notes|merge|stash)|gh\s+(?:pr|issue|release|gist)\s+\w+)\b`,
);

interface Frame {
	/** code: a command list, dq and sq: quotes, bt: backticks (a command list too) */
	kind: "code" | "dq" | "sq" | "bt";
	/** Where the current simple command starts (code and bt) */
	cmdStart: number;
	/** The command whose argument this substitution is: `git commit -m "` for `$(` in it */
	outer?: string;
	/** Inside $(( )): `<<` is a shift there, not a heredoc */
	arith?: boolean;
}

interface PendingHeredoc {
	dash: boolean;
	delimiter: string;
	quoted: boolean;
	/** The heredoc's consumer only writes or displays it */
	feedsData: boolean;
}

/**
 * Remove heredoc bodies that are plain data, so file contents being written do
 * not trigger command rules. A body is dropped only when its consumer is known
 * to treat it as text:
 *
 *   - `cat` or `tee` with no pipe on the marker line, or
 *   - `cat` inside `$( )`, backticks, or `<( )` handed to a text-taking command
 *     (`git commit -m "$(cat <<'EOF' ...)"`), and
 *   - a quoted delimiter, or a body with no command substitution.
 *
 * Everything else is kept, because a shell, interpreter, or pipeline will run it
 * (`bash <<EOF`, `bash -c "$(cat <<EOF ...)"`, `eval`, `| sh`). Markers are only
 * recognized outside quotes and comments, since `cat "<<EOF"` or `# <<EOF` open
 * no heredoc and the lines that follow do execute.
 */
export function stripInertHeredocs(command: string): string {
	if (!command.includes("<<")) return command;
	const n = command.length;
	const stack: Frame[] = [{ kind: "code", cmdStart: 0 }];
	const removed: Array<[number, number]> = [];
	let pending: PendingHeredoc[] = [];

	const top = () => stack[stack.length - 1];
	const commandFrame = () => {
		for (let k = stack.length - 1; k >= 0; k--) {
			if (stack[k].kind === "code" || stack[k].kind === "bt") return stack[k];
		}
		return stack[0];
	};
	const push = (kind: Frame["kind"], at: number, next: number, arith?: boolean) => {
		const parent = commandFrame();
		stack.push({
			kind,
			cmdStart: next,
			outer: command.slice(parent.cmdStart, at),
			arith: arith ?? top().arith,
		});
	};

	/** Skip the bodies of the heredocs opened on the line ending at `newline`. */
	const consumeBodies = (newline: number): number => {
		let cursor = newline + 1;
		for (const h of pending) {
			const bodyStart = cursor;
			let end = cursor;
			let termEnd = n;
			while (end < n) {
				const eol = command.indexOf("\n", end);
				const stop = eol === -1 ? n : eol;
				const line = command.slice(end, stop);
				if ((h.dash ? line.replace(/^\t+/, "") : line) === h.delimiter) {
					termEnd = eol === -1 ? n : eol + 1;
					break;
				}
				end = eol === -1 ? n : eol + 1;
			}
			const body = command.slice(bodyStart, end);
			if (h.feedsData && (h.quoted || !/\$\(|`/.test(body))) {
				// Without a trailing newline, take the one before the body too
				const from = termEnd === n && bodyStart > 0 ? bodyStart - 1 : bodyStart;
				removed.push([from, termEnd]);
			}
			cursor = termEnd;
		}
		pending = [];
		const frame = commandFrame();
		frame.cmdStart = cursor;
		return cursor;
	};

	for (let i = 0; i < n; ) {
		const c = command[i];
		if (c === "\n" && pending.length > 0) {
			i = consumeBodies(i);
			continue;
		}
		const frame = top();

		if (frame.kind === "sq") {
			if (c === "'") stack.pop();
			i++;
			continue;
		}
		if (frame.kind === "dq") {
			if (c === "\\") i += 2;
			else if (c === '"') {
				stack.pop();
				i++;
			} else if (c === "$" && command[i + 1] === "(") {
				push("code", i, i + 2, command.startsWith("$((", i));
				i += 2;
			} else if (c === "`") {
				push("bt", i, i + 1);
				i++;
			} else i++;
			continue;
		}

		// code or bt
		if (c === "\\") {
			i += 2;
		} else if (c === "'") {
			stack.push({ kind: "sq", cmdStart: i });
			i++;
		} else if (c === '"') {
			stack.push({ kind: "dq", cmdStart: i });
			i++;
		} else if (c === "`") {
			if (frame.kind === "bt") stack.pop();
			else push("bt", i, i + 1);
			i++;
		} else if (c === "#" && (i === 0 || /[\s;&|(]/.test(command[i - 1]))) {
			const eol = command.indexOf("\n", i);
			i = eol === -1 ? n : eol;
		} else if (c === "$" && command[i + 1] === "(") {
			push("code", i, i + 2, command.startsWith("$((", i));
			i += 2;
		} else if (c === "(") {
			push("code", i, i + 1);
			i++;
		} else if (c === ")") {
			if (frame.kind === "code" && stack.length > 1) stack.pop();
			i++;
		} else if (c === ";" || c === "|" || c === "\n") {
			frame.cmdStart = i + 1;
			i++;
		} else if (c === "&") {
			// `>&2`, `2>&1`, and `&>file` are redirections, not separators
			const redirect = command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">";
			if (!redirect) frame.cmdStart = i + 1;
			i++;
		} else if (c === "<" && command[i + 1] === "<") {
			if (command[i + 2] === "<" || frame.arith) {
				i += command[i + 2] === "<" ? 3 : 2;
				continue;
			}
			HEREDOC_MARKER.lastIndex = i;
			const m = HEREDOC_MARKER.exec(command);
			if (!m) {
				i += 2;
				continue;
			}
			const [text, dash, escaped, quote, delimiter] = m;
			const consumer = command.slice(frame.cmdStart, i);
			let feedsData: boolean;
			if (frame.outer !== undefined) {
				// Inside a substitution the consumer of the output is the enclosing command
				feedsData = DATA_CONSUMER.test(consumer) && TEXT_SINK.test(frame.outer);
			} else {
				const eol = command.indexOf("\n", i + text.length);
				const rest = command.slice(i + text.length, eol === -1 ? n : eol);
				feedsData =
					(DATA_CONSUMER.test(consumer) || TEXT_SINK.test(consumer)) && !rest.includes("|");
			}
			pending.push({
				dash: dash === "-",
				delimiter,
				quoted: escaped === "\\" || quote !== "",
				feedsData,
			});
			i += text.length;
		} else {
			i++;
		}
	}

	if (removed.length === 0) return command;
	let out = "";
	let from = 0;
	for (const [start, end] of removed) {
		out += command.slice(from, start);
		from = end;
	}
	return out + command.slice(from);
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Segment {
	/** Words of one simple command, quotes removed */
	words: string[];
	/** Targets of output redirections (`>`, `>>`, `&>`) */
	redirects: string[];
}

/**
 * Split a command into segments at ; & && | || newlines, parentheses, and
 * backticks, honoring quotes. Redirection operators are removed from the word
 * list; output redirection targets are collected separately.
 */
function splitSegments(command: string): Segment[] {
	const segments: Segment[] = [];
	let words: string[] = [];
	let redirects: string[] = [];
	let cur = "";
	let hasCur = false;
	let pending: "write" | "skip" | null = null;
	let quote: string | null = null;

	const pushWord = () => {
		if (!hasCur) return;
		if (pending === "write") redirects.push(cur);
		else if (pending === null) words.push(cur);
		pending = null;
		cur = "";
		hasCur = false;
	};
	const endSegment = () => {
		pushWord();
		pending = null;
		if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects });
		words = [];
		redirects = [];
	};
	const dropFdPrefix = () => {
		if (hasCur && /^\d+$/.test(cur)) {
			cur = "";
			hasCur = false;
		} else {
			pushWord();
		}
	};

	const n = command.length;
	for (let i = 0; i < n; i++) {
		const c = command[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (quote === '"' && c === "\\" && i + 1 < n) cur += command[++i];
			else cur += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			hasCur = true;
		} else if (c === "\\" && i + 1 < n) {
			cur += command[++i];
			hasCur = true;
		} else if (c === ";" || c === "\n" || c === "(" || c === ")" || c === "`") {
			endSegment();
		} else if (c === "|") {
			if (command[i + 1] === "|" || command[i + 1] === "&") i++;
			endSegment();
		} else if (c === "&") {
			if (command[i + 1] === "&") {
				i++;
				endSegment();
			} else if (command[i + 1] === ">") {
				pushWord();
				i++;
				if (command[i + 1] === ">") i++;
				pending = "write";
			} else {
				endSegment();
			}
		} else if (c === ">") {
			dropFdPrefix();
			let j = i + 1;
			if (command[j] === ">" || command[j] === "|") j++;
			if (command[j] === "&" && /[\d-]/.test(command[j + 1] ?? "")) {
				j++;
				while (/[\d-]/.test(command[j] ?? "")) j++;
				i = j - 1;
				continue;
			}
			if (command[j] === "&") j++;
			i = j - 1;
			pending = "write";
		} else if (c === "<") {
			dropFdPrefix();
			let j = i + 1;
			while (command[j] === "<" || command[j] === "-") j++;
			i = j - 1;
			pending = "skip";
		} else if (c === " " || c === "\t") {
			pushWord();
		} else {
			cur += c;
			hasCur = true;
		}
	}
	endSegment();
	return segments;
}

interface WrapperSpec {
	/** Flags that consume the next word */
	argFlags?: readonly string[];
	/** Positional words before the wrapped command (`timeout 5 curl`) */
	positional?: number;
}

/** Commands that run another command given as their arguments. */
const WRAPPERS = new Map<string, WrapperSpec>([
	["sudo", { argFlags: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"] }],
	["doas", { argFlags: ["-u", "-C"] }],
	["env", { argFlags: ["-u", "-C", "-S"] }],
	["nohup", {}],
	["command", {}],
	["time", { argFlags: ["-f", "-o"] }],
	["exec", { argFlags: ["-a"] }],
	["nice", { argFlags: ["-n"] }],
	["timeout", { argFlags: ["-s", "-k", "--signal", "--kill-after"], positional: 1 }],
	["xargs", { argFlags: ["-I", "-n", "-L", "-P", "-s", "-d", "-E", "-a"] }],
	["stdbuf", { argFlags: ["-i", "-o", "-e"] }],
	["setsid", {}],
	["ionice", { argFlags: ["-c", "-n", "-p", "-t"] }],
	["chronic", {}],
]);

/** Strip leading env assignments and wrapper commands; returns [commandName, ...args]. */
function commandWords(words: string[]): string[] {
	const rest = [...words];
	for (;;) {
		if (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) {
			rest.shift();
			continue;
		}
		const spec = rest.length > 0 ? WRAPPERS.get(basename(rest[0])) : undefined;
		if (spec) {
			rest.shift();
			while (rest.length > 0 && rest[0].startsWith("-")) {
				const flag = rest.shift() as string;
				if (spec.argFlags?.includes(flag)) rest.shift();
			}
			for (let k = 0; k < (spec.positional ?? 0) && rest.length > 0; k++) rest.shift();
			continue;
		}
		break;
	}
	if (rest.length > 0) rest[0] = basename(rest[0]);
	return rest;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
/** How many levels of `bash -c '...'` and `eval` are looked into */
const MAX_NESTING = 3;

/**
 * Scripts passed as an argument to a shell (`bash -c`, `sh -lc`) or to `eval`.
 * They are command text like any other, so hosts and write targets inside them
 * are extracted too.
 */
function nestedScripts(words: string[]): string[] {
	const [name, ...args] = commandWords(words);
	if (!name) return [];
	if (name === "eval") return args.length > 0 ? [args.join(" ")] : [];
	if (!SHELLS.has(name)) return [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) return i + 1 < args.length ? [args[i + 1]] : [];
		if (arg === "-o" || arg === "+o") i++;
		else if (!arg.startsWith("-") && !arg.startsWith("+")) break;
	}
	return [];
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

const NET_CLIENTS = new Set([
	"curl",
	"wget",
	"nc",
	"ncat",
	"netcat",
	"telnet",
	"ftp",
	"sftp",
	"ssh",
	"scp",
	"rsync",
	"socat",
	"http",
	"https",
	"xh",
]);

const FILE_EXTENSIONS = new Set(
	(
		"js mjs cjs ts tsx jsx json py sh md txt yml yaml toml html htm css csv xml pdf png jpg jpeg " +
		"gif svg zip tar gz tgz bz2 xz log lock conf cfg ini out bin so rs go rb java c h cpp php pl " +
		"env key pem crt sql db sqlite dat tmp bak swp"
	).split(" "),
);

const URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/(?:[^\s/@'"]*@)?(\[[0-9a-f:]+\]|[a-z0-9._-]+)/gi;
const USER_AT_RE = /(?:^|[\s'"=:])[\w.+-]+@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?=[:\s'"/]|$)/gi;
const DEV_TCP_RE = /\/dev\/(?:tcp|udp)\/([a-z0-9._-]+)\//gi;
const BARE_HOST_RE = /^(?:[\w.+-]+@)?([a-z0-9][a-z0-9.-]*)(?::\d+)?(?::|[/?#]|$)/i;

function isIPv4(host: string): boolean {
	const parts = host.split(".");
	return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** A dotted name with an alphabetic TLD that is not a common file extension, or an IPv4 literal. */
function looksLikeHost(host: string): boolean {
	if (isIPv4(host)) return true;
	const labels = host.split(".");
	if (labels.length < 2) return false;
	const tld = labels[labels.length - 1];
	return /^[a-z]{2,}$/.test(tld) && !FILE_EXTENSIONS.has(tld);
}

function cleanHost(host: string): string {
	return host
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
}

export function extractHosts(command: string, depth = 0): string[] {
	const found = new Set<string>();
	const add = (h: string) => {
		const host = cleanHost(h);
		if (host) found.add(host);
	};

	for (const m of command.matchAll(URL_RE)) add(m[1]);
	for (const m of command.matchAll(DEV_TCP_RE)) add(m[1]);
	for (const m of command.matchAll(USER_AT_RE)) if (looksLikeHost(cleanHost(m[1]))) add(m[1]);

	for (const seg of splitSegments(command)) {
		if (depth < MAX_NESTING) {
			for (const script of nestedScripts(seg.words)) {
				for (const host of extractHosts(script, depth + 1)) found.add(host);
			}
		}
		const [name, ...args] = commandWords(seg.words);
		if (!name || !NET_CLIENTS.has(name)) continue;
		for (const arg of args) {
			if (arg.startsWith("-")) continue;
			const m = BARE_HOST_RE.exec(arg);
			if (m && looksLikeHost(cleanHost(m[1]))) add(m[1]);
		}
	}
	return [...found];
}

// ---------------------------------------------------------------------------
// Write targets
// ---------------------------------------------------------------------------

const ALL_ARGS = new Set([
	"tee",
	"mv",
	"rm",
	"rmdir",
	"unlink",
	"shred",
	"truncate",
	"touch",
	"mkdir",
	"chmod",
	"chown",
	"chgrp",
]);
const LAST_ARG = new Set(["cp", "install", "ln"]);
/** Copy tools whose last argument is the destination, unless it names a remote host */
const COPY_TO_LAST = new Set(["rsync", "scp"]);
const IGNORED_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

function valueAfter(args: string[], flags: string[]): string[] {
	const values: string[] = [];
	args.forEach((arg, i) => {
		for (const flag of flags) {
			if (arg === flag && i + 1 < args.length) values.push(args[i + 1]);
			else if (flag.startsWith("--") && arg.startsWith(`${flag}=`)) {
				values.push(arg.slice(flag.length + 1));
			}
		}
	});
	return values;
}

function segmentTargets(seg: Segment): string[] {
	const targets = [...seg.redirects];
	// Not `targets.push(...list)`: spreading a very long argument list overflows the call stack
	const add = (list: string[]) => {
		for (const item of list) targets.push(item);
	};
	const [name, ...args] = commandWords(seg.words);
	if (!name) return targets;
	const positional = args.filter((a) => !a.startsWith("-"));

	if (ALL_ARGS.has(name)) add(positional);
	else if (LAST_ARG.has(name)) {
		// With -t the destination directory is a flag value and every positional is a source
		const dirs = valueAfter(args, ["-t", "--target-directory"]);
		if (dirs.length > 0) add(dirs);
		else if (positional.length > 0) targets.push(positional[positional.length - 1]);
	} else if (COPY_TO_LAST.has(name)) {
		const dest = positional[positional.length - 1];
		if (dest !== undefined && !/^[^/\s]*:/.test(dest)) targets.push(dest);
	} else if (name === "tar") {
		const extracting =
			args.some((a) => /^-[a-zA-Z]*x/.test(a) || a === "--extract" || a === "--get") ||
			/^[a-zA-Z]*x/.test(args[0] ?? "");
		if (extracting) add(valueAfter(args, ["-C", "--directory"]));
	} else if (name === "unzip") {
		add(valueAfter(args, ["-d"]));
	} else if (name === "sed" || name === "gsed" || name === "perl") {
		const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
		if (inPlace) {
			const hasScriptFlag = args.some((a) => /^(-e|-f|--expression|--file)/.test(a));
			// The word after -e or -f is a script, not a file
			const scripts = new Set<number>();
			args.forEach((a, i) => {
				if (/^(-e|-f|--expression|--file)$/.test(a)) scripts.add(i + 1);
			});
			const files = args.filter((a, i) => !a.startsWith("-") && !scripts.has(i));
			add(hasScriptFlag || name === "perl" ? files : files.slice(1));
		}
	} else if (name === "dd") {
		for (const a of args) if (a.startsWith("of=")) targets.push(a.slice(3));
	} else if (name === "curl") {
		add(valueAfter(args, ["-o", "--output"]));
	} else if (name === "wget") {
		add(valueAfter(args, ["-O", "--output-document", "-P", "--directory-prefix"]));
	}
	return targets;
}

/** Absolute paths a command appears to create, modify, or delete. */
export function extractWriteTargets(
	command: string,
	cwd: string,
	home: string,
	depth = 0,
): string[] {
	const out = new Set<string>();
	for (const seg of splitSegments(command)) {
		for (const raw of segmentTargets(seg)) {
			const abs = resolvePathArg(raw, cwd, home);
			if (abs && !IGNORED_TARGETS.has(abs)) out.add(abs);
		}
		if (depth < MAX_NESTING) {
			for (const script of nestedScripts(seg.words)) {
				for (const target of extractWriteTargets(script, cwd, home, depth + 1)) out.add(target);
			}
		}
	}
	return [...out];
}

/**
 * Validating a sed invocation as read-only.
 *
 * sed is the one allowlisted command whose script language can write files
 * (`w`, `W`, `s///w`), read arbitrary ones (`r`, `R`), and run commands (`e`,
 * `s///e`). `--sandbox` would say the same thing but only GNU sed has it, and
 * macOS ships BSD sed, so the script is parsed instead.
 *
 * The check is a whitelist of commands: anything unrecognized fails, so a sed
 * extension we have never seen cannot quietly become an escape hatch. A
 * rejected script is not blocked; it falls out of the read-only class and the
 * policy handles the command as opaque.
 */

const SIMPLE = new Set(["p", "P", "d", "D", "n", "N", "h", "H", "g", "G", "x", "q", "l", "="]);
const BRANCH = new Set(["b", "t", "T"]);
/** Flags allowed after `s///`; `w` and `e` are deliberately absent */
const SUBST_FLAGS = new Set(["g", "p", "i", "I", "m", "M"]);

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n";

/** Skip separators between commands. `;` and newline both end a command. */
function skipSeparators(script: string, i: number): number {
	while (i < script.length && (isSpace(script[i]) || script[i] === ";")) i++;
	return i;
}

/** Index just past the delimiter, or -1 when unterminated. `\` escapes the next character. */
function skipDelimited(script: string, i: number, delimiter: string): number {
	let j = i;
	while (j < script.length) {
		const c = script[j];
		if (c === "\\") {
			j += 2;
			continue;
		}
		if (c === "\n") return -1;
		if (c === delimiter) return j + 1;
		j++;
	}
	return -1;
}

/** A numeric, `$`, `first~step`, `+n`, or `/regex/` address. */
function skipOneAddress(script: string, i: number): number {
	const c = script[i];
	if (i >= script.length) return i;
	if (c === "/") return skipDelimited(script, i + 1, "/");
	if (c === "$") return i + 1;
	if (c === "+" || c === "~") {
		const m = /^[+~]\d+/.exec(script.slice(i));
		return m ? i + m[0].length : -1;
	}
	const m = /^\d+(?:~\d+)?/.exec(script.slice(i));
	return m ? i + m[0].length : i;
}

/** Addresses, an optional `!`, and the whitespace around them. */
function skipAddresses(script: string, i: number): number {
	let j = skipOneAddress(script, i);
	if (j < 0) return -1;
	// Only treat a comma as an address separator when the first address exists
	if (j > i && script[j] === ",") {
		j = skipOneAddress(script, j + 1);
		if (j < 0) return -1;
	}
	while (j < script.length && (script[j] === " " || script[j] === "\t")) j++;
	if (script[j] === "!") j++;
	while (j < script.length && (script[j] === " " || script[j] === "\t")) j++;
	return j;
}

function skipLabel(script: string, i: number): number {
	while (i < script.length && (script[i] === " " || script[i] === "\t")) i++;
	while (i < script.length && /[A-Za-z0-9_-]/.test(script[i])) i++;
	return i;
}

/** `s` or `y`: two delimited parts plus, for `s`, a whitelisted set of flags. */
function skipSubstitution(script: string, i: number, command: string): number {
	const delimiter = script[i];
	if (delimiter === undefined || delimiter === "\\" || delimiter === "\n") return -1;
	let j = skipDelimited(script, i + 1, delimiter);
	if (j < 0) return -1;
	j = skipDelimited(script, j, delimiter);
	if (j < 0) return -1;
	if (command === "y") {
		// No flags: the command ends here or at a separator
		if (j < script.length && !isSpace(script[j]) && script[j] !== ";" && script[j] !== "}") {
			return -1;
		}
		return j;
	}
	while (j < script.length) {
		const flag = script[j];
		if (isSpace(flag) || flag === ";" || flag === "}") break;
		if (!SUBST_FLAGS.has(flag) && !/[0-9]/.test(flag)) return -1;
		j++;
	}
	return j;
}

/**
 * True when the script only reads, prints, and branches. `w`, `W`, `r`, `R`,
 * `e`, `s///w`, `s///e`, `a`, `i`, `c`, and anything unrecognized give false.
 */
export function isReadOnlySedScript(script: string): boolean {
	if (script.trim() === "") return false;
	let i = 0;
	while (i < script.length) {
		i = skipSeparators(script, i);
		if (i >= script.length) return true;

		i = skipAddresses(script, i);
		if (i < 0 || i >= script.length) return false;

		const command = script[i];
		if (command === "{" || command === "}") {
			i++;
			continue;
		}
		if (command === ":" || BRANCH.has(command)) {
			i = skipLabel(script, i + 1);
			continue;
		}
		if (command === "s" || command === "y") {
			i = skipSubstitution(script, i + 1, command);
			if (i < 0) return false;
			continue;
		}
		if (SIMPLE.has(command)) {
			i++;
			continue;
		}
		return false;
	}
	return true;
}

/**
 * Check a sed argument list: collect its scripts, reject `-f` and `-i`, and
 * return the input files (which the caller still has to path-check). Undefined
 * means the invocation is not provably read-only.
 */
export function readOnlySedFiles(
	args: string[],
	denyFlags: readonly string[],
	isDenied: (flag: string, denyFlags: readonly string[]) => boolean,
): string[] | undefined {
	const scripts: string[] = [];
	const files: string[] = [];
	let afterDoubleDash = false;
	let i = 0;

	const takeScript = (value: string | undefined): boolean => {
		if (value === undefined || !isReadOnlySedScript(value)) return false;
		scripts.push(value);
		return true;
	};

	while (i < args.length) {
		const arg = args[i];
		i++;
		if (!afterDoubleDash && arg === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") {
			const [name, ...value] = arg.split("=");
			// -i, -f, and anything the config adds
			if (isDenied(name, denyFlags)) return undefined;
			if (name === "--expression") {
				if (!takeScript(value.length > 0 ? value.join("=") : args[i++])) return undefined;
				continue;
			}
			if (name === "--file") return undefined;
			// Bundled short flags such as -ne take the next argument as a script
			if (/^-[^-]/.test(name) && name.includes("e")) {
				if (!takeScript(args[i++])) return undefined;
			}
			continue;
		}
		// The first positional is the script unless a flag already gave one
		if (scripts.length === 0) {
			if (!takeScript(arg)) return undefined;
		} else {
			files.push(arg);
		}
	}
	return scripts.length > 0 ? files : undefined;
}

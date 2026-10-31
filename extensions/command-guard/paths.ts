/**
 * Path helpers and the shared definition of "sensitive" locations.
 *
 * The same regex source serves two uses: scanning raw command text (rules) and
 * testing resolved absolute paths (allowlist, write/edit rules).
 */

import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Matches a home directory spelled any of the common ways inside command text. */
const HOME_PREFIX = String.raw`(?:~|\$\{?HOME\}?|/Users/[^/\s'"]+|/home/[^/\s'"]+|/root)`;

const HOME_RELATIVE_SENSITIVE = [
	String.raw`\.ssh`,
	String.raw`\.aws`,
	String.raw`\.gnupg`,
	String.raw`\.kube`,
	String.raw`\.azure`,
	String.raw`\.config/(?:gcloud|gh)`,
	String.raw`\.docker/config\.json`,
	String.raw`\.netrc`,
	String.raw`\.npmrc`,
	String.raw`\.pypirc`,
	String.raw`\.git-credentials`,
	String.raw`\.pi/agent/auth\.json`,
	"Library/Keychains",
];

const SENSITIVE_FRAGMENTS = [
	`${HOME_PREFIX}/(?:${HOME_RELATIVE_SENSITIVE.join("|")})(?![\\w-])`,
	// .env and .env.<name>, but not documentation variants. Also after @ (curl -d @.env),
	// : (git show HEAD:.env), and the other characters a path can follow
	String.raw`(?:^|[\s/'"=@:<>,(])\.env(?!\.(?:example|sample|template|dist)(?![\w-]))(?:\.[\w-]+)?(?![\w-])`,
	String.raw`\.(?:pem|p12|pfx)(?![\w-])`,
	String.raw`\.key(?![\w-])`,
	String.raw`\bid_(?:rsa|dsa|ecdsa|ed25519)(?![\w-])`,
	String.raw`\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain)\b`,
	String.raw`/etc/shadow\b`,
];

/** Regex source (use with the "i" flag) matching sensitive locations in text or paths. */
export const SENSITIVE_COMMAND_SOURCE = SENSITIVE_FRAGMENTS.join("|");

/** Home-relative locations whose ancestors a recursive reader must not be pointed at. */
const ANCHORS = [
	".ssh",
	".aws",
	".gnupg",
	".kube",
	".azure",
	".config/gcloud",
	".config/gh",
	".docker/config.json",
	".netrc",
	".npmrc",
	".pypirc",
	".git-credentials",
	".pi/agent/auth.json",
	"Library/Keychains",
];

const SENSITIVE_RE = new RegExp(SENSITIVE_COMMAND_SOURCE, "i");

/**
 * Resolve a path argument (from a command or tool input) to an absolute path.
 * Returns undefined when it depends on shell expansion we cannot evaluate.
 */
export function resolvePathArg(raw: string, cwd: string, home: string): string | undefined {
	let p = raw.startsWith("@") ? raw.slice(1) : raw;
	p = p.replace(/^\$\{HOME\}|^\$HOME(?![\w])/, home);
	if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
	else if (p.startsWith("~")) return undefined;
	if (/[$`]/.test(p)) return undefined;
	return resolve(cwd, p);
}

const aliasCache = new Map<string, string[]>();

/** The home directory and, when it is reached through a symlink, its real location. */
export function homeAliases(home: string): string[] {
	let aliases = aliasCache.get(home);
	if (!aliases) {
		const real = realResolve(home);
		aliases = real === home ? [home] : [home, real];
		aliasCache.set(home, aliases);
	}
	return aliases;
}

/** The absolute path plus, for paths under home, its `~/...` spelling. */
export function pathForms(abs: string, home: string): string[] {
	const forms = [abs];
	for (const alias of homeAliases(home)) {
		if (abs === alias) forms.push("~");
		else if (abs.startsWith(alias + sep)) forms.push(`~${abs.slice(alias.length)}`);
	}
	return forms;
}

export function isSensitivePath(abs: string, home: string): boolean {
	return pathForms(abs, home).some((form) => SENSITIVE_RE.test(form));
}

/** True when `abs` is, or contains, one of the sensitive anchor locations. */
export function isAncestorOfSensitive(abs: string, home: string): boolean {
	const prefix = abs.endsWith(sep) ? abs : abs + sep;
	return homeAliases(home).some((alias) =>
		ANCHORS.some((anchor) => {
			const full = join(alias, anchor);
			return full === abs || full.startsWith(prefix);
		}),
	);
}

/** Resolve symlinks for the longest existing prefix of `abs`, keeping the remainder. */
export function realResolve(abs: string): string {
	const rest: string[] = [];
	let current = abs;
	for (;;) {
		try {
			return join(realpathSync(current), ...rest.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return abs;
			rest.push(current.slice(parent.length).replace(/^[/\\]+/, ""));
			current = parent;
		}
	}
}

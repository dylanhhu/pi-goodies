/**
 * Shipped Layer 1 rules.
 *
 * Rules carry a category and no fixed action: the action comes from the
 * profile and the user's `defaults` / `overrides`, so the same rule set can
 * confirm for one person and defer to the decision model for another.
 *
 * These are tripwires over the surface text of a command. They catch the
 * common spellings; obfuscated or computed variants are the decision model's
 * job.
 */

import { SENSITIVE_COMMAND_SOURCE } from "./paths.ts";
import type { GuardRule } from "./types.ts";

/** Hosts the `notInAllowed` matcher treats as expected. Subdomains are included. */
export const DEFAULT_ALLOWED_HOSTS: string[] = [
	"github.com",
	"githubusercontent.com",
	"githubassets.com",
	"gitlab.com",
	"bitbucket.org",
	"npmjs.org",
	"npmjs.com",
	"yarnpkg.com",
	"nodejs.org",
	"pypi.org",
	"pythonhosted.org",
	"python.org",
	"crates.io",
	"rust-lang.org",
	"golang.org",
	"go.dev",
	"rubygems.org",
	"docker.io",
	"docker.com",
	"ghcr.io",
	"maven.org",
	"apache.org",
];

/**
 * How far (in characters) a flag may sit from the command it belongs to. Real
 * commands keep them close; the bound keeps matching time linear in the length of
 * the command, because an unbounded gap rescans the whole command from every
 * occurrence of the command word (cubic when two gaps follow each other).
 * Padding more than this between a command and its flag defeats the pairing, so
 * anything that must not be missed that way is the decision model's job.
 */
const GAP = 1_000;
/** Wider, for curl and friends: long headers, tokens, and URLs routinely precede the data flag */
const LINE_GAP = 4_000;

/**
 * The rest of one simple command: stops at ; & | and newlines, but steps over
 * backslash escapes and line continuations. Matching across a newline would pair
 * the flags of one command with the name of another.
 */
const REST = String.raw`(?:[^;&|\n\\]|\\[\s\S]){0,${GAP}}`;
/** Same, but pipes may appear (a decoded payload piped on) */
const REST_PIPED = String.raw`(?:[^;&\n\\]|\\[\s\S]){0,${GAP}}`;
/** Anything later on the same line, for the rules that cannot stop at a separator */
const SAME_LINE = `.{0,${LINE_GAP}}`;

/** Forms of a network command that send data out (as opposed to merely fetching). */
// Short flags may be bundled or carry an attached value (-sd, -sSd, -d@file, -dfoo)
const NET_SEND = String.raw`\b(?:curl|wget|xh|httpie)\b${SAME_LINE}(?:\s-[A-Za-z]*[dFT]|\s--(?:data[\w-]*|form[\w-]*|upload-file|post-file|post-data|body-data|body-file|json)\b)|\b(?:nc|ncat|netcat|socat|telnet)\b|\b(?:scp|sftp|rsync|ftp)\b|/dev/(?:tcp|udp)/|\bgh\s+gist\s+create\b`;

/** Programs that reach the network. */
const NET_CLIENT = String.raw`\b(?:curl|wget|nc|ncat|netcat|telnet|ftp|sftp|ssh|scp|rsync|socat|xh|httpie)\b|\bgit\s+(?:push|clone|fetch|pull|remote|submodule|ls-remote)\b|\b(?:npm|npx|pnpm|yarn|pip3?|cargo|go|gem|brew|docker)\s+(?:i|install|add|get|publish|pull|push|fetch)\b`;

const SHELL = "(?:(?:ba|z|da|k)?sh)";

/**
 * Start of a command: beginning of input, after a separator, or after sudo.
 * Keeps rules from firing on words inside echoed text or paths.
 */
const CMD_START = String.raw`(?:^|[;&|(\n]\s*|\b(?:sudo|doas)\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*)`;

/** What may follow a shell that is being fed a script: end, a separator, or a stdin flag. */
const SHELL_FED = String.raw`(?=\s*(?:$|[;&)\n])|\s+-s\b|\s+-(?:\s|$))`;

export const DEFAULT_RULES: GuardRule[] = [
	// -- exfiltration -------------------------------------------------------
	{
		id: "exfil-sensitive-to-net",
		category: "exfiltration",
		label: "Sensitive data sent over the network",
		allOf: [SENSITIVE_COMMAND_SOURCE, NET_SEND],
	},
	{
		id: "exfil-env-to-net",
		category: "exfiltration",
		label: "Environment variables sent over the network",
		allOf: [
			String.raw`(?:^|[|;&(\s])(?:printenv|env)(?:\s|$|\))|\$\(\s*(?:printenv|env)\b`,
			NET_SEND,
		],
	},
	{
		id: "exfil-reverse-shell",
		category: "exfiltration",
		label: "Raw socket or reverse shell",
		// loopback is exempt: local TCP probes are routine
		pattern: String.raw`/dev/(?:tcp|udp)/(?!127\.|localhost\b|::1)|\bbash\s+-i\s+>&|\b(?:nc|ncat|netcat)\b${REST}\s-[a-zA-Z]*e\b|\bmkfifo\b${REST}\b(?:nc|ncat|netcat)\b`,
	},

	// -- egress -------------------------------------------------------------
	{
		id: "egress-exfil-hosts",
		category: "egress",
		label: "Paste, tunnel, webhook, or callback host",
		hosts: {
			domains: [
				"pastebin.com",
				"paste.ee",
				"hastebin.com",
				"ghostbin.com",
				"ix.io",
				"transfer.sh",
				"file.io",
				"0x0.st",
				"termbin.com",
				"webhook.site",
				"requestbin.com",
				"requestbin.net",
				"pipedream.net",
				"ngrok.io",
				"ngrok.app",
				"ngrok-free.app",
				"trycloudflare.com",
				"serveo.net",
				"localhost.run",
				"loca.lt",
				"hooks.slack.com",
				"api.telegram.org",
				"interactsh.com",
				"oast.fun",
				"oast.live",
				"oast.pro",
				"oast.site",
				"oast.online",
				"burpcollaborator.net",
				"canarytokens.com",
			],
		},
	},
	{
		id: "egress-chat-webhooks",
		category: "egress",
		label: "Chat webhook",
		pattern: String.raw`discord(?:app)?\.com/api/webhooks/`,
	},
	{
		id: "egress-risky-tlds",
		category: "egress",
		label: "Host under a high-risk country domain",
		hosts: { tlds: ["cn", "ru", "su", "by", "ir", "kp", "sy"] },
	},
	{
		id: "egress-ip-literal",
		category: "egress",
		label: "Connection to a raw public IP address",
		hosts: { ipLiteral: true },
	},
	{
		id: "egress-not-allowlisted",
		category: "egress",
		label: "Network access to a host outside the allowlist",
		pattern: NET_CLIENT,
		hosts: { notInAllowed: true },
	},
	{
		id: "egress-bulk-archive-upload",
		category: "egress",
		label: "Archive uploaded over the network",
		allOf: [
			String.raw`\b(?:tar|zip|7z|7za|cpio)\b`,
			NET_SEND,
			String.raw`~|\$HOME|/Users/|/home/|\s\.(?:\s|$)|\s\*`,
		],
	},

	// -- obfuscation --------------------------------------------------------
	{
		id: "obf-pipe-to-shell",
		category: "obfuscation",
		label: "Output piped into a shell",
		pattern: String.raw`\|\s*(?:sudo\s+(?:-\S+\s+)*)?${SHELL}\b${SHELL_FED}`,
	},
	{
		id: "obf-base64-exec",
		category: "obfuscation",
		label: "Decoded payload executed",
		// An interpreter only runs the payload when it reads the script from stdin; `python3 -c` parses data
		pattern: String.raw`base64\s+(?:-d|-D|--decode)\b${REST_PIPED}\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:${SHELL}\b|(?:python3?|perl|ruby|node|php)(?:\s+-)?\s*(?:$|[;&)\n|]))|(?<=\b(?:eval|source|bash|sh)\b${REST_PIPED}\$\()[^)]{0,${GAP}}base64\s+(?:-d|-D|--decode)`,
	},
	{
		id: "obf-eval-fetch",
		category: "obfuscation",
		label: "eval of fetched or encoded content",
		pattern: String.raw`\beval\b${REST}\b(?:curl|wget)\b|\beval\b${SAME_LINE}base64`,
	},
	{
		id: "obf-inline-decode",
		category: "obfuscation",
		label: "Inline script decoding or executing a payload",
		pattern: String.raw`\b(?:python3?|perl|ruby|node|php)\s+-[a-zA-Z]*[ceE]\b${SAME_LINE}(?:base64|b64decode|fromCharCode|\bexec\s*\(|\beval\s*\(|__import__)`,
	},

	// -- persistence --------------------------------------------------------
	{
		id: "persist-shell-rc-write",
		category: "persistence",
		label: "Shell startup file modified",
		paths: [
			String.raw`^~/\.(?:bashrc|bash_profile|bash_login|bash_logout|bash_aliases|profile|zshrc|zshenv|zprofile|zlogin|zlogout|inputrc|xprofile|xinitrc)$`,
			// Directory patterns end in (?:/|$): a copy or extraction into the directory resolves to its bare path
			String.raw`^~/\.config/(?:fish|autostart|environment\.d)(?:/|$)`,
		],
	},
	{
		id: "persist-ssh-write",
		category: "persistence",
		label: "SSH configuration or keys modified",
		paths: [String.raw`^~/\.ssh(?:/|$)`],
	},
	{
		id: "persist-git-hooks",
		category: "persistence",
		label: "Git hooks or config modified",
		paths: [String.raw`(?:^|/)\.git/(?:hooks(?:/|$)|config$)`, String.raw`(?:^|/)\.husky(?:/|$)`],
	},
	{
		id: "persist-ci-and-editor",
		category: "persistence",
		label: "CI workflow or editor task modified",
		paths: [
			String.raw`(?:^|/)\.github/workflows(?:/|$)`,
			String.raw`(?:^|/)\.envrc$`,
			String.raw`(?:^|/)\.vscode/(?:tasks|launch|settings)\.json$`,
			String.raw`(?:^|/)\.pre-commit-config\.yaml$`,
		],
	},
	{
		id: "persist-system-config",
		category: "persistence",
		label: "System startup or configuration modified",
		paths: [
			// /etc and /var are symlinks into /private on macOS, and write/edit paths are resolved
			"^(?:/private)?/(?:etc|var/spool/cron|Library/Launch(?:Agents|Daemons))(?:/|$)",
			"^~/Library/Launch(?:Agents|Daemons)(?:/|$)",
			String.raw`^~/\.config/systemd(?:/|$)`,
		],
	},
	{
		id: "persist-credential-config",
		category: "persistence",
		label: "Credential or tool configuration modified",
		paths: [
			String.raw`^~/\.(?:npmrc|pypirc|netrc|git-credentials|gitconfig)$`,
			String.raw`^~/\.(?:aws|gnupg|kube|azure)(?:/|$)`,
			String.raw`^~/\.config/(?:gcloud|gh)(?:/|$)`,
			String.raw`^~/\.docker/config\.json$`,
		],
	},
	{
		id: "persist-pi-config",
		category: "persistence",
		label: "pi settings, extensions, skills, prompts, or global instructions modified",
		// Skills and prompts are instructions the agent follows later: a write is persistent prompt injection
		paths: [
			String.raw`^~/\.pi/agent/(?:settings\.json|models\.json|AGENTS\.md|(?:extensions|skills|prompts|themes)(?:/|$))`,
			String.raw`^~/\.agents(?:/|$)`,
			String.raw`(?:^|/)\.pi/(?:settings\.json|extensions(?:/|$))`,
		],
	},
	{
		id: "persist-symlink-to-sensitive",
		category: "persistence",
		label: "Symlink to a sensitive file",
		// A link in the project would let later reads and sends reach the secret under a harmless name
		pattern: String.raw`${CMD_START}ln\s${REST}(?:${SENSITIVE_COMMAND_SOURCE})`,
	},
	{
		id: "persist-commands",
		category: "persistence",
		label: "Scheduled task or service installed",
		pattern: String.raw`${CMD_START}crontab\s+(?!-l\b)|\blaunchctl\s+(?:load|bootstrap|enable|submit)\b|\bsystemctl\s+(?:--user\s+)?enable\b|\bgit\s+config\b(?!${REST}\s--(?:get|get-all|get-regexp|list|unset)\b)${REST}\b(?:core\.(?:hookspath|sshcommand|fsmonitor)|credential\.helper|alias\.\S+)\s+[^\s;&|<>]`,
	},

	// -- protected ----------------------------------------------------------
	{
		id: "protect-pi-config",
		category: "protected",
		label: "command-guard configuration or pi credentials",
		paths: [
			String.raw`^~/\.pi/agent/(?:command-guard\.json|auth\.json)$`,
			String.raw`(?:^|/)\.pi/command-guard\.json$`,
		],
	},

	// -- destructive --------------------------------------------------------
	{
		id: "destructive-rm-recursive-force",
		category: "destructive",
		label: "Forced recursive delete",
		pattern: String.raw`\brm\b(?=${REST}(?:\s-[a-zA-Z]*[rR]|\s--recursive))(?=${REST}(?:\s-[a-zA-Z]*f|\s--force))`,
	},
	{
		id: "destructive-rm-root-or-home",
		category: "destructive",
		label: "Recursive delete of root or home",
		// Independent lookaheads, not one pattern with two gaps: the cost adds up instead of multiplying
		pattern: String.raw`\brm\b(?=${REST}(?:\s-[a-zA-Z]*[rR]|\s--recursive))(?=${REST}\s(?:/|/\*|~|~/|~/\*|\$HOME/?\*?|\$\{HOME\}/?\*?)(?=\s|$|[;&|]))`,
	},
	{
		id: "destructive-disk-device",
		category: "destructive",
		label: "Filesystem or raw disk write",
		pattern: String.raw`\bmkfs(?:\.\w+)?\b|\bdd\b${REST}\bof=/dev/|>\s*/dev/(?:sd|nvme|disk|hd|mmcblk)\w*|\bdiskutil\s+(?:erase\w*|partition\w*|zero\w*|secureerase)\b`,
	},
	{
		id: "destructive-git-history",
		category: "destructive",
		label: "Git history or working tree destroyed",
		// Forced pushes include a leading + on a refspec; --delete and --mirror remove remote refs
		pattern: String.raw`\bgit\s+push\b${REST}(?:\s--force(?:-with-lease)?\b|\s-f\b|\s\+\S|\s--(?:delete|mirror)\b)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\b${REST}\s-[a-zA-Z]*f`,
	},
	{
		id: "destructive-chmod-recursive-open",
		category: "destructive",
		label: "Recursive permission opening",
		// Independent lookaheads, so `chmod 777 -R dir` is caught as well as `chmod -R 777 dir`
		pattern: String.raw`\bchmod\b(?=${REST}\s-[a-zA-Z]*R)(?=${REST}\s(?:0?777|a\+rwx|o\+w)\b)`,
	},
];

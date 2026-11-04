/**
 * The narrow floor: things a policy of effects should never let through.
 *
 * These are not a general rule set. Every other decision comes from the effect
 * classifier and the path/host policy in policy.ts. A pattern belongs here only
 * when the action has no legitimate place in ordinary work.
 */

import { shellScanText } from "./extract.ts";
import { SENSITIVE_COMMAND_SOURCE } from "./paths.ts";

const SENSITIVE = new RegExp(SENSITIVE_COMMAND_SOURCE, "i");

/** A shell command in command position, optionally behind sudo. */
const CMD = String.raw`(?:^|[;&|(\n]\s*|\bsudo\s+(?:-\S+\s+)*)`;

const DISK_TOOL = new RegExp(
	String.raw`${CMD}(?:mkfs(?:\.\w+)?|diskutil\s+(?:erase\w*|partition\w*|zero\w*|secureerase))\b`,
	"i",
);
const DISK_DD = new RegExp(
	String.raw`${CMD}dd\s[^;&|\n]*\bof=\/dev\/(?:sd|nvme|disk|hd|mmcblk|rdisk)\w*`,
	"i",
);
const DISK_REDIRECT = />\s*\/dev\/(?:sd|nvme|disk|hd|mmcblk|rdisk)\w*/i;

const SECURE_ERASE = new RegExp(
	String.raw`${CMD}(?:shred|srm)\b|\brm\b[^;&|\n]*\s-[a-zA-Z]*P\b`,
	"i",
);

const REVERSE_SOCKET = /\/dev\/(?:tcp|udp)\/(?!127\.|localhost\b|::1)/i;
const NC_EXEC = new RegExp(String.raw`${CMD}(?:nc|ncat|netcat)\s[^;&|\n]*\s-[a-zA-Z]*e\b`, "i");
const BASH_INTERACTIVE = new RegExp(String.raw`${CMD}(?:ba|z|da|k)?sh\s+-i\s+>&`, "i");

const RM_ROOT =
	/\brm\b(?=[^;&|\n]*(?:\s-[a-zA-Z]*[rR]|\s--recursive))(?=[^;&|\n]*\s(?:--?no-preserve-root\s+)?(?:\/|~|\$HOME|\$\{HOME\})(?:\/?\*?)?(?=\s|$|[;&|]))/;

const REMOTE_TO_SHELL =
	/\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\bbase64\s+(?:-d|-D|--decode)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i;

const CHMOD_ROOT =
	/\bchmod\b[^;&|\n]*\s-[a-zA-Z]*R[^;&|\n]*\s(?:0?777|a\+rwx|o\+w)\s+(?:\/|~)(?:\s|$|[;&|])/i;

/** Forms that send data rather than merely fetch it. */
const NET_SEND =
	/\b(?:curl|wget|xh|httpie)\b[^;&|\n]*(?:\s-[A-Za-z]*[dFT]|\s--(?:data[\w-]*|form[\w-]*|upload-file|post-file|post-data|body-data|body-file|json)\b)|\b(?:nc|ncat|netcat|socat|telnet)\b|\b(?:scp|sftp|rsync|ftp)\b|\/dev\/(?:tcp|udp)\/|\bgh\s+gist\s+create\b/i;

/**
 * Code passed to an interpreter with -c or -e is not shell text. Blanking it
 * keeps a Python or Node snippet that happens to contain "curl" or ".env" from
 * tripping a shell pattern. The tradeoff is that an interpreter can read a
 * secret and send it without the floor seeing either half; the sandbox, not
 * this pattern, is the boundary for that.
 */
const INTERPRETER_CODE =
	/\b(?:node|nodejs|deno|bun|python\d*|perl|ruby|php|osascript)\b[^;&|\n]*?\s(?:-e|-c|--eval|--execute)\s+(['"])(?:\\.|[\s\S])*?\1/g;

/**
 * The command text the floor inspects: shell code only, not interpreter bodies.
 * An interpreter argument that contains a sensitive path is replaced by a
 * marker, so a shell-level network client outside it can still be paired with
 * the read without treating code strings as shell commands.
 */
function floorText(command: string): { text: string; sensitiveInCode: boolean } {
	let sensitiveInCode = false;
	const text = shellScanText(command).replace(INTERPRETER_CODE, (match) => {
		const quoted = match.match(/(['"])(?:\\.|[\s\S])*?\1$/);
		if (quoted && SENSITIVE.test(quoted[0])) sensitiveInCode = true;
		return quoted ? `${match.slice(0, match.length - quoted[0].length)}<code>` : match;
	});
	return { text, sensitiveInCode };
}

/** Why this command is never allowed, or undefined when the floor does not apply. */
export function floorHit(command: string): string | undefined {
	const { text, sensitiveInCode } = floorText(command);
	if (DISK_TOOL.test(text) || DISK_DD.test(text) || DISK_REDIRECT.test(text)) {
		return "raw disk or filesystem device write";
	}
	if (REVERSE_SOCKET.test(text) || NC_EXEC.test(text) || BASH_INTERACTIVE.test(text)) {
		return "reverse shell or raw socket";
	}
	if (SECURE_ERASE.test(text)) return "secure erase";
	if (RM_ROOT.test(text)) return "recursive delete of root or home";
	if (REMOTE_TO_SHELL.test(text)) return "remote script piped into a shell";
	if (CHMOD_ROOT.test(text)) return "recursive permission opening on root or home";
	if ((SENSITIVE.test(text) || sensitiveInCode) && NET_SEND.test(text)) {
		return "sensitive data sent over the network";
	}
	return undefined;
}

/** True when the command sends data rather than only fetching it. */
export function sendsData(command: string): boolean {
	const { text } = floorText(command);
	return (
		NET_SEND.test(text) ||
		/\bcurl\b[^;&|\n]*(?:\s-X\s*(?!GET\b)\w+|\s--request\s+(?!GET\b)\w+)/i.test(text) ||
		/\b(?:http|https|httpie|xh)\s+(?:POST|PUT|PATCH|DELETE)\b/i.test(text)
	);
}

/** Normalize a tool call into the Descriptor the rules and judge work on. */

import { resolve } from "node:path";
import { extractHosts, extractWriteTargets, stripInertHeredocs } from "./extract.ts";
import { realResolve } from "./paths.ts";
import type { Descriptor } from "./types.ts";

export function describeBash(command: string, cwd: string, home: string): Descriptor {
	const scanText = stripInertHeredocs(command);
	return {
		tool: "bash",
		cwd,
		command,
		scanText,
		hosts: extractHosts(scanText),
		paths: extractWriteTargets(scanText, cwd, home),
	};
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolve a write/edit path the way pi's file tools do (@ prefix stripped, ~
 * expanded, resolved against cwd), then follow symlinks so a link cannot hide
 * a protected target.
 */
function toolPath(raw: string, cwd: string, home: string): string {
	let p = raw.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
	return realResolve(resolve(cwd, p));
}

function describeFile(
	tool: "write" | "edit",
	input: Record<string, unknown>,
	cwd: string,
	home: string,
): Descriptor | undefined {
	if (typeof input.path !== "string") return undefined;

	let content: string | undefined;
	if (tool === "write") {
		content = typeof input.content === "string" ? input.content : undefined;
	} else if (Array.isArray(input.edits)) {
		content = input.edits
			.map((e) => (e && typeof e.newText === "string" ? e.newText : ""))
			.join("\n");
	} else if (typeof input.newText === "string") {
		content = input.newText;
	}

	return { tool, cwd, hosts: [], paths: [toolPath(input.path, cwd, home)], content };
}

/** Undefined for tools the guard does not cover, or input it cannot make sense of. */
export function describeToolCall(
	event: { toolName: string; input: unknown },
	cwd: string,
	home: string,
): Descriptor | undefined {
	const input = (event.input ?? {}) as Record<string, unknown>;
	switch (event.toolName) {
		case "bash":
			return typeof input.command === "string" ? describeBash(input.command, cwd, home) : undefined;
		case "write":
		case "edit":
			return describeFile(event.toolName, input, cwd, home);
		default:
			return undefined;
	}
}

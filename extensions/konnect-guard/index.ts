/**
 * Konnect Guard Extension
 *
 * Konnect ships Claude Code `PreToolUse` hooks (see `konnect hook <name>` and the
 * matcher table in `~/.claude/settings.json`) that restate its board-state rules
 * before PCB tools run. Pi has no hook configuration, so the same rules are added
 * as a system-prompt section once a Konnect tool is declared to the model. The
 * server uses deferred exposure, so a session that never searches for a Konnect
 * tool never carries the section; one that does gets it on the next run.
 *
 * The per-tool requirements still come from the server's own tool descriptions and
 * server-side guards; this text only keeps the model from working around them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const KONNECT_TOOL_PREFIX = "mcp__konnect__";
export const GUARDRAIL_SECTION = "konnect_guardrails";

export const GUARDRAILS = `Konnect enforces board-state requirements with server-side guards. Follow them:

- Live-IPC PCB operations need KiCad running with the exact requested board open. If IPC or board identity fails, ask the user to open that board and retry once; never bypass the guard by editing the board file behind KiCad.
- Operations with a guarded closed-board fallback let the tool choose the safe path. Never force a file edit while KiCad holds the board open; treat the server's board identity and revision checks as authoritative.
- Operations that edit the saved file directly need the board closed in KiCad. Ask the user to close it first; do not bypass the server's open-board refusal.
- Planning and apply phases of one tool can differ in board-state requirements. A dry run is non-mutating; before applying, follow the tool description and the returned plan exactly and never reuse a stale plan revision.`;

/** Whether any Konnect MCP tool is registered in this session. */
export function hasKonnectTools(toolNames: readonly string[]): boolean {
	return toolNames.some((name) => name.startsWith(KONNECT_TOOL_PREFIX));
}

export default function konnectGuard(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		if (event.systemPromptOptions.sections[GUARDRAIL_SECTION]) return;
		// Gate on declared tools, not registered ones: Konnect uses deferred exposure,
		// so this keeps the guardrails out of sessions that never load a Konnect tool.
		if (!hasKonnectTools(pi.getActiveTools())) return;
		event.systemPromptOptions.sections[GUARDRAIL_SECTION] = GUARDRAILS;
	});
}

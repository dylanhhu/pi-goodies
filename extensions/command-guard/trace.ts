/**
 * Shows how approved calls were decided, under the call in the transcript.
 *
 * Blocked and declined calls already say why. A call that simply ran says
 * nothing, so this adds a note under it: who let it through, and what the
 * decision model scored. It wraps the renderers of the guarded tools, so the
 * tools themselves are untouched.
 *
 * Entries come from the guard as calls are decided, and from the audit entries
 * in the session when it is resumed. The level can change at any time; rows
 * already on screen are redrawn.
 */

import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { AuditEntry } from "./guard.ts";
import { renderNote } from "./trace-format.ts";
import { TOOL_NAMES, type TraceLevel } from "./types.ts";

/** Session entry type the guard records decisions under. */
export const AUDIT_ENTRY_TYPE = "command-guard";

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Validates an entry read back from a session file, which nothing guarantees is ours. */
export function parseAuditEntry(data: unknown): AuditEntry | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const d = data as Record<string, unknown>;
	if (typeof d.toolCallId !== "string" || typeof d.tool !== "string") return undefined;
	if (d.outcome !== "allow" && d.outcome !== "confirm" && d.outcome !== "block") return undefined;
	if (typeof d.source !== "string") return undefined;

	const entry: AuditEntry = {
		tool: d.tool,
		toolCallId: d.toolCallId,
		outcome: d.outcome,
		source: d.source as AuditEntry["source"],
		rules: Array.isArray(d.rules) ? d.rules.filter((r): r is string => typeof r === "string") : [],
	};
	if (typeof d.scores === "object" && d.scores !== null) {
		const scores: Record<string, number> = {};
		for (const [key, value] of Object.entries(d.scores)) {
			if (typeof value === "number" && Number.isFinite(value)) scores[key] = value;
		}
		entry.scores = scores;
	}
	if (typeof d.thresholds === "object" && d.thresholds !== null) {
		const thresholds: NonNullable<AuditEntry["thresholds"]> = {};
		for (const [key, value] of Object.entries(d.thresholds)) {
			const t = value as { confirm?: unknown; block?: unknown } | null;
			if (typeof t?.confirm !== "number" || !Number.isFinite(t.confirm)) continue;
			thresholds[key] =
				typeof t.block === "number" && Number.isFinite(t.block)
					? { confirm: t.confirm, block: t.block }
					: { confirm: t.confirm };
		}
		entry.thresholds = thresholds;
	}
	if (Array.isArray(d.notes)) {
		entry.notes = d.notes.filter((n): n is string => typeof n === "string");
	}
	if (d.judgeError === true) entry.judgeError = true;
	if (typeof d.confirmed === "boolean") entry.confirmed = d.confirmed;
	return entry;
}

/** A tool's own call rendering with the note beneath it. */
class WithNote implements Component {
	inner: Component;
	note: (width: number) => string[];

	constructor(inner: Component, note: (width: number) => string[]) {
		this.inner = inner;
		this.note = note;
	}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		// A call with nothing drawn yet gets no note either
		return lines.length === 0 ? lines : [...lines, ...this.note(width)];
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

export function createTrace() {
	let level: TraceLevel = "off";
	const entries = new Map<string, AuditEntry>();
	/** Redraws a row; known once the row has been drawn */
	const redraw = new Map<string, () => void>();

	const trace = {
		get level(): TraceLevel {
			return level;
		},

		setLevel(next: TraceLevel) {
			if (next === level) return;
			level = next;
			for (const fn of redraw.values()) fn();
		},

		/** A call was decided and goes ahead */
		record(entry: AuditEntry) {
			entries.set(entry.toolCallId, entry);
			redraw.get(entry.toolCallId)?.();
		},

		/** Replace what is known with the decisions recorded in a session branch */
		load(branch: readonly BranchEntry[]) {
			entries.clear();
			for (const item of branch) {
				if (item.type !== "custom" || item.customType !== AUDIT_ENTRY_TYPE) continue;
				const entry = parseAuditEntry(item.data);
				if (entry) entries.set(entry.toolCallId, entry);
			}
			for (const fn of redraw.values()) fn();
		},

		get(toolCallId: string): AuditEntry | undefined {
			return entries.get(toolCallId);
		},

		/** For `pi.registerToolRenderer` */
		resolver: ((toolName, next) => {
			const base = next();
			const renderCall = base?.renderCall;
			if (!base || !renderCall || !(TOOL_NAMES as readonly string[]).includes(toolName)) {
				return base;
			}
			return {
				...base,
				renderCall(args, theme, context) {
					redraw.set(context.toolCallId, context.invalidate);
					const previous = context.lastComponent;
					const reused = previous instanceof WithNote ? previous : undefined;
					// The tool's renderer keeps its own component between draws; hand it back
					const inner = renderCall(args, theme, {
						...context,
						lastComponent: reused ? reused.inner : previous,
					});
					const note = (width: number) => {
						const entry = entries.get(context.toolCallId);
						return entry
							? renderNote(entry, { level, expanded: context.expanded, width }, theme)
							: [];
					};
					if (reused && reused.inner === inner) {
						reused.note = note;
						return reused;
					}
					return new WithNote(inner, note);
				},
			};
		}) satisfies ToolRendererResolver,
	};
	return trace;
}

export type Trace = ReturnType<typeof createTrace>;

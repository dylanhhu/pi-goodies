/**
 * The note shown under an approved tool call: how command-guard came to let it
 * run, and what the decision model scored it.
 *
 * Pure: takes an audit entry and returns lines, so the layout can be tested
 * without a terminal. Colors follow how close a score came to its confirm
 * threshold, since a score that nearly asked you is the interesting one.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AuditEntry } from "./guard.ts";
import type { TraceLevel } from "./types.ts";

export interface NoteTheme {
	fg(color: string, text: string): string;
}

/** Every dimension the decision model can score, in display order, with a short form for narrow terminals. */
const DIMENSIONS: ReadonlyArray<readonly [name: string, short: string]> = [
	["destructive", "destr"],
	["exfiltration", "exfil"],
	["persistence", "persist"],
	["obfuscation", "obfusc"],
	["unauthorized", "unauth"],
];

/** Confirm threshold assumed for entries recorded without one. */
const FALLBACK_CONFIRM = 0.3;
const BAR_CELLS = 20;
const NAME_WIDTH = Math.max(...DIMENSIONS.map(([name]) => name.length));

/** Tree connector that ties the note to the call above it. */
const LEAD = "└ ";
const INDENT = "  ";

type Color = "success" | "warning" | "error" | "muted" | "dim";

interface Headline {
	/** Short form, for the one-line view */
	short: string;
	/** Longer form, for the expanded view */
	long: string;
	color: Color;
}

/** Whether the entry's call actually ran. Blocked and declined calls are not annotated. */
export function executed(entry: AuditEntry): boolean {
	return entry.outcome === "allow" || entry.confirmed === true;
}

function headline(entry: AuditEntry): Headline {
	const approved = entry.confirmed === true;
	if (entry.source === "judge") {
		if (!approved) {
			return {
				short: "model allowed",
				long: "allowed by the decision model",
				color: "success",
			};
		}
		return entry.judgeError
			? {
					short: "you approved",
					long: "you approved it; the decision model was unavailable",
					color: "warning",
				}
			: {
					short: "you approved",
					long: "you approved it after the decision model flagged it",
					color: "warning",
				};
	}
	if (approved) {
		return {
			short: "you approved",
			long:
				entry.source === "oversize"
					? "you approved it; too large for automatic review"
					: "you approved it; a rule flagged it and the decision model was not consulted",
			color: "warning",
		};
	}
	if (entry.source === "allowlist") {
		return {
			short: "allowlisted",
			long: "allowlisted: plain read-only command, decision model skipped",
			color: "muted",
		};
	}
	return {
		short: "no rule matched",
		long: "no rule matched; allowed by policy, decision model not consulted",
		color: "muted",
	};
}

/** Whether a note is shown at this level. */
export function visible(entry: AuditEntry, level: TraceLevel): boolean {
	if (level === "off" || !executed(entry)) return false;
	if (level === "all") return true;
	// "scores": the decision model was involved
	return entry.source === "judge";
}

/** Keeps anything untrusted (a rule id from a project config) from carrying terminal escapes. */
function plain(text: string, max = 60): string {
	const clean = text.replace(/[^\x20-\x7e]/g, "?");
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function confirmAt(entry: AuditEntry, dimension: string): number {
	return entry.thresholds?.[dimension]?.confirm ?? FALLBACK_CONFIRM;
}

/** Muted when far from the confirm threshold, warning when close, error when over it. */
function scoreColor(p: number, confirm: number): Color {
	if (p >= confirm) return "error";
	if (p >= confirm * 0.5) return "warning";
	return "muted";
}

function fmt(p: number): string {
	return p.toFixed(2);
}

interface Row {
	name: string;
	short: string;
	/** Undefined when the dimension was not assessed */
	p?: number;
	confirm: number;
	block?: number;
}

function rowsOf(entry: AuditEntry): Row[] {
	const scores = entry.scores ?? {};
	const rows: Row[] = DIMENSIONS.map(([name, short]) => ({
		name,
		short,
		p: scores[name],
		confirm: confirmAt(entry, name),
		block: entry.thresholds?.[name]?.block,
	}));
	// A dimension this version does not know about still deserves to be seen
	for (const name of Object.keys(scores)) {
		if (DIMENSIONS.some(([known]) => known === name)) continue;
		rows.push({
			name: plain(name, NAME_WIDTH),
			short: plain(name, NAME_WIDTH),
			p: scores[name],
			confirm: confirmAt(entry, name),
			block: entry.thresholds?.[name]?.block,
		});
	}
	return rows;
}

function cell(threshold: number): number {
	return Math.min(BAR_CELLS - 1, Math.max(0, Math.floor(threshold * BAR_CELLS)));
}

/** A bar over 0..1 with the confirm and block thresholds marked on it. */
function bar(row: Row, theme: NoteTheme): string {
	const p = row.p ?? 0;
	const filled = Math.round(p * BAR_CELLS);
	const fillColor = scoreColor(p, row.confirm);
	const confirmCell = cell(row.confirm);
	const blockCell = row.block !== undefined && Number.isFinite(row.block) ? cell(row.block) : -1;
	let out = "";
	for (let i = 0; i < BAR_CELLS; i++) {
		if (i === blockCell) out += theme.fg("error", "│");
		else if (i === confirmCell) out += theme.fg("warning", "│");
		else if (i < filled) out += theme.fg(fillColor, "━");
		else out += theme.fg("dim", "╌");
	}
	return out;
}

function thresholdText(row: Row): string {
	const parts = [`confirm ${fmt(row.confirm)}`];
	if (row.block !== undefined && Number.isFinite(row.block)) parts.push(`block ${fmt(row.block)}`);
	return parts.join("  ");
}

function compact(entry: AuditEntry, width: number, theme: NoteTheme): string {
	const head = headline(entry);
	const lead = theme.fg("muted", LEAD) + theme.fg(head.color, `✓ ${head.short}`);
	const hasScores = Object.keys(entry.scores ?? {}).length > 0;
	if (!hasScores) {
		const unavailable =
			entry.source === "judge" ? theme.fg("muted", " · decision model unavailable") : "";
		return lead + unavailable;
	}
	// Highest first, so a narrow terminal cuts the least interesting scores
	const rows = rowsOf(entry).sort((a, b) => (b.p ?? -1) - (a.p ?? -1));
	const build = (useShort: boolean) =>
		rows
			.map((row) => {
				const label = useShort ? row.short : row.name;
				if (row.p === undefined) return theme.fg("dim", `${label} n/a`);
				return (
					theme.fg("muted", `${label} `) + theme.fg(scoreColor(row.p, row.confirm), fmt(row.p))
				);
			})
			.join(theme.fg("dim", " · "));
	const sep = theme.fg("dim", " · ");
	const full = lead + sep + build(false);
	return visibleWidth(full) <= width ? full : lead + sep + build(true);
}

function expanded(entry: AuditEntry, width: number, theme: NoteTheme): string[] {
	const head = headline(entry);
	const lines = [theme.fg("muted", LEAD) + theme.fg(head.color, `✓ ${head.long}`)];
	const hasScores = Object.keys(entry.scores ?? {}).length > 0;

	if (hasScores) {
		for (const row of rowsOf(entry)) {
			const name = theme.fg("muted", row.name.padEnd(NAME_WIDTH));
			if (row.p === undefined) {
				lines.push(`${INDENT}${INDENT}${name} ${theme.fg("dim", "n/a")}`);
				continue;
			}
			const value = theme.fg(scoreColor(row.p, row.confirm), fmt(row.p));
			const thresholds = theme.fg("dim", thresholdText(row));
			const withBar = `${INDENT}${INDENT}${name} ${value}  ${bar(row, theme)}  ${thresholds}`;
			lines.push(
				visibleWidth(withBar) <= width
					? withBar
					: `${INDENT}${INDENT}${name} ${value}  ${thresholds}`,
			);
		}
	}
	if (entry.rules.length > 0) {
		const ids = [...new Set(entry.rules)].map((id) => plain(id)).join(", ");
		lines.push(`${INDENT}${INDENT}${theme.fg("muted", "flagged by".padEnd(NAME_WIDTH))} ${ids}`);
	}
	for (const note of entry.notes ?? []) {
		lines.push(`${INDENT}${INDENT}${theme.fg("dim", plain(note, 200))}`);
	}
	return lines;
}

/** The lines to show under the call, or none. */
export function renderNote(
	entry: AuditEntry,
	options: { level: TraceLevel; expanded: boolean; width: number },
	theme: NoteTheme,
): string[] {
	if (!visible(entry, options.level)) return [];
	const lines = options.expanded
		? expanded(entry, options.width, theme)
		: [compact(entry, options.width, theme)];
	return lines.map((line) => truncateToWidth(line, options.width));
}

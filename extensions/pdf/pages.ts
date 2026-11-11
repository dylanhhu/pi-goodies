/**
 * Page-range parsing and text shaping for the `pdf` tool.
 *
 * Kept free of I/O so the range grammar, page splitting, and truncation rules can be
 * unit-tested without poppler or a real document.
 */

/** An inclusive run of consecutive pages, the unit a single poppler call accepts. */
export interface PageRun {
	first: number;
	last: number;
}

export interface PageText {
	page: number;
	text: string;
}

export type ParsedPageSpec = { ok: true; pages: number[] } | { ok: false; error: string };

/** Typographic dashes and minus signs that people paste into page ranges. */
const DASH = /[\u2010-\u2015\u2212]/g;

export const MAX_TEXT_CHARS = 200_000;
export const MIN_TEXT_CHARS = 1_000;

/**
 * Parse a page spec such as `"7"`, `"7-12"`, or `"3, 9-11"` into ascending, deduplicated
 * page numbers bounded by `pageCount`. An empty spec or `"all"` selects every page.
 */
export function parsePageSpec(spec: string | undefined, pageCount: number): ParsedPageSpec {
	// `7 - 12` means the same as `7-12`; models and pasted text both produce the spaced form.
	const raw = (spec ?? "")
		.replace(DASH, "-")
		.replace(/\s*-\s*/g, "-")
		.trim();
	if (raw === "" || raw.toLowerCase() === "all") {
		return { ok: true, pages: Array.from({ length: pageCount }, (_, i) => i + 1) };
	}

	const pages: number[] = [];
	for (const token of raw.split(/[,\s]+/).filter(Boolean)) {
		const match = /^(\d+)(?:-(\d+))?$/.exec(token);
		if (!match) {
			return { ok: false, error: `cannot parse page "${token}" (use 7, 7-12, or 3,9-11)` };
		}
		const first = Number(match[1]);
		const last = match[2] === undefined ? first : Number(match[2]);
		if (first < 1) return { ok: false, error: `page numbers start at 1, got ${first}` };
		if (last < first) return { ok: false, error: `page range "${token}" runs backwards` };
		if (last > pageCount) {
			return {
				ok: false,
				error: `page ${last} is past the end of the document (${pageCount} pages)`,
			};
		}
		for (let page = first; page <= last; page++) pages.push(page);
	}
	return { ok: true, pages: [...new Set(pages)].sort((a, b) => a - b) };
}

/** Collapse sorted page numbers into the fewest consecutive runs. */
export function toRuns(pages: readonly number[]): PageRun[] {
	const runs: PageRun[] = [];
	for (const page of pages) {
		const current = runs.at(-1);
		if (current && page === current.last + 1) current.last = page;
		else runs.push({ first: page, last: page });
	}
	return runs;
}

/** Human-readable page label, e.g. `page 4`, `pages 4-9`, `pages 3, 9-11`. */
export function describePages(pages: readonly number[]): string {
	const runs = toRuns(pages);
	if (runs.length === 0) return "no pages";
	const ranges = runs.map((run) =>
		run.first === run.last ? `${run.first}` : `${run.first}-${run.last}`,
	);
	const singular = runs.length === 1 && runs[0].first === runs[0].last;
	return `${singular ? "page" : "pages"} ${ranges.join(", ")}`;
}

export const EMPTY_PAGE_NOTE =
	'[no text on this page — use action "render" to inspect it as an image]';

/**
 * Split poppler's stdout into per-page text. Poppler separates pages with a form feed and
 * terminates the last page with one, so exactly one trailing empty chunk is dropped; a
 * genuinely blank page in the middle keeps its slot and its page number.
 */
export function splitPageText(output: string, firstPage: number): PageText[] {
	const chunks = output.split("\f");
	if (chunks.length > 1 && chunks[chunks.length - 1]?.trim() === "") chunks.pop();
	return chunks.map((text, index) => ({ page: firstPage + index, text }));
}

/** Squeeze a page's text without disturbing relative indentation. */
function normalizePageText(raw: string): string {
	return raw
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export interface FormattedPageText {
	text: string;
	/** True when the character budget cut the result short. */
	truncated: boolean;
	/** Pages that came back with no text layer. */
	emptyPages: number;
}

/**
 * Render extracted pages as labeled sections under a header, stopping at `maxChars`.
 * Page markers survive truncation so a follow-up read can start at a known page.
 */
export function formatPageText(
	label: string,
	pageCount: number,
	pages: readonly PageText[],
	maxChars: number,
): FormattedPageText {
	const header = `${label} — ${describePages(pages.map((page) => page.page))} of ${pageCount}`;
	const parts = [header];
	let used = header.length;
	let truncated = false;
	let emptyPages = 0;

	for (const page of pages) {
		const body = page.text.trim() === "" ? EMPTY_PAGE_NOTE : normalizePageText(page.text);
		if (body === EMPTY_PAGE_NOTE) emptyPages++;
		const block = `\n=== page ${page.page} ===\n${body}`;
		const room = maxChars - used;
		if (block.length > room) {
			if (room > 200) {
				parts.push(
					`${block.slice(0, room)}\n[truncated — narrow the page range or raise maxChars]`,
				);
			} else if (parts.length > 1) {
				parts.push("\n[truncated — narrow the page range or raise maxChars]");
			}
			truncated = true;
			break;
		}
		parts.push(block);
		used += block.length;
	}

	if (pages.length > 0 && emptyPages === pages.length) {
		parts.push("\n[no text layer anywhere in this range — the pages are probably scanned]");
	}

	return { text: parts.join("\n"), truncated, emptyPages };
}

/** Clamp a character budget into a range that is still useful to a model. */
export function clampMaxChars(value: number | undefined): number {
	if (value === undefined) return 40_000;
	if (!Number.isFinite(value)) return 40_000;
	return Math.min(MAX_TEXT_CHARS, Math.max(MIN_TEXT_CHARS, Math.round(value)));
}

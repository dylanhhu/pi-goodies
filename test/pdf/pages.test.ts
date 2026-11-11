import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	clampMaxChars,
	describePages,
	EMPTY_PAGE_NOTE,
	formatPageText,
	parsePageSpec,
	splitPageText,
	toRuns,
} from "../../extensions/pdf/pages.ts";

function pages(spec: string | undefined, pageCount: number): number[] {
	const parsed = parsePageSpec(spec, pageCount);
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
	return parsed.pages;
}

function error(spec: string, pageCount: number): string {
	const parsed = parsePageSpec(spec, pageCount);
	assert.equal(parsed.ok, false);
	return parsed.ok ? "" : parsed.error;
}

describe("parsePageSpec", () => {
	test("selects every page when the spec is absent or 'all'", () => {
		assert.deepEqual(pages(undefined, 3), [1, 2, 3]);
		assert.deepEqual(pages("", 2), [1, 2]);
		assert.deepEqual(pages("  ALL  ", 2), [1, 2]);
	});

	test("parses single pages, ranges, and lists", () => {
		assert.deepEqual(pages("4", 9), [4]);
		assert.deepEqual(pages("7-9", 9), [7, 8, 9]);
		assert.deepEqual(pages("3, 9-11", 12), [3, 9, 10, 11]);
	});

	test("accepts typographic dashes and stray whitespace", () => {
		assert.deepEqual(pages("9\u201311", 12), [9, 10, 11]);
		assert.deepEqual(pages(" 2 - 3 ", 5), [2, 3]);
	});

	test("sorts and deduplicates", () => {
		assert.deepEqual(pages("9, 2", 9), [2, 9]);
		assert.deepEqual(pages("3, 3-4", 5), [3, 4]);
	});

	test("rejects pages outside the document", () => {
		assert.match(error("0", 5), /start at 1/);
		assert.match(error("9", 5), /past the end/);
		assert.match(error("4-9", 5), /past the end/);
	});

	test("rejects malformed and backwards ranges", () => {
		assert.match(error("5-3", 9), /backwards/);
		assert.match(error("3-", 9), /cannot parse/);
		assert.match(error("three", 9), /cannot parse/);
	});
});

describe("toRuns", () => {
	test("collapses consecutive pages into runs", () => {
		assert.deepEqual(toRuns([]), []);
		assert.deepEqual(toRuns([4]), [{ first: 4, last: 4 }]);
		assert.deepEqual(toRuns([1, 2, 3, 5, 6, 9]), [
			{ first: 1, last: 3 },
			{ first: 5, last: 6 },
			{ first: 9, last: 9 },
		]);
	});
});

describe("describePages", () => {
	test("uses singular for one page and ranges otherwise", () => {
		assert.equal(describePages([4]), "page 4");
		assert.equal(describePages([4, 5, 6]), "pages 4-6");
		assert.equal(describePages([3, 9, 10, 11]), "pages 3, 9-11");
		assert.equal(describePages([]), "no pages");
	});
});

describe("splitPageText", () => {
	test("labels form-feed separated pages by their real numbers", () => {
		const parsed = splitPageText("alpha\fbeta\f", 7);
		assert.deepEqual(parsed, [
			{ page: 7, text: "alpha" },
			{ page: 8, text: "beta" },
		]);
	});

	test("keeps a blank page in the middle", () => {
		const parsed = splitPageText("alpha\f\fgamma\f", 1);
		assert.deepEqual(
			parsed.map((page) => page.page),
			[1, 2, 3],
		);
		assert.equal(parsed[1]?.text, "");
	});

	test("accepts output without a trailing form feed", () => {
		assert.equal(splitPageText("alpha\fbeta", 1).length, 2);
	});
});

describe("formatPageText", () => {
	const page = (number: number, text: string) => ({ page: number, text });

	test("marks page boundaries and names the file", () => {
		const formatted = formatPageText("rules.pdf", 12, [page(4, "T.5.2.3 Roll hoop")], 40_000);
		assert.match(formatted.text, /^rules\.pdf — page 4 of 12/);
		assert.match(formatted.text, /=== page 4 ===\nT\.5\.2\.3 Roll hoop/);
		assert.equal(formatted.truncated, false);
		assert.equal(formatted.emptyPages, 0);
	});

	test("flags pages without a text layer", () => {
		const formatted = formatPageText("scan.pdf", 2, [page(1, "   "), page(2, "")], 40_000);
		assert.equal(formatted.emptyPages, 2);
		assert.match(formatted.text, /probably scanned/);
		assert.ok(formatted.text.includes(EMPTY_PAGE_NOTE));
	});

	test("truncates at the character budget", () => {
		const body = "x".repeat(500);
		const formatted = formatPageText("big.pdf", 3, [page(1, body), page(2, body)], 600);
		assert.equal(formatted.truncated, true);
		assert.match(formatted.text, /\[truncated/);
		// The header plus one page survives, and the second page never lands whole.
		assert.match(formatted.text, /=== page 1 ===/);
	});

	test("does not overflow when the budget is spent before the first page", () => {
		const formatted = formatPageText("big.pdf", 3, [page(1, "y".repeat(500))], 40);
		assert.equal(formatted.truncated, true);
		assert.doesNotMatch(formatted.text, /=== page 1 ===/);
	});
});

describe("clampMaxChars", () => {
	test("bounds the budget", () => {
		assert.equal(clampMaxChars(undefined), 40_000);
		assert.equal(clampMaxChars(0), 1_000);
		assert.equal(clampMaxChars(1e9), 200_000);
		assert.equal(clampMaxChars(5_000), 5_000);
	});
});

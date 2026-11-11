import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExecResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createPdfTool, type PdfExec, type PdfToolDetails } from "../../extensions/pdf/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "fixtures", "pdf");
const fixture = "sample.pdf";

/** Poppler is a host dependency, so the integration tests degrade to skips without it. */
const popplerInstalled = spawnSync("pdftotext", ["-v"], { stdio: "ignore" }).error === undefined;
const skip = popplerInstalled ? false : "poppler (pdftotext/pdftoppm) is not installed";

/** Mirrors `pi.exec`: never rejects for a nonzero exit, only for a missing binary. */
const runExec: PdfExec = (command, args, options = {}) =>
	new Promise<ExecResult>((resolve, reject) => {
		execFile(
			command,
			args,
			{
				encoding: "utf8",
				timeout: options.timeout,
				maxBuffer: options.maxBuffer,
				signal: options.signal,
			},
			(error, stdout, stderr) => {
				if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
					reject(error);
					return;
				}
				resolve({
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					killed: error?.killed ?? false,
					truncated: false,
				});
			},
		);
	});

const tool = createPdfTool(runExec);
const ctx = { cwd: fixtureDir } as unknown as ExtensionToolContext;
type CallParams = Parameters<typeof tool.execute>[1];

function call(params: CallParams) {
	return tool.execute("test-call", params, undefined, undefined, ctx);
}

function textOf(result: Awaited<ReturnType<typeof call>>): string {
	return result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

function imagesOf(result: Awaited<ReturnType<typeof call>>) {
	return result.content.flatMap((block) => (block.type === "image" ? [block] : []));
}

function detailsOf(result: Awaited<ReturnType<typeof call>>): PdfToolDetails {
	return result.details as PdfToolDetails;
}

describe("pdf tool: info", { skip }, () => {
	test("reports page count and page size", async () => {
		const result = await call({ path: fixture, action: "info" });
		const text = textOf(result);
		assert.match(text, /sample\.pdf — 3 pages/);
		assert.match(text, /Page size: 612 x 792 pts \(letter\)/);
		assert.equal(detailsOf(result).pageCount, 3);
	});
});

describe("pdf tool: text", { skip }, () => {
	test("returns only the requested page", async () => {
		const result = await call({ path: fixture, action: "text", pages: "2" });
		const text = textOf(result);
		assert.match(text, /=== page 2 ===/);
		assert.match(text, /T\.5\.2\.3 Roll Hoop Test/);
		assert.doesNotMatch(text, /T\.1\.1 Scope/);
		assert.deepEqual(detailsOf(result).pages, [2]);
		assert.equal(detailsOf(result).truncated, false);
	});

	test("merges disjoint ranges under page markers", async () => {
		const result = await call({ path: fixture, action: "text", pages: "1, 3" });
		const text = textOf(result);
		assert.match(text, /=== page 1 ===/);
		assert.match(text, /=== page 3 ===/);
		assert.doesNotMatch(text, /=== page 2 ===/);
		assert.match(text, /M8 {2,}25 N-m/);
	});

	test("takes a leading @ and an absolute path", async () => {
		const result = await call({
			path: `@${join(fixtureDir, fixture)}`,
			action: "text",
			pages: "2",
		});
		assert.match(textOf(result), /T\.5\.2\.3/);
	});

	test("rejects a page past the end of the document", async () => {
		await assert.rejects(call({ path: fixture, action: "text", pages: "9" }), /past the end/);
	});

	test("rejects a file that is not a PDF", async () => {
		await assert.rejects(
			call({ path: join(here, "pages.test.ts"), action: "text", pages: "1" }),
			/Not a PDF/,
		);
	});

	test("rejects a missing file", async () => {
		await assert.rejects(call({ path: "absent.pdf", action: "text" }), /PDF not found/);
	});
});

describe("pdf tool: render", { skip }, () => {
	test("returns a page as a PNG image", async () => {
		const result = await call({ path: fixture, action: "render", pages: "2" });
		const images = imagesOf(result);
		assert.equal(images.length, 1);
		assert.equal(images[0]?.mimeType, "image/png");
		assert.match(images[0]?.data ?? "", /^iVBORw0KGgo/);
		assert.match(textOf(result), /=== page 2 ===/);
		const details = detailsOf(result);
		assert.equal(details.images, 1);
		assert.ok(details.bytes > 500, `expected a real raster, got ${details.bytes} bytes`);
	});

	test("renders jpeg on request", async () => {
		const result = await call({ path: fixture, action: "render", pages: "1", format: "jpeg" });
		const images = imagesOf(result);
		assert.equal(images[0]?.mimeType, "image/jpeg");
		assert.match(images[0]?.data ?? "", /^\/9j\//);
	});

	test("renders every page when no range is named", async () => {
		const result = await call({ path: fixture, action: "render" });
		assert.equal(imagesOf(result).length, 3);
		assert.equal(detailsOf(result).images, 3);
	});
});

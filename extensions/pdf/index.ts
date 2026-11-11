/**
 * PDF Extension
 *
 * Gives the model two ways into a local PDF: `text` reads a page range's text layer, and
 * `render` rasterizes pages for tables, diagrams, and scanned pages that carry no text.
 * Both take printed page numbers, so a rules lookup costs one range instead of a whole
 * document, and nothing here indexes or caches the file: the caller decides what to read.
 *
 * Shelling out to poppler rather than parsing in TypeScript keeps layout fidelity, which
 * matters for rulebooks whose tables and figure captions are the payload.
 */

import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExecOptions,
	type ExecResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	clampMaxChars,
	describePages,
	formatPageText,
	type PageText,
	parsePageSpec,
	splitPageText,
	toRuns,
} from "./pages.ts";

export type PdfAction = "text" | "render" | "info";

export interface PdfToolDetails {
	action: PdfAction;
	path: string;
	pageCount: number;
	/** Page numbers this call covered. */
	pages: number[];
	/** Characters of text returned by `text`. */
	chars: number;
	/** Images returned by `render`. */
	images: number;
	/** Total rasterized bytes returned by `render`. */
	bytes: number;
	/** True when `maxChars` cut the text short. */
	truncated: boolean;
	/** Pages in the requested range with no text layer. */
	emptyPages: number;
}

export type PdfExec = (
	command: string,
	args: string[],
	options?: ExecOptions,
) => Promise<ExecResult>;

interface PdfInfo {
	pageCount: number;
	fields: Record<string, string>;
}

/** Pages per `render` call. Beyond this the images crowd out the rest of the context. */
export const MAX_RENDER_PAGES = 8;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;

const parameters = Type.Object({
	path: Type.String({
		description:
			"PDF file path, absolute or relative to the working directory. A leading @ is ignored.",
	}),
	action: StringEnum(["text", "render", "info"] as const, {
		description:
			"text reads the text layer of a page range; render rasterizes pages as images for tables, figures, or scanned pages; info reports page count and metadata.",
	}),
	pages: Type.Optional(
		Type.String({
			description:
				'Printed page numbers: "7", "7-12", "3,9-11", or "all". Omit for the whole document, or for render to take every page.',
		}),
	),
	layout: Type.Optional(
		Type.Boolean({
			description:
				"text only: preserve the original column layout, default true. Set false to let prose reflow.",
		}),
	),
	dpi: Type.Optional(
		Type.Number({
			description:
				"render only: raster resolution, default 150, clamped to 50-400. Use 200 or more for small print, 96 for a quick overview.",
		}),
	),
	format: Type.Optional(
		StringEnum(["png", "jpeg"] as const, {
			description:
				"render only: png (default) stays crisp on vector text, jpeg is smaller for scanned or photographic pages.",
		}),
	),
	maxChars: Type.Optional(
		Type.Number({
			description: "text only: character budget for the returned text, default 40000.",
		}),
	),
});

type PdfParams = {
	path: string;
	action: PdfAction;
	pages?: string;
	layout?: boolean;
	dpi?: number;
	format?: "png" | "jpeg";
	maxChars?: number;
};

export function resolvePdfPath(input: string, cwd: string): string {
	const raw = input.startsWith("@") ? input.slice(1) : input;
	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** Reject paths that are not regular files, and files that are not PDFs. */
async function assertPdfFile(path: string): Promise<void> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(path);
	} catch {
		throw new Error(`PDF not found: ${path}`);
	}
	if (!info.isFile()) throw new Error(`Not a file: ${path}`);

	const handle = await open(path, "r");
	try {
		const header = Buffer.alloc(4);
		await handle.read(header, 0, 4, 0);
		if (header.toString("latin1") !== "%PDF") {
			throw new Error(`Not a PDF (missing %PDF header): ${path}`);
		}
	} finally {
		await handle.close();
	}
}

function parseFields(stdout: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (key && value) fields[key] = value;
	}
	return fields;
}

async function readPdfInfo(exec: PdfExec, path: string, signal?: AbortSignal): Promise<PdfInfo> {
	const result = await run(exec, "pdfinfo", [path], signal);
	if (result.code !== 0) {
		const reason = firstLine(result.stderr) || `exit code ${result.code}`;
		if (/password|encrypt/i.test(result.stderr)) {
			throw new Error(
				`PDF is encrypted (${reason}). Decrypt a copy first: qpdf --decrypt "${path}" decrypted.pdf`,
			);
		}
		throw new Error(`pdfinfo could not read ${basename(path)}: ${reason}`);
	}

	const fields = parseFields(result.stdout);
	const pageCount = Number(fields.pages);
	if (!Number.isInteger(pageCount) || pageCount < 1) {
		throw new Error(`Could not determine the page count of ${basename(path)}`);
	}
	return { pageCount, fields };
}

function formatInfo(path: string, info: PdfInfo): string {
	const lines = [`${basename(path)} — ${info.pageCount} pages`];
	const wanted: Array<[string, string]> = [
		["title", "Title"],
		["page size", "Page size"],
		["pdf version", "PDF version"],
		["producer", "Producer"],
	];
	for (const [key, label] of wanted) {
		const value = info.fields[key];
		if (value) lines.push(`${label}: ${value}`);
	}
	return lines.join("\n");
}

function popplerMissing(command: string): Error {
	return new Error(
		`${command} is not available. Install poppler (\`brew install poppler\`) so the pdf tool can read documents.`,
	);
}

async function run(
	exec: PdfExec,
	command: string,
	args: string[],
	signal?: AbortSignal,
): Promise<ExecResult> {
	let result: ExecResult;
	try {
		result = await exec(command, args, {
			signal,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: MAX_BUFFER_BYTES,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/ENOENT|command not found/i.test(message)) throw popplerMissing(command);
		throw error;
	}
	if (result.code === 127) throw popplerMissing(command);
	return result;
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line !== "") ?? ""
	);
}

function clampDpi(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 150;
	return Math.min(400, Math.max(50, Math.round(value)));
}

function details(
	base: Pick<PdfToolDetails, "action" | "path" | "pageCount"> &
		Partial<Omit<PdfToolDetails, "action" | "path" | "pageCount">>,
): PdfToolDetails {
	return {
		pages: [],
		chars: 0,
		images: 0,
		bytes: 0,
		truncated: false,
		emptyPages: 0,
		...base,
	};
}

function parsePages(spec: string | undefined, pageCount: number): number[] {
	const parsed = parsePageSpec(spec, pageCount);
	if (!parsed.ok) throw new Error(`${parsed.error}; the document has ${pageCount} pages`);
	return parsed.pages;
}

async function extractText(
	exec: PdfExec,
	path: string,
	info: PdfInfo,
	pages: number[],
	options: { layout: boolean; maxChars: number; signal?: AbortSignal },
) {
	const chunks: PageText[] = [];
	for (const range of toRuns(pages)) {
		if (options.signal?.aborted) throw new Error("Cancelled");
		const args = ["-f", String(range.first), "-l", String(range.last)];
		if (options.layout) args.push("-layout");
		args.push(path, "-");

		const result = await run(exec, "pdftotext", args, options.signal);
		if (result.code !== 0) {
			throw new Error(
				`pdftotext failed on ${describePages(pages)}: ${firstLine(result.stderr) || `exit code ${result.code}`}`,
			);
		}
		chunks.push(...splitPageText(result.stdout, range.first));
	}

	const formatted = formatPageText(basename(path), info.pageCount, chunks, options.maxChars);
	return {
		content: [{ type: "text" as const, text: formatted.text }],
		details: details({
			action: "text",
			path,
			pageCount: info.pageCount,
			pages,
			chars: formatted.text.length,
			truncated: formatted.truncated,
			emptyPages: formatted.emptyPages,
		}),
	};
}

async function renderPages(
	exec: PdfExec,
	path: string,
	info: PdfInfo,
	pages: number[],
	options: { dpi: number; format: "png" | "jpeg"; signal?: AbortSignal },
) {
	if (pages.length > MAX_RENDER_PAGES) {
		throw new Error(
			`render returns at most ${MAX_RENDER_PAGES} pages per call, but ${pages.length} were requested. Split the range.`,
		);
	}

	const dir = await mkdtemp(join(tmpdir(), "pi-pdf-"));
	const content: Array<
		{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
	> = [
		{
			type: "text",
			text: `${basename(path)} — ${describePages(pages)} of ${info.pageCount}, rendered at ${options.dpi} dpi (${options.format})`,
		},
	];
	let bytes = 0;

	try {
		for (const page of pages) {
			if (options.signal?.aborted) throw new Error("Cancelled");

			const prefix = join(dir, `page-${page}`);
			const args = [options.format === "jpeg" ? "-jpeg" : "-png"];
			if (options.format === "jpeg") args.push("-jpegopt", "quality=85");
			args.push(
				"-r",
				String(options.dpi),
				"-f",
				String(page),
				"-l",
				String(page),
				"-singlefile",
				path,
				prefix,
			);

			const result = await run(exec, "pdftoppm", args, options.signal);
			if (result.code !== 0) {
				throw new Error(
					`pdftoppm failed on page ${page}: ${firstLine(result.stderr) || `exit code ${result.code}`}`,
				);
			}

			const extension = options.format === "jpeg" ? "jpg" : "png";
			const data = await readFile(`${prefix}.${extension}`);
			bytes += data.byteLength;
			content.push({ type: "text", text: `=== page ${page} ===` });
			content.push({
				type: "image",
				data: data.toString("base64"),
				mimeType: options.format === "jpeg" ? "image/jpeg" : "image/png",
			});
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}

	return {
		content,
		details: details({
			action: "render",
			path,
			pageCount: info.pageCount,
			pages,
			images: pages.length,
			bytes,
		}),
	};
}

export function createPdfTool(exec: PdfExec) {
	return defineTool({
		name: "pdf",
		label: "PDF",
		description:
			'Read a local PDF: action "text" returns the text layer of a page range, action "render" returns page images for tables, figures, or scanned pages, action "info" reports page count and metadata.',
		promptSnippet: "Read a PDF page range as text, or render pages as images",
		promptGuidelines: [
			'Use pdf with action "text" to read a specific page range of a PDF, and action "render" when a page holds a table, a diagram, or no text layer. Prefer it over shelling out to pdftotext or pdftoppm.',
		],
		parameters,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as PdfParams;
			const path = resolvePdfPath(input.path, ctx.cwd);
			await assertPdfFile(path);

			const info = await readPdfInfo(exec, path, signal);
			const pages = parsePages(input.pages, info.pageCount);

			if (input.action === "info") {
				return {
					content: [{ type: "text", text: formatInfo(path, info) }],
					details: details({ action: "info", path, pageCount: info.pageCount, pages }),
				};
			}

			if (input.action === "render") {
				return renderPages(exec, path, info, pages, {
					dpi: clampDpi(input.dpi),
					format: input.format ?? "png",
					signal,
				});
			}

			return extractText(exec, path, info, pages, {
				layout: input.layout ?? true,
				maxChars: clampMaxChars(input.maxChars),
				signal,
			});
		},
	});
}

export default function pdfExtension(pi: ExtensionAPI): void {
	pi.registerTool(createPdfTool((command, args, options) => pi.exec(command, args, options)));
}

/**
 * A minimal fake of Pi's extension host, enough to drive the OpenRouter extension through
 * its real handlers and commands without a running Pi.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearEndpointCache } from "../../extensions/openrouter/catalog.ts";
import openrouter from "../../extensions/openrouter/index.ts";
import {
	clearSessionPins,
	clearStateCache,
	clearTurnMixCache,
} from "../../extensions/openrouter/state.ts";
import type { Endpoint } from "../../extensions/openrouter/types.ts";

export type Handler = (event: unknown, ctx: unknown) => unknown;

export interface Notification {
	message: string;
	level: string;
}

export interface Host {
	agentDir: string;
	model: { provider: string; id: string; baseUrl?: string };
	notifications: Notification[];
	/** Entries `getEntries` reports, for the shed continuation lookup. */
	entries: unknown[];
	/** What `ctx.ui.select` answers, by index into the offered options. */
	selectIndex: number;
	ctx: Record<string, unknown>;
	emit(name: string, event: unknown): Promise<unknown>;
	command(name: string, args: string): Promise<void>;
	/** Plain-text notifications joined, for substring assertions. */
	notified(): string;
	writeState(state: unknown): void;
	writeRaw(file: string, text: string): void;
	dispose(): void;
}

export const MODEL_ID = "deepseek/deepseek-v4.1-flash-1017";

export function createHost(options: { model?: Host["model"]; hasUI?: boolean } = {}): Host {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-openrouter-test-"));
	mkdirSync(join(agentDir, "sessions"), { recursive: true });
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	clearStateCache();
	clearSessionPins();
	clearEndpointCache();
	clearTurnMixCache();

	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => undefined;
		},
		registerCommand(
			name: string,
			command: { handler: (args: string, ctx: unknown) => Promise<void> },
		) {
			commands.set(name, command);
		},
		appendEntry() {},
	};
	openrouter(pi as never);
	// The factory read the directory; later tests must not inherit this one's override.
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;

	const notifications: Notification[] = [];
	const host: Host = {
		agentDir,
		model: options.model ?? { provider: "openrouter", id: MODEL_ID },
		notifications,
		entries: [],
		selectIndex: 0,
		ctx: {},
		async emit(name, event) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) {
				const value = await handler(event, host.ctx);
				if (value !== undefined) result = value;
			}
			return result;
		},
		async command(name, args) {
			const command = commands.get(name);
			if (!command) throw new Error(`no command ${name}`);
			await command.handler(args, host.ctx);
		},
		notified: () => notifications.map((entry) => entry.message).join("\n---\n"),
		writeState(state) {
			writeFileSync(join(agentDir, "openrouter.json"), JSON.stringify(state));
		},
		writeRaw(file, text) {
			writeFileSync(join(agentDir, file), text);
		},
		dispose() {
			clearStateCache();
			clearSessionPins();
			rmSync(agentDir, { recursive: true });
		},
	};

	host.ctx = {
		get model() {
			return host.model;
		},
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (message: string, level = "info") => notifications.push({ message, level }),
			setStatus: () => undefined,
			select: async (_title: string, choices: string[]) => choices[host.selectIndex],
		},
		modelRegistry: { getApiKeyForProvider: async () => "test-key" },
		sessionManager: {
			getEntries: () => host.entries,
			getBranch: () => [],
		},
		scopedModels: [],
	};
	return host;
}

/** A chat-completions request body for `model`. */
export function chatBody(model: string = MODEL_ID, extra: Record<string, unknown> = {}) {
	return { model, messages: [{ role: "user", content: "hi" }], ...extra };
}

/** An assistant `message_end` event. */
export function assistantEnd(fields: Record<string, unknown> = {}) {
	return {
		message: {
			role: "assistant",
			provider: "openrouter",
			model: MODEL_ID,
			stopReason: "stop",
			usage: {
				input: 1000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			},
			...fields,
		},
	};
}

export type EndpointFixture = Endpoint;

/** A global `fetch` stand-in serving the model catalog and endpoint lists. */
export function stubOpenRouter(
	endpoints: EndpointFixture[],
	aliases: Record<string, string> = {},
): { calls: string[]; restore: () => void } {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: unknown) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith("/api/v1/models")) {
			const data = Object.entries(aliases).map(([id, slug]) => ({ id, alias_target: { slug } }));
			return new Response(JSON.stringify({ data }), { status: 200 });
		}
		if (url.endsWith("/endpoints")) {
			return new Response(JSON.stringify({ data: { endpoints } }), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

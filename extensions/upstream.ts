/**
 * Upstream provider indicator — shows which provider served the last assistant message.
 *
 * Pi's normalized assistant message records `provider: "openrouter"`, not the upstream that
 * actually answered. OpenRouter exposes the serving upstream in its stream payloads instead:
 * chat-completions chunks carry a top-level `provider`, and Anthropic-messages `message_start`
 * events carry `message.provider`. Both are captured here per response id and committed when
 * the matching assistant message ends, so concurrent requests (warming, compaction) cannot
 * overwrite one another.
 *
 * Providers other than OpenRouter fall back to the model provider id.
 *
 * Status: `via InferenceNet`
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "upstream";
/** Responses are deleted when their assistant message ends; this only bounds abandoned ones. */
const MAX_TRACKED = 64;

interface ServedProvider {
	provider: string;
}

const byResponseId = new Map<string, ServedProvider>();
const byModel = new Map<string, ServedProvider>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The upstream provider named by a raw OpenRouter stream event. */
function upstreamProvider(data: unknown): string | undefined {
	if (!isRecord(data)) return undefined;

	const direct = nonEmpty(data.provider);
	if (direct) return direct;
	if (isRecord(data.message)) {
		const nested = nonEmpty(data.message.provider);
		if (nested) return nested;
	}

	// Router metadata accompanies the final chunk, and only when explicitly requested.
	const metadata = data.openrouter_metadata;
	if (!isRecord(metadata)) return undefined;
	if (isRecord(metadata.endpoints) && Array.isArray(metadata.endpoints.available)) {
		for (const endpoint of metadata.endpoints.available) {
			if (!isRecord(endpoint) || endpoint.selected !== true) continue;
			const selected = nonEmpty(endpoint.provider);
			if (selected) return selected;
		}
	}
	if (Array.isArray(metadata.attempts)) {
		for (const attempt of [...metadata.attempts].reverse()) {
			if (!isRecord(attempt) || attempt.status !== 200) continue;
			const succeeded = nonEmpty(attempt.provider);
			if (succeeded) return succeeded;
		}
	}
	return undefined;
}

/** The provider's response id, which matches `AssistantMessage.responseId`. */
function responseId(data: unknown): string | undefined {
	if (!isRecord(data)) return undefined;
	const direct = nonEmpty(data.id);
	if (direct) return direct;
	if (isRecord(data.message)) return nonEmpty(data.message.id);
	return undefined;
}

function remember(map: Map<string, ServedProvider>, key: string, entry: ServedProvider): void {
	map.delete(key);
	map.set(key, entry);
	while (map.size > MAX_TRACKED) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

export default function (pi: ExtensionAPI) {
	const clearStatus = (ctx: ExtensionContext): void => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	pi.on("session_start", (_event, ctx) => clearStatus(ctx));
	pi.on("model_select", (_event, ctx) => clearStatus(ctx));

	pi.on("provider_stream_event", (event) => {
		if (event.provider !== "openrouter") return;
		const provider = upstreamProvider(event.data);
		if (!provider) return;

		const entry: ServedProvider = { provider };
		const id = responseId(event.data);
		if (id) remember(byResponseId, id, entry);
		remember(byModel, event.model, entry);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;

		const id = nonEmpty(message.responseId);
		const served = (id ? byResponseId.get(id) : undefined) ?? byModel.get(message.model);
		if (id) byResponseId.delete(id);
		if (!ctx.hasUI) return;

		const provider = served?.provider ?? message.provider;
		if (provider) ctx.ui.setStatus(STATUS_KEY, `via ${provider}`);
	});
}

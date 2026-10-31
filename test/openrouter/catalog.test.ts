import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import {
	ALIAS_FAILURE_TTL_MS,
	cachedEndpoints,
	clearEndpointCache,
	costFromPricing,
	effectiveRates,
	fetchEndpoints,
	flexEndpoints,
} from "../../extensions/openrouter/catalog.ts";
import type { Endpoint } from "../../extensions/openrouter/types.ts";
import { stubOpenRouter } from "./harness.ts";

beforeEach(() => clearEndpointCache());

describe("pricing", () => {
	const usage = (input: number, cacheRead: number, cacheWrite: number) => ({
		input,
		output: 0,
		cacheRead,
		cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});

	test("prompt-length tiers are measured against the whole prompt, cache included", () => {
		const pricing = {
			prompt: "0.000001",
			completion: "0.000002",
			overrides: [{ min_prompt_tokens: 200_000, prompt: "0.000002" }],
		};
		// 1K uncached input, but 250K tokens read from cache: the long-context tier applies.
		const cost = costFromPricing(pricing, usage(1_000, 250_000, 0));
		assert.equal(cost.input, 0.002);
		assert.equal(effectiveRates(pricing, 1_000).input, 0.000001);
	});

	test("an explicit zero cache rate is honoured; an unlisted one falls back to the input rate", () => {
		assert.equal(effectiveRates({ prompt: "0.5", input_cache_read: "0" }, 0).cacheRead, 0);
		assert.equal(effectiveRates({ prompt: "0.5" }, 0).cacheRead, 0.5);
		assert.equal(effectiveRates({ prompt: "0.5", input_cache_read: "junk" }, 0).cacheRead, 0.5);
	});

	test("an endpoint with no listed rate sorts last among flex endpoints", () => {
		const list: Endpoint[] = [
			{ tag: "unpriced/flex", service_tier: "flex" },
			{ tag: "cheap/flex", service_tier: "flex", pricing: { prompt: "0.1" } },
			{ tag: "dear/flex", service_tier: "flex", pricing: { prompt: "0.3" } },
		];
		assert.deepEqual(
			flexEndpoints(list).map((endpoint) => endpoint.tag),
			["cheap/flex", "dear/flex", "unpriced/flex"],
		);
	});
});

describe("endpoint cache and aliases", () => {
	let restore: () => void = () => undefined;
	afterEach(() => restore());

	const flex: Endpoint = {
		tag: "deepinfra/fp8/flex",
		service_tier: "flex",
		pricing: { prompt: "0.1" },
	};
	const model = { id: "~deepseek/deepseek-flash-latest" };

	test("a latest alias hits the cache under the slug it resolved to", async () => {
		const stub = stubOpenRouter([flex], { "~deepseek/deepseek-flash-latest": "deepseek/v4-flash" });
		restore = stub.restore;
		assert.equal(cachedEndpoints(model), undefined);
		const fetched = await fetchEndpoints(model, "key");
		assert.equal(fetched.slug, "deepseek/v4-flash");
		assert.deepEqual(
			cachedEndpoints(model)?.map((endpoint) => endpoint.tag),
			["deepinfra/fp8/flex"],
		);
	});

	test("a failed alias lookup is not held for the full TTL", async () => {
		const original = globalThis.fetch;
		let failing = true;
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/api/v1/models")) {
				if (failing) return new Response("down", { status: 503 });
				return new Response(
					JSON.stringify({
						data: [{ id: model.id, alias_target: { slug: "deepseek/v4-flash" } }],
					}),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify({ data: { endpoints: [flex] } }), { status: 200 });
		}) as typeof fetch;
		restore = () => {
			globalThis.fetch = original;
		};

		const first = await fetchEndpoints(model, "key");
		assert.equal(
			first.slug,
			"~deepseek/deepseek-flash-latest",
			"unresolved while the catalog is down",
		);
		failing = false;
		// Still inside the short failure TTL: the failure is remembered, not retried.
		assert.equal((await fetchEndpoints(model, "key")).slug, "~deepseek/deepseek-flash-latest");
		// Past it (far short of the five-minute success TTL), the lookup is retried.
		mock.timers.enable({ apis: ["Date"], now: Date.now() });
		try {
			mock.timers.tick(ALIAS_FAILURE_TTL_MS + 1);
			assert.equal((await fetchEndpoints(model, "key")).slug, "deepseek/v4-flash");
		} finally {
			mock.timers.reset();
		}
	});
});

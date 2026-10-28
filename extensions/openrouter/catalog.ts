/**
 * OpenRouter endpoint catalog, pricing, and formatting.
 *
 * One client and one cache serve both `/flex` and `/pin`, so alias resolution, endpoint
 * lookups, and price comparisons cannot disagree about a model. Endpoints are cached per
 * API origin and canonical slug; `latest` aliases resolve through the catalog's
 * `alias_target` before the endpoints lookup.
 */

import type {
	CatalogCost,
	CatalogEntry,
	Endpoint,
	EndpointPricing,
	ModelLike,
	PriceReference,
	ProviderEntry,
	TurnMix,
	UsageLike,
} from "./types.ts";

export const ENDPOINTS_TTL_MS = 5 * 60_000;
export const ENDPOINTS_TIMEOUT_MS = 15_000;
export const DEFAULT_ORIGIN = "https://openrouter.ai";

const endpointCache = new Map<string, { at: number; endpoints: Endpoint[] }>();
/** Alias id to canonical slug, per API origin. */
const aliasCache = new Map<string, { at: number; aliases: Map<string, string> }>();

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** OpenRouter routing variants (`:floor`, `:nitro`) are suffixes on the model slug. */
export function modelSlug(id: string): string {
	const colon = id.indexOf(":");
	return colon === -1 ? id : id.slice(0, colon);
}

/** Regional base URLs such as `https://us.openrouter.ai/api/v1` keep their origin. */
export function originOf(baseUrl: string | undefined): string {
	if (!baseUrl) return DEFAULT_ORIGIN;
	try {
		return new URL(baseUrl).origin;
	} catch {
		return DEFAULT_ORIGIN;
	}
}

/** Map of `~`-prefixed latest aliases to their canonical slugs, cached per origin. */
async function fetchAliasMap(
	origin: string,
	apiKey: string,
	options: { refresh?: boolean } = {},
): Promise<Map<string, string>> {
	const cached = aliasCache.get(origin);
	if (!options.refresh && cached && Date.now() - cached.at < ENDPOINTS_TTL_MS) {
		return cached.aliases;
	}

	const aliases = new Map<string, string>();
	try {
		const response = await fetch(`${origin}/api/v1/models`, {
			headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(ENDPOINTS_TIMEOUT_MS),
		});
		if (response.ok) {
			const body = (await response.json()) as { data?: unknown } | null;
			if (Array.isArray(body?.data)) {
				for (const entry of body.data as CatalogEntry[]) {
					const id = typeof entry?.id === "string" ? entry.id : undefined;
					const target =
						typeof entry?.alias_target?.slug === "string" ? entry.alias_target.slug : undefined;
					if (id?.startsWith("~") && target) aliases.set(id, target);
				}
			}
		}
	} catch {
		// Resolution is best-effort: an unreachable catalog leaves aliases unresolved.
	}
	aliasCache.set(origin, { at: Date.now(), aliases });
	return aliases;
}

/** Resolve a Pi latest-alias model id to OpenRouter's canonical model slug. */
async function resolveSlug(
	model: { id: string; baseUrl?: string },
	apiKey: string,
	options: { refresh?: boolean } = {},
): Promise<{ slug: string; resolvedFrom?: string }> {
	const base = modelSlug(model.id);
	if (!base.startsWith("~")) return { slug: base };
	const target = (await fetchAliasMap(originOf(model.baseUrl), apiKey, options)).get(base);
	return target ? { slug: target, resolvedFrom: base } : { slug: base };
}

export async function fetchEndpoints(
	model: { id: string; baseUrl?: string },
	apiKey: string,
	options: { refresh?: boolean } = {},
): Promise<{ endpoints: Endpoint[]; error?: string; slug: string; resolvedFrom?: string }> {
	const { slug, resolvedFrom } = await resolveSlug(model, apiKey, options);
	const origin = originOf(model.baseUrl);
	const cacheKey = `${origin}:${slug}`;
	const cached = endpointCache.get(cacheKey);
	if (!options.refresh && cached && Date.now() - cached.at < ENDPOINTS_TTL_MS) {
		return { endpoints: cached.endpoints, slug, resolvedFrom };
	}

	let response: Response;
	try {
		response = await fetch(`${origin}/api/v1/models/${encodeURI(slug)}/endpoints`, {
			headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(ENDPOINTS_TIMEOUT_MS),
		});
	} catch (error) {
		return {
			endpoints: [],
			error: `Endpoint list request failed: ${describe(error)}`,
			slug,
			resolvedFrom,
		};
	}

	if (response.status === 404) {
		return {
			endpoints: [],
			error: `OpenRouter does not list endpoints for \`${slug}\``,
			slug,
			resolvedFrom,
		};
	}
	if (!response.ok) {
		return {
			endpoints: [],
			error: `Endpoint list request failed: HTTP ${response.status}`,
			slug,
			resolvedFrom,
		};
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		return {
			endpoints: [],
			error: `Invalid endpoint list response: ${describe(error)}`,
			slug,
			resolvedFrom,
		};
	}

	const raw = (body as { data?: { endpoints?: unknown } } | undefined)?.data?.endpoints;
	if (!Array.isArray(raw)) {
		return {
			endpoints: [],
			error: "Invalid endpoint list response: missing data.endpoints",
			slug,
			resolvedFrom,
		};
	}

	const endpoints = raw.filter(isEndpoint);
	endpointCache.set(cacheKey, { at: Date.now(), endpoints });
	return { endpoints, slug, resolvedFrom };
}

/** Cached endpoints for a model, when a recent lookup exists. No network. */
export function cachedEndpoints(model: { id: string; baseUrl?: string }): Endpoint[] | undefined {
	const key = `${originOf(model.baseUrl)}:${modelSlug(model.id)}`;
	const cached = endpointCache.get(key);
	return cached && Date.now() - cached.at < ENDPOINTS_TTL_MS ? cached.endpoints : undefined;
}

export function clearEndpointCache(): void {
	endpointCache.clear();
}

function isEndpoint(value: unknown): value is Endpoint {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { tag?: unknown }).tag === "string"
	);
}

/** Flex endpoints, cheapest prompt rate first. */
export function flexEndpoints(endpoints: readonly Endpoint[]): Endpoint[] {
	return endpoints
		.filter((endpoint) => endpoint.service_tier === "flex")
		.sort((a, b) => promptRate(a.pricing) - promptRate(b.pricing));
}

/** Endpoint tags start with the provider slug, e.g. `deepinfra/fp8` or `groq/bf16`. */
export function providerSlugOf(tag: string): string {
	return tag.split("/")[0]?.trim().toLowerCase() ?? "";
}

export function providersOf(endpoints: readonly Endpoint[]): ProviderEntry[] {
	const bySlug = new Map<string, ProviderEntry>();
	for (const endpoint of endpoints) {
		const slug = providerSlugOf(endpoint.tag);
		if (!slug) continue;
		const entry = bySlug.get(slug) ?? { slug, name: endpoint.provider_name, endpoints: 0 };
		entry.endpoints += 1;
		if (!entry.name && endpoint.provider_name) entry.name = endpoint.provider_name;
		bySlug.set(slug, entry);
	}
	return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Provider slugs that operate at least one flex endpoint for this model. */
export function flexProviderSlugs(endpoints: readonly Endpoint[]): Set<string> {
	return new Set(providersOf(flexEndpoints(endpoints)).map((provider) => provider.slug));
}

/** The request's existing `provider` routing block, if it is one. */
export function providerRouting(body: Record<string, unknown>): Record<string, unknown> {
	const routing = body.provider;
	return isRecord(routing) ? routing : {};
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export function ratePerToken(value: string | undefined): number {
	const parsed = Number.parseFloat(value ?? "");
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function promptRate(pricing: EndpointPricing | undefined): number {
	return ratePerToken(pricing?.prompt);
}

/** Per-token prices in USD, using prompt-length overrides when the request exceeds them. */
export function effectiveRates(
	pricing: EndpointPricing,
	inputTokens: number,
): { input: number; output: number; cacheRead: number; cacheWrite: number } {
	const input = ratePerToken(pricing.prompt);
	const output = ratePerToken(pricing.completion);
	const cacheRead = ratePerToken(pricing.input_cache_read) || input;
	const cacheWrite = ratePerToken(pricing.input_cache_write) || input;

	const override = (pricing.overrides ?? [])
		.filter((entry) => entry && (entry.min_prompt_tokens ?? 0) <= inputTokens)
		.sort((a, b) => (b.min_prompt_tokens ?? 0) - (a.min_prompt_tokens ?? 0))[0];
	if (!override) return { input, output, cacheRead, cacheWrite };

	return {
		input: ratePerToken(override.prompt) || input,
		output: ratePerToken(override.completion) || output,
		cacheRead: ratePerToken(override.input_cache_read) || cacheRead,
		cacheWrite: ratePerToken(override.input_cache_write) || cacheWrite,
	};
}

export function costFromPricing(pricing: EndpointPricing, usage: UsageLike): UsageLike["cost"] {
	const rates = effectiveRates(pricing, usage.input);
	// Round away float noise from multiplying per-token prices by token counts.
	const round = (value: number): number => Math.round(value * 1e10) / 1e10;
	const cost = {
		input: round(usage.input * rates.input),
		output: round(usage.output * rates.output),
		cacheRead: round(usage.cacheRead * rates.cacheRead),
		cacheWrite: round(usage.cacheWrite * rates.cacheWrite),
	};
	return { ...cost, total: round(cost.input + cost.output + cost.cacheRead + cost.cacheWrite) };
}

/** Blended cost of one representative turn at an endpoint's rates, honoring prompt-length overrides. */
export function endpointTurnCost(endpoint: Endpoint, mix: TurnMix): number {
	const rates = effectiveRates(endpoint.pricing ?? {}, mix.input + mix.cacheRead + mix.cacheWrite);
	const cost =
		mix.input * rates.input +
		mix.cacheRead * rates.cacheRead +
		mix.cacheWrite * rates.cacheWrite +
		mix.output * rates.output;
	// Round away float noise before comparisons and display.
	return Math.round(cost * 1e10) / 1e10;
}

/** Normalize a model's catalog cost, tolerating missing fields. */
export function catalogCost(model: { cost?: unknown }): CatalogCost | undefined {
	const cost = model.cost as Partial<CatalogCost> | undefined;
	if (!cost || typeof cost !== "object") return undefined;
	const rate = (value: unknown): number => (typeof value === "number" && value >= 0 ? value : 0);
	return {
		input: rate(cost.input),
		output: rate(cost.output),
		cacheRead: rate(cost.cacheRead),
		cacheWrite: rate(cost.cacheWrite),
	};
}

export function referencePrice(
	endpoints: readonly Endpoint[],
	modelCost: CatalogCost | undefined,
	mix: TurnMix,
): PriceReference {
	let best: { tag: string; cost: number } | undefined;
	for (const endpoint of endpoints) {
		if (endpoint.service_tier) continue;
		const cost = endpointTurnCost(endpoint, mix);
		if (cost <= 0) continue;
		if (!best || cost < best.cost) best = { tag: endpoint.tag, cost };
	}
	if (best) return { cost: best.cost, label: best.tag };
	if (!modelCost) return { cost: 0, label: "catalog" };
	const cost =
		(mix.input * modelCost.input +
			mix.cacheRead * modelCost.cacheRead +
			mix.cacheWrite * modelCost.cacheWrite +
			mix.output * modelCost.output) /
		1_000_000;
	return { cost: Math.round(cost * 1e10) / 1e10, label: "catalog" };
}

/** Human-readable baseline, e.g. `vs azure $0.081/turn`. */
export function versusLabel(reference: PriceReference): string {
	return `vs ${reference.label} ${formatUsd(reference.cost)}/turn`;
}

/** Tier suffixes OpenRouter appends to a tier endpoint's tag; the standard sibling drops it. */
const TIER_TAG_SUFFIXES = ["flex", "priority", "fast", "ultrafast", "turbo", "highspeed", "prime"];

/** Standard sibling of a tier tag, e.g. `deepinfra/fp8/flex` to `deepinfra/fp8`. */
export function siblingOfTag(tag: string): string | undefined {
	const parts = tag.split("/");
	if (parts.length < 2) return undefined;
	const last = parts[parts.length - 1].toLowerCase();
	return TIER_TAG_SUFFIXES.includes(last) ? parts.slice(0, -1).join("/") : undefined;
}

export function standardSiblingTag(endpoint: Endpoint): string | undefined {
	return endpoint.service_tier ? siblingOfTag(endpoint.tag) : undefined;
}

/** Standard sibling of the cheapest flex endpoint, the one flex routing would pick. */
export function cheapestFlexSibling(endpoints: readonly Endpoint[]): string | undefined {
	for (const endpoint of flexEndpoints(endpoints)) {
		const sibling = standardSiblingTag(endpoint);
		if (sibling) return sibling;
	}
	return undefined;
}

/** Signed percentage clause on the blended turn cost, omitted when the costs match. */
export function discountClause(cost: number, reference: PriceReference): string | undefined {
	if (!(reference.cost > 0) || !(cost > 0)) return undefined;
	const change = Math.round((1 - cost / reference.cost) * 100);
	if (change === 0) return undefined;
	return `${change > 0 ? "−" : "+"}${Math.abs(change)}% ${versusLabel(reference)}`;
}

/**
 * Comparison baselines for one flex endpoint: the cheapest blended standard endpoint,
 * and the same provider's own standard endpoint (tag without the tier suffix),
 * sorted by baseline price ascending so the tightest comparison comes first.
 */
export function flexComparisonRefs(
	endpoint: Endpoint,
	endpoints: readonly Endpoint[],
	reference: PriceReference,
	mix: TurnMix,
): PriceReference[] {
	const refs: PriceReference[] = [];
	const push = (ref: PriceReference | undefined): void => {
		if (!ref || !(ref.cost > 0)) return;
		if (refs.some((existing) => existing.label === ref.label)) return;
		refs.push(ref);
	};
	push(reference);
	const siblingTag = standardSiblingTag(endpoint);
	if (siblingTag) {
		const sibling = endpoints.find(
			(candidate) => !candidate.service_tier && candidate.tag === siblingTag,
		);
		if (sibling) push({ cost: endpointTurnCost(sibling, mix), label: siblingTag });
	}
	refs.sort((a, b) => a.cost - b.cost);
	return refs;
}

export function flexComparisons(
	endpoint: Endpoint,
	endpoints: readonly Endpoint[],
	reference: PriceReference,
	mix: TurnMix,
): string[] {
	const cost = endpointTurnCost(endpoint, mix);
	const clauses: string[] = [];
	const seen = new Set<string>();
	for (const ref of flexComparisonRefs(endpoint, endpoints, reference, mix)) {
		const clause = discountClause(cost, ref);
		if (clause && !seen.has(clause)) {
			seen.add(clause);
			clauses.push(clause);
		}
	}
	return clauses;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function formatPerMillion(perToken: number): string {
	const perMillion = perToken * 1_000_000;
	if (perMillion === 0) return "$0";
	const digits = perMillion >= 100 ? 0 : perMillion >= 1 ? 2 : 3;
	const text = perMillion.toFixed(digits);
	return `$${text.includes(".") ? text.replace(/\.?0+$/, "") : text}`;
}

export function formatContext(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) return "";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M ctx`;
	return `${Math.round(tokens / 1000)}K ctx`;
}

export function formatUsd(value: number): string {
	if (value === 0) return "$0";
	// Keep two significant digits even for sub-cent per-turn costs.
	const decimals =
		value >= 1
			? 2
			: value >= 0.01
				? 3
				: Math.min(8, Math.max(3, Math.ceil(-Math.log10(value)) + 2));
	return `$${value.toFixed(decimals)}`;
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000) {
		const k = tokens / 1_000;
		return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}K`;
	}
	return String(Math.round(tokens));
}

/** The blend without provenance, e.g. `blend 600 in / 42K cached / 300 cw / 260 out per turn`. */
export function blendNote(mix: TurnMix): string {
	const parts = [`${formatTokens(mix.input)} in`, `${formatTokens(mix.cacheRead)} cached`];
	if (mix.cacheWrite > 0) parts.push(`${formatTokens(mix.cacheWrite)} cw`);
	parts.push(`${formatTokens(mix.output)} out`);
	return `blend ${parts.join(" / ")} per turn`;
}

export function turnMixNote(mix: TurnMix, meta: { turns?: number; source: string }): string {
	const provenance =
		meta.turns !== undefined ? `${meta.turns.toLocaleString("en-US")} turns` : meta.source;
	return `${blendNote(mix)} (${provenance})`;
}

/** Per-Mtok cell `in/out/cr` for the endpoint's listed rates; `—` marks an unlisted cache rate. */
export function ratesCell(pricing: EndpointPricing | undefined): string {
	const p = pricing ?? {};
	const cacheRead =
		p.input_cache_read === undefined ? "—" : formatPerMillion(ratePerToken(p.input_cache_read));
	return `${formatPerMillion(ratePerToken(p.prompt))}/${formatPerMillion(ratePerToken(p.completion))}/${cacheRead}`;
}

/** Model-like helper for endpoint lookups that only carry an id. */
export function modelRef(id: string, baseUrl?: string): ModelLike {
	return { provider: "openrouter", id, baseUrl };
}

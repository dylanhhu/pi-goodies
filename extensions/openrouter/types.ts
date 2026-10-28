/**
 * Shared types for the merged OpenRouter routing extension.
 *
 * The old split kept `flex.ts` (service tier) and `openrouter-pin.ts` (provider routing)
 * as independent owners of the request's `provider` block. They now share one model
 * binding and one route planner, so tier, provider order, fallback, and cost accounting
 * all derive from a single decision per request.
 */

export interface PriceOverride {
	min_prompt_tokens?: number;
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
}

export interface EndpointPricing {
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
	overrides?: PriceOverride[];
}

export interface Endpoint {
	tag: string;
	name?: string;
	model_id?: string;
	provider_name?: string;
	service_tier?: string | null;
	pricing?: EndpointPricing;
	context_length?: number;
	max_completion_tokens?: number;
	uptime_last_30m?: number | null;
	throughput_last_30m?: { p50?: number } | null;
}

/** OpenRouter latest aliases (`~deepseek/deepseek-flash-latest`) redirect to a concrete slug. */
export interface AliasTarget {
	name?: string;
	slug?: string;
}

export interface CatalogEntry {
	id?: string;
	alias_target?: AliasTarget | null;
}

/** A flex service-tier binding. `endpoint: null` means any flex endpoint. */
export interface FlexBinding {
	endpoint: string | null;
	providerName?: string;
	/** Pricing of the pinned endpoint, kept for cost accounting. */
	pricing?: EndpointPricing;
	updatedAt: number;
}

export type PinMode = "only" | "prefer";

/** `model` writes to the state file; `session` keeps the change in this session alone. */
export type PinScope = "model" | "session";

/** A provider-routing pin. `only` never falls back; `prefer` may. */
export interface PinBinding {
	providers: string[];
	mode: PinMode;
	/** Meaningful for `prefer` only; an `only` pin never falls back. */
	allowFallbacks: boolean;
	updatedAt: number;
}

/** One model's combined routing state: flex tier plus provider pin. */
export interface ModelBinding {
	flex?: FlexBinding;
	pin?: PinBinding;
}

/**
 * A representative agentic turn, in tokens. The default is derived from Pi session
 * history; a `turnMix` object in the state file overrides it.
 */
export interface TurnMix {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

/**
 * Where a rate-limited flex request goes for the rest of the cooldown: the same
 * provider's standard-tier endpoint (keeps its prompt cache warm), or OpenRouter's
 * default routing (ignores provider affinity).
 */
export type FallbackRouting = "same-provider" | "openrouter";

export interface GatewayState {
	version: 1;
	models: Record<string, ModelBinding>;
	/** Optional user override for the representative agentic turn. */
	turnMix?: TurnMix;
	/** Where a shed flex request is served during the cooldown. */
	fallback?: FallbackRouting;
}

export interface ProviderEntry {
	slug: string;
	name?: string;
	endpoints: number;
}

/** What a flex discount is measured against: the cheapest standard endpoint, or the catalog price. */
export interface PriceReference {
	/** Blended cost of the representative turn at the comparison endpoint's rates. */
	cost: number;
	/** Endpoint tag providing the rates, or `catalog` when the model list price is used. */
	label: string;
}

/** The four catalog rates in USD per million tokens. */
export interface CatalogCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface ModelLike {
	provider: string;
	id: string;
	baseUrl?: string;
	cost?: unknown;
}

/**
 * The concrete request routing a plan produces. Fields are set only when the plan
 * owns that dimension; an empty plan leaves the payload untouched.
 */
export interface PlannedRoute {
	/** Set to "flex" when the request should use the flex service tier. */
	serviceTier?: "flex";
	/** Provider routing to apply; `only` and `order` are set explicitly, never inherited. */
	provider?: {
		only?: string[];
		order?: string[];
		allow_fallbacks?: boolean;
	};
	/** Endpoint pricing to bill the response against, when the serving endpoint is known. */
	pricing?: EndpointPricing;
	/** True when the request is continuing at standard rates during a flex cooldown. */
	shed?: boolean;
}

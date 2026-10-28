/**
 * Route planning — the single place that decides tier, provider routing, fallback, and
 * the pricing used for cost accounting.
 *
 * Ownership rules:
 * - A pinned flex endpoint owns `provider.only`. A provider pin is stored but dormant
 *   while an endpoint is pinned, because the two constraints can contradict each other.
 * - With flex auto, the provider pin is active and constrains which flex endpoint serves.
 * - During a shed cooldown the request continues at standard rates; the same-provider
 *   route is preferred, ordered through the pin when one is active.
 */

import {
	cheapestFlexSibling,
	flexEndpoints,
	providerSlugOf,
	siblingOfTag,
	standardSiblingTag,
} from "./catalog.ts";
import type {
	Endpoint,
	FallbackRouting,
	FlexBinding,
	ModelBinding,
	PinBinding,
	PlannedRoute,
} from "./types.ts";

export interface RouteInputs {
	binding?: ModelBinding;
	pin?: PinBinding;
	/** Active cooldown for this model, if any. */
	fallback?: { until: number; endpoint?: string };
	routing: FallbackRouting;
	now?: number;
	/** Cached endpoint list, used for auto+pin pricing and the fallback sibling. */
	endpoints?: Endpoint[];
}

/** Provider routing for a pin, or `undefined` when no pin applies. */
export function pinRouting(pin: PinBinding | undefined): PlannedRoute["provider"] | undefined {
	if (!pin || pin.providers.length === 0) return undefined;
	return pin.mode === "only"
		? { only: pin.providers, order: pin.providers, allow_fallbacks: false }
		: { order: pin.providers, allow_fallbacks: pin.allowFallbacks };
}

/**
 * The flex endpoint a request is expected to use, when that is knowable.
 *
 * A pinned endpoint is known. Auto routing with a provider pin resolves to the cheapest
 * flex endpoint among the pinned providers. Auto without a pin leaves the choice to
 * OpenRouter, so pricing stays unknown and the catalog cost remains an upper bound.
 */
export function effectiveFlexEndpoint(
	flex: FlexBinding | undefined,
	pin: PinBinding | undefined,
	endpoints: Endpoint[] | undefined,
): Endpoint | undefined {
	if (!flex) return undefined;
	const flexList = flexEndpoints(endpoints ?? []);
	if (flex.endpoint) {
		const known = flexList.find((endpoint) => endpoint.tag === flex.endpoint);
		if (known) return known;
		// The catalog may be cold; the binding carries the pricing captured at pin time.
		return { tag: flex.endpoint, pricing: flex.pricing };
	}
	if (!pin) return undefined;
	const allowed = new Set(pin.providers);
	return flexList.find((endpoint) => allowed.has(providerSlugOf(endpoint.tag)));
}

/** Order a cooldown's provider list so the sibling provider comes first, keeping the pin. */
function siblingFirst(pin: PinBinding, siblingTag: string): PlannedRoute["provider"] {
	const provider = providerSlugOf(siblingTag);
	const rest = pin.providers.filter((entry) => entry !== provider);
	if (pin.mode === "only") {
		return { only: pin.providers, order: [provider, ...rest], allow_fallbacks: false };
	}
	return { order: [provider, ...rest], allow_fallbacks: pin.allowFallbacks };
}

function planShed(
	flex: FlexBinding | undefined,
	pin: PinBinding | undefined,
	routing: FallbackRouting,
	endpoints: Endpoint[] | undefined,
): PlannedRoute {
	if (routing === "openrouter") {
		// No affinity is added; a provider pin is a persistent constraint, not a fallback choice.
		return { shed: true, provider: pinRouting(pin) };
	}

	let sibling: string | undefined;
	if (flex?.endpoint) sibling = siblingOfTag(flex.endpoint);
	else {
		const effective = effectiveFlexEndpoint(flex, pin, endpoints);
		if (effective) sibling = standardSiblingTag(effective) ?? siblingOfTag(effective.tag);
	}
	if (!sibling) {
		sibling = cheapestFlexSibling(endpoints ?? []);
	}
	if (!sibling) return { shed: true, provider: pinRouting(pin) };

	// An endpoint pin keeps the provider affinity the endpoint itself expressed.
	if (!flex || flex.endpoint)
		return { shed: true, provider: { order: [sibling], allow_fallbacks: true } };
	if (pin) return { shed: true, provider: siblingFirst(pin, sibling) };
	return { shed: true, provider: { order: [sibling], allow_fallbacks: true } };
}

export function planRoute(input: RouteInputs): PlannedRoute {
	const now = input.now ?? Date.now();
	const flex = input.binding?.flex;
	const pin = input.pin;

	if (flex && input.fallback && now < input.fallback.until) {
		return planShed(flex, pin, input.routing, input.endpoints);
	}

	if (!flex) return { provider: pinRouting(pin) };

	if (flex.endpoint) {
		// The endpoint is a hard `only`; a provider pin cannot be honored alongside it.
		// Preserve the endpoint pin's original body: `only` already restricts the route.
		return {
			serviceTier: "flex",
			provider: { only: [flex.endpoint] },
			pricing: effectiveFlexEndpoint(flex, undefined, input.endpoints)?.pricing,
		};
	}

	const effective = effectiveFlexEndpoint(flex, pin, input.endpoints);
	return {
		serviceTier: "flex",
		provider: pinRouting(pin),
		pricing: effective?.pricing,
	};
}

/** Readable flex binding label, for notifications and status. */
export function flexEndpointLabel(flex: FlexBinding, endpoints: Endpoint[] | undefined): string {
	if (flex.endpoint) return flex.endpoint;
	const effective = effectiveFlexEndpoint(flex, undefined, endpoints);
	return effective ? `auto (${effective.tag})` : "auto";
}

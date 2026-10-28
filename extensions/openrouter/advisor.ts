/**
 * Flex advisor — is the flex tier actually cheaper than standard routing?
 *
 * Flex is only worth using while its endpoint's blended price beats the cheapest
 * standard endpoint the model could otherwise use. The comparison uses the same
 * representative turn blend as `/flex`'s discount columns, so the advisory and the
 * picker agree.
 *
 * Pin semantics:
 * - `only` is a hard restriction, so the baseline is the cheapest standard endpoint among
 *   the pinned providers. Advising anything outside the pin would be unactionable.
 * - `prefer` with fallbacks still permits any provider, so the baseline is unrestricted.
 * - `prefer` without fallbacks is a trusted-provider lock. Nothing outside the pin can
 *   serve and nothing inside it can be swapped for another provider, so the advisor stays
 *   silent rather than recommending a change the pin forbids.
 * - A pinned flex endpoint makes the pin dormant, so the baseline is unrestricted.
 */

import { endpointTurnCost, flexEndpoints, providerSlugOf, referencePrice } from "./catalog.ts";
import { effectiveFlexEndpoint } from "./route.ts";
import type { Endpoint, FlexBinding, PinBinding, PriceReference, TurnMix } from "./types.ts";

export interface FlexAdvice {
	/** True when standard routing is cheaper than the flex endpoint serving the request. */
	notOptimal: boolean;
	/** The flex endpoint the advice is about. */
	endpoint: string;
	/** Blended cost of the representative turn on that endpoint. */
	flexCost: number;
	/** The cheapest comparable standard baseline. */
	reference: PriceReference;
}

/** `only` restricts the comparison set; a dormant pin does not. */
function pinRestrictsStandard(pin: PinBinding | undefined, flex: FlexBinding): boolean {
	return Boolean(pin) && !flex.endpoint && pin?.mode === "only";
}

/**
 * A `prefer` pin without fallbacks is a trusted-provider lock: nothing outside the pin
 * can serve, so there is no alternative to advise and the advisor stays silent.
 */
function pinSilencesAdvice(pin: PinBinding | undefined, flex: FlexBinding): boolean {
	return Boolean(pin) && !flex.endpoint && pin?.mode === "prefer" && pin?.allowFallbacks === false;
}

/** Cheapest standard endpoint among the pinned providers. */
function pinnedReference(
	endpoints: readonly Endpoint[],
	pin: PinBinding,
	mix: TurnMix,
): PriceReference | undefined {
	const allowed = new Set(pin.providers);
	let best: { cost: number; label: string } | undefined;
	for (const endpoint of endpoints) {
		if (endpoint.service_tier) continue;
		if (!allowed.has(providerSlugOf(endpoint.tag))) continue;
		const cost = endpointTurnCost(endpoint, mix);
		if (!(cost > 0)) continue;
		if (!best || cost < best.cost) best = { cost, label: endpoint.tag };
	}
	return best;
}

/**
 * Compare the flex endpoint this binding would use against the cheapest standard one.
 * Returns `undefined` when there is nothing reliable to compare: no flex endpoint,
 * no standard endpoint rates, or a pin that leaves no permitted flex endpoint.
 */
export function assessFlex(
	flex: FlexBinding,
	pin: PinBinding | undefined,
	endpoints: readonly Endpoint[],
	mix: TurnMix,
): FlexAdvice | undefined {
	if (pinSilencesAdvice(pin, flex)) return undefined;

	let effective: Endpoint | undefined;
	if (flex.endpoint) effective = effectiveFlexEndpoint(flex, pin, [...endpoints]);
	else if (pin) effective = effectiveFlexEndpoint(flex, pin, [...endpoints]);
	else effective = flexEndpoints(endpoints)[0];
	if (!effective) return undefined;

	const flexCost = endpointTurnCost(effective, mix);
	if (!(flexCost > 0)) return undefined;

	const reference = pinRestrictsStandard(pin, flex)
		? pinnedReference(endpoints, pin as PinBinding, mix)
		: referencePrice(endpoints, undefined, mix);
	// A catalog-price baseline has no per-endpoint rates to compare against.
	if (!reference || reference.label === "catalog" || !(reference.cost > 0)) return undefined;

	return {
		notOptimal: flexCost > reference.cost,
		endpoint: effective.tag,
		flexCost,
		reference,
	};
}

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assessFlex } from "../../extensions/openrouter/advisor.ts";
import {
	effectiveFlexEndpoint,
	isLockedPin,
	planRoute,
} from "../../extensions/openrouter/route.ts";
import type { Endpoint, FlexBinding, PinBinding } from "../../extensions/openrouter/types.ts";

const AUTO: FlexBinding = { endpoint: null, updatedAt: 1 };
const until = Date.now() + 60_000;

const pin = (
	providers: string[],
	mode: PinBinding["mode"] = "only",
	allowFallbacks = false,
): PinBinding => ({ providers, mode, allowFallbacks, updatedAt: 1 });

const endpoints: Endpoint[] = [
	{
		tag: "deepinfra/fp8/flex",
		service_tier: "flex",
		pricing: { prompt: "0.1", completion: "0.2" },
	},
	{ tag: "wafer/fp8/flex", service_tier: "flex", pricing: { prompt: "0.05", completion: "0.2" } },
	{ tag: "deepinfra/fp8", pricing: { prompt: "0.2", completion: "0.4" } },
	{ tag: "wafer/fp8", pricing: { prompt: "0.2", completion: "0.4" } },
	{ tag: "decart/fp8", pricing: { prompt: "0.3", completion: "0.6" } },
];

describe("plans without flex", () => {
	test("a pin-only model carries no service tier", () => {
		const plan = planRoute({
			binding: { pin: pin(["decart"], "prefer", false) },
			pin: pin(["decart"], "prefer", false),
			routing: "same-provider",
		});
		assert.equal(plan.serviceTier, undefined);
		assert.equal(plan.shed, undefined);
		assert.deepEqual(plan.provider, { order: ["decart"], allow_fallbacks: false });
	});

	test("`only` sends only, order, and no fallbacks", () => {
		const plan = planRoute({ pin: pin(["a", "b"]), routing: "same-provider" });
		assert.deepEqual(plan.provider, {
			only: ["a", "b"],
			order: ["a", "b"],
			allow_fallbacks: false,
		});
	});

	test("no pin and no flex plans nothing", () => {
		assert.deepEqual(planRoute({ routing: "same-provider" }), { provider: undefined });
	});
});

describe("shed routing never widens a locked pin", () => {
	test("a sibling outside a strict prefer pin is not injected", () => {
		const locked = pin(["decart"], "prefer", false);
		// The cheapest flex endpoint is wafer's; wafer is not in the pin.
		const plan = planRoute({
			binding: { flex: AUTO },
			pin: locked,
			fallback: { until },
			routing: "same-provider",
			endpoints,
		});
		assert.equal(plan.shed, true);
		assert.deepEqual(plan.provider, { order: ["decart"], allow_fallbacks: false });
	});

	test("a sibling inside the pin is tried first and the pin is kept", () => {
		const plan = planRoute({
			binding: { flex: AUTO },
			pin: pin(["decart", "wafer"], "only"),
			fallback: { until },
			routing: "same-provider",
			endpoints,
		});
		// decart has no flex endpoint, so wafer served flex; its standard sibling leads and
		// the pin's `only` still bounds the route.
		assert.deepEqual(plan.provider, {
			only: ["decart", "wafer"],
			order: ["wafer", "decart"],
			allow_fallbacks: false,
		});
	});

	test("an endpoint-pinned shed keeps a no-fallback pin strict", () => {
		const plan = planRoute({
			binding: { flex: { endpoint: "deepinfra/fp8/flex", updatedAt: 1 } },
			pin: pin(["decart"], "only"),
			fallback: { until },
			routing: "same-provider",
			endpoints,
		});
		assert.deepEqual(plan.provider, { order: ["deepinfra/fp8"], allow_fallbacks: false });
	});

	test("an endpoint-pinned shed without a pin may route around a full sibling", () => {
		const plan = planRoute({
			binding: { flex: { endpoint: "deepinfra/fp8/flex", updatedAt: 1 } },
			fallback: { until },
			routing: "same-provider",
			endpoints,
		});
		assert.deepEqual(plan.provider, { order: ["deepinfra/fp8"], allow_fallbacks: true });
	});

	test("with no sibling and a pin, the pin alone routes", () => {
		const plan = planRoute({
			binding: { flex: AUTO },
			pin: pin(["decart"], "only"),
			fallback: { until },
			routing: "same-provider",
			endpoints: [],
		});
		assert.deepEqual(plan.provider, {
			only: ["decart"],
			order: ["decart"],
			allow_fallbacks: false,
		});
	});

	test("the shed never carries the flex tier", () => {
		const plan = planRoute({
			binding: { flex: AUTO },
			fallback: { until },
			routing: "openrouter",
			endpoints,
		});
		assert.equal(plan.serviceTier, undefined);
		assert.equal(plan.shed, true);
	});

	test("an expired cooldown plans flex again", () => {
		const plan = planRoute({
			binding: { flex: AUTO },
			fallback: { until: Date.now() - 1 },
			routing: "same-provider",
		});
		assert.equal(plan.serviceTier, "flex");
	});
});

describe("flex plans", () => {
	test("an endpoint pin owns provider.only and leaves any pin dormant", () => {
		const plan = planRoute({
			binding: { flex: { endpoint: "deepinfra/fp8/flex", updatedAt: 1 } },
			pin: pin(["decart"]),
			routing: "same-provider",
			endpoints,
		});
		assert.equal(plan.serviceTier, "flex");
		assert.deepEqual(plan.provider, { only: ["deepinfra/fp8/flex"] });
	});

	test("auto with a pin prices the first pinned provider that has flex, not the cheapest", () => {
		const ordered = pin(["deepinfra", "wafer"], "only");
		const effective = effectiveFlexEndpoint(AUTO, ordered, endpoints);
		assert.equal(effective?.tag, "deepinfra/fp8/flex");
		const plan = planRoute({
			binding: { flex: AUTO },
			pin: ordered,
			routing: "same-provider",
			endpoints,
		});
		assert.equal(plan.pricing?.prompt, "0.1");
	});

	test("auto without a pin leaves pricing unknown", () => {
		assert.equal(effectiveFlexEndpoint(AUTO, undefined, endpoints), undefined);
	});
});

describe("locked pins", () => {
	test("`only` and strict prefer are locked; prefer with fallbacks is not", () => {
		assert.equal(isLockedPin(pin(["a"], "only")), true);
		assert.equal(isLockedPin(pin(["a"], "prefer", false)), true);
		assert.equal(isLockedPin(pin(["a"], "prefer", true)), false);
		assert.equal(isLockedPin(undefined), false);
	});
});

describe("advisor", () => {
	test("is silent for a strict prefer pin", () => {
		const mix = { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100 };
		assert.equal(assessFlex(AUTO, pin(["decart"], "prefer", false), endpoints, mix), undefined);
	});
});

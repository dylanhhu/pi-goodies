/**
 * OpenRouter routing — flex service tier and provider pins, planned together.
 *
 * `/flex` chooses the service tier (standard, auto flex, or a specific flex endpoint) and
 * `/pin` constrains which upstream providers may serve the model. Both dimensions are
 * stored on one binding and applied by one `before_provider_request` handler, so the
 * request body cannot end up with a tier and a provider list that contradict each other.
 *
 * Ownership:
 * - A pinned flex endpoint owns `provider.only`. A provider pin stays stored but dormant
 *   while an endpoint is pinned; `/flex on` or `/flex off` makes it active again.
 * - With flex auto, the provider pin constrains which flex endpoints can serve, and its
 *   cost accounting uses the cheapest permitted flex endpoint.
 * - During a capacity cooldown the request continues at standard rates. The same-provider
 *   standard sibling is ordered first, through the pin when one is active.
 *
 * Commands:
 *   /flex                     Pick a flex endpoint, flex auto, or standard pricing
 *   /flex on                  Request flex for any permitted flex endpoint (cheapest first)
 *   /flex <endpoint>          Request flex and pin `provider.only` to that endpoint tag
 *   /flex off                 Standard routing (the provider pin, if any, still applies)
 *   /flex status              Show the tier, the pin state, and the fallback routing
 *   /flex scan [refresh]      Check every scoped model for flex endpoints, then pin one
 *   /flex refresh             Drop the endpoint cache
 *   /flex mix [refresh]       Show or re-derive the per-turn token blend
 *   /flex fallback [...]      Show or set where a shed request is served
 *
 *   /pin                     Pick a provider for the current model from its endpoint list
 *   /pin <slug>[,<slug>...]  Pin to those providers (`provider.only`, no fallbacks)
 *   /pin prefer <slug>...    Prefer those providers, allow fallbacks (`provider.order`)
 *   /pin strict <slug>...    Prefer in order, no fallbacks
 *   /pin off                 Remove the pin for the current model
 *   /pin status              Show the pin, whether it is active, and the flex tier
 *
 *   Prefix with `session` (or `temp`) to scope any pin to this session only.
 *
 * State: ~/.pi/agent/openrouter.json, keyed by `<provider>:<model id>`, holding
 * `{ flex?, pin? }` per model plus `turnMix` and `fallback`. The legacy `flex.json` and
 * `openrouter-pin.json` are imported only when this file does not exist, and are left
 * untouched. An unreadable or invalid file is never replaced by them: the last good state
 * stays in force, a copy of the bad file is saved, and the problem is reported. Writes are
 * atomic, reload on outside changes, and report failure instead of hiding it.
 *
 * Safety:
 * - Shed detection runs only for requests that actually carried the flex tier, and only
 *   while a flex binding still exists, so a pin-only model's 429 is an ordinary error.
 * - The extension's own continuation of a shed attempt (which bypasses Pi's retry budget)
 *   is capped; past the cap a shed sets the cooldown and Pi's bounded retry takes over.
 * - A cooldown never widens a pin that forbids fallbacks.
 * - An explicit `service_tier` in the request body replaces the flex binding but not the
 *   provider pin. A request for a different model, or a body that is not chat-completions
 *   shaped, is not routed; the latter warns, since it means a pin is not in effect.
 * - Handler bodies are guarded: a bug here is reported once and the event proceeds
 *   unmodified, so the extension cannot break a request, a turn, or the session.
 *
 * Billing: the catalog price is the standard-tier price, so while a known flex endpoint
 * serves a request, that message's cost is recomputed from the endpoint's published
 * prices. Flex auto without a pin keeps the catalog cost, an upper bound.
 *
 * Advisor: while a flex binding is active, the endpoint's blended turn cost is compared
 * against the cheapest comparable standard endpoint. The first time standard routing is
 * cheaper in a session, one warning is shown; the status line carries `(not optimal)`
 * until flex is disabled or retargeted. An `only` pin restricts the comparison to its
 * providers; a `prefer` pin with fallbacks compares against all; a `prefer` pin without
 * fallbacks is a trusted-provider lock, so the advisor stays silent. A pinned flex
 * endpoint makes the pin dormant and the baseline unrestricted.
 *
 * Fallback: flex capacity is shed under load, and OpenRouter only falls back to endpoints
 * priced at or below the flex rate. When a flex request fails on a rate-limit or capacity
 * error, the model is served at standard rates for 60s, then flex resumes. The shed
 * attempt is rewritten to a non-retryable error so Pi does not schedule its own retry, and
 * `agent_before_settle` continues the request at standard rates immediately.
 */

import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	type MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { assessFlex, type FlexAdvice } from "./advisor.ts";
import {
	blendNote,
	cachedEndpoints,
	catalogCost,
	cheapestFlexSibling,
	costFromPricing,
	endpointTurnCost,
	fetchEndpoints,
	flexComparisons,
	flexEndpoints,
	flexProviderSlugs,
	formatContext,
	formatPerMillion,
	formatUsd,
	isRecord,
	modelSlug,
	providerRouting,
	providersOf,
	ratePerToken,
	ratesCell,
	referencePrice,
	siblingOfTag,
	standardSiblingTag,
	turnMixNote,
	versusLabel,
} from "./catalog.ts";
import { effectiveFlexEndpoint, planRoute } from "./route.ts";
import {
	bindingFor,
	bindingKey,
	clearSessionPins,
	deleteSessionPin,
	describeFallbackRouting,
	fallbackRouting,
	loadState,
	peekTurnMix,
	putSessionPin,
	resolvePin,
	resolveTurnMix,
	restoreSessionPins,
	SESSION_ENTRY_TYPE,
	STATE_FILE,
	sessionPinState,
	setFallbackRouting,
	setFlexBinding,
	setPinBinding,
	stateHealth,
} from "./state.ts";
import type {
	Endpoint,
	EndpointPricing,
	FlexBinding,
	ModelLike,
	PinBinding,
	PinMode,
	PinScope,
	TurnMix,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Transient request state
// ---------------------------------------------------------------------------

const STATUS_KEY = "openrouter";
/** Keys owned by the pre-merge extensions, cleared so a reload leaves no stale text. */
const LEGACY_STATUS_KEYS = ["flex", "pin"];

/**
 * How long a request's cost and shed bookkeeping stays valid. Flex requests queue, so a
 * response can legitimately arrive many minutes after the request left; this only bounds
 * state that a request abandoned without a `message_end`.
 */
const REQUEST_STATE_TTL_MS = 30 * 60_000;

/**
 * The extension may relabel a shed attempt and continue it itself, bypassing Pi's retry
 * budget. That bypass is capped: past this many per window, a shed only sets the cooldown
 * and the error goes to Pi's own bounded retry.
 */
const MAX_SHED_CONTINUATIONS = 2;
const SHED_WINDOW_MS = 5 * 60_000;

/** A shed's provider lookup must not hold up the message for a slow catalog. */
const FALLBACK_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * How long flex stays shed after a rate-limit or capacity error. The cooldown covers
 * the immediate standard-tier continuation and the next turns, and expires once flex
 * may have capacity again.
 */
const FALLBACK_COOLDOWN_MS = 60_000;

/**
 * Provider errors that mean flex capacity was unavailable, rather than the request
 * being invalid: OpenRouter surfaces a flex shed as 429/503, or as capacity wording
 * from the upstream provider. Dropping to the standard tier is the remedy in each.
 */
const FALLBACK_ERROR_PATTERN = new RegExp(
	[
		"\\b(?:429|503|529)\\b",
		"rate.?limit",
		"too many requests",
		"capacity",
		"resource_unavailable",
		"no available (?:model )?provider",
		"service.?unavailable",
		"temporarily unavailable",
		"overloaded",
		"\\bflex\\b",
	].join("|"),
	"i",
);

type Shed = { until: number; reason: string; endpoint?: string };

/** Resolve with `undefined` if `promise` has not settled within `ms`; it keeps running. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** The triggering provider error, trimmed to one line for the notification and status. */
function fallbackReason(error: string | undefined): string | undefined {
	if (!error || !FALLBACK_ERROR_PATTERN.test(error)) return undefined;
	const single = error.replace(/\s+/g, " ").trim();
	return single.length > 160 ? `${single.slice(0, 157)}...` : single;
}

/**
 * Error text left on a shed flex attempt. Pi's retry classifier matches the original
 * 429/capacity wording and would sleep before retrying, so the attempt is relabelled
 * with wording it does not match; `agent_before_settle` then continues it directly.
 */
const FALLBACK_STOP_MESSAGE = "Flex capacity shed; continuing at standard rates";

/** Entry of the shed assistant message, so the continuation can omit it from context. */
function shedAttemptEntryId(ctx: ExtensionContext, errorText: string): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.stopReason === "error" && entry.message.errorMessage === errorText
			? entry.id
			: undefined;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Shared display helpers
// ---------------------------------------------------------------------------

/** Status-bar width: name the first few providers and count the rest. */
const STATUS_PROVIDER_LIMIT = 2;

function statusProviderList(providers: readonly string[]): string {
	if (providers.length <= STATUS_PROVIDER_LIMIT) return providers.join(", ");
	const shown = providers.slice(0, STATUS_PROVIDER_LIMIT).join(", ");
	return `${shown} +${providers.length - STATUS_PROVIDER_LIMIT}`;
}

function pinSuffix(pin: PinBinding, sessionScoped: boolean): string {
	// `prefer` is the default reading of a provider list, so only the exception is shown.
	const fallbacks = pin.mode === "prefer" && !pin.allowFallbacks ? " (no fb)" : "";
	const scope = sessionScoped ? " (this session)" : "";
	return `${statusProviderList(pin.providers)}${fallbacks}${scope}`;
}

function providerLabel(provider: { slug: string; name?: string; endpoints: number }): string {
	const suffix = `${provider.endpoints} endpoint${provider.endpoints === 1 ? "" : "s"}`;
	return `${provider.slug}${provider.name ? ` — ${provider.name}` : ""} (${suffix})`;
}

function describePin(model: { id: string }, pin: PinBinding, sessionScoped = false): string {
	const providers = pin.providers.join(", ");
	const scope = sessionScoped ? ", this session only" : "";
	return pin.mode === "prefer"
		? `Preferring ${providers} for ${model.id} (provider.order, ${pin.allowFallbacks ? "fallbacks allowed" : "no fallbacks"}${scope})`
		: `Pinned ${model.id} to ${providers} (provider.only, no fallbacks${scope})`;
}

function describeBinding(model: { id: string }, binding: FlexBinding): string {
	if (!binding.endpoint)
		return `Flex auto for ${model.id}: cheapest flex endpoint serves each request`;
	const pricing = binding.pricing;
	if (!pricing) return `Flex pinned to ${binding.endpoint} for ${model.id}`;
	return `Flex pinned to ${binding.endpoint} for ${model.id}: ${formatPerMillion(ratePerToken(pricing.prompt))} in / ${formatPerMillion(ratePerToken(pricing.completion))} out per Mtok`;
}

function isHelpArg(args: string): boolean {
	return /^(help|\?|-h|--help)$/i.test(args.trim());
}

function endpointLabel(
	endpoint: Endpoint,
	allEndpoints: readonly Endpoint[],
	reference: ReturnType<typeof referencePrice>,
	mix: TurnMix,
	selected: boolean,
): string {
	const prompt = ratePerToken(endpoint.pricing?.prompt);
	const completion = ratePerToken(endpoint.pricing?.completion);
	const details = [`${formatPerMillion(prompt)}/${formatPerMillion(completion)} per Mtok`];
	details.push(...flexComparisons(endpoint, allEndpoints, reference, mix));
	const context = formatContext(endpoint.context_length);
	if (context) details.push(context);
	if (typeof endpoint.uptime_last_30m === "number")
		details.push(`${endpoint.uptime_last_30m.toFixed(1)}% up`);
	return `${selected ? "▶" : " "} ${endpoint.tag} · ${details.join(" · ")}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

interface ParsedPinArgs {
	scope: PinScope;
	mode: PinMode;
	allowFallbacks: boolean;
	rest: string;
}

/** Split a `/pin` argument string into its scope, mode, fallback intent, and provider list. */
function parsePinArgs(args: string): ParsedPinArgs {
	let scope: PinScope = "model";
	let rest = args.trim();
	// A keyword counts only as a whole word: `temp-ai` is a provider slug, not `temp`.
	const scopeMatch = /^(session|temp|temporarily)(?![^\s,])[\s,]*/i.exec(rest);
	if (scopeMatch) {
		scope = "session";
		rest = rest.slice(scopeMatch[0].length);
	}

	let mode: PinMode = "only";
	let allowFallbacks = false;
	const modeMatch = /^(only|prefer|soft|strict|ordered)(?![^\s,])[\s,]*/i.exec(rest);
	if (modeMatch) {
		const keyword = modeMatch[1].toLowerCase();
		// `strict` and `ordered` are prefer pins that decline fallbacks.
		mode = keyword === "only" ? "only" : "prefer";
		allowFallbacks = mode === "prefer" && keyword !== "strict" && keyword !== "ordered";
		rest = rest.slice(modeMatch[0].length);
	}
	// `prefer strict` and `prefer no-fallbacks` say the same thing as `strict`.
	if (mode === "prefer") {
		const modifier = /^(no-?fallbacks?|strict)(?![^\s,])[\s,]*/i.exec(rest);
		if (modifier) {
			allowFallbacks = false;
			rest = rest.slice(modifier[0].length);
		} else {
			const allow = /^(fallbacks?|with-?fallbacks?)(?![^\s,])[\s,]*/i.exec(rest);
			if (allow) rest = rest.slice(allow[0].length);
		}
	}
	return { scope, mode, allowFallbacks, rest };
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();

	// Transient request state lives in the factory, so every extension instance (and every
	// test) starts clean.
	/** The endpoint of the request currently in flight, for cost accounting. */
	let inFlight: { key: string; pricing: EndpointPricing; at: number } | undefined;
	/** The model whose request carries the flex tier, for fallback detection. */
	let inFlightFlex: { key: string; at: number } | undefined;
	/** The shed attempt whose standard-tier continuation is pending at the settle boundary. */
	let pendingContinuation: { at: number; errorText: string } | undefined;
	/** Models currently shed to the standard tier, keyed like bindings. */
	const fallbacks = new Map<string, Shed>();
	/** Times the extension itself continued a shed attempt, per model, for the cap. */
	const shedContinuations = new Map<string, number[]>();
	/** Last advisor result per model, so the status line can show it without re-fetching. */
	const advice = new Map<string, FlexAdvice>();
	/** The advisory warning is shown once per session; later bad models get only the status note. */
	let advisedThisSession = false;
	/** Invalidates background advisor checks across session boundaries. */
	let sessionGeneration = 0;
	const adviceInFlight = new Set<string>();
	/** One-time warnings per session, so a recurring condition does not flood the UI. */
	const warned = new Set<string>();

	/** Warn once per session per `id`; the extension never repeats the same complaint. */
	const warnOnce = (ctx: ExtensionContext, id: string, message: string): void => {
		if (warned.has(id)) return;
		warned.add(id);
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
	};

	/** Tell the user a change did not reach disk, so it is not mistaken for a saved one. */
	const reportPersist = (ctx: ExtensionContext, error: string | undefined): void => {
		if (!error || !ctx.hasUI) return;
		ctx.ui.notify(
			`Could not save ${STATE_FILE}: ${error}\nThe change applies to this session only and will be lost on restart.`,
			"error",
		);
	};

	/** Say so when `openrouter.json` cannot be used, since pins and flex would be missing. */
	const reportStateHealth = (ctx: ExtensionContext): void => {
		const health = stateHealth(agentDir);
		if (!health) return;
		const backup = health.backupPath ? `\nA copy was saved to ${health.backupPath}.` : "";
		const effect = health.usingLastGood
			? "Continuing with the last good settings."
			: "Pins and flex bindings are NOT in effect until it is repaired.";
		warnOnce(
			ctx,
			"state-health",
			`${STATE_FILE} is ${health.problem} (${health.detail}). ${effect}${backup}\nThe file is left as-is; fix or delete it, or run /pin or /flex to write a fresh one.`,
		);
	};

	const reportFailure = (ctx: ExtensionContext, name: string, error: unknown): void => {
		warnOnce(
			ctx,
			`error:${name}`,
			`OpenRouter extension error in ${name}: ${error instanceof Error ? error.message : String(error)}\nThe event continued without extension routing.`,
		);
	};

	/**
	 * Run an event handler body so that a bug here can never break a request, a turn, or
	 * the session: the failure is reported once and the event proceeds unmodified.
	 */
	const guarded = <R>(name: string, ctx: ExtensionContext, fn: () => R): R | undefined => {
		try {
			return fn();
		} catch (error) {
			reportFailure(ctx, name, error);
			return undefined;
		}
	};

	const guardedAsync = async <R>(
		name: string,
		ctx: ExtensionContext,
		fn: () => Promise<R>,
	): Promise<R | undefined> => {
		try {
			return await fn();
		} catch (error) {
			reportFailure(ctx, name, error);
			return undefined;
		}
	};

	/** Latest UI context, so the countdown can refresh the footer between events. */
	let statusCtx: ExtensionContext | undefined;
	/** One-second ticker, running only while the current model is shed to standard rates. */
	let countdown: ReturnType<typeof setInterval> | undefined;

	const stopCountdown = (): void => {
		if (!countdown) return;
		clearInterval(countdown);
		countdown = undefined;
	};

	/** Countdown text for an active fallback, or `undefined` when flex is serving again. */
	const fallbackStatus = (ctx: ExtensionContext): string | undefined => {
		const model = ctx.model;
		if (!model) return undefined;
		const fallback = fallbacks.get(bindingKey(model));
		if (!fallback || Date.now() >= fallback.until) return undefined;
		return `flex: standard ${Math.ceil((fallback.until - Date.now()) / 1000)}s`;
	};

	/**
	 * The single status line: tier and pin together, so the displayed route is the route
	 * the planner would produce. A dormant pin is labelled rather than hidden.
	 */
	const routeStatus = (ctx: ExtensionContext): string | undefined => {
		const model = ctx.model;
		if (model?.provider !== "openrouter") return undefined;
		const binding = bindingFor(agentDir, model);
		const { pin, sessionScoped } = resolvePin(agentDir, model);
		const shed = fallbackStatus(ctx);
		const endpointPinned = Boolean(binding?.flex?.endpoint);
		// The planner activates the pin during an `openrouter` cooldown, since no provider
		// affinity is imposed and the pin remains the only constraint. Everywhere else an
		// endpoint pin owns the route and the pin is dormant.
		const pinActive =
			!endpointPinned || (Boolean(shed) && fallbackRouting(agentDir) === "openrouter");
		const notOptimal = !shed && advice.get(bindingKey(model))?.notOptimal ? " (not optimal)" : "";
		const pinText = pin
			? ` · pin: ${pinSuffix(pin, sessionScoped)}${pinActive ? "" : " (pin inactive)"}`
			: "";
		if (shed) return `${shed}${pinText}`;
		if (!binding?.flex) {
			if (!pin) return undefined;
			return `pin: ${pinSuffix(pin, sessionScoped)}`;
		}
		const tier = `${binding.flex.endpoint ? `flex: ${binding.flex.endpoint}` : "flex: auto"}${notOptimal}`;
		if (!pin) return tier;
		return `${tier}${pinText}`;
	};

	const tick = (): void => {
		const ctx = statusCtx;
		if (!ctx?.hasUI) {
			stopCountdown();
			return;
		}
		// Recompose the line; when the cooldown elapses this also restores the binding text
		// and lets the next request retry flex.
		syncStatus(ctx);
	};

	const syncStatus = (ctx: ExtensionContext): void => {
		statusCtx = ctx;
		if (!ctx.hasUI) {
			stopCountdown();
			return;
		}
		const text = routeStatus(ctx);
		ctx.ui.setStatus(STATUS_KEY, text);
		const model = ctx.model;
		const shed = model ? fallbacks.get(bindingKey(model)) : undefined;
		if (shed && Date.now() < shed.until) {
			if (!countdown) {
				countdown = setInterval(tick, 1_000);
				// The ticker only refreshes the footer; it must never keep the process alive.
				countdown.unref?.();
			}
		} else stopCountdown();
	};

	/**
	 * Store the advisor's comparison for a model and, once per session, warn when standard
	 * routing is cheaper. The comparison itself is pure; this handles caching and notice.
	 */
	const recordAdvice = (
		ctx: ExtensionContext,
		model: ModelLike,
		endpoints: readonly Endpoint[],
	): void => {
		const key = bindingKey(model);
		const binding = bindingFor(agentDir, model);
		if (!binding?.flex) {
			advice.delete(key);
			return;
		}
		const turn = peekTurnMix(agentDir);
		if (!turn) {
			// The blend comes from scanning session history, which is asynchronous. Compare
			// once it is ready rather than advising on a placeholder.
			const generation = sessionGeneration;
			void resolveTurnMix(agentDir).then(() => {
				if (generation !== sessionGeneration) return;
				guarded("flex advisor", ctx, () => {
					recordAdvice(ctx, model, endpoints);
					syncStatus(ctx);
				});
			});
			return;
		}
		const { pin } = resolvePin(agentDir, model);
		const result = assessFlex(binding.flex, pin, endpoints, turn.mix);
		if (!result) {
			advice.delete(key);
			return;
		}
		advice.set(key, result);
		if (!ctx.hasUI || !result.notOptimal || advisedThisSession) return;

		advisedThisSession = true;
		const percent = Math.max(1, Math.round((result.flexCost / result.reference.cost - 1) * 100));
		ctx.ui.notify(
			`Flex is not the cheapest route for ${model.id}: standard ${result.reference.label} costs ${formatUsd(result.reference.cost)}/turn vs ${formatUsd(result.flexCost)}/turn on ${result.endpoint} (${percent}% more).\nFlex stays on; run /flex off for standard pricing, or /flex to pick a cheaper endpoint.`,
			"warning",
		);
	};

	/** Fetch endpoints in the background when no fresh list is cached, then advise. */
	const refreshAdvice = async (ctx: ExtensionContext, model: ModelLike): Promise<void> => {
		const key = bindingKey(model);
		if (adviceInFlight.has(key)) return;
		if (!bindingFor(agentDir, model)?.flex) return;
		const generation = sessionGeneration;
		// Claim the slot before the first await, so concurrent callers cannot both proceed.
		adviceInFlight.add(key);
		try {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
			if (!apiKey || generation !== sessionGeneration) return;
			const { endpoints } = await fetchEndpoints(model, apiKey);
			if (generation !== sessionGeneration) return;
			recordAdvice(ctx, model, endpoints);
			const current = ctx.model;
			if (current && bindingKey(current) === key) syncStatus(ctx);
		} catch {
			// The advisor is optional; routing and status keep working without it.
		} finally {
			adviceInFlight.delete(key);
		}
	};

	/**
	 * Check the current binding: use a cached endpoint list when available, otherwise
	 * refresh in the background so model switches are never blocked by the catalog.
	 */
	const ensureAdvice = (ctx: ExtensionContext, model: ModelLike | undefined): void => {
		if (!model) return;
		if (!bindingFor(agentDir, model)?.flex) {
			advice.delete(bindingKey(model));
			return;
		}
		const endpoints = cachedEndpoints(model);
		if (endpoints) recordAdvice(ctx, model, endpoints);
		else void refreshAdvice(ctx, model);
	};

	/**
	 * The standard-tier endpoint a shed request should be ordered onto, if any. A pinned
	 * flex endpoint maps to its own standard sibling; auto maps to the sibling of the
	 * cheapest flex endpoint permitted by the pin, since that endpoint is the one flex
	 * routing would have preferred and so the provider most likely holding the cache.
	 */
	const standardFallbackEndpoint = async (
		ctx: ExtensionContext,
		modelId: string,
	): Promise<string | undefined> => {
		if (fallbackRouting(agentDir) === "openrouter") return undefined;
		const model: ModelLike = { provider: "openrouter", id: modelId };
		const flex = bindingFor(agentDir, model)?.flex;
		if (!flex) return undefined;
		if (flex.endpoint) return siblingOfTag(flex.endpoint);

		const { pin } = resolvePin(agentDir, model);
		const siblingOf = (endpoints: readonly Endpoint[]): string | undefined => {
			const effective = effectiveFlexEndpoint(flex, pin, [...endpoints]);
			if (effective) return standardSiblingTag(effective) ?? siblingOfTag(effective.tag);
			return cheapestFlexSibling(endpoints);
		};

		const cached = cachedEndpoints(model);
		if (cached) {
			const sibling = siblingOf(cached);
			if (sibling) return sibling;
		}

		// The endpoint cache has usually expired by the time capacity runs out; one list
		// request per shed is cheap next to the wasted flex attempt it replaces. The wait is
		// bounded: the lookup keeps running and fills the cache, which the next request's
		// plan reads, so a slow catalog never holds up the message itself.
		try {
			const apiKey = await withTimeout(
				ctx.modelRegistry.getApiKeyForProvider("openrouter"),
				FALLBACK_LOOKUP_TIMEOUT_MS,
			);
			if (!apiKey) return undefined;
			const fetched = await withTimeout(fetchEndpoints(model, apiKey), FALLBACK_LOOKUP_TIMEOUT_MS);
			return fetched ? siblingOf(fetched.endpoints) : undefined;
		} catch {
			return undefined;
		}
	};

	const HELP_FLEX = [
		"/flex — OpenRouter flex service tier",
		"",
		"  /flex                     Pick a flex endpoint, flex auto, or standard pricing",
		"  /flex on                  Flex auto: the cheapest permitted flex endpoint wins",
		"  /flex <endpoint tag>      Pin that flex endpoint (`provider.only`)",
		"  /flex off                 Standard routing (the provider pin still applies)",
		"  /flex status              Show the tier, the pin state, and fallback routing",
		"  /flex scan [refresh]      Check every scoped model for flex endpoints, then pin one",
		"  /flex refresh             Drop the cached endpoint list",
		"  /flex mix [refresh]       Show or re-derive the per-turn token blend",
		"  /flex fallback            Show where a rate-limited request is served",
		"  /flex fallback same-provider | openrouter",
		"                            Set that standard-tier route during a cooldown",
		"  /flex help                This text",
		"",
		"With flex on and no endpoint pinned, `/pin` constrains which flex endpoints may serve.",
		"A pinned endpoint takes precedence over `/pin`; the pin stays stored but inactive.",
		"Advisor: warns once when standard routing is cheaper, and marks the status line",
		"`(not optimal)` until flex is turned off or retargeted.",
		"An `only` pin limits the comparison to its providers; `prefer` without fallbacks",
		"disables the advisor, since no alternative provider is allowed.",
		`Bindings persist in ~/.pi/agent/${STATE_FILE}.`,
	].join("\n");

	const HELP_PIN = [
		"/pin — OpenRouter provider routing",
		"",
		"  /pin                     Pick a provider for the current model",
		"  /pin <slug>[,<slug>...]  Pin to those providers (provider.only, no fallbacks)",
		"  /pin prefer <slug>...    Prefer those providers, allow fallbacks (provider.order)",
		"  /pin strict <slug>...    Prefer those providers in order, no fallbacks",
		"  /pin off                 Remove the persisted pin for this model",
		"  /pin status              Show the pin and whether flex makes it active",
		"",
		"Session scope: applies until this session ends and leaves the state file alone",
		"  /pin session <slug>...   Pin for this session only",
		"  /pin session prefer ...  Prefer for this session only",
		"  /pin session off         Ignore the persisted pin for this session",
		"  /pin session status      Show the session-scoped pin",
		"",
		"With flex on and an endpoint pinned, the pin is stored but inactive. With flex auto",
		"or off, the pin constrains routing. `temp` and `temporarily` are aliases for `session`.",
	].join("\n");

	// -------------------------------------------------------------------------
	// Request planning
	// -------------------------------------------------------------------------

	/**
	 * One handler owns `service_tier` and `provider`. The plan applies them together, so a
	 * tier and a provider list can no longer be written by different owners.
	 */
	pi.on("before_provider_request", (event, ctx) =>
		guarded("request planning", ctx, () => planRequest(event.payload, ctx)),
	);

	const planRequest = (payload: unknown, ctx: ExtensionContext): unknown => {
		inFlight = undefined;
		inFlightFlex = undefined;
		const model = ctx.model;
		if (model?.provider !== "openrouter") return;
		if (!isRecord(payload)) return;
		const body = payload;

		// Pi builds the request body with `model: model.id`. A different id means this request
		// is for another model (a compaction or summary call), which the selected model's
		// binding must not route.
		if (typeof body.model === "string" && body.model !== model.id) return;

		const key = bindingKey(model);
		const binding = bindingFor(agentDir, model);
		const { pin } = resolvePin(agentDir, model);
		const now = Date.now();
		// A state file that went bad mid-session means the pin is not in effect; say so once.
		reportStateHealth(ctx);

		// Only chat-completions-shaped bodies carry provider routing and service tiers. A
		// pin is a trust lock, so a body the extension cannot route must not pass silently.
		if (!Array.isArray(body.messages)) {
			if (binding?.flex || pin) {
				warnOnce(
					ctx,
					`unroutable:${key}`,
					`${model.id} has a flex binding or provider pin, but its request is not chat-completions shaped, so OpenRouter routing is NOT being applied.`,
				);
			}
			return;
		}
		// An explicit tier from models.json or samplingParams wins over the flex binding, but
		// the provider pin still applies: a tier setting must not silently drop a lock.
		const explicitTier = body.service_tier !== undefined;

		let fallback = fallbacks.get(key);
		if (fallback && now >= fallback.until) {
			fallbacks.delete(key);
			fallback = undefined;
			syncStatus(ctx);
		}

		const plan = planRoute({
			binding: explicitTier ? undefined : binding,
			pin,
			fallback,
			routing: fallbackRouting(agentDir),
			now,
			endpoints: cachedEndpoints(model),
		});
		if (!plan.serviceTier && !plan.provider) return;

		const next: Record<string, unknown> = { ...body };
		if (plan.serviceTier) next.service_tier = plan.serviceTier;
		if (plan.provider) {
			// The plan is authoritative for these keys; stale routing must not leak through.
			const routing = { ...providerRouting(body) };
			delete routing.only;
			delete routing.order;
			Object.assign(routing, plan.provider);
			next.provider = routing;
		}

		// Shed detection is armed only for a request that actually carries the flex tier. A
		// pin-only request that fails with a 429 is an ordinary error, not a flex shed.
		if (plan.serviceTier && !plan.shed) inFlightFlex = { key, at: now };
		if (!plan.shed && plan.pricing) inFlight = { key, pricing: plan.pricing, at: now };
		return next;
	};

	/**
	 * Shed flex when the request it served was rate limited, and otherwise rebuild the
	 * message cost from the serving endpoint's published prices. Pi bills the catalog
	 * price, which is the standard tier.
	 */
	pi.on("message_end", (event, ctx) =>
		guardedAsync("message handling", ctx, () => handleMessageEnd(event.message, ctx)),
	);

	const handleMessageEnd = async (
		eventMessage: unknown,
		ctx: ExtensionContext,
	): Promise<MessageEndEventResult | undefined> => {
		const message = eventMessage as {
			role?: string;
			provider?: string;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
			usage?: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				cost: {
					input: number;
					output: number;
					cacheRead: number;
					cacheWrite: number;
					total: number;
				};
			};
		};
		const pending = inFlight;
		const pendingFlex = inFlightFlex;
		inFlight = undefined;
		inFlightFlex = undefined;
		if (message.role !== "assistant" || message.provider !== "openrouter") return;

		// Warming, summary, and compaction requests for other models must not inherit this state.
		const key = `openrouter:${message.model}`;
		const current =
			pendingFlex !== undefined &&
			Date.now() - pendingFlex.at < REQUEST_STATE_TTL_MS &&
			pendingFlex.key === key;
		if (current && message.stopReason === "error") {
			const reason = fallbackReason(message.errorMessage);
			// Shed only while flex is still wanted: `/flex off` while the request was in flight
			// leaves an ordinary error for Pi to handle.
			const modelRef: ModelLike = { provider: "openrouter", id: message.model ?? "" };
			if (!reason || !bindingFor(agentDir, modelRef)?.flex) return;

			const endpoint = await standardFallbackEndpoint(ctx, modelRef.id);
			// The lookup awaited; flex may have been turned off meanwhile.
			if (!bindingFor(agentDir, modelRef)?.flex) return;
			fallbacks.set(key, { until: Date.now() + FALLBACK_COOLDOWN_MS, reason, endpoint });

			// Relabelling the error and continuing it ourselves skips Pi's retry budget, so it
			// is capped. Past the cap the cooldown is still set, and Pi's own bounded retry
			// (backoff included) sends the next attempt at standard rates.
			const now = Date.now();
			const recent = (shedContinuations.get(key) ?? []).filter((at) => now - at < SHED_WINDOW_MS);
			const continueHere = recent.length < MAX_SHED_CONTINUATIONS;
			if (continueHere) recent.push(now);
			shedContinuations.set(key, recent);

			if (ctx.hasUI) {
				const seconds = FALLBACK_COOLDOWN_MS / 1000;
				const via = endpoint ?? "OpenRouter default routing";
				const tail = continueHere ? "" : "\nRepeated sheds: leaving the retry to Pi's backoff";
				ctx.ui.notify(
					`Flex rate limited: ${reason}\nServing ${message.model} at standard rates for ${seconds}s via ${via}, then retrying flex${tail}`,
					"warning",
				);
				syncStatus(ctx);
			}
			if (!continueHere) return;
			pendingContinuation = { at: Date.now(), errorText: FALLBACK_STOP_MESSAGE };
			return {
				message: { ...message, errorMessage: FALLBACK_STOP_MESSAGE },
			} as unknown as MessageEndEventResult;
		}

		if (!pending || Date.now() - pending.at > REQUEST_STATE_TTL_MS) return;
		if (pending.key !== key) return;
		const usage = message.usage;
		if (!usage?.cost) return;
		const replacement = {
			...message,
			usage: { ...usage, cost: costFromPricing(pending.pricing, usage) },
		};
		return { message: replacement } as unknown as MessageEndEventResult;
	};

	/**
	 * Serve a shed flex request at the standard tier without Pi's retry backoff. The failed
	 * attempt is omitted from model context, exactly as Pi omits an attempt it retries.
	 */
	pi.on("agent_before_settle", (event, ctx) => {
		const pending = pendingContinuation;
		pendingContinuation = undefined;
		if (!pending || Date.now() - pending.at > 30_000) return;
		return guarded("settle", ctx, () => {
			const targetId = shedAttemptEntryId(ctx, pending.errorText);
			if (!targetId) return undefined;
			return {
				entries: [...event.entries, { type: "context_edit" as const, targetId, replacement: null }],
				continue: true,
			};
		});
	});

	/** Flex capacity is not prioritised for warming, and most flex endpoints do not cache. */
	pi.on("cache_warming_decision", (_event, ctx) => {
		const model = ctx.model;
		if (model?.provider !== "openrouter") return;
		if (bindingFor(agentDir, model)?.flex) return { action: "stop" as const };
		return;
	});

	pi.on("session_start", (_event, ctx) => {
		guarded("session start", ctx, () => {
			sessionGeneration += 1;
			advisedThisSession = false;
			advice.clear();
			warned.clear();
			shedContinuations.clear();
			restoreSessionPins(ctx);
			if (ctx.hasUI) {
				for (const key of LEGACY_STATUS_KEYS) ctx.ui.setStatus(key, undefined);
			}
			reportStateHealth(ctx);
			syncStatus(ctx);
			ensureAdvice(ctx, ctx.model);
		});
	});
	pi.on("model_select", (_event, ctx) => {
		guarded("model select", ctx, () => {
			syncStatus(ctx);
			ensureAdvice(ctx, ctx.model);
		});
	});
	pi.on("session_shutdown", () => {
		sessionGeneration += 1;
		advisedThisSession = false;
		advice.clear();
		adviceInFlight.clear();
		stopCountdown();
		statusCtx = undefined;
		inFlight = undefined;
		inFlightFlex = undefined;
		pendingContinuation = undefined;
		fallbacks.clear();
		shedContinuations.clear();
		clearSessionPins();
	});

	/** Session pins are stored in the session file so `/resume` keeps them. */
	const persistSessionPins = (): void => {
		pi.appendEntry<{ pins: Record<string, PinBinding | null> }>(SESSION_ENTRY_TYPE, {
			pins: sessionPinState(),
		});
	};

	// -------------------------------------------------------------------------
	// /flex
	// -------------------------------------------------------------------------

	const applyFlex = (
		ctx: ExtensionCommandContext,
		model: { id: string },
		binding: FlexBinding | null,
		endpoints?: readonly Endpoint[],
	): void => {
		const modelRef: ModelLike = { provider: "openrouter", id: model.id };
		const key = bindingKey(modelRef);

		// Flex auto must be able to honor the pin, or the request would carry the flex tier
		// to providers that have no flex endpoint. Every route into auto passes through here,
		// so `/flex on`, the picker, and `/flex scan` cannot disagree. Turning flex off, or
		// pinning an endpoint (which owns `provider.only`), never conflicts.
		if (binding && !binding.endpoint && endpoints) {
			const { pin: activePin } = resolvePin(agentDir, modelRef);
			const conflict = activePin
				? pinBlocksFlex(activePin, endpoints, modelSlug(model.id))
				: undefined;
			if (conflict) {
				ctx.ui.notify(conflict, "warning");
				return;
			}
		}

		// An explicit /flex change supersedes a fallback the extension chose.
		fallbacks.delete(key);
		reportPersist(ctx, setFlexBinding(agentDir, key, binding));
		if (!binding) {
			advice.delete(key);
			ctx.ui.notify(`Flex off: ${model.id} uses standard routing`, "info");
		} else {
			if (endpoints) recordAdvice(ctx, modelRef, endpoints);
			else ensureAdvice(ctx, modelRef);
			const { pin } = resolvePin(agentDir, modelRef);
			ctx.ui.notify(describeBinding(model, binding), "info");
			if (pin && binding.endpoint) {
				ctx.ui.notify(
					`Provider pin ${pinSuffix(pin, false)} is inactive while an endpoint is pinned; run /flex on or /flex off to re-enable it`,
					"info",
				);
			}
		}
		syncStatus(ctx);
	};

	const pickFlex = async (
		ctx: ExtensionCommandContext,
		model: { id: string; provider: string },
		flex: readonly Endpoint[],
		allEndpoints: readonly Endpoint[],
		reference: ReturnType<typeof referencePrice>,
		turn: { mix: TurnMix; turns?: number; source: string },
		note = "",
	): Promise<FlexBinding | null | undefined> => {
		const current = bindingFor(agentDir, model)?.flex;
		const options: string[] = [];
		const targets: (FlexBinding | null)[] = [];

		const cheapest = flex[0];
		const autoSelected = Boolean(current && !current.endpoint);
		const autoPrice = `${formatPerMillion(ratePerToken(cheapest.pricing?.prompt))}/${formatPerMillion(ratePerToken(cheapest.pricing?.completion))}`;
		options.push(
			`${autoSelected ? "▶" : " "} flex auto · from ${autoPrice} per Mtok · cheapest flex endpoint wins`,
		);
		targets.push({ endpoint: null, updatedAt: Date.now() });

		for (const endpoint of flex) {
			const selected = current?.endpoint === endpoint.tag;
			options.push(endpointLabel(endpoint, allEndpoints, reference, turn.mix, selected));
			targets.push(bindingFromEndpoint(endpoint));
		}

		options.push(`${current ? " " : "▶"} standard pricing (off)`);
		targets.push(null);

		const baseline = reference.cost > 0 ? ` · discounts ${versusLabel(reference)}` : "";
		const title = `Flex for ${model.id}${note} · ${flex.length} flex endpoint${flex.length === 1 ? "" : "s"} (${turnMixNote(turn.mix, turn)}${baseline})`;
		const choice = await ctx.ui.select(title, options);
		if (choice === undefined) return undefined;
		const index = options.indexOf(choice);
		return index === -1 ? undefined : targets[index];
	};

	const scanTargets = (
		ctx: ExtensionCommandContext,
	): { provider: string; id: string; baseUrl?: string }[] => {
		const seen = new Set<string>();
		const targets: { provider: string; id: string; baseUrl?: string }[] = [];
		const add = (model: { provider: string; id: string; baseUrl?: string } | undefined): void => {
			// Thinking-level variants (`model:high`) share one endpoint list; keep the first full id.
			if (model?.provider !== "openrouter" || seen.has(modelSlug(model.id))) return;
			seen.add(modelSlug(model.id));
			targets.push(model);
		};
		for (const scoped of ctx.scopedModels) add(scoped.model);
		if (targets.length === 0) add(ctx.model);
		return targets;
	};

	interface ScanRow {
		model: { provider: string; id: string };
		slug: string;
		resolvedFrom?: string;
		endpoints: Endpoint[];
		flex: Endpoint[];
		reference: ReturnType<typeof referencePrice>;
		turn: { mix: TurnMix; turns?: number; source: string };
		error?: string;
	}

	/** Check every scoped OpenRouter model for flex endpoints, then offer to pin one. */
	const scanScopedModels = async (
		ctx: ExtensionCommandContext,
		options: { refresh?: boolean } = {},
	): Promise<void> => {
		const targets = scanTargets(ctx);
		if (targets.length === 0) {
			ctx.ui.notify("No OpenRouter models in the scoped set (/scoped-models)", "warning");
			return;
		}

		const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
		if (!apiKey) {
			ctx.ui.notify("No OpenRouter credential. Run /login openrouter first.", "error");
			return;
		}

		if (
			targets.length === 1 &&
			!ctx.scopedModels.some((scoped) => scoped.model.provider === "openrouter")
		) {
			ctx.ui.notify("No scoped models configured; scanning the current model only", "info");
		}

		const turn = await resolveTurnMix(agentDir);
		const rows = await mapLimit(targets, 6, async (model) => {
			const { endpoints, error, slug, resolvedFrom } = await fetchEndpoints(model, apiKey, options);
			return {
				model,
				slug,
				resolvedFrom,
				endpoints,
				flex: flexEndpoints(endpoints),
				reference: referencePrice(endpoints, undefined, turn.mix),
				turn,
				error,
			} satisfies ScanRow;
		});

		const capable = rows.filter((row) => row.flex.length > 0);
		capable.sort((a, b) => discount(a) - discount(b));
		const rest = rows.filter((row) => row.flex.length === 0);
		const lines = [
			`Flex scan: ${rows.length} OpenRouter model${rows.length === 1 ? "" : "s"} (${capable.length} flex-capable) · ${turnMixNote(turn.mix, turn)}`,
		];
		if (capable.length > 0) lines.push("", ...formatScanTable(capable));
		if (rest.length > 0) {
			lines.push("", `No flex endpoint (${rest.length}):`);
			for (const row of rest) lines.push(noFlexLine(row));
		}
		ctx.ui.notify(lines.join("\n"), capable.length > 0 ? "info" : "warning");

		if (capable.length === 0) return;
		const chosen = await ctx.ui.select(
			"Pin flex for a model",
			capable.map((row) => row.model.id),
		);
		if (chosen === undefined) return;
		const row = capable.find((entry) => entry.model.id === chosen);
		if (!row) return;
		const binding = await pickFlex(
			ctx,
			row.model,
			row.flex,
			row.endpoints,
			row.reference,
			row.turn,
			row.resolvedFrom ? ` (${row.slug})` : "",
		);
		if (binding === undefined) return;
		applyFlex(ctx, row.model, binding, row.endpoints);
	};

	const discount = (row: ScanRow): number => {
		const cost = endpointTurnCost(row.flex[0], row.turn.mix);
		return row.reference.cost > 0 && cost > 0 ? cost / row.reference.cost : 1;
	};

	const formatScanTable = (capable: readonly ScanRow[]): string[] => {
		const pad = (text: string, width: number): string =>
			text.length >= width ? text : text + " ".repeat(width - text.length);
		const cells = capable.map((row) => ({
			model: `✓ ${row.model.id}${row.resolvedFrom ? ` (${row.slug})` : ""}`,
			price:
				formatUsd(endpointTurnCost(row.flex[0], row.turn.mix)) +
				(row.flex.length > 1 ? ` (${row.flex.length} flex)` : ""),
			rates: ratesCell(row.flex[0].pricing),
			comp:
				flexComparisons(row.flex[0], row.endpoints, row.reference, row.turn.mix).join(" · ") || "—",
		}));
		const widthOf = (header: string, values: readonly string[]): number =>
			Math.max(header.length, ...values.map((value) => value.length));
		const modelWidth = widthOf(
			"MODEL",
			cells.map((cell) => cell.model),
		);
		const priceWidth = widthOf(
			"FLEX $/TURN",
			cells.map((cell) => cell.price),
		);
		const ratesWidth = widthOf(
			"IN/OUT/CR $/MTOK",
			cells.map((cell) => cell.rates),
		);
		const lines = [
			`${pad("MODEL", modelWidth)}  ${pad("FLEX $/TURN", priceWidth)}  ${pad("IN/OUT/CR $/MTOK", ratesWidth)}  COMPARISONS (cheapest baseline first)`,
		];
		for (const cell of cells) {
			lines.push(
				`${pad(cell.model, modelWidth)}  ${pad(cell.price, priceWidth)}  ${pad(cell.rates, ratesWidth)}  ${cell.comp}`,
			);
		}
		return lines;
	};

	const noFlexLine = (row: ScanRow): string => {
		const id = row.model.id;
		const resolved = row.resolvedFrom ? ` (${row.slug})` : "";
		if (row.error) return `· ${id}${resolved} — unavailable: ${row.error}`;
		if (row.endpoints.length === 0) {
			const unresolved = row.slug.startsWith("~");
			return `· ${id}${resolved} — OpenRouter lists no endpoints${unresolved ? " (an unrecognized Pi latest-alias; use the concrete model id)" : ""}`;
		}
		const tiers = [
			...new Set(row.endpoints.map((endpoint) => endpoint.service_tier ?? "default")),
		].sort();
		return `· ${id}${resolved} — no flex endpoint (tiers: ${tiers.join(", ")})`;
	};

	function bindingFromEndpoint(endpoint: Endpoint): FlexBinding {
		return {
			endpoint: endpoint.tag,
			providerName: endpoint.provider_name,
			pricing: endpoint.pricing,
			updatedAt: Date.now(),
		};
	}

	pi.registerCommand("flex", {
		description: "OpenRouter flex service tier: list flex endpoints, pricing, and pin one",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "help", label: "help", description: "Show usage for every subcommand" },
				{ value: "on", label: "on", description: "Request flex, no endpoint pin" },
				{ value: "off", label: "off", description: "Standard routing" },
				{ value: "mix", label: "mix", description: "Show or refresh the blend weights" },
				{
					value: "fallback",
					label: "fallback",
					description: "Show where a shed request is served",
				},
				{
					value: "fallback same-provider",
					label: "fallback same-provider",
					description: "Standard sibling of the same provider, cache warm",
				},
				{
					value: "fallback openrouter",
					label: "fallback openrouter",
					description: "OpenRouter default routing during the cooldown",
				},
				{ value: "scan", label: "scan", description: "Check all scoped models for flex endpoints" },
				{ value: "status", label: "status", description: "Show the current binding" },
				{ value: "refresh", label: "refresh", description: "Drop the endpoint cache" },
			];
			const matches = items.filter((item) => item.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (rawArgs, ctx) => {
			// Subcommands and endpoint tags are lowercase, so `/flex OFF` means `/flex off`.
			const args = rawArgs.trim().toLowerCase();

			// Model-independent: usage is the same for every model.
			if (isHelpArg(args)) {
				ctx.ui.notify(HELP_FLEX, "info");
				return;
			}

			// Model-independent: the blend applies to every comparison.
			if (args === "mix" || args.startsWith("mix ")) {
				const turn = await resolveTurnMix(agentDir, { refresh: args === "mix refresh" });
				const mixLines = [
					`Turn mix (${turn.source}${turn.turns !== undefined ? `, ${turn.turns.toLocaleString("en-US")} turns` : ""}): ${blendNote(turn.mix)}`,
					"Comparison percentages weight each endpoint's rates over this turn.",
					`Override: add "turnMix": { input, cacheRead, cacheWrite, output } to ~/.pi/agent/${STATE_FILE} (or the legacy flex.json)`,
				];
				ctx.ui.notify(mixLines.join("\n"), "info");
				// The blend weights the advisory comparison too.
				ensureAdvice(ctx, ctx.model);
				syncStatus(ctx);
				return;
			}

			// Model-independent: the cooldown route applies to every binding.
			if (args === "fallback" || args.startsWith("fallback ")) {
				const wanted = args.slice("fallback".length).trim();
				if (wanted === "") {
					ctx.ui.notify(
						`Flex fallback routing: ${describeFallbackRouting(fallbackRouting(agentDir))}`,
						"info",
					);
					return;
				}
				const routing =
					wanted === "openrouter"
						? "openrouter"
						: wanted === "same-provider"
							? "same-provider"
							: undefined;
				if (!routing) {
					ctx.ui.notify(
						`Unknown fallback routing \`${wanted}\`. Use \`same-provider\` or \`openrouter\`.`,
						"error",
					);
					return;
				}
				reportPersist(ctx, setFallbackRouting(agentDir, routing));
				ctx.ui.notify(`Flex fallback routing: ${describeFallbackRouting(routing)}`, "info");
				return;
			}

			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("/flex needs a selected model", "warning");
				return;
			}
			if (model.provider !== "openrouter") {
				ctx.ui.notify(
					`/flex applies to OpenRouter models only (current: ${model.provider}/${model.id})`,
					"warning",
				);
				return;
			}

			if (args === "scan" || args.startsWith("scan ")) {
				await scanScopedModels(ctx, { refresh: args === "scan refresh" });
				return;
			}

			if (args === "off" || args === "none" || args === "standard") {
				applyFlex(ctx, model, null);
				return;
			}

			if (args === "status") {
				const binding = bindingFor(agentDir, model)?.flex;
				const { pin, sessionScoped } = resolvePin(agentDir, model);
				const lines: string[] = [];
				if (!binding) lines.push(`Flex off: ${model.id} uses standard routing`);
				else lines.push(describeBinding(model, binding));
				if (pin) {
					const inactive = Boolean(binding?.endpoint);
					lines.push(
						`${describePin(model, pin, sessionScoped)}${inactive ? " — inactive while an endpoint is pinned" : ""}`,
					);
				} else {
					lines.push("Provider routing: OpenRouter default (no pin)");
				}
				const advisory = advice.get(bindingKey(model));
				if (advisory?.notOptimal) {
					lines.push(
						`Advisor: standard ${advisory.reference.label} is cheaper (${formatUsd(advisory.reference.cost)}/turn vs ${formatUsd(advisory.flexCost)}/turn on ${advisory.endpoint})`,
					);
				}
				const fallback = fallbacks.get(bindingKey(model));
				if (fallback && Date.now() < fallback.until) {
					const seconds = Math.ceil((fallback.until - Date.now()) / 1000);
					const via = fallback.endpoint ?? "OpenRouter default routing";
					lines.push(
						`Falling back to standard rates for ${seconds}s via ${via}, then retrying flex: ${fallback.reason}`,
					);
				}
				lines.push(`Fallback routing: ${describeFallbackRouting(fallbackRouting(agentDir))}`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
			if (!apiKey) {
				ctx.ui.notify("No OpenRouter credential. Run /login openrouter first.", "error");
				return;
			}

			const { endpoints, error, slug, resolvedFrom } = await fetchEndpoints(model, apiKey, {
				refresh: args === "refresh",
			});
			const flex = flexEndpoints(endpoints);
			const turn = await resolveTurnMix(agentDir);
			const reference = referencePrice(endpoints, catalogCost(model), turn.mix);
			const about = resolvedFrom ? ` (resolved from \`${resolvedFrom}\`)` : "";

			if (args === "refresh") {
				if (bindingFor(agentDir, model)?.flex) recordAdvice(ctx, model, endpoints);
				else advice.delete(bindingKey(model));
				ctx.ui.notify(
					`Endpoint cache cleared (${flex.length} flex endpoint${flex.length === 1 ? "" : "s"})`,
					"info",
				);
				syncStatus(ctx);
				return;
			}

			if (error || flex.length === 0) {
				const tiers = [
					...new Set(endpoints.map((endpoint) => endpoint.service_tier ?? "default")),
				].sort();
				if (endpoints.length === 0) {
					const unresolved = slug.startsWith("~");
					const hint =
						error ??
						`OpenRouter lists no endpoints for \`${slug}\`${about}${unresolved ? " (an unrecognized Pi latest-alias; use the concrete model id)" : ""}`;
					ctx.ui.notify(hint, "warning");
					return;
				}
				const reason = error ?? `no flex endpoint is listed for \`${slug}\`${about}`;
				ctx.ui.notify(`OpenRouter: ${reason}. Available tiers: ${tiers.join(", ")}.`, "warning");
				return;
			}

			if (args === "on") {
				// `applyFlex` refuses flex auto when the pin could not be honored.
				applyFlex(ctx, model, { endpoint: null, updatedAt: Date.now() }, endpoints);
				return;
			}

			if (args !== "") {
				const wanted = args.replace(/^provider\.only=/, "");
				const match = flex.find((endpoint) => endpoint.tag === wanted);
				if (!match) {
					ctx.ui.notify(
						`Unknown flex endpoint \`${wanted}\`. Available: ${flex.map((endpoint) => endpoint.tag).join(", ")}`,
						"error",
					);
					return;
				}
				applyFlex(ctx, model, bindingFromEndpoint(match), endpoints);
				return;
			}

			const choice = await pickFlex(
				ctx,
				model,
				flex,
				endpoints,
				reference,
				turn,
				resolvedFrom ? ` (${slug})` : "",
			);
			if (choice === undefined) return;
			applyFlex(ctx, model, choice, endpoints);
		},
	});

	// -------------------------------------------------------------------------
	// /pin
	// -------------------------------------------------------------------------

	const applyPin = (
		ctx: ExtensionCommandContext,
		model: { id: string },
		providers: string[],
		mode: PinMode,
		allowFallbacks: boolean,
		scope: PinScope,
	): void => {
		const binding: PinBinding = {
			providers,
			mode,
			allowFallbacks: mode === "only" ? false : allowFallbacks,
			updatedAt: Date.now(),
		};
		const key = bindingKey({ provider: "openrouter", id: model.id });
		const modelRef = { provider: "openrouter", id: model.id };
		if (scope === "session") {
			putSessionPin(key, binding);
			persistSessionPins();
		} else {
			// A persisted pin supersedes any session override for this model.
			deleteSessionPin(key);
			persistSessionPins();
			reportPersist(ctx, setPinBinding(agentDir, key, binding));
		}
		// The pin changes which flex endpoint auto routing would use and which standard
		// endpoints are comparable, so the advisory is recomputed.
		ensureAdvice(ctx, modelRef);
		syncStatus(ctx);
		ctx.ui.notify(describePin(model, binding, scope === "session"), "info");
		const flex = bindingFor(agentDir, modelRef)?.flex;
		if (flex?.endpoint) {
			ctx.ui.notify(
				`Pin stored but inactive while flex endpoint ${flex.endpoint} is pinned; run /flex on or /flex off to activate it`,
				"info",
			);
		}
	};

	pi.registerCommand("pin", {
		description: "Pin the current OpenRouter model to a provider, persistently or for this session",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "help", label: "help", description: "Show usage and examples" },
				{ value: "status", label: "status", description: "Show the pin for the current model" },
				{ value: "off", label: "off", description: "Remove the pin for the current model" },
				{ value: "prefer", label: "prefer", description: "Prefer providers but allow fallbacks" },
				{
					value: "prefer strict",
					label: "prefer strict",
					description: "Prefer providers in order, no fallbacks",
				},
				{ value: "strict", label: "strict", description: "Order providers, disallow fallbacks" },
				{ value: "session", label: "session", description: "Scope the pin to this session only" },
				{
					value: "session off",
					label: "session off",
					description: "Ignore the persisted pin for this session",
				},
			];
			const matches = items.filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (rawArgs, ctx) => {
			const parsed = parsePinArgs(rawArgs);
			const args = parsed.rest;
			const scope = parsed.scope;

			if (isHelpArg(args)) {
				ctx.ui.notify(HELP_PIN, "info");
				return;
			}

			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("/pin needs a selected model", "warning");
				return;
			}
			if (model.provider !== "openrouter") {
				ctx.ui.notify(
					`/pin applies to OpenRouter models only (current: ${model.provider}/${model.id})`,
					"warning",
				);
				return;
			}

			const key = bindingKey(model);
			const verb = args.toLowerCase();
			const flex = bindingFor(agentDir, model)?.flex;

			if (verb === "off" || verb === "auto" || verb === "none") {
				if (scope === "session") {
					putSessionPin(key, null);
					persistSessionPins();
					ensureAdvice(ctx, model);
					syncStatus(ctx);
					ctx.ui.notify(
						`${model.id} uses OpenRouter's default provider routing for this session`,
						"info",
					);
					return;
				}
				reportPersist(ctx, setPinBinding(agentDir, key, null));
				deleteSessionPin(key);
				persistSessionPins();
				ensureAdvice(ctx, model);
				syncStatus(ctx);
				ctx.ui.notify(`${model.id} uses OpenRouter's default provider routing`, "info");
				return;
			}

			if (verb === "status") {
				const persisted = loadState(agentDir).models[key]?.pin;
				const { pin, sessionScoped } = resolvePin(agentDir, model);
				const flexLine = flex
					? flex.endpoint
						? `Flex tier: pinned to ${flex.endpoint} (this makes any pin inactive)`
						: "Flex tier: auto (the pin constrains which flex endpoints may serve)"
					: "Flex tier: standard (the pin applies as usual)";
				if (pin) {
					const inactive = Boolean(flex?.endpoint);
					ctx.ui.notify(
						`${describePin(model, pin, sessionScoped)}${inactive ? "\nThis pin is inactive while a flex endpoint is pinned." : ""}\n${flexLine}`,
						"info",
					);
					return;
				}
				if (sessionScoped) {
					ctx.ui.notify(
						`No session pin for ${model.id}: default provider routing (persisted pin${persisted ? ` \`${persisted.providers.join(", ")}\` is ignored for this session` : " absent"})\n${flexLine}`,
						"info",
					);
					return;
				}
				ctx.ui.notify(`No pin for ${model.id}\n${flexLine}`, "info");
				return;
			}

			const { mode, allowFallbacks } = parsed;

			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
			const requested = args
				.split(/[\s,]+/)
				.map((provider) => provider.trim().toLowerCase())
				.filter(Boolean);

			if (requested.length === 0) {
				if (!apiKey) {
					ctx.ui.notify("No OpenRouter credential. Run /login openrouter first.", "error");
					return;
				}
				const { endpoints, error, slug } = await fetchEndpoints(model, apiKey);
				const providers = providersOf(endpoints);
				if (error || providers.length === 0) {
					ctx.ui.notify(
						`OpenRouter: ${error ?? `no endpoints are listed for \`${slug}\``}`,
						"warning",
					);
					return;
				}
				if (!ctx.hasUI) {
					const available = providers.map((provider) => provider.slug).join(", ");
					ctx.ui.notify(`Providers for ${slug}: ${available}`, "info");
					return;
				}

				const labels = providers.map(providerLabel);
				const pinKind =
					mode === "prefer" ? (allowFallbacks ? "Prefer" : "Prefer (no fallbacks)") : "Pin";
				const scopeNote = scope === "session" ? " for this session" : "";
				const choice = await ctx.ui.select(
					`${pinKind} ${slug} on which provider${scopeNote}?`,
					labels,
				);
				if (choice === undefined) return;
				const chosen = providers[labels.indexOf(choice)]?.slug;
				if (!chosen) return;
				const incompatible =
					flex && !flex.endpoint
						? flexCapabilityWarning([chosen], mode, endpoints, slug)
						: undefined;
				if (incompatible) {
					ctx.ui.notify(incompatible, "warning");
					return;
				}
				applyPin(ctx, model, [chosen], mode, allowFallbacks, scope);
				return;
			}

			const invalid = requested.filter((provider) => !PROVIDER_PATTERN.test(provider));
			if (invalid.length > 0) {
				ctx.ui.notify(`Invalid provider slug: ${invalid.join(", ")}`, "error");
				return;
			}
			const providers = [...new Set(requested)];

			// Validation is best-effort: an unreachable endpoint list still lets the pin through.
			if (apiKey) {
				const { endpoints, error, slug } = await fetchEndpoints(model, apiKey);
				if (!error && endpoints.length > 0) {
					const known = new Set(providersOf(endpoints).map((provider) => provider.slug));
					const unknown = providers.filter((provider) => !known.has(provider));
					if (known.size > 0 && unknown.length > 0) {
						ctx.ui.notify(
							`Unknown provider${unknown.length === 1 ? "" : "s"} for ${modelSlug(model.id)}: ${unknown.join(", ")}. Available: ${[...known].join(", ")}`,
							"error",
						);
						return;
					}
				}
				if (flex && !flex.endpoint) {
					const incompatible = flexCapabilityWarning(providers, mode, endpoints, slug);
					if (incompatible) {
						ctx.ui.notify(incompatible, "warning");
						return;
					}
				}
			}

			applyPin(ctx, model, providers, mode, allowFallbacks, scope);
		},
	});
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

/**
 * A flex-tier request can only be served by providers with a flex endpoint. `only`
 * requires every named provider to be flex-capable; `prefer` requires at least one, since
 * the others would simply never serve.
 */
function flexCapabilityWarning(
	providers: readonly string[],
	mode: PinMode,
	endpoints: readonly Endpoint[],
	slug: string,
): string | undefined {
	const capable = flexProviderSlugs(endpoints);
	if (capable.size === 0) return undefined;
	const missing = providers.filter((provider) => !capable.has(provider));
	if (mode === "only" && missing.length > 0) {
		return `Flex is on but ${missing.join(", ")} has no flex endpoint for ${slug} (provider.only requires all of them to serve flex).\nFlex-capable: ${[...capable].join(", ")}. Run /flex off first, or pick a flex-capable provider.`;
	}
	if (mode === "prefer" && missing.length === providers.length) {
		return `Flex is on but none of ${providers.join(", ")} has a flex endpoint for ${slug}.\nFlex-capable: ${[...capable].join(", ")}. Run /flex off first, or pick a flex-capable provider.`;
	}
	return undefined;
}

/**
 * Why flex auto cannot honor this pin, or `undefined` when it can. Auto sends the flex
 * tier with the pin's provider list, so providers without a flex endpoint would never
 * serve: `only` needs every pinned provider to be flex-capable, `prefer` at least one.
 * When no flex endpoint is known at all there is nothing to judge.
 */
function pinBlocksFlex(
	pin: PinBinding,
	endpoints: readonly Endpoint[],
	slug: string,
): string | undefined {
	const capable = flexProviderSlugs(endpoints);
	if (capable.size === 0) return undefined;
	const missing =
		pin.mode === "only"
			? pin.providers.filter((provider) => !capable.has(provider))
			: pin.providers.some((provider) => capable.has(provider))
				? []
				: pin.providers;
	if (missing.length === 0) return undefined;
	return `Flex auto would break the pin: no flex endpoint for ${missing.join(", ")} on ${slug}.\nFlex-capable providers: ${[...capable].join(", ")}.\nRetarget the pin with /pin, remove it with /pin off, or pin a flex endpoint with /flex <endpoint>.`;
}

/** Run `fn` over `items` with at most `limit` calls in flight. */
async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			for (;;) {
				const index = next++;
				if (index >= items.length) return;
				results[index] = await fn(items[index]);
			}
		}),
	);
	return results;
}

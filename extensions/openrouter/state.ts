/**
 * Persisted and session-scoped routing state.
 *
 * A model's flex tier and provider pin now live in one binding (`<provider>:<model id>`
 * in `openrouter.json`), which is what lets the route planner see them together.
 *
 * The first load migrates `flex.json` and `openrouter-pin.json` into the unified file and
 * leaves the legacy files untouched, so reverting to the old extensions still restores the
 * settings they had before this merge. Session-scoped pins keep their old entry type so
 * resumed sessions still restore them.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./catalog.ts";
import type {
	EndpointPricing,
	FallbackRouting,
	FlexBinding,
	GatewayState,
	ModelBinding,
	PinBinding,
	PinMode,
	TurnMix,
	UsageLike,
} from "./types.ts";

export const STATE_FILE = "openrouter.json";
export const LEGACY_FLEX_FILE = "flex.json";
export const LEGACY_PIN_FILE = "openrouter-pin.json";
export const SESSION_ENTRY_TYPE = "openrouter-pin-session";

const TURN_MIX_TTL_MS = 10 * 60_000;
const TURN_MIX_MAX_FILES = 60;
const TURN_MIX_MIN_TURNS = 50;

type Cache = { dir: string; state: GatewayState; reads: number };

let cached: Cache | undefined;

function emptyState(): GatewayState {
	return { version: 1, models: {} };
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	} catch {
		// A read-only config directory only loses persistence, not routing.
	}
}

function parseFlexBinding(value: unknown): FlexBinding | undefined {
	if (!isRecord(value)) return undefined;
	return {
		endpoint: typeof value.endpoint === "string" ? value.endpoint : null,
		providerName: typeof value.providerName === "string" ? value.providerName : undefined,
		pricing: isRecord(value.pricing) ? (value.pricing as EndpointPricing) : undefined,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
	};
}

function parsePinBinding(value: unknown): PinBinding | undefined {
	if (!isRecord(value)) return undefined;
	const providers = Array.isArray(value.providers)
		? value.providers.filter((provider): provider is string => typeof provider === "string")
		: [];
	if (providers.length === 0) return undefined;
	const mode: PinMode = value.mode === "prefer" ? "prefer" : "only";
	return {
		providers,
		mode,
		// Older prefer pins predate the flag and meant fallbacks allowed.
		allowFallbacks:
			typeof value.allowFallbacks === "boolean" ? value.allowFallbacks : mode === "prefer",
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
	};
}

function parseFallbackRouting(value: unknown): FallbackRouting | undefined {
	return value === "openrouter"
		? "openrouter"
		: value === "same-provider"
			? "same-provider"
			: undefined;
}

function parseTurnMix(value: unknown): TurnMix | undefined {
	if (!isRecord(value)) return undefined;
	const values = [value.input, value.cacheRead, value.cacheWrite, value.output];
	if (!values.every((entry) => typeof entry === "number" && entry >= 0)) return undefined;
	return {
		input: value.input as number,
		cacheRead: value.cacheRead as number,
		cacheWrite: value.cacheWrite as number,
		output: value.output as number,
	};
}

/** Merge the two legacy files into one unified state. */
function migrate(agentDir: string): GatewayState | undefined {
	const state = emptyState();
	let found = false;

	const legacyFlex = readJson(join(agentDir, LEGACY_FLEX_FILE));
	if (isRecord(legacyFlex)) {
		found = true;
		const models = legacyFlex.models;
		if (isRecord(models)) {
			for (const [key, value] of Object.entries(models)) {
				const flex = parseFlexBinding(value);
				if (!flex) continue;
				state.models[key] = { ...state.models[key], flex };
			}
		}
		const turnMix = parseTurnMix(legacyFlex.turnMix);
		if (turnMix) state.turnMix = turnMix;
		const fallback = parseFallbackRouting(legacyFlex.fallback);
		if (fallback) state.fallback = fallback;
	}

	const legacyPin = readJson(join(agentDir, LEGACY_PIN_FILE));
	if (isRecord(legacyPin)) {
		found = true;
		const models = legacyPin.models;
		if (isRecord(models)) {
			for (const [key, value] of Object.entries(models)) {
				const pin = parsePinBinding(value);
				if (!pin) continue;
				state.models[key] = { ...state.models[key], pin };
			}
		}
	}

	return found ? state : undefined;
}

export function loadState(agentDir: string): GatewayState {
	if (cached?.dir === agentDir) return cached.state;
	const path = join(agentDir, STATE_FILE);
	const parsed = readJson(path);
	if (isRecord(parsed)) {
		const state = emptyState();
		if (isRecord(parsed.models)) {
			for (const [key, value] of Object.entries(parsed.models)) {
				if (!isRecord(value)) continue;
				const binding: ModelBinding = {};
				const flex = parseFlexBinding(value.flex);
				const pin = parsePinBinding(value.pin);
				if (flex) binding.flex = flex;
				if (pin) binding.pin = pin;
				if (binding.flex || binding.pin) state.models[key] = binding;
			}
		}
		const turnMix = parseTurnMix(parsed.turnMix);
		if (turnMix) state.turnMix = turnMix;
		const fallback = parseFallbackRouting(parsed.fallback);
		if (fallback) state.fallback = fallback;
		cached = { dir: agentDir, state, reads: 0 };
		return state;
	}

	// No unified file: import the legacy settings once, then persist the result.
	const migrated = migrate(agentDir);
	const state = migrated ?? emptyState();
	cached = { dir: agentDir, state, reads: 0 };
	if (migrated) writeJson(path, state);
	return state;
}

export function saveState(agentDir: string, state: GatewayState): void {
	cached = { dir: agentDir, state, reads: cached?.reads ?? 0 };
	writeJson(join(agentDir, STATE_FILE), state);
}

export function clearStateCache(): void {
	cached = undefined;
}

export function bindingKey(model: { provider: string; id: string }): string {
	return `${model.provider}:${model.id}`;
}

export function bindingFor(
	agentDir: string,
	model: { provider: string; id: string },
): ModelBinding | undefined {
	return loadState(agentDir).models[bindingKey(model)];
}

function setModelBinding(
	agentDir: string,
	key: string,
	update: (binding: ModelBinding) => ModelBinding | undefined,
): void {
	const state = loadState(agentDir);
	const models = { ...state.models };
	const next = update(models[key] ?? {});
	if (next && (next.flex || next.pin)) models[key] = next;
	else delete models[key];
	saveState(agentDir, { ...state, version: 1, models });
}

export function setFlexBinding(agentDir: string, key: string, flex: FlexBinding | null): void {
	setModelBinding(agentDir, key, (binding) => {
		const next = { ...binding };
		if (flex) next.flex = flex;
		else delete next.flex;
		return next;
	});
}

export function setPinBinding(agentDir: string, key: string, pin: PinBinding | null): void {
	setModelBinding(agentDir, key, (binding) => {
		const next = { ...binding };
		if (pin) next.pin = pin;
		else delete next.pin;
		return next;
	});
}

/** Cooldown routing, defaulting to same-provider so the prompt cache survives a shed. */
export function fallbackRouting(agentDir: string): FallbackRouting {
	return loadState(agentDir).fallback === "openrouter" ? "openrouter" : "same-provider";
}

export function setFallbackRouting(agentDir: string, routing: FallbackRouting): void {
	saveState(agentDir, { ...loadState(agentDir), fallback: routing });
}

export function describeFallbackRouting(routing: FallbackRouting): string {
	return routing === "openrouter"
		? "OpenRouter default routing plus any pin (no provider affinity added)"
		: "same provider's standard endpoint (`provider.order`, cache warm)";
}

// ---------------------------------------------------------------------------
// Session-scoped pins
// ---------------------------------------------------------------------------

/** Pins that apply to this session only; a `null` value shadows a persisted pin. */
let sessionPins: Record<string, PinBinding | null> = {};

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

interface SessionBranchReader {
	sessionManager: { getBranch: () => readonly BranchEntry[] };
}

/** The last session entry describing the whole map wins, as branches replay in order. */
export function restoreSessionPins(ctx: SessionBranchReader): void {
	sessionPins = {};
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data)) continue;
		const rawPins = data.pins;
		if (!isRecord(rawPins)) continue;
		const pins: Record<string, PinBinding | null> = {};
		for (const [key, value] of Object.entries(rawPins)) {
			if (value === null) pins[key] = null;
			else {
				const binding = parsePinBinding(value);
				if (binding) pins[key] = binding;
			}
		}
		sessionPins = pins;
	}
}

export function sessionPinState(): Record<string, PinBinding | null> {
	return sessionPins;
}

export function putSessionPin(key: string, pin: PinBinding | null): void {
	sessionPins = { ...sessionPins, [key]: pin };
}

export function deleteSessionPin(key: string): void {
	if (!Object.hasOwn(sessionPins, key)) return;
	const next = { ...sessionPins };
	delete next[key];
	sessionPins = next;
}

export function clearSessionPins(): void {
	sessionPins = {};
}

/** Session pin wins over the persisted pin; `undefined` means no override at all. */
export function resolvePin(
	agentDir: string,
	model: { provider: string; id: string },
): { pin?: PinBinding; sessionScoped: boolean } {
	const key = bindingKey(model);
	if (Object.hasOwn(sessionPins, key)) {
		return { pin: sessionPins[key] ?? undefined, sessionScoped: true };
	}
	return { pin: bindingFor(agentDir, model)?.pin, sessionScoped: false };
}

// ---------------------------------------------------------------------------
// Turn-mix resolution
// ---------------------------------------------------------------------------

const DEFAULT_TURN_MIX: TurnMix = {
	input: 2_000,
	cacheRead: 40_000,
	cacheWrite: 500,
	output: 1_000,
};

let turnMixCache: { at: number; mix: TurnMix; turns: number } | undefined;

/** Optional user override: `turnMix` in openrouter.json (or the legacy flex.json). */
function turnMixOverride(agentDir: string): TurnMix | undefined {
	for (const file of [STATE_FILE, LEGACY_FLEX_FILE]) {
		const parsed = readJson(join(agentDir, file));
		if (!isRecord(parsed)) continue;
		const override = parseTurnMix(parsed.turnMix);
		if (override) return override;
	}
	return undefined;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Scan Pi session files for per-turn token usage and derive a representative
 * agentic turn: median uncached input, cache-read and output; mean cache-write
 * (sparse but large when a session cold-starts).
 */
function scanTurnMix(agentDir: string): { mix: TurnMix; turns: number } | undefined {
	const sessionsDir = join(agentDir, "sessions");
	try {
		const files: { path: string; mtime: number }[] = [];
		for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const dir = join(sessionsDir, entry.name);
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".jsonl")) continue;
				const path = join(dir, file);
				files.push({ path, mtime: statSync(path).mtimeMs });
			}
		}
		// Recent sessions resemble current usage patterns most closely.
		files.sort((a, b) => b.mtime - a.mtime);
		const inputs: number[] = [];
		const cacheReads: number[] = [];
		const cacheWrites: number[] = [];
		const outputs: number[] = [];
		for (const file of files.slice(0, TURN_MIX_MAX_FILES)) {
			let content: string;
			try {
				content = readFileSync(file.path, "utf8");
			} catch {
				continue;
			}
			for (const line of content.split("\n")) {
				if (!line.includes('"assistant"')) continue;
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				const message = (entry as { message?: { role?: string; usage?: UsageLike } }).message;
				if (message?.role !== "assistant") continue;
				const usage = message.usage;
				if (!usage) continue;
				if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite <= 0) continue;
				inputs.push(usage.input);
				cacheReads.push(usage.cacheRead);
				cacheWrites.push(usage.cacheWrite);
				outputs.push(usage.output);
			}
		}
		if (inputs.length < TURN_MIX_MIN_TURNS) return undefined;
		// Cache writes land on few turns (session cold starts), so expected value beats median.
		const roundTo = (value: number, quantum: number): number =>
			Math.round(value / quantum) * quantum;
		return {
			mix: {
				input: roundTo(median(inputs), 100),
				cacheRead: roundTo(median(cacheReads), 100),
				cacheWrite: roundTo(mean(cacheWrites), 50),
				output: roundTo(median(outputs), 10),
			},
			turns: inputs.length,
		};
	} catch {
		// Missing or unreadable sessions fall back to the default mix.
		return undefined;
	}
}

/** Resolve the representative turn: state-file override, then session history, then a default. */
export function resolveTurnMix(
	agentDir: string,
	options: { refresh?: boolean } = {},
): { mix: TurnMix; turns?: number; source: string } {
	const override = turnMixOverride(agentDir);
	if (override) return { mix: override, source: STATE_FILE };
	if (!options.refresh && turnMixCache && Date.now() - turnMixCache.at < TURN_MIX_TTL_MS) {
		return { mix: turnMixCache.mix, turns: turnMixCache.turns, source: "your sessions" };
	}
	const scanned = scanTurnMix(agentDir);
	if (scanned) {
		turnMixCache = { at: Date.now(), ...scanned };
		return { mix: scanned.mix, turns: scanned.turns, source: "your sessions" };
	}
	return { mix: DEFAULT_TURN_MIX, source: "built-in default" };
}

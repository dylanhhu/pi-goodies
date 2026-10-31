/**
 * Persisted and session-scoped routing state.
 *
 * A model's flex tier and provider pin live in one binding (`<provider>:<model id>`
 * in `openrouter.json`), which is what lets the route planner see them together.
 *
 * Durability rules, because a bad state file must never leave Pi unusable or silently
 * change routing:
 * - Writes are atomic (temp file, then rename), so a concurrent reader never sees a
 *   half-written file.
 * - The legacy `flex.json` and `openrouter-pin.json` are imported only when
 *   `openrouter.json` does not exist. An unreadable or invalid file is never treated as
 *   absent: the last good state stays in force, the bad file is backed up, and the
 *   problem is reported through `stateHealth`.
 * - The in-memory copy is reloaded whenever the file changes on disk, and every write
 *   starts from the latest disk state, so two Pi sessions do not overwrite each other
 *   with stale copies.
 * - A failed write is returned to the caller instead of being swallowed.
 *
 * The legacy files are left untouched, so reverting to the old extensions still restores
 * the settings they had before this merge. Session-scoped pins keep their old entry type
 * so resumed sessions still restore them.
 */

import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
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
/** Session files beyond this size are skipped by the turn-mix scan, so it stays cheap. */
const TURN_MIX_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Why `openrouter.json` could not be used. */
export interface StateHealth {
	problem: "invalid" | "unreadable";
	detail: string;
	/** Copy of the invalid file, when one could be made. */
	backupPath?: string;
	/** True when a previously loaded state is still in force; false when starting empty. */
	usingLastGood: boolean;
}

type Cache = { dir: string; state: GatewayState; signature: string; health?: StateHealth };

let cached: Cache | undefined;

function emptyState(): GatewayState {
	return { version: 1, models: {} };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type FileRead =
	| { kind: "ok"; value: Record<string, unknown> }
	| { kind: "missing" }
	| { kind: "invalid"; detail: string }
	| { kind: "unreadable"; detail: string };

/** Read a JSON object file, telling an absent file apart from one that cannot be trusted. */
function readJsonFile(path: string): FileRead {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
		return { kind: "unreadable", detail: errorText(error) };
	}
	try {
		const value: unknown = JSON.parse(text);
		if (!isRecord(value)) return { kind: "invalid", detail: "top-level value is not an object" };
		return { kind: "ok", value };
	} catch (error) {
		return { kind: "invalid", detail: errorText(error) };
	}
}

/** Lenient read for legacy files and overrides: anything unusable counts as absent. */
function readJson(path: string): Record<string, unknown> | undefined {
	const read = readJsonFile(path);
	return read.kind === "ok" ? read.value : undefined;
}

/** Atomic write: a reader sees the old file or the new one, never a partial file. */
function writeJsonAtomic(path: string, value: unknown): string | undefined {
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		renameSync(temp, path);
		return undefined;
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// The temp file may never have been created.
		}
		return errorText(error);
	}
}

/** Identity of the file's current contents, cheap enough to check on every access. */
function fileSignature(path: string): string {
	try {
		const info = statSync(path, { bigint: true });
		return `${info.ino}:${info.mtimeNs}:${info.size}`;
	} catch {
		return "missing";
	}
}

function parseFlexBinding(value: unknown): FlexBinding | undefined {
	if (!isRecord(value)) return undefined;
	// Flex is a paid-tier opt-in, so an entry must say so explicitly: a named endpoint, or
	// `null` for auto. A malformed entry (`{}`, a number) is dropped, never read as auto.
	let endpoint: string | null;
	if (value.endpoint === null) endpoint = null;
	else if (typeof value.endpoint === "string" && value.endpoint.trim() !== "")
		endpoint = value.endpoint.trim();
	else return undefined;
	return {
		endpoint,
		providerName: typeof value.providerName === "string" ? value.providerName : undefined,
		pricing: isRecord(value.pricing) ? (value.pricing as EndpointPricing) : undefined,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
	};
}

function parsePinBinding(value: unknown): PinBinding | undefined {
	if (!isRecord(value)) return undefined;
	const providers = Array.isArray(value.providers)
		? [
				...new Set(
					value.providers
						.filter((provider): provider is string => typeof provider === "string")
						.map((provider) => provider.trim().toLowerCase())
						.filter(Boolean),
				),
			]
		: [];
	if (providers.length === 0) return undefined;
	const mode: PinMode = value.mode === "prefer" ? "prefer" : "only";
	return {
		providers,
		mode,
		// Older prefer pins predate the flag and meant fallbacks allowed.
		allowFallbacks:
			mode === "only"
				? false
				: typeof value.allowFallbacks === "boolean"
					? value.allowFallbacks
					: true,
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
	if (legacyFlex) {
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
	if (legacyPin) {
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

function parseState(parsed: Record<string, unknown>): GatewayState {
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
	return state;
}

/** Keep a copy of a file the extension cannot parse, so repairing it never loses data. */
function backUpInvalid(path: string): string | undefined {
	const backup = `${path}.invalid-${Date.now()}`;
	try {
		copyFileSync(path, backup);
		return backup;
	} catch {
		return undefined;
	}
}

export function loadState(agentDir: string): GatewayState {
	const path = join(agentDir, STATE_FILE);
	const signature = fileSignature(path);
	if (cached?.dir === agentDir && cached.signature === signature) return cached.state;

	const read = readJsonFile(path);
	if (read.kind === "ok") {
		const state = parseState(read.value);
		cached = { dir: agentDir, state, signature };
		return state;
	}

	if (read.kind === "missing") {
		// A first run (or a deliberate delete): import the legacy settings, then persist
		// the result. This is the only path that reads the legacy files.
		const migrated = migrate(agentDir);
		const state = migrated ?? emptyState();
		cached = { dir: agentDir, state, signature };
		if (migrated && !writeJsonAtomic(path, state)) cached.signature = fileSignature(path);
		return state;
	}

	// Unreadable or invalid: never treat as absent, never migrate over it. Keep the last
	// good state when there is one, otherwise run without routing state.
	const lastGood = cached?.dir === agentDir ? cached.state : undefined;
	const health: StateHealth = {
		problem: read.kind,
		detail: read.detail,
		backupPath: read.kind === "invalid" ? backUpInvalid(path) : undefined,
		usingLastGood: Boolean(lastGood),
	};
	const state = lastGood ?? emptyState();
	cached = { dir: agentDir, state, signature, health };
	return state;
}

/** Why the state file is not in use, or `undefined` when it loaded cleanly. */
export function stateHealth(agentDir: string): StateHealth | undefined {
	loadState(agentDir);
	return cached?.dir === agentDir ? cached.health : undefined;
}

/**
 * Persist `state` and make it the in-memory state either way, so the running session
 * follows the command even when the disk is read-only. Returns the write error, if any.
 */
export function saveState(agentDir: string, state: GatewayState): string | undefined {
	const path = join(agentDir, STATE_FILE);
	const error = writeJsonAtomic(path, state);
	if (error) {
		cached = {
			dir: agentDir,
			state,
			signature: cached?.dir === agentDir ? cached.signature : fileSignature(path),
			health: cached?.dir === agentDir ? cached.health : undefined,
		};
		return error;
	}
	cached = { dir: agentDir, state, signature: fileSignature(path) };
	return undefined;
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
): string | undefined {
	// `loadState` reloads when another process changed the file, so the write below
	// changes one model's entry on top of the latest disk state.
	const state = loadState(agentDir);
	const models = { ...state.models };
	const next = update(models[key] ?? {});
	if (next && (next.flex || next.pin)) models[key] = next;
	else delete models[key];
	return saveState(agentDir, { ...state, version: 1, models });
}

export function setFlexBinding(
	agentDir: string,
	key: string,
	flex: FlexBinding | null,
): string | undefined {
	return setModelBinding(agentDir, key, (binding) => {
		const next = { ...binding };
		if (flex) next.flex = flex;
		else delete next.flex;
		return next;
	});
}

export function setPinBinding(
	agentDir: string,
	key: string,
	pin: PinBinding | null,
): string | undefined {
	return setModelBinding(agentDir, key, (binding) => {
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

export function setFallbackRouting(agentDir: string, routing: FallbackRouting): string | undefined {
	return saveState(agentDir, { ...loadState(agentDir), fallback: routing });
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

export interface TurnMixResolution {
	mix: TurnMix;
	turns?: number;
	source: string;
}

let turnMixCache: { at: number; value: TurnMixResolution } | undefined;
let turnMixScan: Promise<TurnMixResolution> | undefined;

/** Optional user override: `turnMix` in openrouter.json (or the legacy flex.json). */
function turnMixOverride(agentDir: string): TurnMix | undefined {
	const fromState = loadState(agentDir).turnMix;
	if (fromState) return fromState;
	return parseTurnMix(readJson(join(agentDir, LEGACY_FLEX_FILE))?.turnMix);
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
 * (sparse but large when a session cold-starts). Asynchronous and size-capped, so it
 * never stalls the UI thread.
 */
async function scanTurnMix(agentDir: string): Promise<{ mix: TurnMix; turns: number } | undefined> {
	const sessionsDir = join(agentDir, "sessions");
	try {
		const files: { path: string; mtime: number }[] = [];
		for (const entry of await readdir(sessionsDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const dir = join(sessionsDir, entry.name);
			for (const file of await readdir(dir)) {
				if (!file.endsWith(".jsonl")) continue;
				const path = join(dir, file);
				try {
					const info = await stat(path);
					if (info.size <= TURN_MIX_MAX_FILE_BYTES) files.push({ path, mtime: info.mtimeMs });
				} catch {
					// A session file removed mid-scan is simply skipped.
				}
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
				content = await readFile(file.path, "utf8");
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

/**
 * The representative turn when it is available without scanning: the state-file override,
 * or a fresh cached scan. `undefined` means a scan is needed first.
 */
export function peekTurnMix(agentDir: string): TurnMixResolution | undefined {
	const override = turnMixOverride(agentDir);
	if (override) return { mix: override, source: STATE_FILE };
	if (turnMixCache && Date.now() - turnMixCache.at < TURN_MIX_TTL_MS) return turnMixCache.value;
	return undefined;
}

/** Resolve the representative turn: state-file override, then session history, then a default. */
export async function resolveTurnMix(
	agentDir: string,
	options: { refresh?: boolean } = {},
): Promise<TurnMixResolution> {
	if (!options.refresh) {
		const ready = peekTurnMix(agentDir);
		if (ready) return ready;
	}
	const override = turnMixOverride(agentDir);
	if (override) return { mix: override, source: STATE_FILE };

	// Concurrent callers share one scan.
	turnMixScan ??= scanTurnMix(agentDir)
		.then((scanned): TurnMixResolution => {
			const value: TurnMixResolution = scanned
				? { mix: scanned.mix, turns: scanned.turns, source: "your sessions" }
				: { mix: DEFAULT_TURN_MIX, source: "built-in default" };
			turnMixCache = { at: Date.now(), value };
			return value;
		})
		.finally(() => {
			turnMixScan = undefined;
		});
	return turnMixScan;
}

/** Drop the cached scan, for tests and `/flex mix refresh`. */
export function clearTurnMixCache(): void {
	turnMixCache = undefined;
}

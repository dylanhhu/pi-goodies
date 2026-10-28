/**
 * Tokens Per Second Extension — per-request decode throughput in the footer
 *
 * `AssistantMessage.durationMs` measures the monotonic elapsed time from request
 * start to response end, and `usage.output` is the provider-reported output token
 * count (reasoning included). Their ratio is end-to-end throughput: it includes
 * time to first token and any thinking, so it runs below pure decode speed on
 * reasoning models. Prefill-heavy requests likewise read low.
 *
 * Status key: `tokens-per-second`.
 *
 * Config file: ~/.pi/agent/tokens-per-second.json  (global)
 *              .pi/tokens-per-second.json          (project-local, overrides)
 *
 * The `scale` array is ordered; each tier's `maxTps` is an exclusive upper bound,
 * so a tier applies while `tps < maxTps`. The final tier may omit `maxTps` as a
 * catch-all. Values above every bound use `overflowColor` (default `accent`).
 *
 *   {
 *     "scale": [
 *       { "maxTps": 20, "color": "error" },
 *       { "maxTps": 60, "color": "warning" },
 *       { "color": "success" }
 *     ],
 *     "overflowColor": "accent"
 *   }
 *
 * Commands:
 *   /tps              Open the color-scale editor (TUI), or print the scale
 *   /tps 20 60        Set the first two upper bounds, keeping colors
 *   /tps reset        Restore the default red/yellow/green scale
 *
 * Edits made in the editor are written to the config file immediately; a
 * /reload is only needed after editing the JSON by hand.
 */

import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Input, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATUS_KEY = "tokens-per-second";

/** Foreground theme tokens offered by the editor. */
const COLOR_VALUES: ThemeColor[] = ["error", "warning", "success", "accent", "text", "muted", "dim"];

interface Tier {
	/** Exclusive upper bound of the tier in tokens per second. */
	maxTps?: number;
	/** Theme foreground token applied to the status text. */
	color: ThemeColor;
}

interface TpsConfig {
	scale?: Tier[];
	overflowColor?: ThemeColor;
}

const DEFAULT_SCALE: Tier[] = [
	{ maxTps: 20, color: "error" },
	{ maxTps: 60, color: "warning" },
	{ color: "success" },
];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function globalConfigPath(): string {
	return join(getAgentDir(), "tokens-per-second.json");
}

function projectConfigPath(): string {
	return join(process.cwd(), CONFIG_DIR_NAME, "tokens-per-second.json");
}

/** Existing project config wins; otherwise the global file is the target. */
function activeConfigPath(): string {
	const project = projectConfigPath();
	return existsSync(project) ? project : globalConfigPath();
}

function isThemeColor(value: unknown): value is ThemeColor {
	return typeof value === "string" && (COLOR_VALUES as string[]).includes(value);
}

function loadConfig(): { scale: Tier[]; overflowColor: ThemeColor } {
	const path = activeConfigPath();
	if (!existsSync(path)) return { scale: DEFAULT_SCALE, overflowColor: "accent" };

	try {
		const config = JSON.parse(readFileSync(path, "utf-8")) as TpsConfig;
		const scale = config.scale;
		if (!Array.isArray(scale) || scale.length === 0) {
			return { scale: DEFAULT_SCALE, overflowColor: "accent" };
		}

		let previous = Number.NEGATIVE_INFINITY;
		for (const [index, tier] of scale.entries()) {
			if (!isThemeColor(tier?.color)) return { scale: DEFAULT_SCALE, overflowColor: "accent" };
			const isLast = index === scale.length - 1;
			if (tier.maxTps === undefined) {
				if (!isLast) return { scale: DEFAULT_SCALE, overflowColor: "accent" };
				continue;
			}
			if (!Number.isFinite(tier.maxTps) || tier.maxTps <= previous) {
				return { scale: DEFAULT_SCALE, overflowColor: "accent" };
			}
			previous = tier.maxTps;
		}

		return {
			scale,
			overflowColor: isThemeColor(config.overflowColor) ? config.overflowColor : "accent",
		};
	} catch (err) {
		console.error(`[tokens-per-second] Failed to load config from ${path}: ${err}`);
		return { scale: DEFAULT_SCALE, overflowColor: "accent" };
	}
}

function saveConfig(scale: Tier[], overflowColor: ThemeColor): string {
	const path = activeConfigPath();
	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(path)) existing = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		// A malformed file is replaced rather than blocking edits.
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...existing, scale, overflowColor }, null, 2)}\n`, "utf8");
	return path;
}

function colorFor(tps: number, scale: Tier[], overflowColor: ThemeColor): ThemeColor {
	for (const tier of scale) {
		if (tier.maxTps === undefined || tps < tier.maxTps) return tier.color;
	}
	return overflowColor;
}

function describeScale(scale: Tier[], overflowColor: ThemeColor): string {
	const tiers = scale.map((tier) =>
		tier.maxTps === undefined ? `${tier.color}: everything else` : `${tier.color}: <${tier.maxTps}`,
	);
	return `${tiers.join(", ")}; ${overflowColor}: above all bounds`;
}

export default function (pi: ExtensionAPI) {
	let { scale, overflowColor } = loadConfig();
	let lastTps: number | undefined;

	function renderStatus(ctx: Pick<ExtensionContext, "ui">, tps: number): void {
		const text = `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tps`;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(colorFor(tps, scale, overflowColor), text));
	}

	pi.on("session_start", async (_event, ctx) => {
		({ scale, overflowColor } = loadConfig());
		lastTps = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;

		const output = message.usage?.output ?? 0;
		const durationMs = message.durationMs ?? 0;
		if (output <= 0 || durationMs <= 0) return;

		lastTps = output / (durationMs / 1000);
		renderStatus(ctx, lastTps);
	});

	function openEditor(ctx: ExtensionContext): Promise<void> | void {
		let settingsList: SettingsList;
		let dirty = false;

		const apply = () => {
			dirty = true;
			saveConfig(scale, overflowColor);
			if (lastTps !== undefined) renderStatus(ctx, lastTps);
		};

		const numberSubmenu =
			(currentValue: string, done: (selectedValue?: string) => void) => {
				const input = new Input({ placeholder: `current: ${currentValue}` });
				input.focused = true;
				input.onSubmit = (value) => done(value.trim() || currentValue);
				input.onEscape = () => done();
				return {
					render(width: number) {
						return [
							ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Upper bound (tokens/sec, exclusive)")),
							...input.render(width),
							ctx.ui.theme.fg("dim", "enter save • esc cancel"),
						];
					},
					invalidate() {
						input.invalidate();
					},
					handleInput(data: string) {
						input.handleInput(data);
					},
				};
			};

		const items: SettingItem[] = [];
		scale.forEach((tier, index) => {
			if (tier.maxTps !== undefined) {
				items.push({
					id: `tier-${index}-max`,
					label: `Tier ${index + 1} upper bound`,
					description: "Exclusive bound in tokens per second; type a number",
					currentValue: String(tier.maxTps),
					submenu: numberSubmenu,
				});
			}
			items.push({
				id: `tier-${index}-color`,
				label: `Tier ${index + 1} color`,
				description: tier.maxTps === undefined ? "Catches every rate at or above lower bounds" : undefined,
				currentValue: tier.color,
				values: COLOR_VALUES,
			});
		});

		items.push({
			id: "overflow",
			label: "Above all bounds",
			description: "Only used when the final tier has an upper bound",
			currentValue: overflowColor,
			values: COLOR_VALUES,
		});

		return ctx.ui.custom<undefined>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(
				new (class {
					render() {
						const legend = scale.map((tier) =>
							theme.fg(tier.color, tier.maxTps === undefined ? "everything else" : `<${tier.maxTps}`),
						);
						return [
							theme.fg("accent", theme.bold("Tokens per second colors")),
							`${legend.join(theme.fg("dim", "  •  "))}${theme.fg("dim", `  •  ${overflowColor}: above all`)}`,
							"",
						];
					}
					invalidate() {}
				})(),
			);

			settingsList = new SettingsList(
				items,
				Math.min(items.length, 12),
				getSettingsListTheme(),
				(id, newValue) => {
					const match = /^tier-(\d+)-(max|color)$/.exec(id);
					if (!match) {
						if (id === "overflow" && isThemeColor(newValue)) {
							overflowColor = newValue;
							apply();
							container.invalidate();
							tui.requestRender();
						}
						return;
					}

					const index = Number(match[1]);
					const tier = scale[index];
					if (!tier) return;

					if (match[2] === "color") {
						if (!isThemeColor(newValue)) return;
						tier.color = newValue;
						apply();
						container.invalidate();
						tui.requestRender();
						return;
					}

					const bound = Number(newValue);
					const previous = scale[index - 1]?.maxTps ?? Number.NEGATIVE_INFINITY;
					const next = scale[index + 1]?.maxTps ?? Number.POSITIVE_INFINITY;
					if (!Number.isFinite(bound) || bound <= 0 || bound <= previous || bound >= next) {
						ctx.ui.notify(`Bound must be a positive number between ${previous} and ${next}`, "warning");
						settingsList.updateValue(id, String(tier.maxTps));
						return;
					}
					tier.maxTps = bound;
					apply();
					container.invalidate();
					tui.requestRender();
				},
				() => {
					if (dirty) {
						ctx.ui.notify(`Saved ${describeScale(scale, overflowColor)}`, "info");
						dirty = false;
					}
					done(undefined);
				},
			);

			container.addChild(settingsList);
			container.addChild(new Text(theme.fg("dim", `config: ${activeConfigPath()}`)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	pi.registerCommand("tps", {
		description: "Configure tokens-per-second status colors",
		handler: async (args, ctx) => {
			const input = args.trim();

			if (input === "reset") {
				({ scale, overflowColor } = { scale: DEFAULT_SCALE, overflowColor: "accent" });
				const path = saveConfig(scale, overflowColor);
				if (lastTps !== undefined) renderStatus(ctx, lastTps);
				ctx.ui.notify(`Restored default scale in ${path}`, "info");
				return;
			}

			if (input) {
				const bounds = input.split(/\s+/).map(Number);
				if (bounds.length !== 2 || bounds.some((n) => !Number.isFinite(n) || n <= 0) || bounds[0] >= bounds[1]) {
					ctx.ui.notify("Usage: /tps 20 60, /tps reset, or /tps for the editor", "warning");
					return;
				}
				scale = [
					{ maxTps: bounds[0], color: scale[0]?.color ?? "error" },
					{ maxTps: bounds[1], color: scale[1]?.color ?? "warning" },
					{ color: scale[2]?.color ?? "success" },
				];
				const path = saveConfig(scale, overflowColor);
				if (lastTps !== undefined) renderStatus(ctx, lastTps);
				ctx.ui.notify(`Scale ${describeScale(scale, overflowColor)} saved to ${path}`, "info");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify(describeScale(scale, overflowColor), "info");
				return;
			}

			await openEditor(ctx);
		},
	});
}

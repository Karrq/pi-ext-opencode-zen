/**
 * OpenCode Zen Provider Extension
 *
 * Provides access to OpenCode models through the zen.opencode.ai gateway.
 * Uses Zen's /v1/models endpoint as the authoritative source for available models,
 * enriched with metadata from models.dev (capabilities, routing, pricing).
 *
 * Usage:
 *   pi -e pi-ext-opencode-zen
 *   # Set OPENCODE_API_KEY=sk-... for full model access
 *   # Or use without key for free models only (determined by cost=0 in Zen's pricing)
 */

import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	streamSimpleAnthropic,
	streamSimpleGoogle,
	streamSimpleOpenAICompletions,
	streamSimpleOpenAIResponses,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ModelSelectEvent } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// =============================================================================
// Constants
// =============================================================================

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const ZEN_MODELS_URL = `${ZEN_BASE_URL}/models`;
const MODELS_API_URL = "https://models.dev/api.json";
const CACHE_DIR = process.env.XDG_CACHE_HOME
	? path.join(process.env.XDG_CACHE_HOME, "pi-ext-opencode-zen")
	: path.join(os.homedir(), ".cache", "pi-ext-opencode-zen");
const ZEN_MODELS_CACHE_FILE = path.join(CACHE_DIR, "zen-models.json");
const MODELS_CACHE_FILE = path.join(CACHE_DIR, "models.json");
const FREE_MODEL_IDS_FILE = path.join(CACHE_DIR, "free-model-ids.json");

// =============================================================================
// Types
// =============================================================================

type Backend = "anthropic" | "openai-responses" | "openai-completions" | "google";

interface ModelConfig {
	id: string;
	name: string;
	backend: Backend;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

interface ModelsDevAPI {
	opencode?: {
		models?: Record<
			string,
			{
				id: string;
				name: string;
				cost?: {
					input?: number;
					output?: number;
					cache_read?: number;
					cache_write?: number;
				};
				limit?: {
					context?: number;
					output?: number;
				};
				reasoning?: boolean;
				attachment?: boolean;
				tool_call?: boolean;
				modalities?: string[];
				provider?: {
					npm?: string;
					api?: string;
				};
			}
		>;
		provider?: {
			npm?: string;
			api?: string;
		};
	};
}

interface ZenModelsResponse {
	object: "list";
	data: Array<{
		id: string;
		object: string;
		created: number;
		owned_by: string;
	}>;
}

// =============================================================================
// Extension Settings
// =============================================================================

function getExtensionSetting(extensionName: string, settingId: string, defaultValue: string): string {
	try {
		const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings-extensions.json");
		if (!fs.existsSync(settingsPath)) return defaultValue;
		const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return data?.[extensionName]?.[settingId] ?? defaultValue;
	} catch {
		return defaultValue;
	}
}

// =============================================================================
// Model fetching and caching
// =============================================================================

function ensureCacheDir() {
	if (!fs.existsSync(CACHE_DIR)) {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
	}
}

async function fetchZenModels(): Promise<string[]> {
	const response = await fetch(ZEN_MODELS_URL);
	if (!response.ok) {
		throw new Error(`Failed to fetch Zen models: ${response.status} ${response.statusText}`);
	}

	const data = (await response.json()) as ZenModelsResponse;
	if (!data.data || !Array.isArray(data.data)) {
		throw new Error("Invalid Zen API response: missing data array");
	}

	return data.data.map((m) => m.id);
}

function loadZenModelsFromCache(): string[] | null {
	try {
		if (!fs.existsSync(ZEN_MODELS_CACHE_FILE)) return null;
		const data = fs.readFileSync(ZEN_MODELS_CACHE_FILE, "utf-8");
		const modelIds = JSON.parse(data) as string[];
		if (!Array.isArray(modelIds) || modelIds.length === 0) return null;
		return modelIds;
	} catch {
		return null;
	}
}

function saveZenModelsToCache(modelIds: string[]) {
	try {
		ensureCacheDir();
		fs.writeFileSync(ZEN_MODELS_CACHE_FILE, JSON.stringify(modelIds, null, 2), "utf-8");
	} catch (error) {
		console.error("Failed to save Zen models to cache:", error);
	}
}

function getBackendFromNpmPackage(npmPackage: string | undefined, defaultBackend: string | undefined): Backend {
	if (!npmPackage) {
		// Use default from provider level or fall back to openai-completions
		if (defaultBackend === "@ai-sdk/anthropic") return "anthropic";
		if (defaultBackend === "@ai-sdk/openai") return "openai-responses";
		if (defaultBackend === "@ai-sdk/google") return "google";
		return "openai-completions";
	}

	if (npmPackage === "@ai-sdk/anthropic") return "anthropic";
	if (npmPackage === "@ai-sdk/openai") return "openai-responses";
	if (npmPackage === "@ai-sdk/google") return "google";
	return "openai-completions"; // Default for @ai-sdk/openai-compatible or unknown
}

function loadModelsFromCache(): ModelConfig[] | null {
	try {
		if (!fs.existsSync(MODELS_CACHE_FILE)) return null;
		const data = fs.readFileSync(MODELS_CACHE_FILE, "utf-8");
		const models = JSON.parse(data) as ModelConfig[];
		// Basic validation
		if (!Array.isArray(models) || models.length === 0) return null;
		for (const model of models) {
			if (!model.id || !model.name || !model.backend) return null;
		}
		return models;
	} catch {
		return null;
	}
}

function saveModelsToCache(models: ModelConfig[]) {
	try {
		ensureCacheDir();
		fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify(models, null, 2), "utf-8");
	} catch (error) {
		console.error("Failed to save models to cache:", error);
	}
}

function loadFreeModelIds(): string[] {
	try {
		if (!fs.existsSync(FREE_MODEL_IDS_FILE)) return [];
		const data = fs.readFileSync(FREE_MODEL_IDS_FILE, "utf-8");
		return JSON.parse(data) as string[];
	} catch {
		return [];
	}
}

function saveFreeModelIds(ids: string[]) {
	try {
		ensureCacheDir();
		fs.writeFileSync(FREE_MODEL_IDS_FILE, JSON.stringify(ids, null, 2), "utf-8");
	} catch (error) {
		console.error("Failed to save free model IDs:", error);
	}
}

async function getModels(hasApiKey: boolean): Promise<ModelConfig[]> {
	// Step 1: Get authoritative model list from Zen
	let zenModelIds: string[];
	try {
		zenModelIds = await fetchZenModels();
		saveZenModelsToCache(zenModelIds);
	} catch (error) {
		console.warn("Failed to fetch Zen models, using cache:", error);
		const cached = loadZenModelsFromCache();
		if (!cached) {
			throw new Error("No cached Zen models available and API fetch failed");
		}
		zenModelIds = cached;
	}

	// Step 2: Fetch models.dev for metadata enrichment
	let modelsDevData: ModelsDevAPI["opencode"] | undefined;
	try {
		const response = await fetch(MODELS_API_URL);
		if (response.ok) {
			const data = (await response.json()) as ModelsDevAPI;
			modelsDevData = data.opencode;
		}
	} catch (error) {
		console.warn("Failed to fetch models.dev metadata:", error);
		// Fall back to cached enriched models if available
		const cachedModels = loadModelsFromCache();
		if (cachedModels) {
			console.warn("Using cached enriched models as fallback");
			// Filter cached models to only those still in Zen's list
			const zenSet = new Set(zenModelIds);
			let models = cachedModels.filter((m) => zenSet.has(m.id));
			if (!hasApiKey) {
				models = models.filter((m) => m.cost.input === 0 && m.cost.output === 0);
			}
			return models;
		}
		console.warn("No cached models available, will use defaults");
	}

	// Step 3: Build model configs - only for models in Zen's list
	let models: ModelConfig[] = [];
	const providerDefaultNpm = modelsDevData?.provider?.npm;

	for (const modelId of zenModelIds) {
		const devModel = modelsDevData?.models?.[modelId];

		if (devModel) {
			// Enrich with models.dev metadata
			const npmPackage = devModel.provider?.npm;
			const backend = getBackendFromNpmPackage(npmPackage, providerDefaultNpm);

			const input: ("text" | "image")[] = ["text"];
			if (devModel.attachment || devModel.modalities?.includes("image")) {
				input.push("image");
			}

			models.push({
				id: devModel.id || modelId,
				name: devModel.name || modelId,
				backend,
				reasoning: devModel.reasoning ?? false,
				input,
				cost: {
					input: devModel.cost?.input ?? 0,
					output: devModel.cost?.output ?? 0,
					cacheRead: devModel.cost?.cache_read ?? 0,
					cacheWrite: devModel.cost?.cache_write ?? 0,
				},
				contextWindow: devModel.limit?.context ?? 128000,
				maxTokens: devModel.limit?.output ?? 16384,
			});
		} else {
			// Model exists in Zen but not in models.dev - use sensible defaults
			models.push({
				id: modelId,
				name: modelId,
				backend: "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: 128000,
				maxTokens: 16384,
			});
		}
	}

	// Save enriched models to cache
	saveModelsToCache(models);

	// Step 4: Filter to free models if no API key
	if (!hasApiKey) {
		models = models.filter((m) => m.cost.input === 0 && m.cost.output === 0);
	}

	return models;
}

// =============================================================================
// Stream Function
// =============================================================================

const MODEL_MAP = new Map<string, ModelConfig>();

function getStreamFunction(backend: Backend): typeof streamSimpleAnthropic {
	switch (backend) {
		case "anthropic":
			return streamSimpleAnthropic as any;
		case "openai-responses":
			return streamSimpleOpenAIResponses as any;
		case "google":
			return streamSimpleGoogle as any;
		case "openai-completions":
		default:
			return streamSimpleOpenAICompletions as any;
	}
}

export function streamOpenCodeZen(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const apiKey = options?.apiKey;
			const cfg = MODEL_MAP.get(model.id);
			if (!cfg) {
				throw new Error(`Unknown model: ${model.id}`);
			}

			// Check if API key is required for this model
			const isFreeModel = cfg.cost.input === 0 && cfg.cost.output === 0;
			if (!apiKey && !isFreeModel) {
				throw new Error(`No OpenCode API key. Set OPENCODE_API_KEY env var. (This model requires an API key.)`);
			}

			const modelWithBaseUrl = { ...model, baseUrl: ZEN_BASE_URL };
			const streamOptions = { ...options, ...(apiKey ? { apiKey } : {}) };

			// Route to correct backend
			const streamFn = getStreamFunction(cfg.backend);
			const innerStream = streamFn(modelWithBaseUrl as any, context, streamOptions);

			for await (const event of innerStream) {
				stream.push(event);
			}
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// State Management
// =============================================================================

let widgetDismissTimeout: NodeJS.Timeout | null = null;

function clearWidgetNotification(ctx: any) {
	if (widgetDismissTimeout) {
		clearTimeout(widgetDismissTimeout);
		widgetDismissTimeout = null;
	}
	if (ctx?.ui?.setWidget) {
		ctx.ui.setWidget("opencode-zen-info", undefined);
	}
}

function showFreeModelChangeNotification(
	ctx: any,
	added: string[],
	removed: string[],
) {
	if (!ctx?.ui?.setWidget) return;

	const lines: string[] = ["OpenCode Zen: Free model availability changed"];

	if (added.length > 0) {
		lines.push("");
		lines.push("Added:");
		for (const id of added) {
			lines.push(`  + ${id}`);
		}
	}

	if (removed.length > 0) {
		lines.push("");
		lines.push("Removed:");
		for (const id of removed) {
			lines.push(`  - ${id}`);
		}
	}

	lines.push("");
	lines.push("(Dismisses in 10 seconds or on next interaction)");

	ctx.ui.setWidget("opencode-zen-info", lines, { placement: "aboveEditor" });

	// Auto-dismiss after 10 seconds
	if (widgetDismissTimeout) clearTimeout(widgetDismissTimeout);
	widgetDismissTimeout = setTimeout(() => {
		clearWidgetNotification(ctx);
	}, 10000);
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
	// Register extension settings
	pi.events.emit("pi-extension-settings:register", {
		name: "opencode-zen",
		settings: [{
			id: "notify-free-model-changes",
			label: "Free Model Change Notifications",
			description: "Notify when free model availability changes on OpenCode Zen",
			defaultValue: "on",
			values: ["on", "off"],
		}]
	});

	const apiKey = process.env.OPENCODE_API_KEY;
	const hasApiKey = Boolean(apiKey);

	// Fetch models
	let models: ModelConfig[];
	try {
		models = await getModels(hasApiKey);
	} catch (error) {
		console.error("Failed to load OpenCode Zen models:", error);
		return;
	}

	// Populate MODEL_MAP
	MODEL_MAP.clear();
	for (const model of models) {
		MODEL_MAP.set(model.id, model);
	}

	// Track free model changes
	const currentFreeIds = models.filter((m) => m.cost.input === 0 && m.cost.output === 0).map((m) => m.id);
	const previousFreeIds = loadFreeModelIds();
	saveFreeModelIds(currentFreeIds);

	// Calculate free model changes
	const added = currentFreeIds.filter((id) => !previousFreeIds.includes(id));
	const removed = previousFreeIds.filter((id) => !currentFreeIds.includes(id));
	const hasFreeModelChanges = added.length > 0 || removed.length > 0;

	// Register provider
	pi.registerProvider("opencode-zen", {
		baseUrl: ZEN_BASE_URL,
		apiKey: "OPENCODE_API_KEY",
		api: "opencode-zen-api" as Api,
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
		streamSimple: streamOpenCodeZen,
	});

	// Show free model change notification on first interaction (if applicable)
	if (hasFreeModelChanges && getExtensionSetting("opencode-zen", "notify-free-model-changes", "on") === "on") {
		let notificationShown = false;

		pi.on("input", (event, ctx) => {
			if (!notificationShown && ctx.hasUI) {
				showFreeModelChangeNotification(ctx, added, removed);
				notificationShown = true;
			}
		});

		// Also show on session_start if interactive
		pi.on("session_start", (event, ctx) => {
			if (!notificationShown && ctx.hasUI) {
				showFreeModelChangeNotification(ctx, added, removed);
				notificationShown = true;
			}
		});
	}

	// Listen for model selection to detect if selected model disappears
	pi.on("model_select", (event, ctx) => {
		const modelId = event.model.id;
		if (event.model.provider !== "opencode-zen") return;

		if (!MODEL_MAP.has(modelId)) {
			if (ctx.ui?.notify) {
				ctx.ui.notify(`Model ${modelId} is no longer available in OpenCode Zen`, "warning");
			} else {
				console.warn(`Selected model ${modelId} is no longer available in OpenCode Zen`);
			}
		}
	});

	// Dismiss widget on user input
	pi.on("input", (event, ctx) => {
		clearWidgetNotification(ctx);
	});
}

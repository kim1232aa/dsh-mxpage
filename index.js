import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/config.ts
const Config = Schema.object({
	imageBaseUrl: Schema.string().default("https://api.openai.com/v1").description("图像 API 根路径，需含 /v1"),
	imageApiKeyEnv: Schema.string().default("MXPAGE_IMAGE_API_KEY").description("图像 API Key 所在环境变量名，不写明文 key"),
	imageModel: Schema.string().default("gpt-image-2").description("默认图像模型"),
	textBaseUrl: Schema.string().description("可选：独立文本/视觉端点。空则优先 ctx.llm"),
	textApiKeyEnv: Schema.string(),
	textModel: Schema.string(),
	workspaceDir: Schema.string().description("项目根。空则 $DSH_HOME/mxpage/projects"),
	defaultLanguage: Schema.union([
		"zh-CN",
		"en",
		"ja",
		"ko"
	]).default("zh-CN"),
	defaultHeroCount: Schema.number().default(3),
	defaultDetailCount: Schema.number().default(6),
	defaultDetailAspectRatio: Schema.union(["3:4", "9:16"]).default("3:4"),
	timeoutMs: Schema.number().default(18e4),
	analyzeTimeoutMs: Schema.number().default(12e4),
	maxReferenceImages: Schema.number().default(4),
	maxParallelSections: Schema.number().default(2),
	generateAsJob: Schema.boolean().default(true),
	allowSvgFallback: Schema.boolean().default(false)
});
//#endregion
//#region src/util/redact.ts
function redactSecrets(text) {
	return text.replace(/\bsk-\S+/g, "[REDACTED]").replace(/Bearer\s+\S+/g, "Bearer [REDACTED]");
}
const NO_VISION = "当前模型不支持视觉，无法分析商品图";
function extractJsonBlock(raw) {
	const direct = raw.trim();
	if (direct.startsWith("{") || direct.startsWith("[")) return direct;
	const fenced = direct.match(/```json([\s\S]*?)```/i) ?? direct.match(/```([\s\S]*?)```/i);
	if (fenced?.[1]) return fenced[1].trim();
	const first = direct.indexOf("{");
	const last = direct.lastIndexOf("}");
	if (first >= 0 && last > first) return direct.slice(first, last + 1);
	return direct;
}
function failResult(error) {
	return {
		ok: false,
		error: redactSecrets(error)
	};
}
function isAbort$1(err, signal) {
	if (signal?.aborted) return true;
	return Boolean(err && typeof err === "object" && "name" in err && err.name === "AbortError");
}
function llmLooksUsable(llm) {
	if (!llm || typeof llm !== "object") return false;
	return typeof llm.stream === "function";
}
async function llmHasVision(llm, signal) {
	const rec = llm;
	if (typeof rec.listProviders !== "function" || typeof rec.listModels !== "function") return void 0;
	try {
		const providers = rec.listProviders();
		const list = Array.isArray(providers) ? providers : [];
		for (const provider of list) {
			const id = typeof provider === "string" ? provider : provider && typeof provider === "object" && "id" in provider ? String(provider.id) : "";
			if (!id) continue;
			const models = await rec.listModels(id);
			if (!Array.isArray(models)) continue;
			for (const model of models) {
				const modalities = model && typeof model === "object" ? model.inputModalities ?? model.input : void 0;
				if (Array.isArray(modalities) && modalities.includes("image")) return true;
			}
		}
		if (signal?.aborted) return void 0;
		return list.length > 0 ? false : void 0;
	} catch {
		return;
	}
}
function dataUrl(image) {
	return `data:${image.mediaType || "image/png"};base64,${Buffer.from(image.bytes).toString("base64")}`;
}
function asImageMediaType(value) {
	if (value === "image/jpeg" || value === "image/webp" || value === "image/gif" || value === "image/png") return value;
	return "image/png";
}
async function collectStreamText(stream) {
	let text = "";
	let blockText = "";
	for await (const chunk of stream) {
		if (!chunk || typeof chunk !== "object") continue;
		const rec = chunk;
		if (rec.type === "text-delta" && typeof rec.text === "string") text += rec.text;
		if (rec.type === "block-end" && rec.block && typeof rec.block === "object") {
			const block = rec.block;
			if (block.type === "text" && typeof block.text === "string") blockText += block.text;
		}
		if (rec.type === "finish" && rec.reason && typeof rec.reason === "object") {
			const reason = rec.reason;
			if (reason.kind === "error" || reason.kind === "aborted") throw new Error(reason.failure?.message || reason.kind);
		}
	}
	return text || blockText;
}
function firstProvider(llm) {
	const rec = llm;
	if (typeof rec.listProviders !== "function") return void 0;
	try {
		const providers = rec.listProviders();
		if (!Array.isArray(providers) || providers.length === 0) return void 0;
		const first = providers[0];
		if (typeof first === "string") return first;
		if (first && typeof first === "object" && "id" in first) return String(first.id);
	} catch {
		return;
	}
}
function createLlmCompleteJson(llm, saveImage) {
	const rec = llm;
	return async (input) => {
		if (input.signal?.aborted) throw new Error("已取消");
		const images = input.images ?? [];
		if (images.length > 0) {
			if (await llmHasVision(llm, input.signal) === false) return failResult(NO_VISION);
			if (!saveImage) return failResult(NO_VISION);
		}
		const provider = firstProvider(llm) ?? "default";
		let model = input.model;
		if (!model && typeof rec.listModels === "function") try {
			const models = await rec.listModels(provider);
			if (Array.isArray(models) && models.length > 0) {
				const withImage = models.find((item) => {
					const modalities = item && typeof item === "object" ? item.inputModalities : void 0;
					return Array.isArray(modalities) && modalities.includes("image");
				});
				const picked = (images.length ? withImage : void 0) ?? models[0];
				if (picked && typeof picked === "object" && "id" in picked) model = String(picked.id);
			}
		} catch {}
		model = model ?? "default";
		const content = [{
			type: "text",
			text: input.user
		}];
		if (images.length > 0 && saveImage) try {
			for (const image of images) {
				const ref = await saveImage({
					data: image.bytes,
					mediaType: asImageMediaType(image.mediaType),
					name: image.filename
				});
				content.push({
					type: "image",
					attachment: ref
				});
			}
		} catch (err) {
			if (isAbort$1(err, input.signal)) throw new Error("已取消");
			return failResult(err instanceof Error ? err.message : String(err));
		}
		try {
			const text = await collectStreamText(rec.stream({
				provider,
				model,
				system: input.system || "只输出一个 JSON 对象",
				messages: [createUserMessage({
					content,
					source: {
						kind: "plugin",
						plugin: "mxpage"
					}
				})],
				signal: input.signal
			}));
			if (input.signal?.aborted) throw new Error("已取消");
			if (!text.trim()) return failResult(NO_VISION);
			return {
				ok: true,
				text,
				modelUsed: model
			};
		} catch (err) {
			if (isAbort$1(err, input.signal)) throw new Error("已取消");
			return failResult(err instanceof Error ? err.message : String(err));
		}
	};
}
function createHttpCompleteJson(opts) {
	return async (input) => {
		if (input.signal?.aborted) throw new Error("已取消");
		const model = input.model ?? opts.model;
		const userContent = (input.images?.length ?? 0) > 0 ? [{
			type: "text",
			text: input.user
		}, ...(input.images ?? []).map((image) => ({
			type: "image_url",
			image_url: { url: dataUrl(image) }
		}))] : input.user;
		const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
		let res;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${opts.apiKey}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					model,
					temperature: .2,
					messages: [{
						role: "system",
						content: input.system || "只输出一个 JSON 对象"
					}, {
						role: "user",
						content: userContent
					}]
				}),
				signal: input.signal
			});
		} catch (err) {
			if (isAbort$1(err, input.signal)) throw new Error("已取消");
			return failResult(err instanceof Error ? err.message : String(err));
		}
		const body = await res.text().catch(() => "");
		if (!res.ok) return failResult(`文本模型请求失败 (${res.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
		let payload;
		try {
			payload = JSON.parse(body);
		} catch {
			return failResult("文本模型响应无效");
		}
		const content = payload.choices?.[0]?.message?.content;
		const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("") : "";
		if (!text.trim()) return failResult("文本模型返回空数据");
		return {
			ok: true,
			text,
			modelUsed: model
		};
	};
}
function resolveCompleteJson(opts) {
	if (opts.completeJson) return opts.completeJson;
	const http = (() => {
		const baseUrl = opts.config.textBaseUrl?.trim();
		const model = opts.config.textModel?.trim();
		const envName = opts.config.textApiKeyEnv?.trim();
		if (!baseUrl || !model || !envName) return void 0;
		const apiKey = process.env[envName];
		if (!apiKey) return void 0;
		return createHttpCompleteJson({
			baseUrl,
			apiKey,
			model
		});
	})();
	if (llmLooksUsable(opts.llm)) {
		const llmCaller = createLlmCompleteJson(opts.llm, opts.saveImage);
		if (!http) return llmCaller;
		return async (input) => {
			if (input.images && input.images.length > 0) {
				if (await llmHasVision(opts.llm, input.signal) === false) return http(input);
			}
			const result = await llmCaller(input);
			if (!result.ok && http) return http(input);
			return result;
		};
	}
	return http;
}
async function completeValidatedJson(completeJson, opts) {
	const system = opts.system ?? "只输出一个 JSON 对象";
	const tryOnce = async (user) => {
		return completeJson({
			system,
			user,
			images: opts.images,
			signal: opts.signal,
			model: opts.model
		});
	};
	const parseText = (text) => {
		try {
			const json = JSON.parse(extractJsonBlock(text));
			return {
				ok: true,
				value: opts.parse(json)
			};
		} catch (err) {
			return {
				ok: false,
				error: redactSecrets(err instanceof Error ? err.message : String(err))
			};
		}
	};
	const first = await tryOnce(opts.user);
	if (!first.ok) return first;
	const parsed = parseText(first.text);
	if (parsed.ok) return {
		ok: true,
		value: parsed.value,
		modelUsed: first.modelUsed
	};
	const second = await tryOnce(opts.repairUser?.(first.text) ?? `只输出一个 JSON 对象。Repair the following into one JSON object:\n${first.text}`);
	if (!second.ok) return second;
	const repaired = parseText(second.text);
	if (repaired.ok) return {
		ok: true,
		value: repaired.value,
		modelUsed: second.modelUsed
	};
	return {
		ok: false,
		error: repaired.error
	};
}
//#endregion
//#region src/util/paths.ts
function assertInside(root, target) {
	const resolvedRoot = resolve(root);
	const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(resolvedRoot, target);
	const rel = relative(resolvedRoot, resolvedTarget);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes project root: ${target}`);
	return resolvedTarget;
}
//#endregion
//#region src/service/state-machine.ts
const TRANSITIONS = {
	created: ["analyzing", "failed"],
	analyzing: ["analyzed", "failed"],
	analyzed: ["planning", "failed"],
	planning: ["planned", "failed"],
	planned: [
		"planning",
		"generating",
		"editing",
		"failed"
	],
	generating: ["generated", "failed"],
	generated: [
		"editing",
		"generating",
		"failed"
	],
	editing: ["generated", "failed"],
	failed: [
		"analyzing",
		"planning",
		"generating",
		"editing"
	]
};
function assertTransition(from, to) {
	if (!TRANSITIONS[from]?.includes(to)) throw new Error(`illegal status transition: ${from} → ${to}`);
	return to;
}
//#endregion
//#region src/service/project-store.ts
const MAX_ASSETS = 10;
function assertExistingFile(path) {
	if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`image file not found: ${path}`);
}
function uniqueBasename(dir, name) {
	const ext = extname(name);
	const stem = basename(name, ext);
	let candidate = name;
	let n = 1;
	while (existsSync(join(dir, candidate))) {
		candidate = `${stem}-${n}${ext}`;
		n += 1;
	}
	return candidate;
}
function createStore(rootDir) {
	function projectDir(projectId) {
		return assertInside(rootDir, join(rootDir, "projects", projectId));
	}
	function persist(record) {
		const dir = projectDir(record.id);
		const file = assertInside(dir, join(dir, "project.json"));
		writeFileSync(file, JSON.stringify(record, null, 2));
	}
	function copyIntoAssets(dir, absImagePath) {
		assertExistingFile(absImagePath);
		const assetsDir = join(dir, "assets");
		mkdirSync(assetsDir, { recursive: true });
		const dest = assertInside(dir, join(assetsDir, uniqueBasename(assetsDir, basename(absImagePath))));
		copyFileSync(absImagePath, dest);
		return dest;
	}
	function read(projectId) {
		const dir = projectDir(projectId);
		const file = assertInside(dir, join(dir, "project.json"));
		if (!existsSync(file)) throw new Error(`project not found: ${projectId}`);
		return JSON.parse(readFileSync(file, "utf8"));
	}
	function create(input) {
		const imagePaths = input.imagePaths;
		if (!Array.isArray(imagePaths) || imagePaths.length < 1 || imagePaths.length > MAX_ASSETS) throw new Error("imagePaths required (1–10 existing files)");
		for (const src of imagePaths) assertExistingFile(src);
		const mainSrc = resolve(input.mainImagePath ?? imagePaths[0]);
		if (!imagePaths.some((src) => resolve(src) === mainSrc)) throw new Error("mainImagePath is not in imagePaths");
		const id = `mxp_${randomUUID()}`;
		const dir = projectDir(id);
		const assets = [];
		let mainAssetPath = "";
		for (const src of imagePaths) {
			const dest = copyIntoAssets(dir, src);
			const role = resolve(src) === mainSrc ? "main" : "reference";
			assets.push({
				path: dest,
				role
			});
			if (role === "main") mainAssetPath = dest;
		}
		const record = {
			id,
			name: input.name ?? "untitled",
			status: "created",
			language: input.language ?? "zh-CN",
			aspectRatio: input.aspectRatio ?? "3:4",
			mainAssetPath,
			assets,
			workspaceDir: dir
		};
		persist(record);
		return record;
	}
	function addAsset(projectId, absImagePath, role) {
		const rec = read(projectId);
		if (rec.assets.length >= MAX_ASSETS) throw new Error("max 10 assets");
		const dest = copyIntoAssets(projectDir(projectId), absImagePath);
		if (role === "main") {
			for (const asset of rec.assets) if (asset.role === "main") asset.role = "reference";
			rec.mainAssetPath = dest;
		}
		rec.assets.push({
			path: dest,
			role
		});
		persist(rec);
		return rec;
	}
	function write(projectId, patch) {
		const current = read(projectId);
		if (patch.status !== void 0) assertTransition(current.status, patch.status);
		const next = {
			...current,
			...patch,
			id: current.id
		};
		persist(next);
		return next;
	}
	return {
		create,
		addAsset,
		read,
		write,
		projectDir
	};
}
//#endregion
//#region src/tools/add-asset.ts
const ROLES = [
	"main",
	"angle",
	"detail",
	"reference"
];
function addAssetTool(opts) {
	return defineTool({
		name: "mxpage_add_asset",
		description: "Add a product or reference image to an existing mxpage project. Pass image_path. Replacing the main image requires role=main. P1 does not read attachment_id.",
		parameters: {
			project_id: {
				type: "string",
				required: true,
				description: "Existing mxpage project id"
			},
			image_path: {
				type: "string",
				description: "Workspace-relative or absolute image path to copy"
			},
			attachment_id: {
				type: "string",
				description: "Unused in P1; pass image_path instead"
			},
			role: {
				type: "string",
				enum: ROLES,
				required: true,
				description: "Asset role. Use main only when replacing the anchoring product photo."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args) => {
			if (!args.image_path) {
				if (args.attachment_id) return {
					ok: false,
					error: "请提供 image_path（P1 暂不从附件读取）"
				};
				return {
					ok: false,
					error: redactSecrets("请提供 image_path")
				};
			}
			const abs = assertInside(opts.storeRoot, args.image_path);
			const record = opts.store.addAsset(args.project_id, abs, args.role);
			return {
				ok: true,
				projectId: record.id,
				assetCount: record.assets.length,
				mainAssetPath: record.mainAssetPath
			};
		}
	});
}
//#endregion
//#region src/prompts/analysis.ts
const requiredJsonShape = `{
  "productName": "string",
  "category": "string",
  "subcategory": "string",
  "material": "string",
  "color": "string",
  "styleTags": ["string"],
  "targetAudience": ["string"],
  "usageScenarios": ["string"],
  "coreSellingPoints": ["string"],
  "differentiationPoints": ["string"],
  "userConcerns": ["string"],
  "recommendedFocusPoints": ["string"],
  "additionalInformation": "string",
  "generationRequirements": "string",
  "suggestedSectionPlan": [
    {
      "type": "hero | selling_points | scenario | detail_closeup | specs | material | comparison | gift_scene | brand_trust | summary | custom",
      "title": "string",
      "goal": "string"
    }
  ]
}`;
const supportedSectionTypes = [
	"hero",
	"selling_points",
	"scenario",
	"detail_closeup",
	"specs",
	"material",
	"comparison",
	"gift_scene",
	"brand_trust",
	"summary",
	"custom"
].join(", ");
const PHYSICAL_REALISM$1 = [
	"物理真实约束（必须写入 additionalInformation / generationRequirements）：",
	"- 几何不可反转：外形、开口、铰链、层数、部件方向必须与主图一致，禁止镜像错结构。",
	"- 禁止逆风：气流/液体/热量只从真实出口出去，禁止从进风口反向喷出。",
	"- 主体与参考图一致：颜色、材质、比例、可动结构与识别特征锚定主图，禁止换成别的商品。",
	"- 避免乱码文字：后续出图时图内文案必须清晰、拼写正确、无乱码。"
].join("\n");
function buildProductAnalysisPrompt(assets) {
	return [
		"You are a senior e-commerce product strategist and detail-page planner.",
		"只输出一个 JSON 对象。",
		"Analyze the provided product images and asset role hints, then return one strict JSON object only. The main image is the factual source of truth for what the product actually is.",
		"Do not output markdown, code fences, explanations, comments, or extra keys.",
		"Do not infer the product from file names or path strings; only use the attached images and role hints.",
		"All copy values should be written in Simplified Chinese.",
		"If some attributes are uncertain, infer the most likely answer from the images and keep the field non-empty. Do not misclassify the product by overfitting to props, rulers, labels, packaging, or background objects.",
		"",
		"Available assets (roles only, not file names):",
		assets.map((asset, index) => `${index + 1}. role=${asset.role}; isMain=${asset.isMain ? "yes" : "no"}`).join("\n") || "No uploaded assets.",
		"",
		"Required rules:",
		"1. Every required key must exist.",
		"2. Every array field must be an array of short Chinese strings.",
		"3. suggestedSectionPlan must contain at least 6 sections.",
		`4. suggestedSectionPlan.type must be one of: ${supportedSectionTypes}.`,
		"5. Focus on e-commerce conversion, visual hierarchy, and section planning, but every section must fit the real product category and mechanics shown in the main image.",
		"6. First identify the exact product object, its category, visual structure, count of repeated parts, operation/mechanism, and what it must never be mistaken for. Put this into additionalInformation.",
		"7. For puzzle cubes / speed cubes / Rubik-like cubes, explicitly capture: cube order such as 3x3x3 if visible, six colored faces, corner/edge/center pieces, twistable layers, seams, tile/sticker style, size if inferable, target users, and avoid treating it as a sticker craft, ruler, storage box, electronics product, or generic block.",
		"8. additionalInformation must summarize important extra facts for generation, especially product dimensions if visible or inferable. Include placeholders for unknown but required facts: size, weight/capacity/power, compatible specifications, package contents, usage constraints, and safety notes.",
		"",
		PHYSICAL_REALISM$1,
		"",
		"Return exactly this JSON shape:",
		requiredJsonShape
	].join("\n");
}
function buildProductAnalysisRepairPrompt(raw) {
	return [
		"You repair malformed product-analysis output into one strict JSON object.",
		"只输出一个 JSON 对象。",
		"Return JSON only. No markdown, no explanations, no extra keys.",
		"All string values should be in Simplified Chinese when possible.",
		"If a field is missing, infer a reasonable non-empty value from the source content.",
		"If suggestedSectionPlan is missing or too short, create at least 6 valid sections.",
		"If additionalInformation is missing, create a concise Chinese checklist covering size, weight/capacity/power, compatible specifications, package contents, usage constraints, and safety notes. Mark uncertain values as 待用户补充 instead of inventing exact numbers.",
		`Valid section types: ${supportedSectionTypes}.`,
		PHYSICAL_REALISM$1,
		"",
		"Target JSON shape:",
		requiredJsonShape,
		"",
		"Source content to repair:",
		raw
	].join("\n");
}
//#endregion
//#region src/schemas/product-analysis.ts
function asRecord$2(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid analysis: expected object");
	return value;
}
function requiredString(obj, key) {
	const value = obj[key];
	if (typeof value !== "string" || value.trim() === "") throw new Error(`invalid analysis: missing ${key}`);
	return value;
}
function optionalString$1(obj, key) {
	const value = obj[key];
	if (value === void 0 || value === null) return "";
	if (typeof value !== "string") throw new Error(`invalid analysis: missing ${key}`);
	return value;
}
function stringArray(obj, key) {
	const value = obj[key];
	if (!Array.isArray(value)) throw new Error(`invalid analysis: missing ${key}`);
	return value.map((item) => String(item));
}
function parseSuggested(value) {
	if (!Array.isArray(value)) throw new Error("invalid analysis: missing suggestedSectionPlan");
	return value.map((item) => {
		const rec = asRecord$2(item);
		return {
			type: requiredString(rec, "type"),
			title: requiredString(rec, "title"),
			goal: requiredString(rec, "goal")
		};
	});
}
function parseProductAnalysis(value) {
	const obj = asRecord$2(value);
	return {
		productName: requiredString(obj, "productName"),
		category: requiredString(obj, "category"),
		subcategory: requiredString(obj, "subcategory"),
		material: requiredString(obj, "material"),
		color: requiredString(obj, "color"),
		styleTags: stringArray(obj, "styleTags"),
		targetAudience: stringArray(obj, "targetAudience"),
		usageScenarios: stringArray(obj, "usageScenarios"),
		coreSellingPoints: stringArray(obj, "coreSellingPoints"),
		differentiationPoints: stringArray(obj, "differentiationPoints"),
		userConcerns: stringArray(obj, "userConcerns"),
		recommendedFocusPoints: stringArray(obj, "recommendedFocusPoints"),
		additionalInformation: optionalString$1(obj, "additionalInformation"),
		generationRequirements: optionalString$1(obj, "generationRequirements"),
		suggestedSectionPlan: parseSuggested(obj.suggestedSectionPlan)
	};
}
function fail$4(message) {
	throw new Error(redactSecrets(message));
}
function readU32BE(bytes, offset) {
	return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}
function parsePngSize(bytes) {
	if (bytes.length < 24) return null;
	const sig = [
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	];
	for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
	if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return null;
	return {
		width: readU32BE(bytes, 16),
		height: readU32BE(bytes, 20)
	};
}
function parseJpegSize(bytes) {
	if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
	let i = 2;
	while (i < bytes.length - 8) {
		if (bytes[i] !== 255) {
			i += 1;
			continue;
		}
		const marker = bytes[i + 1];
		if (marker === 255) {
			i += 1;
			continue;
		}
		if (marker >= 192 && marker <= 195 || marker >= 197 && marker <= 199 || marker >= 201 && marker <= 203 || marker >= 205 && marker <= 207) {
			const height = bytes[i + 5] << 8 | bytes[i + 6];
			return {
				width: bytes[i + 7] << 8 | bytes[i + 8],
				height
			};
		}
		if (marker === 216 || marker === 217 || marker === 1 || marker >= 208 && marker <= 215) {
			i += 2;
			continue;
		}
		if (i + 3 >= bytes.length) return null;
		const length = bytes[i + 2] << 8 | bytes[i + 3];
		if (length < 2) return null;
		i += 2 + length;
	}
	return null;
}
function readImageFile(absPath) {
	if (statSync(absPath).size > 20971520) fail$4("image exceeds 20MiB");
	const bytes = new Uint8Array(readFileSync(absPath));
	if (bytes.byteLength > 20971520) fail$4("image exceeds 20MiB");
	const png = parsePngSize(bytes);
	if (png) {
		if (png.width > 8192 || png.height > 8192) fail$4("image edge exceeds 8192");
		return {
			bytes,
			mediaType: "image/png"
		};
	}
	const jpeg = parseJpegSize(bytes);
	if (jpeg) {
		if (jpeg.width > 8192 || jpeg.height > 8192) fail$4("image edge exceeds 8192");
		return {
			bytes,
			mediaType: "image/jpeg"
		};
	}
	fail$4("unsupported image format");
}
//#endregion
//#region src/pipeline/analyze.ts
function fail$3(error) {
	return {
		ok: false,
		error: redactSecrets(error)
	};
}
function readAnalysisFile(projectDir) {
	const file = assertInside(projectDir, join(projectDir, "analysis.json"));
	if (!existsSync(file)) return void 0;
	try {
		return parseProductAnalysis(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return;
	}
}
function loadProjectImages(record) {
	const ordered = [...record.assets.filter((asset) => asset.path === record.mainAssetPath || asset.role === "main"), ...record.assets.filter((asset) => asset.path !== record.mainAssetPath && asset.role !== "main")];
	const seen = /* @__PURE__ */ new Set();
	const images = [];
	for (const asset of ordered) {
		if (seen.has(asset.path)) continue;
		seen.add(asset.path);
		if (!existsSync(asset.path)) continue;
		try {
			images.push(readImageFile(asset.path));
		} catch {
			continue;
		}
		if (images.length >= 10) break;
	}
	return images;
}
function markFailed$1(store, projectId) {
	try {
		store.write(projectId, { status: "failed" });
	} catch {}
}
async function analyzeProduct(deps, args, signal) {
	const record = deps.store.read(args.projectId);
	if (signal.aborted) throw new Error("已取消");
	if (!deps.completeJson) return fail$3(NO_VISION);
	const status = record.status;
	if (status !== "created" && status !== "failed" && status !== "analyzing") return fail$3("MXPAGE_STATE");
	if (status === "created" || status === "failed") try {
		deps.store.write(record.id, { status: "analyzing" });
	} catch {
		return fail$3("MXPAGE_STATE");
	}
	try {
		const images = loadProjectImages(record);
		if (images.length === 0) {
			markFailed$1(deps.store, record.id);
			return fail$3(NO_VISION);
		}
		const user = buildProductAnalysisPrompt(record.assets.map((asset) => ({
			role: asset.role,
			isMain: asset.role === "main" || asset.path === record.mainAssetPath
		})));
		const result = await completeValidatedJson(deps.completeJson, {
			user,
			images,
			parse: parseProductAnalysis,
			repairUser: buildProductAnalysisRepairPrompt,
			signal,
			model: args.model
		});
		if (!result.ok) {
			markFailed$1(deps.store, record.id);
			return fail$3(result.error);
		}
		const analysisPath = assertInside(record.workspaceDir, join(record.workspaceDir, "analysis.json"));
		writeFileSync(analysisPath, JSON.stringify(result.value, null, 2));
		deps.store.write(record.id, { status: "analyzed" });
		return {
			ok: true,
			projectId: record.id,
			modelUsed: result.modelUsed,
			analysis: result.value
		};
	} catch (err) {
		if (signal.aborted || err instanceof Error && err.message === "已取消") throw err instanceof Error ? err : /* @__PURE__ */ new Error("已取消");
		markFailed$1(deps.store, record.id);
		return fail$3(err instanceof Error ? err.message : String(err));
	}
}
//#endregion
//#region src/tools/analyze.ts
function analyzeProductTool(opts) {
	return defineTool({
		name: "mxpage_analyze_product",
		description: "Analyze product photos into structured selling-point JSON. Writes analysis.json. Requires vision (ctx.llm with image input, or Config textBaseUrl + textModel). Transitions created|failed → analyzing → analyzed.",
		parameters: {
			project_id: {
				type: "string",
				required: true,
				description: "Existing mxpage project id"
			},
			model: {
				type: "string",
				description: "Optional text/vision model override"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		timeoutMs: 12e4,
		execute: async (args, exec) => {
			return analyzeProduct({
				store: opts.store,
				completeJson: opts.completeJson
			}, {
				projectId: args.project_id,
				model: args.model
			}, exec.signal);
		}
	});
}
//#endregion
//#region src/tools/create-project.ts
const LANGUAGES$1 = [
	"zh-CN",
	"en",
	"ja",
	"ko"
];
const ASPECT_RATIOS = [
	"1:1",
	"3:4",
	"9:16"
];
function createProjectTool(opts) {
	return defineTool({
		name: "mxpage_create_project",
		description: "Create an mxpage project and copy product photos into assets/ (does not move sources). Call this before generate_section. image_paths are workspace-relative or absolute, 1–10 files.",
		parameters: {
			name: {
				type: "string",
				description: "Project display name; default untitled"
			},
			image_paths: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Product image paths (1–10). Copied into the project; sources are left in place."
			},
			main_image_path: {
				type: "string",
				description: "Main product image; default first image_paths entry"
			},
			language: {
				type: "string",
				enum: LANGUAGES$1,
				description: "Content language"
			},
			aspect_ratio: {
				type: "string",
				enum: ASPECT_RATIOS,
				description: "Default detail aspect ratio"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args) => {
			const imagePaths = args.image_paths.map((path) => assertInside(opts.storeRoot, path));
			const mainImagePath = args.main_image_path === void 0 ? void 0 : assertInside(opts.storeRoot, args.main_image_path);
			const record = opts.store.create({
				name: args.name,
				imagePaths,
				mainImagePath,
				language: args.language ?? opts.config.defaultLanguage,
				aspectRatio: args.aspect_ratio
			});
			return {
				ok: true,
				projectId: record.id,
				assetCount: record.assets.length,
				mainAssetPath: record.mainAssetPath,
				workspaceDir: record.workspaceDir
			};
		}
	});
}
//#endregion
//#region src/prompts/planning.ts
const sectionTypeGuide = [
	"hero=头图主视觉",
	"selling_points=卖点模块",
	"scenario=场景展示",
	"detail_closeup=细节特写",
	"specs=规格参数",
	"material=材质工艺",
	"comparison=对比说明",
	"gift_scene=送礼场景",
	"brand_trust=品牌信任",
	"summary=总结收口",
	"custom=自定义模块"
].join(", ");
const platformLabels = {
	ecommerce: "通用电商",
	xiaohongshu: "小红书"
};
const styleLabels = {
	generic_clean: "通用简洁",
	premium: "高级质感",
	soft_lifestyle: "柔和生活方式",
	conversion_focused: "转化导向",
	tech: "科技感"
};
const languageNames = {
	"zh-CN": "Simplified Chinese",
	en: "English",
	ja: "Japanese",
	ko: "Korean"
};
const PHYSICAL_REALISM = [
	"Physical realism and product-specific constraints:",
	"- 几何不可反转：外形、开口、铰链、层数、部件方向必须正确，禁止镜像错结构。",
	"- 禁止逆风：气流/液体/热量只从真实出口出去，禁止从进风口或反向喷出。",
	"- 主体与参考图一致：颜色、材质、比例、可动结构与识别特征锚定主图，禁止换成别的商品。",
	"- 避免乱码文字：图内文案必须清晰、拼写正确、无乱码、无重复叠字。",
	"- Before writing any visualPrompt, infer how this exact product works physically: inlet/outlet direction, cable/plug position, seams, openings, hinges, buttons, handles, fluid direction, airflow direction, support points, gravity, shadows, and how a hand would hold or use it.",
	"- Every section must include product-specific negative constraints in visualPrompt: state what must NOT happen for this product.",
	"- Avoid impossible physics: floating products without support, cables merging into surfaces, reversed airflow, liquids flowing upward, disconnected shadows, impossible reflections, text wrapped through objects, hands gripping through solid parts, and product parts bending in ways the real material cannot."
].join("\n");
function buildSectionPlanningPrompt(analysis, options) {
	const style = options.style ?? "premium";
	const platform = options.platform ?? "ecommerce";
	const language = options.language ?? "zh-CN";
	const styleLabel = styleLabels[style] ?? style;
	const platformLabel = platformLabels[platform] ?? platform;
	const targetLanguage = languageNames[language] ?? languageNames["zh-CN"];
	const heroImageCount = options.heroCount;
	const detailSectionCount = options.detailCount;
	const planningContext = {
		productName: analysis.productName,
		category: analysis.category,
		subcategory: analysis.subcategory,
		material: analysis.material,
		color: analysis.color,
		styleTags: analysis.styleTags.slice(0, 8),
		targetAudience: analysis.targetAudience.slice(0, 6),
		usageScenarios: analysis.usageScenarios.slice(0, 6),
		coreSellingPoints: analysis.coreSellingPoints.slice(0, 8),
		differentiationPoints: analysis.differentiationPoints.slice(0, 6),
		userConcerns: analysis.userConcerns.slice(0, 6),
		recommendedFocusPoints: analysis.recommendedFocusPoints.slice(0, 8),
		additionalInformation: analysis.additionalInformation,
		generationRequirements: analysis.generationRequirements,
		suggestedSectionPlan: analysis.suggestedSectionPlan.slice(0, 8)
	};
	return [
		"You are a senior e-commerce content strategist and mobile detail-page planner.",
		"只输出一个 JSON 对象。",
		`Platform: ${platformLabel}`,
		`Style: ${styleLabel}`,
		`Target content language: ${targetLanguage}`,
		"Create a mobile product-detail section plan based on the planning context below.",
		"Return strict JSON only.",
		"First define one project-level visualStyleGuide, then create all sections under that same visual system.",
		"visualStyleGuide must include: styleName, colorPalette, backgroundSystem, lighting, cameraLanguage, typography, layoutRules, propRules, productRenderingRules, negativeStyleConstraints.",
		"The visualStyleGuide is the source of truth for visual consistency across hero images and detail-page images.",
		"Before writing sections, reason from the product analysis as the source of truth: exact product category, visible geometry, mechanism, repeated-part count, materials, colors, size/spec facts, and what the product must not be mistaken for.",
		"Do not create generic manufacturing, craft, measuring-ruler, sticker-sheet, electronics, storage-box, appliance, or unrelated sections unless the product analysis clearly supports them.",
		"For puzzle cubes / speed cubes / Rubik-like cubes, the detail page should explain cube order, turning feel, layer seams, corner/edge/center pieces, color recognition, grip, stability, suitable users, package contents and real dimensions; avoid claiming unrelated sticker cutting, ruler measurement props, batteries, cables, airflow, screens, or appliance functions.",
		`The output must contain exactly ${heroImageCount + detailSectionCount} sections in total.`,
		`You must create exactly ${heroImageCount} hero sections and exactly ${detailSectionCount} non-hero detail sections.`,
		"All hero sections must come first in the output array.",
		`Hero sections represent individual square hero gallery images, so each hero section must have a distinct first-screen communication role across these ${heroImageCount} angles.`,
		"The hero sections should cover different roles such as primary visual, core selling point, scenario mood, trust, and differentiation without repeating the same purpose.",
		"For each hero section, describe a different concrete picture: camera angle, crop, product placement, scene/background, props, lighting, in-image title position, selling-point callouts, CTA placement, and what exact product feature is visible.",
		"Hero section visualPrompts must not reuse the same generic sentence. Each one needs at least 3 concrete visual details unique to that image.",
		"If generationRequirements is provided, treat it as a hard creative brief. Convert requirements such as multi-angle, multi-scene, and different usage methods into distinct hero/detail sections and concrete visualPrompt instructions.",
		"Do not merely repeat generationRequirements as generic text; operationalize it through camera angles, scenes, props, product interaction modes, section goals, and in-image copy.",
		"All non-hero sections must come after the hero sections.",
		"Each section item must include: id, type, title, goal, copy, visualPrompt, editableFields.",
		"Each section.visualPrompt must explicitly cite how it follows the shared visualStyleGuide: same palette, background system, lighting, typography, CTA style, safe margins, product rendering rules, and negative constraints.",
		`All user-facing section titles, goals, copy, and in-image text instructions must be written in ${targetLanguage}.`,
		"visualPrompt must use this exact two-part format:",
		`Primary Prompt: <visual direction in ${targetLanguage}>`,
		"English Prompt: <English image prompt>",
		"The visualPrompt must explicitly require the image model to generate the marketing title, selling points, supporting copy, and CTA directly inside the image, instead of relying on external DOM text.",
		`Allowed section types: ${sectionTypeGuide}`,
		"editableFields should include at least one of: sellingPoints, tone, compositionHint.",
		"editableFields must also include styleRole, sharedStyleAnchors, and localVariation. styleRole describes this section role inside the shared visual system. sharedStyleAnchors lists the visual elements that must remain identical with the rest of the project. localVariation describes what can change only in this one image.",
		"editableFields should also include negativeConstraints as an array of product-specific impossible or undesirable visual outcomes.",
		"Avoid duplicate section goals and avoid repeating the same section type excessively.",
		"The section flow should feel commercially complete and conversion-oriented.",
		"",
		"Return exactly this JSON shape:",
		`{
  "visualStyleGuide": {
    "styleName": "string",
    "colorPalette": "string",
    "backgroundSystem": "string",
    "lighting": "string",
    "cameraLanguage": "string",
    "typography": "string",
    "layoutRules": "string",
    "propRules": "string",
    "productRenderingRules": "string",
    "negativeStyleConstraints": "string"
  },
  "sections": [
    {
      "id": "string",
      "type": "hero | selling_points | scenario | detail_closeup | specs | material | comparison | gift_scene | brand_trust | summary | custom",
      "title": "string",
      "goal": "string",
      "copy": "string",
      "visualPrompt": "Primary Prompt: ...\\nEnglish Prompt: ...",
      "editableFields": {
        "styleRole": "string",
        "sharedStyleAnchors": ["string"],
        "localVariation": "string",
        "negativeConstraints": ["string"]
      }
    }
  ]
}`,
		"",
		PHYSICAL_REALISM,
		"",
		"Planning context:",
		JSON.stringify(planningContext, null, 2)
	].join("\n");
}
const SECTION_TYPE_SET = /* @__PURE__ */ new Set([
	"hero",
	"selling_points",
	"scenario",
	"detail_closeup",
	"specs",
	"material",
	"comparison",
	"gift_scene",
	"brand_trust",
	"summary",
	"custom"
]);
const STYLE_KEYS = [
	"styleName",
	"colorPalette",
	"backgroundSystem",
	"lighting",
	"cameraLanguage",
	"typography",
	"layoutRules",
	"propRules",
	"productRenderingRules",
	"negativeStyleConstraints"
];
function asRecord$1(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
	return value;
}
function str(value) {
	return typeof value === "string" ? value : value == null ? "" : String(value);
}
function parseType(value) {
	const normalized = str(value).trim().toLowerCase();
	if (SECTION_TYPE_SET.has(normalized)) return normalized;
	return "custom";
}
function parseVisualStyleGuide(value) {
	const rec = asRecord$1(value) ?? {};
	const guide = {};
	for (const key of STYLE_KEYS) guide[key] = str(rec[key]);
	return guide;
}
function parseSection(value) {
	const rec = asRecord$1(value) ?? {};
	const editable = asRecord$1(rec.editableFields) ?? {};
	return {
		id: str(rec.id),
		type: parseType(rec.type),
		title: str(rec.title),
		goal: str(rec.goal),
		copy: str(rec.copy),
		visualPrompt: str(rec.visualPrompt),
		editableFields: { ...editable }
	};
}
function unwrap(value) {
	if (Array.isArray(value)) return {
		visualStyleGuide: void 0,
		sections: value
	};
	const rec = asRecord$1(value);
	if (!rec) throw new Error("invalid section plan: expected object");
	if (Array.isArray(rec.sections) || rec.visualStyleGuide !== void 0) return {
		visualStyleGuide: rec.visualStyleGuide,
		sections: rec.sections
	};
	const data = asRecord$1(rec.data);
	if (data && (Array.isArray(data.sections) || data.visualStyleGuide !== void 0)) return {
		visualStyleGuide: data.visualStyleGuide,
		sections: data.sections
	};
	const result = asRecord$1(rec.result);
	if (result && (Array.isArray(result.sections) || result.visualStyleGuide !== void 0)) return {
		visualStyleGuide: result.visualStyleGuide,
		sections: result.sections
	};
	throw new Error("invalid section plan: missing sections");
}
function parseSectionPlan(value) {
	const raw = unwrap(value);
	if (!Array.isArray(raw.sections)) throw new Error("invalid section plan: missing sections");
	return {
		visualStyleGuide: parseVisualStyleGuide(raw.visualStyleGuide),
		sections: raw.sections.map(parseSection)
	};
}
//#endregion
//#region src/pipeline/plan.ts
function fail$2(error) {
	return {
		ok: false,
		error: redactSecrets(error)
	};
}
function clamp(value, min, max, fallback) {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}
function normalizeSections(plan) {
	const heroes = plan.sections.filter((section) => section.type === "hero");
	const details = plan.sections.filter((section) => section.type !== "hero");
	return [...heroes.map((section, index) => ({
		sectionKey: `hero_${String(index + 1).padStart(2, "0")}`,
		type: "hero",
		title: section.title || `头图${index + 1}`,
		goal: section.goal,
		copy: section.copy,
		visualPrompt: section.visualPrompt,
		editableFields: section.editableFields,
		order: index
	})), ...details.map((section, index) => ({
		sectionKey: `detail_${String(index + 1).padStart(2, "0")}_${section.type}`,
		type: section.type,
		title: section.title || `详情${index + 1}`,
		goal: section.goal,
		copy: section.copy,
		visualPrompt: section.visualPrompt,
		editableFields: section.editableFields,
		order: heroes.length + index
	}))];
}
function readPlanFile(projectDir) {
	const file = assertInside(projectDir, join(projectDir, "plan.json"));
	if (!existsSync(file)) return void 0;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		const sections = Array.isArray(raw.sections) ? raw.sections : [];
		return {
			visualStyleGuide: parseVisualStyleGuide(raw.visualStyleGuide),
			sections,
			previewConfig: raw.previewConfig
		};
	} catch {
		return;
	}
}
function readStyleGuideFile(projectDir) {
	const file = assertInside(projectDir, join(projectDir, "style-guide.json"));
	if (!existsSync(file)) return void 0;
	try {
		return parseVisualStyleGuide(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return;
	}
}
function markFailed(store, projectId) {
	try {
		store.write(projectId, { status: "failed" });
	} catch {}
}
async function planPage(deps, args, signal) {
	const record = deps.store.read(args.projectId);
	if (signal.aborted) throw new Error("已取消");
	if (record.status !== "analyzed" && record.status !== "planned") return fail$2("MXPAGE_STATE");
	if (!deps.completeJson) return fail$2(NO_VISION);
	const analysis = readAnalysisFile(record.workspaceDir);
	if (!analysis) return fail$2("MXPAGE_STATE");
	const heroCount = clamp(args.heroCount, 1, 5, deps.config.defaultHeroCount);
	const detailCount = clamp(args.detailCount, 1, 10, deps.config.defaultDetailCount);
	const platform = args.platform === "xiaohongshu" ? "xiaohongshu" : "ecommerce";
	const language = args.language ?? record.language;
	const detailAspect = record.aspectRatio === "9:16" ? "9:16" : record.aspectRatio === "3:4" ? "3:4" : deps.config.defaultDetailAspectRatio;
	try {
		deps.store.write(record.id, { status: "planning" });
	} catch {
		return fail$2("MXPAGE_STATE");
	}
	try {
		const user = buildSectionPlanningPrompt(analysis, {
			platform,
			heroCount,
			detailCount,
			language
		});
		const result = await completeValidatedJson(deps.completeJson, {
			user,
			images: loadProjectImages(record).slice(0, 3),
			parse: parseSectionPlan,
			repairUser: (raw) => `只输出一个 JSON 对象。Repair this section plan JSON:\n${raw}`,
			signal
		});
		if (!result.ok) {
			markFailed(deps.store, record.id);
			return fail$2(result.error);
		}
		const sections = normalizeSections(result.value);
		const visualStyleGuide = result.value.visualStyleGuide;
		const previewConfig = {
			heroImageCount: heroCount,
			detailSectionCount: detailCount,
			imageAspectRatio: detailAspect,
			contentLanguage: language
		};
		const planPath = assertInside(record.workspaceDir, join(record.workspaceDir, "plan.json"));
		const stylePath = assertInside(record.workspaceDir, join(record.workspaceDir, "style-guide.json"));
		writeFileSync(planPath, JSON.stringify({
			visualStyleGuide,
			sections,
			previewConfig
		}, null, 2));
		writeFileSync(stylePath, JSON.stringify(visualStyleGuide, null, 2));
		deps.store.write(record.id, { status: "planned" });
		return {
			ok: true,
			visualStyleGuide,
			sections,
			previewConfig
		};
	} catch (err) {
		if (signal.aborted || err instanceof Error && err.message === "已取消") throw err instanceof Error ? err : /* @__PURE__ */ new Error("已取消");
		markFailed(deps.store, record.id);
		return fail$2(err instanceof Error ? err.message : String(err));
	}
}
//#endregion
//#region src/prompts/visual-prompt-agent.ts
const STYLE_LABELS = {
	styleName: "风格名称",
	colorPalette: "主色 / 辅助色",
	backgroundSystem: "背景系统",
	lighting: "光线方向",
	cameraLanguage: "镜头语言",
	typography: "字体气质",
	layoutRules: "版式密度",
	propRules: "道具规则",
	productRenderingRules: "商品表现规则",
	negativeStyleConstraints: "负面约束"
};
function styleGuideToPrompt(guide) {
	return Object.keys(STYLE_LABELS).map((key) => `${STYLE_LABELS[key]}: ${guide[key]}`).join("\n");
}
function summarizeReferences(input) {
	const roles = input.referenceRoles ?? [];
	if (roles.length === 0) return "No reference images.";
	return `Reference roles: ${roles.map((item) => `${item.role}${item.isMain ? " (main product)" : ""}`).join(" / ")}`;
}
function buildVisualPromptAgentPrompt(input) {
	return [
		"You are the system-level Visual Prompt Agent for an AI commerce design workflow.",
		"只输出一个 JSON 对象。",
		"Your job is to analyze the task before image generation and write a detailed final prompt for the image model.",
		"Return strict JSON only. No markdown.",
		"",
		input.mode === "xiaohongshu_page" ? `Create a production-grade prompt for one Xiaohongshu ${input.aspectRatio} carousel image.` : input.mode === "image_edit" ? "Create a production-grade prompt for editing an existing image while preserving identity and composition continuity." : "Create a production-grade prompt for one e-commerce product detail page image.",
		"",
		"The finalPrompt must be detailed and directly usable by an image generation/editing model.",
		"It must include:",
		"- business objective and target audience",
		"- canvas aspect ratio and crop",
		"- product/subject identity rules from reference images, especially the main product image as the non-negotiable source of truth",
		"- foreground, middle ground, background, props, scene, camera angle, product placement",
		"- lighting, material texture, color palette, depth, shadows and reflections",
		"- in-image typography: title position, hierarchy, copy blocks, CTA/badges, safe margins",
		"- product-specific physical rules and impossible phenomena to avoid",
		"- final quality bar for a polished Xiaohongshu/e-commerce visual",
		"- if a project-level visual style guide is provided, repeat and obey it as the highest-priority visual consistency contract",
		"",
		"Important constraints:",
		"- 几何不可反转：外形、开口、铰链、层数、部件方向必须正确，禁止镜像错结构。",
		"- 禁止逆风：气流/液体/热量只从真实出口出去，禁止从进风口或反向喷出。",
		"- 主体与参考图一致：Preserve the product/object identity from reference images. Do not invent a different product.",
		"- 避免乱码文字：All visible text must be clear, correctly spelled, and in the target content language.",
		"- Do not create category mistakes or impossible mechanics: no reversed airflow, cables entering furniture, floating unsupported objects, liquid flowing upward, broken shadows, impossible reflections, wrong hinges/openings, wrong cube layer count, wrong tile grid, wrong corner/edge/center structure, or hands passing through objects.",
		"- Avoid vague words alone. Make every visual choice concrete.",
		"- For e-commerce sections, hero images and detail images must look like one cohesive commercial page.",
		"- If reference images are attached, analyze them as geometry/style references, but do not describe them as \"uploaded image\" inside the final artwork.",
		"- Do not infer the product from file names.",
		"",
		"Task context:",
		JSON.stringify({
			mode: input.mode,
			title: input.title,
			goal: input.goal,
			copy: input.copy,
			basePrompt: input.basePrompt,
			aspectRatio: input.aspectRatio,
			contentLanguage: input.contentLanguage ?? "zh-CN",
			references: summarizeReferences(input),
			productContext: input.productContext ?? null,
			visualStyleGuide: input.visualStyleGuide ? styleGuideToPrompt(input.visualStyleGuide) : null
		}, null, 2),
		"",
		"Return this JSON shape:",
		`{
  "analysisSummary": "short analysis of the image strategy",
  "finalPrompt": "long detailed prompt for the image model",
  "negativePrompt": "what must not appear",
  "qualityChecklist": ["check 1", "check 2", "check 3"]
}`
	].join("\n");
}
function buildVisualPromptRepairPrompt(raw) {
	return [
		"You repair malformed visual-prompt-agent output into one strict JSON object.",
		"只输出一个 JSON 对象。",
		"finalPrompt must be at least 20 characters.",
		"几何不可反转、禁止逆风、主体与参考图一致、避免乱码文字。",
		"Target JSON shape:",
		`{
  "analysisSummary": "string",
  "finalPrompt": "string min 20 chars",
  "negativePrompt": "string",
  "qualityChecklist": ["string"]
}`,
		"",
		"Source content to repair:",
		raw
	].join("\n");
}
//#endregion
//#region src/schemas/visual-prompt.ts
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid visual prompt: expected object");
	return value;
}
function optionalString(obj, key) {
	const value = obj[key];
	if (value === void 0 || value === null) return "";
	if (typeof value !== "string") throw new Error(`invalid visual prompt: missing ${key}`);
	return value;
}
function parseVisualPrompt(value) {
	const obj = asRecord(value);
	const finalPrompt = obj.finalPrompt;
	if (typeof finalPrompt !== "string" || finalPrompt.trim().length < 20) throw new Error("invalid visual prompt: finalPrompt");
	const checklist = obj.qualityChecklist;
	if (checklist !== void 0 && !Array.isArray(checklist)) throw new Error("invalid visual prompt: qualityChecklist");
	return {
		analysisSummary: optionalString(obj, "analysisSummary"),
		finalPrompt,
		negativePrompt: optionalString(obj, "negativePrompt"),
		qualityChecklist: Array.isArray(checklist) ? checklist.map((item) => String(item)) : []
	};
}
//#endregion
//#region src/pipeline/visual-prompt.ts
function fail$1(error) {
	return {
		ok: false,
		error: redactSecrets(error)
	};
}
function syntheticSection(sectionKey, productName) {
	const isHero = /^hero_/i.test(sectionKey);
	return {
		sectionKey,
		type: isHero ? "hero" : "custom",
		title: productName || sectionKey,
		goal: isHero ? "建立第一眼商品记忆点" : "展示该模块的核心卖点",
		copy: "",
		visualPrompt: "",
		editableFields: {},
		order: 0
	};
}
async function refinePrompt(deps, args, signal) {
	const record = deps.store.read(args.projectId);
	if (signal.aborted) throw new Error("已取消");
	if (!deps.completeJson) return fail$1(NO_VISION);
	const analysis = readAnalysisFile(record.workspaceDir);
	if (!analysis) return fail$1("MXPAGE_STATE");
	const plan = readPlanFile(record.workspaceDir);
	const styleGuide = readStyleGuideFile(record.workspaceDir) ?? plan?.visualStyleGuide;
	const section = plan?.sections.find((item) => item.sectionKey === args.sectionKey) ?? syntheticSection(args.sectionKey, analysis.productName);
	const aspectRatio = section.type === "hero" ? "1:1" : record.aspectRatio === "9:16" ? "9:16" : "3:4";
	const mode = args.mode ?? "ecommerce_section";
	try {
		const user = buildVisualPromptAgentPrompt({
			mode,
			title: section.title,
			goal: section.goal,
			copy: section.copy,
			basePrompt: section.visualPrompt,
			aspectRatio,
			contentLanguage: record.language,
			referenceRoles: record.assets.map((asset) => ({
				role: asset.role,
				isMain: asset.role === "main" || asset.path === record.mainAssetPath
			})),
			productContext: analysis,
			visualStyleGuide: styleGuide
		});
		const result = await completeValidatedJson(deps.completeJson, {
			user,
			images: loadProjectImages(record).slice(0, 3),
			parse: parseVisualPrompt,
			repairUser: buildVisualPromptRepairPrompt,
			signal
		});
		if (!result.ok) return fail$1(result.error);
		const dir = assertInside(record.workspaceDir, join(record.workspaceDir, "prompts"));
		mkdirSync(dir, { recursive: true });
		const file = assertInside(record.workspaceDir, join(dir, `${args.sectionKey}.json`));
		const payload = result.value;
		writeFileSync(file, JSON.stringify(payload, null, 2));
		return {
			ok: true,
			analysisSummary: payload.analysisSummary,
			finalPrompt: payload.finalPrompt,
			negativePrompt: payload.negativePrompt,
			qualityChecklist: payload.qualityChecklist
		};
	} catch (err) {
		if (signal.aborted || err instanceof Error && err.message === "已取消") throw err instanceof Error ? err : /* @__PURE__ */ new Error("已取消");
		return fail$1(err instanceof Error ? err.message : String(err));
	}
}
//#endregion
//#region src/pipeline/generate.ts
const MISSING_PROMPT = "missing prompt; call mxpage_refine_prompt or pass prompt_override";
function fail(error) {
	return {
		ok: false,
		error: redactSecrets(error)
	};
}
function readPromptFile(projectDir, sectionKey) {
	const file = assertInside(projectDir, join(projectDir, "prompts", `${sectionKey}.json`));
	if (!existsSync(file)) return void 0;
	try {
		const data = JSON.parse(readFileSync(file, "utf8"));
		if (typeof data.finalPrompt === "string" && data.finalPrompt.trim()) return data.finalPrompt;
		if (typeof data.prompt === "string" && data.prompt.trim()) return data.prompt;
	} catch {
		return;
	}
}
function resolvePrompt(projectDir, sectionKey, promptOverride) {
	if (promptOverride !== void 0 && promptOverride.trim() !== "") return promptOverride;
	return readPromptFile(projectDir, sectionKey);
}
function latestVersionId(projectDir, sectionKey) {
	const dir = join(projectDir, "versions", sectionKey);
	if (!existsSync(dir)) return void 0;
	let max = 0;
	for (const name of readdirSync(dir)) {
		const match = /^v(\d+)\.png$/.exec(name);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max > 0 ? `v${max}` : void 0;
}
function nextVersionId(projectDir, sectionKey) {
	const current = latestVersionId(projectDir, sectionKey);
	if (!current) return "v1";
	return `v${Number(current.slice(1)) + 1}`;
}
function listOutputSections(projectDir) {
	const outputDir = join(projectDir, "output");
	if (!existsSync(outputDir)) return [];
	return readdirSync(outputDir).filter((name) => name.endsWith(".png")).sort().map((name) => {
		const key = name.slice(0, -4);
		return {
			key,
			outputPath: join(outputDir, name),
			versionId: latestVersionId(projectDir, key)
		};
	});
}
function firstHeroOutput(projectDir) {
	const outputDir = join(projectDir, "output");
	if (!existsSync(outputDir)) return void 0;
	const first = readdirSync(outputDir).filter((name) => /^hero_.*\.png$/i.test(name)).sort()[0];
	return first ? join(outputDir, first) : void 0;
}
function defaultReferencePaths(record, max) {
	const paths = [];
	if (record.mainAssetPath) paths.push(record.mainAssetPath);
	const hero = firstHeroOutput(record.workspaceDir);
	if (hero && !paths.includes(hero)) paths.push(hero);
	return paths.slice(0, max);
}
function toBlob$1(absPath) {
	const { bytes, mediaType } = readImageFile(absPath);
	return {
		bytes,
		mediaType,
		filename: basename(absPath)
	};
}
function loadReferences(storeRoot, record, config, referencePaths) {
	return (referencePaths !== void 0 ? referencePaths.map((path) => assertInside(storeRoot, path)) : defaultReferencePaths(record, config.maxReferenceImages)).slice(0, config.maxReferenceImages).filter((path) => existsSync(path)).map(toBlob$1);
}
async function generateSection(deps, args, signal) {
	const record = deps.store.read(args.projectId);
	let prompt = resolvePrompt(record.workspaceDir, args.sectionKey, args.promptOverride);
	if (!prompt) {
		if (!deps.completeJson) return fail(MISSING_PROMPT);
		const refined = await refinePrompt({
			store: deps.store,
			completeJson: deps.completeJson
		}, {
			projectId: args.projectId,
			sectionKey: args.sectionKey
		}, signal);
		if (!refined.ok) return fail(refined.error);
		prompt = refined.finalPrompt;
	}
	const model = args.model ?? deps.config.imageModel;
	const size = args.size ?? "1024x1024";
	const references = loadReferences(deps.storeRoot, record, deps.config, args.referencePaths);
	const generated = await deps.images.generate({
		prompt,
		size,
		model,
		references,
		signal
	});
	if (signal.aborted) throw new Error("已取消");
	const projectDir = record.workspaceDir;
	const versionId = nextVersionId(projectDir, args.sectionKey);
	const outputDir = assertInside(projectDir, join(projectDir, "output"));
	const versionDir = assertInside(projectDir, join(projectDir, "versions", args.sectionKey));
	mkdirSync(outputDir, { recursive: true });
	mkdirSync(versionDir, { recursive: true });
	const outputPath = assertInside(projectDir, join(outputDir, `${args.sectionKey}.png`));
	const versionPath = assertInside(projectDir, join(versionDir, `${versionId}.png`));
	const buf = Buffer.from(generated.bytes);
	writeFileSync(outputPath, buf);
	writeFileSync(versionPath, buf);
	const ref = await deps.saveImage({
		data: generated.bytes,
		mediaType: "image/png",
		name: `${args.sectionKey}.png`
	});
	return {
		ok: true,
		projectId: record.id,
		sectionKey: args.sectionKey,
		outputPath,
		attachmentId: ref.attachmentId,
		modelUsed: model,
		versionId
	};
}
//#endregion
//#region src/provider/openai-images.ts
function mapImageError(status, body) {
	if (status === 401) return {
		ok: false,
		error: "图像 API 密钥无效或未配置"
	};
	if (status === 429) return {
		ok: false,
		error: "额度或速率限制"
	};
	if (status === 400 && /model/i.test(body)) return {
		ok: false,
		error: "模型不支持"
	};
	const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
	return {
		ok: false,
		error: redactSecrets(`图像 API 请求失败 (${status})${snippet ? `: ${snippet}` : ""}`)
	};
}
function throwRedacted(message) {
	throw new Error(redactSecrets(message));
}
function throwMapped(status, body) {
	throwRedacted(mapImageError(status, body).error);
}
function throwCancelled() {
	throw new Error("已取消");
}
function isAbort(err, signal) {
	if (signal.aborted) return true;
	return Boolean(err && typeof err === "object" && "name" in err && err.name === "AbortError");
}
function endpoint(baseUrl, path) {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
function toBlob(image) {
	const copy = new Uint8Array(image.bytes.byteLength);
	copy.set(image.bytes);
	return new Blob([copy], { type: image.mediaType || "application/octet-stream" });
}
function appendImage(form, image) {
	form.append("image", toBlob(image), image.filename);
}
function parsePngResult(payload) {
	const b64 = payload?.data?.[0]?.b64_json;
	if (!b64) throwRedacted("图像 API 返回空数据");
	return {
		bytes: new Uint8Array(Buffer.from(b64, "base64")),
		mediaType: "image/png"
	};
}
function editForm(prompt, model, size, images) {
	const form = new FormData();
	form.append("prompt", prompt);
	form.append("model", model);
	form.append("size", size);
	for (const image of images) appendImage(form, image);
	return form;
}
function createImagesClient(opts) {
	const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
	async function request(path, init, signal) {
		if (signal.aborted) throwCancelled();
		let res;
		try {
			res = await fetchFn(endpoint(opts.baseUrl, path), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${opts.apiKey}`,
					...init.headers
				},
				body: init.body,
				signal
			});
		} catch (err) {
			if (isAbort(err, signal)) throwCancelled();
			throwRedacted(err instanceof Error ? err.message : String(err));
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throwMapped(res.status, body);
		}
		let payload;
		try {
			payload = await res.json();
		} catch (err) {
			if (isAbort(err, signal)) throwCancelled();
			throwRedacted(err instanceof Error ? err.message : "图像 API 响应无效");
		}
		return parsePngResult(payload);
	}
	return {
		generate(input) {
			if (input.references.length > 0) return request("/images/edits", { body: editForm(input.prompt, input.model, input.size, input.references) }, input.signal);
			return request("/images/generations", {
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: input.model,
					prompt: input.prompt,
					size: input.size
				})
			}, input.signal);
		},
		edit(input) {
			return request("/images/edits", { body: editForm(input.prompt, input.model, input.size, [input.image, ...input.references]) }, input.signal);
		}
	};
}
//#endregion
//#region src/tools/generate-section.ts
const SIZES = ["1024x1024", "1024x1536"];
const MISSING_KEY = "未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）";
function generateSectionTool(opts) {
	return defineTool({
		name: "mxpage_generate_section",
		description: "Generate one page section image (e.g. hero_01). Pass prompt_override in P1, or refine_prompt first so prompts/<sectionKey>.json exists. Writes output/<sectionKey>.png and returns attachmentId. Default size 1024x1024; default references are the main asset plus the first hero output.",
		parameters: {
			project_id: {
				type: "string",
				required: true,
				description: "Existing mxpage project id"
			},
			section_key: {
				type: "string",
				required: true,
				description: "e.g. hero_01"
			},
			prompt_override: {
				type: "string",
				description: "skip VPA"
			},
			reference_paths: {
				type: "array",
				items: { type: "string" },
				description: "Extra reference images; default main asset + first hero output"
			},
			size: {
				type: "string",
				enum: SIZES,
				description: "Output size; default 1024x1024"
			},
			model: {
				type: "string",
				description: "Image model override"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		timeoutMs: 18e4,
		isConcurrencySafe: () => false,
		execute: async (args, exec) => {
			const images = resolveImages(opts.config, opts.images);
			if (images === void 0) return {
				ok: false,
				error: MISSING_KEY
			};
			return generateSection({
				store: opts.store,
				storeRoot: opts.storeRoot,
				config: opts.config,
				images,
				saveImage: opts.saveImage,
				completeJson: opts.completeJson
			}, {
				projectId: args.project_id,
				sectionKey: args.section_key,
				promptOverride: args.prompt_override,
				referencePaths: args.reference_paths,
				size: args.size,
				model: args.model
			}, exec.signal);
		}
	});
}
function resolveImages(config, injected) {
	if (injected) return injected;
	const apiKey = process.env[config.imageApiKeyEnv];
	if (!apiKey) return void 0;
	return createImagesClient({
		baseUrl: config.imageBaseUrl,
		apiKey
	});
}
//#endregion
//#region src/tools/plan.ts
const PLATFORMS = ["ecommerce", "xiaohongshu"];
const LANGUAGES = [
	"zh-CN",
	"en",
	"ja",
	"ko"
];
function planPageTool(opts) {
	return defineTool({
		name: "mxpage_plan_page",
		description: "Plan hero and detail sections plus a visual style guide. Requires status analyzed (or planned to replan). Writes plan.json and style-guide.json. hero_count 1–5 default 3, detail_count 1–10 default 6.",
		parameters: {
			project_id: {
				type: "string",
				required: true,
				description: "Existing mxpage project id; must be analyzed or planned"
			},
			hero_count: {
				type: "number",
				description: "Hero images, 1–5; default config.defaultHeroCount (3)"
			},
			detail_count: {
				type: "number",
				description: "Detail modules, 1–10; default config.defaultDetailCount (6)"
			},
			platform: {
				type: "string",
				enum: PLATFORMS,
				description: "ecommerce or xiaohongshu; default ecommerce"
			},
			language: {
				type: "string",
				enum: LANGUAGES,
				description: "Content language override"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args, exec) => {
			return planPage({
				store: opts.store,
				config: opts.config,
				completeJson: opts.completeJson
			}, {
				projectId: args.project_id,
				heroCount: args.hero_count,
				detailCount: args.detail_count,
				platform: args.platform,
				language: args.language
			}, exec.signal);
		}
	});
}
//#endregion
//#region src/tools/project-status.ts
function projectStatusTool(opts) {
	return defineTool({
		name: "mxpage_project_status",
		description: "Read-only mxpage project status. Safe to call at status=created, before analyze. Returns assets and generated sections (key, outputPath, versionId).",
		parameters: { project_id: {
			type: "string",
			required: true,
			description: "Existing mxpage project id"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args) => {
			const record = opts.store.read(args.project_id);
			return {
				ok: true,
				status: record.status,
				language: record.language,
				aspectRatio: record.aspectRatio,
				mainAssetPath: record.mainAssetPath,
				assets: record.assets,
				sections: listOutputSections(record.workspaceDir)
			};
		}
	});
}
//#endregion
//#region src/tools/refine-prompt.ts
const MODES = [
	"ecommerce_section",
	"xiaohongshu_page",
	"image_edit"
];
function refinePromptTool(opts) {
	return defineTool({
		name: "mxpage_refine_prompt",
		description: "Run Visual Prompt Agent for one section. Writes prompts/<sectionKey>.json with finalPrompt, negativePrompt, qualityChecklist. Needs analysis (plan optional). mode default ecommerce_section.",
		parameters: {
			project_id: {
				type: "string",
				required: true,
				description: "Existing mxpage project id"
			},
			section_key: {
				type: "string",
				required: true,
				description: "e.g. hero_01"
			},
			mode: {
				type: "string",
				enum: MODES,
				description: "VPA mode; default ecommerce_section"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute: async (args, exec) => {
			return refinePrompt({
				store: opts.store,
				completeJson: opts.completeJson
			}, {
				projectId: args.project_id,
				sectionKey: args.section_key,
				mode: args.mode
			}, exec.signal);
		}
	});
}
//#endregion
//#region src/tools/register.ts
function resolveStoreRoot(config) {
	if (config.workspaceDir) return config.workspaceDir;
	return join(process.env.DSH_HOME ?? homedir(), "mxpage");
}
function asSaveImage(saveImage) {
	return async (input) => {
		const ref = await saveImage(input);
		return {
			attachmentId: ref.attachmentId,
			mediaType: ref.mediaType ?? input.mediaType,
			bytes: ref.bytes ?? input.data.byteLength,
			width: ref.width ?? 0,
			height: ref.height ?? 0,
			name: ref.name ?? input.name
		};
	};
}
function registerMxpageTools(ctx, config, deps) {
	const storeRoot = resolveStoreRoot(config);
	const store = createStore(storeRoot);
	const saveImage = asSaveImage((input) => ctx.attachments.saveImage(input));
	const completeJson = resolveCompleteJson({
		completeJson: deps?.completeJson,
		llm: deps?.llm ?? ctx.llm,
		config,
		saveImage
	});
	ctx.tools.register(createProjectTool({
		store,
		storeRoot,
		config
	}));
	ctx.tools.register(addAssetTool({
		store,
		storeRoot
	}));
	ctx.tools.register(projectStatusTool({ store }));
	ctx.tools.register(analyzeProductTool({
		store,
		completeJson
	}));
	ctx.tools.register(planPageTool({
		store,
		config,
		completeJson
	}));
	ctx.tools.register(refinePromptTool({
		store,
		completeJson
	}));
	ctx.tools.register(generateSectionTool({
		store,
		storeRoot,
		config,
		saveImage: (input) => ctx.attachments.saveImage(input),
		images: deps?.images,
		completeJson
	}));
}
//#endregion
//#region src/index.ts
const name = "mxpage";
const inject = [
	"tools",
	"attachments",
	"jobs"
];
function apply(ctx, config) {
	registerMxpageTools(ctx, config, { llm: ctx.llm });
}
//#endregion
export { Config, apply, inject, name };

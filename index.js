import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { crc32 } from "node:zlib";
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
	maxParallelProjects: Schema.number().default(1).description("批量 SKU 同时进行的项目数，默认 1"),
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
function dataUrl$1(image) {
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
			image_url: { url: dataUrl$1(image) }
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
//#region src/util/attachments.ts
function sniffExt(bytes) {
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80) return ".png";
	if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 216) return ".jpg";
	return ".png";
}
function assertAttachmentId(id) {
	const value = id.trim();
	if (!value || value.includes("..") || value.includes("/") || value.includes("\\")) throw new Error(redactSecrets("invalid attachment_id"));
	return value;
}
async function materializeAttachment(storeRoot, attachmentId, attachments, signal) {
	const id = assertAttachmentId(attachmentId);
	if (!attachments) throw new Error("无法读取附件");
	let bytes;
	const hostPath = attachments.imageHostPath?.({ attachmentId: id });
	if (hostPath && existsSync(hostPath)) bytes = new Uint8Array(readFileSync(hostPath));
	else if (attachments.readImage) bytes = (await attachments.readImage({ attachmentId: id }, signal)).data;
	if (!bytes || bytes.byteLength === 0) throw new Error("无法读取附件");
	const incoming = assertInside(storeRoot, join(storeRoot, "incoming"));
	mkdirSync(incoming, { recursive: true });
	const dest = assertInside(storeRoot, join(incoming, `att_${randomUUID()}${sniffExt(bytes)}`));
	writeFileSync(dest, Buffer.from(bytes));
	return dest;
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
		description: "Add a product or reference image to an existing mxpage project. Pass image_path or attachment_id. Replacing the main image requires role=main.",
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
				description: "Chat image attachment id; copied into the project store"
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
		execute: async (args, exec) => {
			let abs;
			try {
				if (args.image_path) abs = assertInside(opts.storeRoot, args.image_path);
				else if (args.attachment_id) abs = await materializeAttachment(opts.storeRoot, args.attachment_id, opts.attachments, exec.signal);
			} catch (err) {
				return {
					ok: false,
					error: redactSecrets(err instanceof Error ? err.message : String(err))
				};
			}
			if (!abs) return {
				ok: false,
				error: redactSecrets("请提供 image_path 或 attachment_id")
			};
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
function fail$6(message) {
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
	if (statSync(absPath).size > 20971520) fail$6("image exceeds 20MiB");
	const bytes = new Uint8Array(readFileSync(absPath));
	if (bytes.byteLength > 20971520) fail$6("image exceeds 20MiB");
	const png = parsePngSize(bytes);
	if (png) {
		if (png.width > 8192 || png.height > 8192) fail$6("image edge exceeds 8192");
		return {
			bytes,
			mediaType: "image/png"
		};
	}
	const jpeg = parseJpegSize(bytes);
	if (jpeg) {
		if (jpeg.width > 8192 || jpeg.height > 8192) fail$6("image edge exceeds 8192");
		return {
			bytes,
			mediaType: "image/jpeg"
		};
	}
	fail$6("unsupported image format");
}
//#endregion
//#region src/pipeline/analyze.ts
function fail$5(error) {
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
	if (!deps.completeJson) return fail$5(NO_VISION);
	const status = record.status;
	if (status !== "created" && status !== "failed" && status !== "analyzing") return fail$5("MXPAGE_STATE");
	if (status === "created" || status === "failed") try {
		deps.store.write(record.id, { status: "analyzing" });
	} catch {
		return fail$5("MXPAGE_STATE");
	}
	try {
		const images = loadProjectImages(record);
		if (images.length === 0) {
			markFailed$1(deps.store, record.id);
			return fail$5(NO_VISION);
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
			return fail$5(result.error);
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
		return fail$5(err instanceof Error ? err.message : String(err));
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
const LANGUAGES$2 = [
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
		description: "Create an mxpage project and copy product photos into assets/ (does not move sources). Call this before generate_section. Pass image_paths (workspace files inside the mxpage store) and/or attachment_ids from the current chat image. Combined 1–10 images. Default main is the first.",
		parameters: {
			name: {
				type: "string",
				description: "Project display name; default untitled"
			},
			image_paths: {
				type: "array",
				items: { type: "string" },
				description: "Product image paths (workspace-relative or absolute, inside the mxpage store). Combined with attachment_ids, 1–10 files."
			},
			attachment_ids: {
				type: "array",
				items: { type: "string" },
				description: "Chat image attachment ids from the current turn. Copied into the project store; 1–10 combined with image_paths."
			},
			main_image_path: {
				type: "string",
				description: "Main product image path; default first resolved image"
			},
			language: {
				type: "string",
				enum: LANGUAGES$2,
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
		execute: async (args, exec) => {
			const pathArgs = Array.isArray(args.image_paths) ? args.image_paths : [];
			const attachmentArgs = Array.isArray(args.attachment_ids) ? args.attachment_ids : [];
			const imagePaths = pathArgs.map((path) => assertInside(opts.storeRoot, path));
			try {
				for (const id of attachmentArgs) imagePaths.push(await materializeAttachment(opts.storeRoot, id, opts.attachments, exec.signal));
			} catch (err) {
				return {
					ok: false,
					error: redactSecrets(err instanceof Error ? err.message : String(err))
				};
			}
			if (imagePaths.length < 1 || imagePaths.length > 10) return {
				ok: false,
				error: "请提供 image_paths 或 attachment_ids（1–10 张）"
			};
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
const languageNames$1 = {
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
	const targetLanguage = languageNames$1[language] ?? languageNames$1["zh-CN"];
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
function fail$4(error) {
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
	if (record.status !== "analyzed" && record.status !== "planned") return fail$4("MXPAGE_STATE");
	if (!deps.completeJson) return fail$4(NO_VISION);
	const analysis = readAnalysisFile(record.workspaceDir);
	if (!analysis) return fail$4("MXPAGE_STATE");
	const heroCount = clamp(args.heroCount, 1, 5, deps.config.defaultHeroCount);
	const detailCount = clamp(args.detailCount, 1, 10, deps.config.defaultDetailCount);
	const platform = args.platform === "xiaohongshu" ? "xiaohongshu" : "ecommerce";
	const language = args.language ?? record.language;
	const detailAspect = record.aspectRatio === "9:16" ? "9:16" : record.aspectRatio === "3:4" ? "3:4" : deps.config.defaultDetailAspectRatio;
	try {
		deps.store.write(record.id, { status: "planning" });
	} catch {
		return fail$4("MXPAGE_STATE");
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
			return fail$4(result.error);
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
		return fail$4(err instanceof Error ? err.message : String(err));
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
function fail$3(error) {
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
	if (!deps.completeJson) return fail$3(NO_VISION);
	const analysis = readAnalysisFile(record.workspaceDir);
	if (!analysis) return fail$3("MXPAGE_STATE");
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
		if (!result.ok) return fail$3(result.error);
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
		return fail$3(err instanceof Error ? err.message : String(err));
	}
}
//#endregion
//#region src/pipeline/generate.ts
const MISSING_PROMPT = "missing prompt; call mxpage_refine_prompt or pass prompt_override";
function rememberOutput(store, projectId, item) {
	try {
		const rest = (store.read(projectId).outputs ?? []).filter((entry) => entry.key !== item.key);
		store.write(projectId, { outputs: [...rest, item].sort((a, b) => a.key.localeCompare(b.key)) });
	} catch {}
}
function fail$2(error) {
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
function toBlob$2(absPath) {
	const { bytes, mediaType } = readImageFile(absPath);
	return {
		bytes,
		mediaType,
		filename: basename(absPath)
	};
}
function loadReferences(storeRoot, record, config, referencePaths) {
	return (referencePaths !== void 0 ? referencePaths.map((path) => assertInside(storeRoot, path)) : defaultReferencePaths(record, config.maxReferenceImages)).slice(0, config.maxReferenceImages).filter((path) => existsSync(path)).map(toBlob$2);
}
async function generateSection(deps, args, signal) {
	const record = deps.store.read(args.projectId);
	let prompt = resolvePrompt(record.workspaceDir, args.sectionKey, args.promptOverride);
	if (!prompt) {
		if (!deps.completeJson) return fail$2(MISSING_PROMPT);
		const refined = await refinePrompt({
			store: deps.store,
			completeJson: deps.completeJson
		}, {
			projectId: args.projectId,
			sectionKey: args.sectionKey
		}, signal);
		if (!refined.ok) return fail$2(refined.error);
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
		mediaType: generated.mediaType,
		name: `${args.sectionKey}.png`
	});
	rememberOutput(deps.store, record.id, {
		key: args.sectionKey,
		attachmentId: ref.attachmentId,
		mediaType: ref.mediaType ?? generated.mediaType,
		bytes: ref.bytes ?? generated.bytes.byteLength,
		width: ref.width ?? 0,
		height: ref.height ?? 0,
		name: ref.name ?? `${args.sectionKey}.png`
	});
	return {
		ok: true,
		projectId: record.id,
		sectionKey: args.sectionKey,
		outputPath,
		attachmentId: ref.attachmentId,
		mediaType: ref.mediaType ?? generated.mediaType,
		bytes: ref.bytes ?? generated.bytes.byteLength,
		width: ref.width ?? 0,
		height: ref.height ?? 0,
		modelUsed: model,
		versionId
	};
}
//#endregion
//#region src/prompts/generation.ts
const languageNames = {
	"zh-CN": "Simplified Chinese",
	en: "English",
	ja: "Japanese",
	ko: "Korean"
};
function buildReferenceText(referenceAssets) {
	if (!referenceAssets.length) return "No reference images were provided.";
	return `Reference roles: ${referenceAssets.map((item) => `${item.role}${item.isMain ? " (main)" : ""}`).join(" / ")}`;
}
function buildMainImageInstruction(referenceAssets) {
	if (!referenceAssets.length) return "If no product image reference is provided, infer the product carefully from the structured analysis and keep the same product identity across all generated sections.";
	return [
		"The uploaded main product image is the source of truth for product identity.",
		"主体与参考图一致：Keep the same product category, shape, material, color family, proportions, grid/layer structure, moving parts, and key recognisable details across every generated hero image and detail image.",
		"Do not invent a different product.",
		"Use the provided image as the visual anchor, then change composition, scene, angle, crop, lighting, and selling-point emphasis according to the section goal. Never replace the product with a similar-looking object or a generic prop."
	].join(" ");
}
function buildAspectInstruction(aspectRatio) {
	if (aspectRatio === "1:1") return "The final image must be a square 1:1 e-commerce hero composition, optimized for tappable product gallery covers.";
	return aspectRatio === "3:4" ? "The final image must be a vertical 3:4 marketplace poster composition." : "The final image must be a vertical 9:16 long-form mobile commerce composition.";
}
function buildTargetLanguageInstruction(contentLanguage) {
	const targetLanguage = languageNames[contentLanguage];
	return [
		`All user-facing marketing copy that appears inside the image must be written in ${targetLanguage}.`,
		`The section title, key selling points, short supporting copy, disclaimers, and CTA should all be in ${targetLanguage} when they appear in the image.`,
		"Do not mix in Simplified Chinese unless the target language is Simplified Chinese.",
		"Keep the typography native, polished, and commercially readable for the target language.",
		"避免乱码文字：in-image copy must be sharp, correctly spelled, with no garbled glyphs or stacked duplicates."
	].join(" ");
}
function buildPhysicalRealityInstruction() {
	return [
		"Respect product physics and product-specific mechanical logic.",
		"几何不可反转：preserve real openings, hinges, layer count, seams, buttons, handles and part direction; do not mirror or invert structure.",
		"禁止逆风：airflow, liquid and heat may leave only through the real outlet; never blow backward from an intake.",
		"Infer how the product actually works from the uploaded image and section goal: cable exit points, vents, nozzles, hinges, openings, drawers, buttons, handles, gravity, shadows, reflections, support surfaces, airflow, liquid flow, and user interaction direction.",
		"Do not create impossible physical effects: reversed airflow, cords disappearing into furniture, floating unsupported products, hands passing through solid parts, liquids flowing upward, disconnected shadows, impossible reflections, text crossing through product geometry, or parts bending in a way the material cannot.",
		"For hair dryers specifically, airflow must leave the front nozzle, the rear intake must not emit wind, and the power cord must connect naturally from the handle/base instead of merging into a desk or wall.",
		"For Rubik cubes, speed cubes, puzzle cubes and other mechanical toys: preserve the correct cube order such as 3x3x3 when stated or visible, keep six square color faces, visible corner/edge/center piece logic, real twistable layer seams, rounded or straight tile style matching the reference, and do not turn it into a ruler, sticker sheet, generic storage box, electronics device, or unrelated block toy."
	].join(" ");
}
function buildGenerationRequirementsInstruction(generationRequirements) {
	const trimmed = generationRequirements?.trim();
	if (!trimmed) return "No extra project-level image generation requirements were provided.";
	return [
		"Project-level image generation requirements from the user. Treat these as high-priority creative constraints for this image while still following the current section goal:",
		trimmed,
		"Operationalize these requirements concretely through camera angle, scene, props, product interaction, composition variation, and in-image copy. Do not ignore them or mention them only as abstract text."
	].join("\n");
}
function buildSectionImagePrompt(section, referenceAssets = [], aspectRatio = "9:16", contentLanguage = "zh-CN", generationRequirements) {
	return [
		"You are a senior e-commerce key-visual designer creating marketplace-ready product artwork.",
		`Section type: ${section.type}`,
		`Section title: ${section.title}`,
		`Section goal: ${section.goal}`,
		`Section copy: ${section.copy}`,
		`Visual prompt guidance: ${section.visualPrompt}`,
		buildReferenceText(referenceAssets),
		buildMainImageInstruction(referenceAssets),
		buildAspectInstruction(aspectRatio),
		buildTargetLanguageInstruction(contentLanguage),
		buildGenerationRequirementsInstruction(generationRequirements),
		buildPhysicalRealityInstruction(),
		"Generate one high-conversion mobile e-commerce visual for this section.",
		"The image should emphasize product clarity, composition hierarchy, material texture, and marketplace aesthetics.",
		"The headline, selling points, supporting copy, and CTA should be visually designed inside the image rather than left for later DOM text insertion.",
		"Make the result feel like finished commercial artwork, not a blank template."
	].join("\n");
}
function buildImageEditPrompt(section, referenceAssets = [], mode = "repaint", aspectRatio = "9:16", contentLanguage = "zh-CN", generationRequirements) {
	const targetLanguage = languageNames[contentLanguage];
	const modeInstruction = mode === "translate" ? `This is an in-image translation task. Use the current image as the base and translate every visible user-facing word, headline, selling point, label, badge, CTA, note, and disclaimer into ${targetLanguage}. Preserve the original product, layout, composition, typography hierarchy, colors, lighting, and commercial style as much as possible. Do not add new claims or redesign the image except where text length requires natural typographic fitting. Remove the original-language text after replacing it with ${targetLanguage}. 避免乱码文字。` : mode === "enhance" ? "This is an enhancement task. Use the current image as the base, preserve the overall framing, and improve realism, texture, lighting, clarity, edge quality, and commercial polish." : "This is a repaint task. Use the current image as the base, keep the same product identity, and redesign the composition, atmosphere, styling, and conversion emphasis according to the section goal.";
	return [
		buildSectionImagePrompt(section, referenceAssets, aspectRatio, contentLanguage, generationRequirements),
		modeInstruction,
		"The current section image must be treated as the editable base image.",
		"Keep the product identical to the uploaded main product image and do not replace it with a different item. 主体与参考图一致。",
		mode === "translate" ? "Only change the in-image language. Do not translate invisible metadata, do not add subtitles outside the artwork, and do not leave bilingual duplicates unless the original design intentionally uses bilingual branding." : "",
		"Output one marketplace-ready mobile e-commerce image only."
	].filter(Boolean).join("\n");
}
//#endregion
//#region src/pipeline/edit.ts
function fail$1(error) {
	return {
		ok: false,
		error: redactSecrets(error)
	};
}
function toBlob$1(absPath) {
	const { bytes, mediaType } = readImageFile(absPath);
	return {
		bytes,
		mediaType,
		filename: basename(absPath)
	};
}
function tryStatus$1(store, projectId, status) {
	try {
		store.write(projectId, { status });
	} catch {}
}
async function editSection(deps, args, signal) {
	const record = deps.store.read(args.projectId);
	if (signal.aborted) throw new Error("已取消");
	const projectDir = record.workspaceDir;
	const outputPath = assertInside(projectDir, join(projectDir, "output", `${args.sectionKey}.png`));
	if (!existsSync(outputPath)) return fail$1("MXPAGE_NOT_FOUND");
	const section = readPlanFile(projectDir)?.sections.find((item) => item.sectionKey === args.sectionKey);
	const generation = {
		type: section?.type ?? (args.sectionKey.startsWith("hero_") ? "hero" : "custom"),
		title: section?.title ?? args.sectionKey,
		goal: section?.goal ?? args.instruction ?? "",
		copy: section?.copy ?? "",
		visualPrompt: section?.visualPrompt ?? args.instruction ?? ""
	};
	const aspectRatio = generation.type === "hero" ? "1:1" : record.aspectRatio === "9:16" ? "9:16" : record.aspectRatio === "3:4" ? "3:4" : "3:4";
	const contentLanguage = args.mode === "translate" ? args.targetLanguage ?? record.language : record.language;
	const analysis = readAnalysisFile(projectDir);
	let prompt = buildImageEditPrompt(generation, [{
		role: "output",
		isMain: false
	}, {
		role: "main",
		isMain: true
	}], args.mode, aspectRatio, contentLanguage, analysis?.generationRequirements);
	if (args.instruction?.trim()) prompt = `${prompt}\nUser instruction: ${args.instruction.trim()}`;
	const image = toBlob$1(outputPath);
	const references = [image];
	if (record.mainAssetPath && existsSync(record.mainAssetPath)) references.push(toBlob$1(record.mainAssetPath));
	tryStatus$1(deps.store, record.id, "editing");
	const model = args.model ?? deps.config.imageModel;
	const size = args.size ?? "1024x1024";
	const generated = await deps.images.edit({
		prompt,
		size,
		model,
		image,
		references,
		signal
	});
	if (signal.aborted) throw new Error("已取消");
	const versionId = nextVersionId(projectDir, args.sectionKey);
	const versionDir = assertInside(projectDir, join(projectDir, "versions", args.sectionKey));
	mkdirSync(versionDir, { recursive: true });
	const versionPath = assertInside(projectDir, join(versionDir, `${versionId}.png`));
	const buf = Buffer.from(generated.bytes);
	writeFileSync(outputPath, buf);
	writeFileSync(versionPath, buf);
	const ref = await deps.saveImage({
		data: generated.bytes,
		mediaType: generated.mediaType,
		name: `${args.sectionKey}.png`
	});
	rememberOutput(deps.store, record.id, {
		key: args.sectionKey,
		attachmentId: ref.attachmentId,
		mediaType: ref.mediaType ?? generated.mediaType,
		bytes: ref.bytes ?? generated.bytes.byteLength,
		width: ref.width ?? 0,
		height: ref.height ?? 0,
		name: ref.name ?? `${args.sectionKey}.png`
	});
	tryStatus$1(deps.store, record.id, "generated");
	return {
		ok: true,
		projectId: record.id,
		sectionKey: args.sectionKey,
		outputPath,
		attachmentId: ref.attachmentId,
		mediaType: ref.mediaType ?? generated.mediaType,
		bytes: ref.bytes ?? generated.bytes.byteLength,
		width: ref.width ?? 0,
		height: ref.height ?? 0,
		modelUsed: model,
		versionId
	};
}
//#endregion
//#region src/provider/openai-images.ts
function isQuotaBody(body) {
	return /insufficient_user_quota|预扣费额度失败|out of credits|额度失败|用户额度不足|额度不足|余额不足|remaining quota/i.test(body);
}
function mapImageError(status, body) {
	if (status === 401) return {
		ok: false,
		error: "图像 API 密钥无效或未配置"
	};
	if (status === 429 || isQuotaBody(body)) return {
		ok: false,
		error: "额度或速率限制"
	};
	if (status === 400 && /model/i.test(body) && !/does not support image generation/i.test(body)) return {
		ok: false,
		error: "模型不支持"
	};
	const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
	return {
		ok: false,
		error: redactSecrets(`图像 API 请求失败 (${status})${snippet ? `: ${snippet}` : ""}`)
	};
}
function isQuotaError(err) {
	const message = err instanceof Error ? err.message : String(err ?? "");
	return /额度或速率限制/.test(message);
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
function appendImage(form, image, field = "image") {
	form.append(field, toBlob(image), image.filename);
}
function asImage$1(bytes) {
	if (bytes.byteLength < 3) throwRedacted("图像 API 返回空数据");
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return {
		bytes,
		mediaType: "image/jpeg"
	};
	if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return {
		bytes,
		mediaType: "image/webp"
	};
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return {
		bytes,
		mediaType: "image/png"
	};
	throwRedacted("图像 API 返回空数据");
}
function flattenContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part === "string") return part;
		if (!part || typeof part !== "object") return "";
		const rec = part;
		if (typeof rec.text === "string") return rec.text;
		if (typeof rec.image_url === "string") return rec.image_url;
		if (rec.image_url && typeof rec.image_url === "object" && typeof rec.image_url.url === "string") return String(rec.image_url.url);
		return "";
	}).join("\n");
}
function extractImageB64(payload) {
	if (!payload || typeof payload !== "object") return void 0;
	const rec = payload;
	const data = rec.data;
	if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
		const first = data[0];
		if (typeof first.b64_json === "string" && first.b64_json.trim()) return first.b64_json.trim();
	}
	const choices = rec.choices;
	const match = flattenContent(Array.isArray(choices) && choices[0] && typeof choices[0] === "object" ? choices[0].message?.content : void 0).match(/data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\n\r]+)/i);
	if (match?.[1]) return match[1].replace(/\s+/g, "");
}
function extractImageUrl(payload) {
	if (!payload || typeof payload !== "object") return void 0;
	const data = payload.data;
	if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
		const url = data[0].url;
		if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;
	}
}
function shouldFallbackToChat(status, body) {
	if (status === 401 || status === 429) return false;
	if (isQuotaBody(body)) return false;
	if (status === 400 && /model/i.test(body) && !/does not support image generation/i.test(body)) return false;
	return status >= 400;
}
function dataUrl(image) {
	return `data:${image.mediaType || "image/png"};base64,${Buffer.from(image.bytes).toString("base64")}`;
}
function editForm(prompt, model, size, images, field = "image") {
	const form = new FormData();
	form.append("prompt", prompt);
	form.append("model", model);
	form.append("size", size);
	for (const image of images) appendImage(form, image, field);
	return form;
}
function editJsonBody(prompt, model, size, images) {
	const body = {
		prompt,
		model,
		size
	};
	if (images.length <= 1) {
		const image = images[0];
		if (image) body.image = {
			type: "image_url",
			url: dataUrl(image)
		};
		return body;
	}
	body.images = images.map((image) => ({
		type: "image_url",
		url: dataUrl(image)
	}));
	return body;
}
function createImagesClient(opts) {
	const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
	async function parsePayload(payload, signal) {
		const b64 = extractImageB64(payload);
		if (b64) return asImage$1(new Uint8Array(Buffer.from(b64, "base64")));
		const url = extractImageUrl(payload);
		if (!url) throwRedacted("图像 API 返回空数据");
		if (signal.aborted) throwCancelled();
		let res;
		try {
			res = await fetchFn(url, { signal });
		} catch (err) {
			if (isAbort(err, signal)) throwCancelled();
			throwRedacted(err instanceof Error ? err.message : String(err));
		}
		if (!res.ok) throwRedacted(`图像下载失败 (${res.status})`);
		const buf = new Uint8Array(await res.arrayBuffer());
		if (buf.byteLength < 32) throwRedacted("图像 API 返回空数据");
		return asImage$1(buf);
	}
	async function parseRaw(raw, signal) {
		const fromText = raw.match(/data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\n\r]+)/i);
		const tryJson = (text) => {
			try {
				return JSON.parse(text);
			} catch {
				const first = text.indexOf("{");
				const last = text.lastIndexOf("}");
				if (first < 0 || last <= first) return void 0;
				try {
					return JSON.parse(text.slice(first, last + 1));
				} catch {
					return;
				}
			}
		};
		const payload = tryJson(raw);
		if (payload !== void 0) try {
			return await parsePayload(payload, signal);
		} catch (err) {
			if (isAbort(err, signal)) throwCancelled();
		}
		if (fromText?.[1]) return asImage$1(new Uint8Array(Buffer.from(fromText[1].replace(/\s+/g, ""), "base64")));
		throwRedacted("图像 API 返回空数据");
	}
	async function postJson(path, body, signal) {
		return fetchFn(endpoint(opts.baseUrl, path), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${opts.apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify(body),
			signal
		});
	}
	async function requestChat(prompt, model, size, images, signal) {
		if (signal.aborted) throwCancelled();
		const parts = [{
			type: "text",
			text: [
				prompt,
				`Output a single product image only. Approximate size ${size}. No watermark.`,
				images.length > 0 ? "Keep the product identity from the attached reference photos. The first image is the main product." : ""
			].filter(Boolean).join("\n")
		}];
		for (const image of images.slice(0, 4)) parts.push({
			type: "image_url",
			image_url: { url: dataUrl(image) }
		});
		let res;
		try {
			res = await postJson("/chat/completions", {
				model,
				messages: [{
					role: "user",
					content: parts
				}]
			}, signal);
		} catch (err) {
			if (isAbort(err, signal)) throwCancelled();
			throwRedacted(err instanceof Error ? err.message : String(err));
		}
		const raw = await res.text().catch(() => "");
		if (!res.ok) throwMapped(res.status, raw);
		return parseRaw(raw, signal);
	}
	async function request(path, init, signal, fallback) {
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
		const raw = await res.text().catch(() => "");
		if (!res.ok) {
			if (shouldFallbackToChat(res.status, raw)) return fallback();
			throwMapped(res.status, raw);
		}
		try {
			return await parseRaw(raw, signal);
		} catch (err) {
			if (isAbort(err, signal)) throwCancelled();
			return fallback();
		}
	}
	return {
		generate(input) {
			const chat = () => requestChat(input.prompt, input.model, input.size, input.references.slice(0, 1), input.signal);
			const mp = (images, field, next) => request("/images/edits", { body: editForm(input.prompt, input.model, input.size, images, field) }, input.signal, next);
			const js = (images, next) => request("/images/edits", {
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(editJsonBody(input.prompt, input.model, input.size, images))
			}, input.signal, next);
			if (input.references.length > 1) return js(input.references, () => mp(input.references, "images", () => mp(input.references, "image[]", () => mp(input.references.slice(0, 1), "image", chat))));
			if (input.references.length === 1) return mp(input.references, "image", chat);
			return request("/images/generations", {
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: input.model,
					prompt: input.prompt,
					size: input.size
				})
			}, input.signal, chat);
		},
		edit(input) {
			const images = [input.image, ...input.references];
			const chat = () => requestChat(input.prompt, input.model, input.size, images.slice(0, 1), input.signal);
			const mp = (imgs, field, next) => request("/images/edits", { body: editForm(input.prompt, input.model, input.size, imgs, field) }, input.signal, next);
			const js = (imgs, next) => request("/images/edits", {
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(editJsonBody(input.prompt, input.model, input.size, imgs))
			}, input.signal, next);
			if (images.length > 1) return js(images, () => mp(images, "images", () => mp(images, "image[]", () => mp([input.image], "image", chat))));
			return mp(images, "image", chat);
		}
	};
}
function withQuotaFallback(primary, fallback) {
	async function retry(run, backup) {
		try {
			return await run();
		} catch (err) {
			if (isQuotaError(err)) return backup();
			throw err;
		}
	}
	return {
		generate(input) {
			return retry(() => primary.generate(input), () => fallback.generate(input));
		},
		edit(input) {
			return retry(() => primary.edit(input), () => fallback.edit(input));
		}
	};
}
function imagesClientFromEnv(config) {
	const apiKey = process.env[config.imageApiKeyEnv];
	if (!apiKey) return void 0;
	const primary = createImagesClient({
		baseUrl: config.imageBaseUrl,
		apiKey
	});
	const fallbackUrl = process.env.MXPAGE_IMAGE_FALLBACK_BASE_URL?.trim();
	const fallbackKey = process.env.MXPAGE_IMAGE_FALLBACK_API_KEY?.trim();
	if (!fallbackUrl || !fallbackKey) return primary;
	const norm = (url) => url.replace(/\/+$/, "");
	if (norm(fallbackUrl) === norm(config.imageBaseUrl)) return primary;
	return withQuotaFallback(primary, createImagesClient({
		baseUrl: fallbackUrl,
		apiKey: fallbackKey
	}));
}
//#endregion
//#region src/tools/render.ts
function asImage(input) {
	if (!input || typeof input !== "object") return void 0;
	const rec = input;
	const attachmentId = typeof rec.attachmentId === "string" ? rec.attachmentId : "";
	if (!attachmentId) return void 0;
	const attachment = {
		attachmentId,
		mediaType: typeof rec.mediaType === "string" && rec.mediaType.startsWith("image/") ? rec.mediaType : "image/png",
		bytes: typeof rec.bytes === "number" ? rec.bytes : 0,
		width: typeof rec.width === "number" ? rec.width : 0,
		height: typeof rec.height === "number" ? rec.height : 0
	};
	if (typeof rec.name === "string" && rec.name) attachment.name = rec.name;
	return {
		type: "image",
		attachment
	};
}
function renderJsonAndImages(_args, value) {
	const blocks = [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}];
	if (!value || typeof value !== "object") return blocks;
	const rec = value;
	const seen = /* @__PURE__ */ new Set();
	const push = (raw) => {
		const block = asImage(raw);
		if (!block || seen.has(block.attachment.attachmentId)) return;
		seen.add(block.attachment.attachmentId);
		blocks.push(block);
	};
	if (Array.isArray(rec.outputs)) for (const item of rec.outputs) push(item);
	push(rec);
	return blocks;
}
const textRender = (_args, value) => [{
	type: "text",
	text: JSON.stringify(value, null, 2)
}];
//#endregion
//#region src/tools/edit-section.ts
const SIZES$1 = ["1024x1024", "1024x1536"];
const MODES$1 = [
	"repaint",
	"enhance",
	"translate"
];
const LANGUAGES$1 = [
	"zh-CN",
	"en",
	"ja",
	"ko"
];
const MISSING_KEY$2 = "未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）";
function editSectionTool(opts) {
	return defineTool({
		name: "mxpage_edit_section",
		description: "Edit an existing section image (repaint / enhance / translate). Writes a new versions/<key>/vN.png and updates output/<key>.png; older version files are kept. instruction required for repaint/enhance; target_language required for translate.",
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
				enum: MODES$1,
				required: true,
				description: "repaint, enhance, or translate"
			},
			instruction: {
				type: "string",
				description: "Required for repaint and enhance"
			},
			target_language: {
				type: "string",
				enum: LANGUAGES$1,
				description: "Required for translate"
			},
			size: {
				type: "string",
				enum: SIZES$1,
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
			render: renderJsonAndImages
		},
		timeoutMs: 18e4,
		isConcurrencySafe: () => false,
		execute: async (args, exec) => {
			const mode = args.mode;
			if (mode === "translate" && !args.target_language) return {
				ok: false,
				error: "MXPAGE_MISSING_LANGUAGE"
			};
			if ((mode === "repaint" || mode === "enhance") && !args.instruction?.trim()) return {
				ok: false,
				error: redactSecrets("请提供 instruction")
			};
			const images = resolveImages$2(opts.config, opts.images);
			if (images === void 0) return {
				ok: false,
				error: MISSING_KEY$2
			};
			return editSection({
				store: opts.store,
				storeRoot: opts.storeRoot,
				config: opts.config,
				images,
				saveImage: opts.saveImage
			}, {
				projectId: args.project_id,
				sectionKey: args.section_key,
				mode,
				instruction: args.instruction,
				targetLanguage: args.target_language,
				size: args.size,
				model: args.model
			}, exec.signal);
		}
	});
}
function resolveImages$2(config, injected) {
	if (injected) return injected;
	return imagesClientFromEnv(config);
}
//#endregion
//#region src/pipeline/export.ts
function fail(error) {
	return {
		ok: false,
		error: redactSecrets(error)
	};
}
function u16(n) {
	const buf = Buffer.alloc(2);
	buf.writeUInt16LE(n & 65535);
	return buf;
}
function u32(n) {
	const buf = Buffer.alloc(4);
	buf.writeUInt32LE(n >>> 0);
	return buf;
}
function zipEntryName(absPath) {
	const name = basename(absPath);
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error(`invalid zip entry name: ${name}`);
	return name;
}
/** Minimal ZIP (STORE) using node:zlib crc32. No extra deps. */
function writeStoreZip(zipPath, entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const data = entry.data;
		const crc = crc32(data) >>> 0;
		const size = data.length;
		const local = Buffer.concat([
			u32(67324752),
			u16(20),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(crc),
			u32(size),
			u32(size),
			u16(nameBuf.length),
			u16(0),
			nameBuf
		]);
		locals.push(local, data);
		centrals.push(Buffer.concat([
			u32(33639248),
			u16(20),
			u16(20),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(crc),
			u32(size),
			u32(size),
			u16(nameBuf.length),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(0),
			u32(offset),
			nameBuf
		]));
		offset += local.length + data.length;
	}
	const centralDir = Buffer.concat(centrals);
	const eocd = Buffer.concat([
		u32(101010256),
		u16(0),
		u16(0),
		u16(entries.length),
		u16(entries.length),
		u32(centralDir.length),
		u32(offset),
		u16(0)
	]);
	writeFileSync(zipPath, Buffer.concat([
		...locals,
		centralDir,
		eocd
	]));
}
function exportPage(deps, args) {
	let record;
	try {
		record = deps.store.read(args.projectId);
	} catch {
		return fail("MXPAGE_NOT_FOUND");
	}
	const format = args.format ?? "paths";
	if (format !== "paths" && format !== "zip") return fail("invalid format");
	try {
		const projectDir = record.workspaceDir;
		const sections = listOutputSections(projectDir);
		const files = sections.map((section) => section.outputPath);
		if (format === "paths") return {
			ok: true,
			format,
			files
		};
		const outputDir = assertInside(projectDir, join(projectDir, "output"));
		mkdirSync(outputDir, { recursive: true });
		const iso = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const zipPath = assertInside(projectDir, join(outputDir, `export-${iso}.zip`));
		const zipEntries = [];
		for (const section of sections) {
			const abs = assertInside(projectDir, section.outputPath);
			if (!existsSync(abs)) continue;
			zipEntries.push({
				name: zipEntryName(abs),
				data: readFileSync(abs)
			});
		}
		const analysisPath = assertInside(projectDir, join(projectDir, "analysis.json"));
		if (existsSync(analysisPath)) zipEntries.push({
			name: "analysis.json",
			data: readFileSync(analysisPath)
		});
		writeStoreZip(zipPath, zipEntries);
		return {
			ok: true,
			format,
			files,
			zipPath
		};
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}
//#endregion
//#region src/tools/export.ts
const FORMATS = ["paths", "zip"];
function exportPageTool(opts) {
	return defineTool({
		name: "mxpage_export_page",
		description: "List generated section PNG paths or zip them with analysis.json. format defaults to paths. Zip is written to output/export-<iso>.zip.",
		parameters: {
			project_id: {
				type: "string",
				required: true,
				description: "Existing mxpage project id"
			},
			format: {
				type: "string",
				enum: FORMATS,
				description: "paths (default) or zip"
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
			return exportPage({ store: opts.store }, {
				projectId: args.project_id,
				format: args.format
			});
		}
	});
}
//#endregion
//#region src/tools/job.ts
const liveJobs = /* @__PURE__ */ new Map();
function progressPath(projectDir, jobId) {
	const safeId = basename(jobId);
	if (safeId !== jobId || jobId.includes("..")) throw new Error(`path escapes project root: ${jobId}`);
	const dir = assertInside(projectDir, join(projectDir, "tasks"));
	return assertInside(projectDir, join(dir, `${safeId}.json`));
}
function registerLiveJob(jobId, rec) {
	liveJobs.set(jobId, rec);
}
function getLiveJob(jobId) {
	return liveJobs.get(jobId);
}
function writeJobProgress(projectDir, jobId, data) {
	const dir = assertInside(projectDir, join(projectDir, "tasks"));
	mkdirSync(dir, { recursive: true });
	const file = progressPath(projectDir, jobId);
	const progress = Math.min(1, Math.max(0, data.progress));
	const payload = {
		state: data.state,
		progress,
		currentSection: data.currentSection
	};
	if (data.error) payload.error = redactSecrets(data.error);
	writeFileSync(file, JSON.stringify(payload));
}
function readJobProgress(projectDir, jobId) {
	const file = progressPath(projectDir, jobId);
	if (!existsSync(file)) return void 0;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (!raw || typeof raw !== "object") return void 0;
		const state = raw.state;
		if (state !== "running" && state !== "stopping" && state !== "completed" && state !== "killed" && state !== "failed") return void 0;
		return {
			state,
			progress: typeof raw.progress === "number" ? raw.progress : 0,
			currentSection: typeof raw.currentSection === "string" ? raw.currentSection : "",
			...typeof raw.error === "string" ? { error: raw.error } : {}
		};
	} catch {
		return;
	}
}
function jobStatusTool(opts) {
	return defineTool({
		name: "mxpage_job_status",
		description: "Read mxpage background job progress (state, progress 0–1, currentSection). Pass job_id from mxpage_generate_page.",
		parameters: {
			job_id: {
				type: "string",
				required: true,
				description: "Job id returned by mxpage_generate_page"
			},
			project_id: {
				type: "string",
				description: "Optional project id to locate tasks/<jobId>.json"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: renderJsonAndImages
		},
		execute: async (args, exec) => {
			const jobId = args.job_id;
			const live = getLiveJob(jobId);
			let file;
			let projectId = args.project_id;
			if (live) {
				file = readJobProgress(live.projectDir, jobId);
				projectId = projectId || live.projectId;
			} else if (args.project_id) try {
				file = readJobProgress(opts.store.read(args.project_id).workspaceDir, jobId);
			} catch {
				file = void 0;
			}
			let snapshot;
			try {
				snapshot = opts.jobs?.get?.(jobId, exec.agent);
			} catch {
				snapshot = void 0;
			}
			if (!file && !snapshot) return {
				ok: false,
				error: "MXPAGE_NOT_FOUND"
			};
			const error = file?.error ?? snapshot?.detail;
			let outputs = [];
			if (projectId) try {
				outputs = opts.store.read(projectId).outputs ?? [];
			} catch {
				outputs = [];
			}
			return {
				ok: true,
				state: snapshot?.status ?? file?.state ?? "running",
				progress: file?.progress ?? 0,
				currentSection: file?.currentSection ?? "",
				...error ? { error } : {},
				...outputs.length > 0 ? { outputs } : {}
			};
		}
	});
}
function jobCancelTool(opts) {
	return defineTool({
		name: "mxpage_job_cancel",
		description: "Cancel an mxpage page job. Completed section files are kept. Pass job_id from mxpage_generate_page.",
		parameters: {
			job_id: {
				type: "string",
				required: true,
				description: "Job id returned by mxpage_generate_page"
			},
			reason: {
				type: "string",
				description: "Optional cancel reason"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: textRender
		},
		execute: async (args, exec) => {
			const jobId = args.job_id;
			const live = getLiveJob(jobId);
			live?.abort.abort(args.reason);
			if (live) {
				const prev = readJobProgress(live.projectDir, jobId);
				writeJobProgress(live.projectDir, jobId, {
					state: "stopping",
					progress: prev?.progress ?? 0,
					currentSection: prev?.currentSection ?? "",
					...prev?.error ? { error: prev.error } : {}
				});
			}
			let result = live ? "requested" : "already-finished";
			if (opts.jobs?.kill) try {
				result = opts.jobs.kill(jobId, exec.agent, args.reason);
			} catch {}
			return {
				ok: true,
				jobId,
				result
			};
		}
	});
}
//#endregion
//#region src/tools/generate-page.ts
const PAGE_KIND = "mxpage_page";
const MISSING_KEY$1 = "未配置图像 API Key（环境变量 MXPAGE_IMAGE_API_KEY）";
function abortError(message = "已取消") {
	const err = new Error(message);
	err.name = "AbortError";
	return err;
}
function isAbortErr(err, signal) {
	if (signal?.aborted) return true;
	if (!err || typeof err !== "object") return false;
	const rec = err;
	return rec.name === "AbortError" || rec.message === "已取消";
}
function tryStatus(store, projectId, status) {
	try {
		store.write(projectId, { status });
	} catch {}
}
function resolveImages$1(config, injected) {
	if (injected) return injected;
	return imagesClientFromEnv(config);
}
async function withSectionLock(locks, key, fn) {
	const prev = locks.get(key) ?? Promise.resolve();
	let release;
	const curr = new Promise((resolve) => {
		release = resolve;
	});
	locks.set(key, prev.then(() => curr, () => curr));
	try {
		await prev.catch(() => void 0);
		await fn();
	} finally {
		release();
	}
}
async function runPool(keys, limit, signal, worker) {
	if (keys.length === 0) return;
	const conc = Math.max(1, limit);
	let index = 0;
	let failed;
	const runWorker = async () => {
		while (true) {
			if (signal.aborted) throw abortError();
			if (failed) return;
			const i = index++;
			if (i >= keys.length) return;
			try {
				await worker(keys[i]);
			} catch (err) {
				failed = err;
				throw err;
			}
		}
	};
	const results = await Promise.allSettled(Array.from({ length: Math.min(conc, keys.length) }, () => runWorker()));
	if (signal.aborted) throw abortError();
	const rejected = results.find((result) => result.status === "rejected");
	if (rejected) throw rejected.reason;
}
async function runPageJob(deps, args, jobId, signal) {
	const projectDir = deps.store.read(args.projectId).workspaceDir;
	let lastProgress = 0;
	const persist = (state, progress, currentSection, error) => {
		lastProgress = progress;
		writeJobProgress(projectDir, jobId, {
			state,
			progress,
			currentSection,
			...error ? { error } : {}
		});
	};
	persist("running", 0, "");
	const locks = /* @__PURE__ */ new Map();
	try {
		if (signal.aborted) throw abortError();
		const rec = deps.store.read(args.projectId);
		if (!(Boolean(readAnalysisFile(rec.workspaceDir)) || rec.status === "analyzed" || rec.status === "planned" || rec.status === "generating" || rec.status === "generated")) {
			persist("running", .05, "analyze");
			const analyzed = await analyzeProduct({
				store: deps.store,
				completeJson: deps.completeJson
			}, { projectId: args.projectId }, signal);
			if (!analyzed.ok) throw new Error(analyzed.error);
		}
		persist("running", .1, "analyze");
		if (signal.aborted) throw abortError();
		const planExisting = readPlanFile(deps.store.read(args.projectId).workspaceDir);
		if (!Boolean(planExisting && planExisting.sections.length > 0)) {
			persist("running", .12, "plan");
			const planned = await planPage({
				store: deps.store,
				config: deps.config,
				completeJson: deps.completeJson
			}, { projectId: args.projectId }, signal);
			if (!planned.ok) throw new Error(planned.error);
		}
		persist("running", .2, "plan");
		const latest = deps.store.read(args.projectId);
		const plan = readPlanFile(latest.workspaceDir);
		if (!plan || plan.sections.length === 0) throw new Error("MXPAGE_STATE");
		const outputDir = join(latest.workspaceDir, "output");
		const requested = args.sectionKeys;
		const selected = requested?.length ? plan.sections.filter((section) => requested.includes(section.sectionKey)) : plan.sections.filter((section) => !existsSync(join(outputDir, `${section.sectionKey}.png`)));
		const heroes = selected.filter((section) => section.type === "hero" || section.sectionKey.startsWith("hero_"));
		const details = selected.filter((section) => !heroes.includes(section));
		const total = heroes.length + details.length;
		let completed = 0;
		if (latest.status !== "generating") tryStatus(deps.store, latest.id, "generating");
		const generateOne = async (sectionKey) => {
			await withSectionLock(locks, sectionKey, async () => {
				if (signal.aborted) throw abortError();
				persist("running", total === 0 ? .2 : .2 + .8 * (completed / total), sectionKey);
				const result = await generateSection({
					store: deps.store,
					storeRoot: deps.storeRoot,
					config: deps.config,
					images: deps.images,
					saveImage: deps.saveImage,
					completeJson: deps.completeJson
				}, {
					projectId: args.projectId,
					sectionKey
				}, signal);
				if (!result.ok) throw new Error(result.error);
				completed += 1;
				persist("running", total === 0 ? 1 : .2 + .8 * (completed / total), sectionKey);
			});
		};
		const parallel = deps.config.maxParallelSections || 2;
		await runPool(heroes.map((section) => section.sectionKey), parallel, signal, generateOne);
		if (signal.aborted) throw abortError();
		await runPool(details.map((section) => section.sectionKey), parallel, signal, generateOne);
		tryStatus(deps.store, args.projectId, "generated");
		persist("completed", 1, "");
	} catch (err) {
		const aborted = isAbortErr(err, signal);
		persist(aborted ? "killed" : "failed", lastProgress, "", redactSecrets(err instanceof Error ? err.message : String(err)));
		if (!aborted) tryStatus(deps.store, args.projectId, "failed");
		if (aborted) throw abortError(err instanceof Error ? err.message : "已取消");
		throw err instanceof Error ? err : new Error(String(err));
	}
}
function generatePageTool(opts) {
	return defineTool({
		name: "mxpage_generate_page",
		description: "Generate ecommerce page images (analyze → plan → heroes → details). Starts a cancellable background job, waits until it finishes, and returns output attachment refs. Use section_keys for a subset (e.g. [\"hero_01\"] for a single 主图). Consumes image API quota.",
		parameters: {
			project_id: {
				type: "string",
				required: true,
				description: "Existing mxpage project id"
			},
			section_keys: {
				type: "array",
				items: { type: "string" },
				description: "Optional subset of section keys; default is planned sections missing output/<key>.png"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: renderJsonAndImages
		},
		timeoutMs: 18e4,
		isConcurrencySafe: () => false,
		execute: async (args, exec) => {
			const images = resolveImages$1(opts.config, opts.images);
			if (images === void 0) return {
				ok: false,
				error: MISSING_KEY$1
			};
			if (!opts.jobs?.start) throw new Error("请加载 @deepseek-ai/dsh-jobs");
			if (exec.signal.aborted) throw abortError();
			let record;
			try {
				record = opts.store.read(args.project_id);
			} catch {
				return {
					ok: false,
					error: "MXPAGE_NOT_FOUND"
				};
			}
			const ac = new AbortController();
			const projectId = args.project_id;
			const sectionKeys = args.section_keys;
			const pageDeps = {
				store: opts.store,
				storeRoot: opts.storeRoot,
				config: opts.config,
				images,
				saveImage: opts.saveImage,
				completeJson: opts.completeJson
			};
			let resolveStart;
			let rejectStart;
			const work = new Promise((res, rej) => {
				resolveStart = res;
				rejectStart = rej;
			}).then((id) => runPageJob(pageDeps, {
				projectId,
				sectionKeys
			}, id, ac.signal));
			work.catch(() => {});
			const onAbort = () => ac.abort("tool-aborted");
			exec.signal.addEventListener("abort", onAbort, { once: true });
			try {
				const jobId = opts.jobs.start({
					kind: PAGE_KIND,
					label: `mxpage page ${projectId}`,
					...exec.agent ? { owner: exec.agent } : {},
					run: () => ({
						cancel: (reason) => ac.abort(reason),
						done: work.then(() => ({ status: "completed" }), (err) => {
							return {
								status: isAbortErr(err, ac.signal) ? "killed" : "failed",
								detail: redactSecrets(String(err instanceof Error ? err.message : err))
							};
						})
					})
				});
				registerLiveJob(jobId, {
					projectId: record.id,
					projectDir: record.workspaceDir,
					abort: ac
				});
				resolveStart(jobId);
				const outcome = await work.then(() => ({
					status: "completed",
					detail: void 0
				}), (err) => {
					return {
						status: isAbortErr(err, ac.signal) ? "killed" : "failed",
						detail: redactSecrets(String(err instanceof Error ? err.message : err))
					};
				});
				if (exec.signal.aborted) throw abortError(outcome.detail);
				const outputs = opts.store.read(projectId).outputs ?? [];
				if (outcome.status !== "completed") return {
					ok: false,
					jobId,
					projectId,
					state: outcome.status,
					error: outcome.detail ?? outcome.status,
					outputs
				};
				return {
					ok: true,
					jobId,
					projectId,
					state: "completed",
					outputs
				};
			} catch (err) {
				if (!ac.signal.aborted) ac.abort();
				if (err instanceof Error && err.name === "AbortError") throw err;
				rejectStart(err);
				throw err;
			} finally {
				exec.signal.removeEventListener("abort", onAbort);
			}
		}
	});
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
			render: renderJsonAndImages
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
	return imagesClientFromEnv(config);
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
		description: "Read-only mxpage project status. Safe to call at status=created, before analyze. Returns assets, generated sections, and image attachment refs for the GUI.",
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
			render: renderJsonAndImages
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
				sections: listOutputSections(record.workspaceDir),
				outputs: record.outputs ?? []
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
		llm: deps?.llm,
		config,
		saveImage
	});
	const toolSaveImage = (input) => ctx.attachments.saveImage(input);
	const attachments = {
		readImage: ctx.attachments.readImage?.bind(ctx.attachments),
		imageHostPath: ctx.attachments.imageHostPath?.bind(ctx.attachments)
	};
	ctx.tools.register(createProjectTool({
		store,
		storeRoot,
		config,
		attachments
	}));
	ctx.tools.register(addAssetTool({
		store,
		storeRoot,
		attachments
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
		saveImage: toolSaveImage,
		images: deps?.images,
		completeJson
	}));
	ctx.tools.register(generatePageTool({
		store,
		storeRoot,
		config,
		saveImage: toolSaveImage,
		images: deps?.images,
		completeJson,
		jobs: ctx.jobs
	}));
	ctx.tools.register(editSectionTool({
		store,
		storeRoot,
		config,
		saveImage: toolSaveImage,
		images: deps?.images
	}));
	ctx.tools.register(exportPageTool({ store }));
	ctx.tools.register(jobStatusTool({
		store,
		jobs: ctx.jobs
	}));
	ctx.tools.register(jobCancelTool({ jobs: ctx.jobs }));
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
	registerMxpageTools(ctx, config, { llm: ctx.get("llm") });
}
//#endregion
export { Config, apply, inject, name };

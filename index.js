import Schema from "@deepseek-ai/schemastery";
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
//#region src/index.ts
const name = "mxpage";
const inject = [
	"tools",
	"attachments",
	"jobs"
];
function apply(_ctx, _config) {}
//#endregion
export { Config, apply, inject, name };

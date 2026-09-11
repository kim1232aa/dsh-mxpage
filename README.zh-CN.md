# dsh-mxpage

[English](./README.md) | 简体中文

把 [MxPage](https://github.com/ziguishian/MxPage) 的电商生图流水线做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **原生插件**：

**登记商品图 → 分析卖点 → 规划头图/详情 → Visual Prompt Agent → 分镜生图**

不是又一个通用生图插件。工具名全部 `mxpage_*`。装进官方 **`web` profile**，不要用 `sdk-minimal`。

当前状态：**文档已齐，实现进行中。** 已对照 `@deepseek-ai/dsh@0.1.5-rc.1`。

## 文档

先读 [docs/requirements.md](docs/requirements.md) 和 [规范调查](docs/guides/dsh-plugin-spec-investigation.md)。

对话验收：「根据这张商品图出一套淘宝详情页」→ ≥1 张头图 + ≥3 张详情，附件 + 工作区文件。

## 安装（P0 之后）

```sh
dsh plugin --profile web add github:kim1232aa/dsh-mxpage
export MXPAGE_IMAGE_API_KEY=sk-...
```

密钥只走环境变量。

## 许可

MIT。MxPage 提示词/schema 为 MIT（灵矩绘境），见 [NOTICE](./NOTICE)。**不是** DeepSeek 官方产品。

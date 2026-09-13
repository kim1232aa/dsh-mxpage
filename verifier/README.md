# Verifier index

Append-only. One entry per version.

- **v1** （创建 2026-09-13): `v1/criteria.md` — MxPage UI/能力无缝集成验收标准。覆盖上游能力对齐 A1–A10、红线 B1–B5、工程验证 C1–C4、交付 D1–D3。基线为 v0.2.0（51/51 测试，构建通过）。
  运行记录见 `runs/`（命令 + 退出码 + 关键输出，含未发布的中间运行）。
  最终运行 `runs/2026-09-14T0235Z-final.txt`：构建绿，**64/64 测试通过**，v0.3.0 全项满足后交付。
  推送验证 `runs/2026-09-14T2013Z-push-verification.txt`：`git push --force-with-lease` 至 origin/main（63600f9），fresh clone `diff -r` 与本地树零差异，字节级一致。

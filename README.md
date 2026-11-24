# PTE 备考进度调度器

一个记录 PTE 备考进度、计算每日任务的应用。生产环境的云端进度是唯一权威；本机只保留运行中的计时和等待云端确认时供人工恢复的草稿。

## 功能

- Vue 3 + TypeScript + Vite 单页应用
- 本地开发使用 localStorage 保存测试进度，生产环境从 Cloudflare D1 拉取进度
- Cloudflare Pages Functions 按云端修订号保存每次修改，过期页面无法覆盖较新的云端进度
- 访问密码由 Cloudflare Pages Secret `APP_PASSWORD` 提供，前端不写死密码
- 使用单一备考总计划，可安排多个模考日
- 数量型任务可手动开启错题轮刷，背诵型任务继续按篇目与熟悉度记录
- 自动计算当前任务或当前轮的今日建议量和整体进度

## 本地开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

## Cloudflare Pages 部署

Cloudflare Pages 连接 GitHub `main` 分支后自动部署。项目使用根路径部署，`vite.config.ts` 中保持 `base: '/'` 或不设置 `base`。

Cloudflare Pages 项目需要配置：

- D1 database：`pte_progress_db`，binding name：`PROGRESS_DB`
- KV namespace：`PTE_PROGRESS`，binding name：`PROGRESS_KV`，仅供迁移校验和旧数据备份
- Secret：`APP_PASSWORD`
- Text variable：`MIGRATION_SHA256`，切换前从最终 KV 导出文件计算 SHA-256；只有 KV 原始内容与此值完全一致时才导入 D1

Pages Functions 接口位于 `functions/api/progress.js`，前端只通过 `/api/progress` 读写进度。旧版页面提交的整份进度会被拒绝。首次迁移后保留 KV 不再写入；每次编辑会立即暂存待确认草稿，云端成功回执后清除。刷新后先读取云端，若草稿尚未确认且云端版本未变化，可手动重试；版本已变化时保留草稿供下载和人工核对，不会自动覆盖云端。

# PTE 备考进度调度器

一个只负责记录 PTE 备考进度、计算每日任务的前端应用。它不是刷题平台，不上传题库；本地优先保存，Cloudflare KV 只用于跨设备备份。

## 功能

- Vue 3 + TypeScript + Vite 单页应用
- localStorage 保存本地计划和进度，key 为 `pte_progress_backup`
- Cloudflare Pages Functions + Cloudflare KV 自动同步完整进度
- 访问密码由 Cloudflare Pages Secret `APP_PASSWORD` 提供，前端不写死密码
- 支持 phased_pool、fixed_pool、daily_fixed、memorization 策略
- 支持 adaptive_average、none、next_day carryoverMode
- 自动计算阶段日期、当前阶段、今日建议任务量和整体进度

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

- KV namespace：`PTE_PROGRESS`
- KV binding name：`PROGRESS_KV`
- Secret：`APP_PASSWORD`

Pages Functions 接口位于 `functions/api/progress.js`，前端只通过 `/api/progress` 读写进度。

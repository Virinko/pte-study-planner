# PTE 备考进度调度器

一个只负责记录 PTE 备考进度、计算每日任务的前端应用。它不是刷题平台，不上传题库，不需要后端、云服务器或数据库。

## 功能

- Vue 3 + TypeScript + Vite 单页应用
- localStorage 保存本地计划和进度
- 通过 GitHub REST Contents API 读写另一个私有仓库中的 `data.json`
- Token 每次同步手动输入，输入后仅临时使用，不写入代码、`.env`、localStorage、sessionStorage 或 data.json
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

## GitHub Pages 部署步骤

1. 将本仓库推送到 GitHub，例如仓库名为 `pte-study-planner`。
2. 安装依赖并构建：
   ```bash
   npm install
   npm run build
   ```
3. 部署到 `gh-pages` 分支：
   ```bash
   npm run deploy
   ```
4. 打开 GitHub 仓库 Settings → Pages。
5. Source 选择 `Deploy from a branch`，Branch 选择 `gh-pages` 和 `/root`。
6. 保存后访问 GitHub Pages 地址：`https://<owner>.github.io/pte-study-planner/`。

如果仓库名不是 `pte-study-planner`，请修改 `vite.config.ts` 中的 `base`。

## 数据仓库建议

创建一个私有仓库，默认名为 `pte-study-data`，在 `main` 分支放置 `data.json`。fine-grained personal access token 仅需授权该私有数据仓库 Contents 读写权限。

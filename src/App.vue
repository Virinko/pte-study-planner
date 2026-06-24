<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { buildSchedule, currentPhase, daysBetweenInclusive, defaultData, pct, taskSuggestion, todayIso } from './planner';
import { fetchGitHubData, saveGitHubData } from './github';
import type { CarryoverMode, Phase, PhaseSchedule, StrategyType, StudyData, Task } from './types';

const KEY = 'pte-study-planner-data';
const GITHUB_KEY = 'pte-study-planner-github-config';
const strategies: StrategyType[] = ['phased_pool', 'fixed_pool', 'daily_fixed', 'memorization'];
const modes: CarryoverMode[] = ['adaptive_average', 'none', 'next_day'];
const tabs = [
  ['today', '今日任务'],
  ['progress', '整体进度'],
  ['settings', '计划设置'],
  ['sync', 'GitHub 同步'],
] as const;

const strategyLabels: Record<StrategyType, string> = {
  phased_pool: '分阶段题库',
  fixed_pool: '固定范围题库',
  daily_fixed: '每日固定训练',
  memorization: '背诵熟悉型',
};

const carryoverLabels: Record<CarryoverMode, string> = {
  adaptive_average: '动态均摊',
  none: '不累计',
  next_day: '累计到第二天',
};

function normalizeData(source?: Partial<StudyData>): StudyData {
  const base = defaultData();
  const settings = { ...base.settings, ...source?.settings };
  const phases = (source?.phases ?? base.phases).map((phase, index) => ({
    ...phase,
    order: phase.order ?? index + 1,
    startDate: phase.startDate || (index === 0 ? settings.startDate : undefined),
    endDate: phase.endDate || (index === 0 ? addDays(settings.deadline, -Math.max(0, settings.bufferDays)) : undefined),
  }));
  return {
    ...base,
    ...source,
    settings,
    phases,
    tasks: source?.tasks ?? base.tasks,
    dailyLogs: source?.dailyLogs ?? base.dailyLogs,
  };
}

function load(): StudyData {
  try {
    const raw = localStorage.getItem(KEY);
    const cfg = localStorage.getItem(GITHUB_KEY);
    const data = normalizeData(raw ? JSON.parse(raw) as Partial<StudyData> : undefined);
    return {
      ...data,
      settings: {
        ...data.settings,
        ...(cfg ? JSON.parse(cfg) as Partial<StudyData['settings']> : {}),
      },
    };
  } catch {
    return defaultData();
  }
}

const data = ref<StudyData>(load());
const tab = ref<(typeof tabs)[number][0]>('today');
const showTokenModal = ref(false);
const tokenInput = ref('');
const tokenField = ref<HTMLInputElement | null>(null);
let tokenResolver: ((token: string) => void) | null = null;

const schedule = computed(() => buildSchedule(data.value));
const phase = computed(() => currentPhase(schedule.value));
const todayTasks = computed(() => data.value.tasks.filter((task) => task.phaseId === phase.value?.id));
const ghConfig = computed(() => ({
  owner: data.value.settings.githubOwner,
  repo: data.value.settings.githubRepo,
  branch: data.value.settings.githubBranch,
  path: data.value.settings.githubPath,
}));
const todayLogs = computed(() => data.value.dailyLogs[todayIso()] || []);
const todayLogByTask = computed(() => todayLogs.value.reduce<Record<string, number>>((result, log) => {
  result[log.taskId] = (result[log.taskId] || 0) + log.amount;
  return result;
}, {}));
const todayLogTotal = computed(() => todayLogs.value.reduce((sum, log) => sum + log.amount, 0));
const overallDone = computed(() => data.value.tasks.reduce((sum, task) => sum + task.completed, 0));
const overallTarget = computed(() => data.value.tasks.reduce((sum, task) => sum + task.target, 0));
const overallPercent = computed(() => pct(overallDone.value, overallTarget.value));
const totalRemaining = computed(() => Math.max(0, overallTarget.value - overallDone.value));
const daysLeft = computed(() => daysBetweenInclusive(todayIso(), data.value.settings.deadline));
const lastSyncedAt = computed(() => data.value.updatedAt ? new Date(data.value.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未同步');

const todayTaskRows = computed(() => todayTasks.value.map((task, index) => {
  const todayCompleted = todayLogByTask.value[task.id] || 0;
  const baselineTask = { ...task, completed: Math.max(0, task.completed - todayCompleted) };
  const dailyTarget = taskSuggestion(baselineTask, phase.value);
  const remainingToday = Math.max(0, dailyTarget - todayCompleted);
  const doneToday = dailyTarget > 0 ? todayCompleted >= dailyTarget : task.target > 0 && task.completed >= task.target;
  return {
    ...task,
    accent: taskAccent(index),
    initials: taskInitials(task.name),
    percent: pct(task.completed, task.target),
    remaining: Math.max(0, task.target - task.completed),
    todayCompleted,
    dailyTarget,
    remainingToday,
    doneToday,
  };
}));
const todayTarget = computed(() => todayTaskRows.value.reduce((sum, task) => sum + task.dailyTarget, 0));
const todayPercent = computed(() => pct(todayLogTotal.value, todayTarget.value));
const todayPendingRows = computed(() => todayTaskRows.value.filter((task) => !task.doneToday));
const todayDoneRows = computed(() => todayTaskRows.value.filter((task) => task.doneToday));

const phaseProgress = computed(() => schedule.value.map((item, index) => {
  const tasks = data.value.tasks.filter((task) => task.phaseId === item.id);
  const done = tasks.reduce((sum, task) => sum + task.completed, 0);
  const target = tasks.reduce((sum, task) => sum + task.target, 0);
  return { ...item, done, target, percent: pct(done, target), accent: phaseAccent(index) };
}));

const taskGroups = computed(() => phaseProgress.value.map((phase) => ({
  phase,
  tasks: data.value.tasks.filter((task) => task.phaseId === phase.id),
})));

const taskProgressRows = computed(() => data.value.tasks.map((task, index) => ({
  ...task,
  accent: taskAccent(index),
  initials: taskInitials(task.name),
  percent: pct(task.completed, task.target),
  remaining: Math.max(0, task.target - task.completed),
})));

const trendRows = computed(() => {
  const rows = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(todayIso(), index - 6);
    const total = (data.value.dailyLogs[date] || []).reduce((sum, log) => sum + log.amount, 0);
    return { date, label: date.slice(5), total };
  });
  const max = Math.max(1, ...rows.map((row) => row.total));
  return rows.map((row) => ({ ...row, height: Math.max(8, Math.round((row.total / max) * 76)) }));
});

function saveLocal(next: StudyData) {
  const stamped = { ...normalizeData(next), updatedAt: new Date().toISOString() };
  data.value = stamped;
  localStorage.setItem(KEY, JSON.stringify(stamped));
  const { githubOwner, githubRepo, githubBranch, githubPath } = stamped.settings;
  localStorage.setItem(GITHUB_KEY, JSON.stringify({ githubOwner, githubRepo, githubBranch, githubPath }));
}

function updateSettings(patch: Partial<StudyData['settings']>) {
  saveLocal({ ...data.value, settings: { ...data.value.settings, ...patch } });
}

function updatePhase(id: string, patch: Partial<Phase>) {
  saveLocal({ ...data.value, phases: data.value.phases.map((item) => item.id === id ? { ...item, ...patch } : item) });
}

function deletePhase(id: string) {
  saveLocal({
    ...data.value,
    phases: data.value.phases.filter((item) => item.id !== id),
    tasks: data.value.tasks.filter((task) => task.phaseId !== id),
  });
}

function addPhase() {
  const last = schedule.value[schedule.value.length - 1];
  const effectiveEnd = addDays(data.value.settings.deadline, -Math.max(0, data.value.settings.bufferDays));
  const startDate = last ? addDays(last.endDate, 1) : data.value.settings.startDate;
  const endDate = startDate > effectiveEnd ? startDate : effectiveEnd;
  saveLocal({
    ...data.value,
    phases: [...data.value.phases, { id: crypto.randomUUID(), name: '新阶段', order: data.value.phases.length + 1, startDate, endDate }],
  });
}

function updateTask(id: string, patch: Partial<Task>) {
  saveLocal({ ...data.value, tasks: data.value.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) });
}

function addTask(phaseId?: string) {
  const targetPhase = phase.value || schedule.value[0];
  saveLocal({
    ...data.value,
    tasks: [
      ...data.value.tasks,
      {
        id: crypto.randomUUID(),
        phaseId: phaseId || targetPhase?.id || data.value.phases[0]?.id || '',
        name: 'RS 超高频',
        strategy: 'phased_pool',
        target: 100,
        completed: 0,
        dailyFixed: 10,
        carryoverMode: 'adaptive_average',
      },
    ],
  });
}

function deleteTask(id: string) {
  saveLocal({ ...data.value, tasks: data.value.tasks.filter((task) => task.id !== id) });
}

function addAmount(task: Task, amount: number) {
  const completed = Math.max(0, amount);
  const date = todayIso();
  const log = data.value.dailyLogs[date] || [];
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((item) => item.id === task.id ? { ...item, completed: item.completed + completed } : item),
    dailyLogs: { ...data.value.dailyLogs, [date]: [...log, { taskId: task.id, amount: completed }] },
  });
}

function addManualAmount(task: Task) {
  addAmount(task, Number(prompt('输入完成量') || 0));
}

function plannedDailyTarget(task: Task, targetPhase: PhaseSchedule) {
  const startDate = todayIso() > targetPhase.startDate ? todayIso() : targetPhase.startDate;
  return taskSuggestion(task, targetPhase, startDate);
}

function askToken() {
  showTokenModal.value = true;
  tokenInput.value = '';
  void nextTick(() => tokenField.value?.focus());
  return new Promise<string>((resolve) => {
    tokenResolver = resolve;
  });
}

function resolveToken(token: string) {
  const resolve = tokenResolver;
  tokenResolver = null;
  tokenInput.value = '';
  showTokenModal.value = false;
  resolve?.(token);
}

async function pull() {
  let token = await askToken();
  if (!token) return;
  try {
    const remote = normalizeData((await fetchGitHubData(ghConfig.value, token)).data);
    const localNewer = data.value.updatedAt && remote.updatedAt && data.value.updatedAt > remote.updatedAt;
    if (localNewer && !confirm('本地数据比 GitHub 更新。确定使用 GitHub 数据覆盖本地？取消则停止同步。')) return;
    saveLocal(remote);
    alert('已从 GitHub 拉取数据');
  } catch (error) {
    alert(error instanceof Error ? error.message : '同步失败');
  } finally {
    token = '';
  }
}

async function push() {
  let token = await askToken();
  if (!token) return;
  try {
    const remote = normalizeData((await fetchGitHubData(ghConfig.value, token)).data);
    if (remote.updatedAt > data.value.updatedAt) {
      const choice = prompt('检测到 GitHub 数据更新。输入 1 使用 GitHub 覆盖本地；输入 2 使用本地覆盖 GitHub；其他取消');
      if (choice === '1') {
        saveLocal(remote);
        return;
      }
      if (choice !== '2') return;
    }
    const stamped = { ...data.value, updatedAt: new Date().toISOString() };
    await saveGitHubData(ghConfig.value, token, stamped);
    saveLocal(stamped);
    alert('已保存到 GitHub');
  } catch (error) {
    alert(error instanceof Error ? error.message : '同步失败');
  } finally {
    token = '';
  }
}

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function taskInitials(name: string) {
  const letters = name.match(/[A-Za-z]+/g)?.join('').slice(0, 3);
  return (letters || name.slice(0, 2) || 'T').toUpperCase();
}

function taskAccent(index: number) {
  return ['#1167d8', '#12a150', '#f26a00', '#744fd7', '#0f8ca0'][index % 5];
}

function phaseAccent(index: number) {
  return ['#1167d8', '#12a150', '#f26a00'][index % 3];
}
</script>

<template>
  <main>
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">P</span>
        <h1>PTE 备考进度调度器</h1>
      </div>
      <nav>
        <button
          v-for="[key, label] in tabs"
          :key="key"
          :class="{ active: tab === key }"
          type="button"
          @click="tab = key"
        >
          {{ label }}
        </button>
      </nav>
      <span class="bell">!</span>
    </header>

    <section v-if="tab === 'today'" class="page">
      <div class="metric-grid">
        <article class="metric-card">
          <span class="metric-icon blue">□</span>
          <p>今天</p>
          <strong>{{ todayIso() }}</strong>
        </article>
        <article class="metric-card wide">
          <span class="metric-icon green">F</span>
          <p>当前阶段</p>
          <strong>{{ phase?.name || '暂无阶段' }}</strong>
        </article>
        <article class="metric-card">
          <span class="metric-icon orange">D</span>
          <p>距截止</p>
          <strong>{{ daysLeft }} 天</strong>
        </article>
        <article class="metric-card">
          <span class="metric-icon violet">≡</span>
          <p>今日总任务</p>
          <strong>{{ todayTarget }}</strong>
        </article>
      </div>

      <section class="panel">
        <div class="section-heading">
          <h2>今日待完成</h2>
          <span class="list-count">{{ todayPendingRows.length }} 项待完成</span>
        </div>
        <div v-if="todayTaskRows.length === 0" class="empty-state">
          <strong>今天还没有任务</strong>
          <p>在计划设置里添加任务后，这里会按当前阶段显示今日建议量。</p>
          <button type="button" @click="tab = 'settings'">去添加任务</button>
        </div>
        <div v-else-if="todayPendingRows.length === 0" class="empty-state compact">
          <strong>今日任务已完成</strong>
          <p>所有题型都已达到今日建议量，可以继续追加练习，或明天再看新的动态均摊建议。</p>
        </div>
        <article v-for="task in todayPendingRows" :key="task.id" class="task-row">
          <div class="task-badge" :style="{ background: task.accent }">{{ task.initials }}</div>
          <div class="task-main">
            <h3>{{ task.name }}</h3>
            <p>今日目标 {{ task.dailyTarget }} 项</p>
          </div>
          <div class="task-stat">
            <span>今日已做</span>
            <strong>{{ task.todayCompleted }} <small>/ {{ task.dailyTarget }}</small></strong>
          </div>
          <div class="task-stat">
            <span>今日剩余</span>
            <strong>{{ task.remainingToday }}</strong>
          </div>
          <div class="task-progress">
            <span>总进度 {{ task.percent }}%</span>
            <div class="progress slim"><span :style="{ width: `${pct(task.todayCompleted, task.dailyTarget)}%`, background: task.accent }" /></div>
          </div>
          <div class="quick-actions">
            <div>
              <button v-for="amount in [1, 5, 10]" :key="amount" class="ghost" type="button" @click="addAmount(task, amount)">+{{ amount }}</button>
            </div>
            <button class="ghost manual" type="button" @click="addManualAmount(task)">手动输入</button>
          </div>
        </article>
      </section>

      <section v-if="todayDoneRows.length > 0" class="panel done-panel">
        <div class="section-heading">
          <h2>今日已完成</h2>
          <span class="list-count done">{{ todayDoneRows.length }} 项</span>
        </div>
        <article v-for="task in todayDoneRows" :key="task.id" class="done-row">
          <div class="mini-badge" :style="{ background: task.accent }">{{ task.initials }}</div>
          <div>
            <strong>{{ task.name }}</strong>
            <small>今日完成 {{ task.todayCompleted }} / {{ task.dailyTarget }}，总进度 {{ task.completed }} / {{ task.target }}</small>
          </div>
          <button class="ghost" type="button" @click="addManualAmount(task)">追加</button>
        </article>
      </section>

      <section class="panel today-summary">
        <strong>今日完成进度</strong>
        <div class="progress"><span :style="{ width: `${todayPercent}%` }" /></div>
        <b>{{ todayPercent }}%</b>
        <p>继续加油，稳步前进！</p>
      </section>
    </section>

    <section v-else-if="tab === 'progress'" class="page">
      <div class="progress-layout">
        <section class="panel hero-progress">
          <div class="ring" :style="{ '--percent': `${overallPercent}%` }">
            <strong>{{ overallPercent }}%</strong>
          </div>
          <div>
            <p>总进度</p>
            <h2>{{ overallDone }} <small>/ {{ overallTarget }}</small></h2>
            <span>{{ overallPercent }}%</span>
            <p>已完成 {{ overallDone }} 项/页，共 {{ overallTarget }} 项/页</p>
          </div>
          <div class="trend-card">
            <h3>近 7 天完成趋势</h3>
            <div class="bars">
              <div v-for="row in trendRows" :key="row.date">
                <span :style="{ height: `${row.height}px` }" />
                <small>{{ row.label }}</small>
              </div>
            </div>
          </div>
        </section>

        <section class="panel">
          <h2>阶段进度</h2>
          <article v-for="item in phaseProgress" :key="item.id" class="compact-row">
            <div>
              <strong>{{ item.name }}</strong>
              <small>{{ item.done }} / {{ item.target }}</small>
            </div>
            <div class="progress slim"><span :style="{ width: `${item.percent}%`, background: item.accent }" /></div>
            <b>{{ item.percent }}%</b>
          </article>
        </section>

        <section class="panel">
          <h2>题型任务进度</h2>
          <article v-for="task in taskProgressRows" :key="task.id" class="compact-row task-compact">
            <div class="mini-badge" :style="{ background: task.accent }">{{ task.initials }}</div>
            <div>
              <strong>{{ task.name }}</strong>
              <small>{{ task.completed }} / {{ task.target }}</small>
            </div>
            <div class="progress slim"><span :style="{ width: `${task.percent}%`, background: task.accent }" /></div>
            <b>{{ task.percent }}%</b>
          </article>
          <p v-if="taskProgressRows.length === 0" class="muted">暂无任务，整体进度按 0% 显示。</p>
        </section>

        <section class="panel stat-strip">
          <article><span>当前总任务</span><strong>{{ overallTarget }}</strong></article>
          <article><span>已完成</span><strong>{{ overallDone }}</strong></article>
          <article><span>剩余</span><strong>{{ totalRemaining }}</strong></article>
          <article><span>计划总天数</span><strong>{{ daysLeft }} 天</strong></article>
        </section>
      </div>
    </section>

    <section v-else-if="tab === 'settings'" class="page">
      <div class="settings-grid">
        <label class="setting-card">开始日期<input type="date" :value="data.settings.startDate" @input="updateSettings({ startDate: ($event.target as HTMLInputElement).value })"></label>
        <label class="setting-card">最终截止日期<input type="date" :value="data.settings.deadline" @input="updateSettings({ deadline: ($event.target as HTMLInputElement).value })"></label>
        <label class="setting-card">缓冲天数<input type="number" :value="data.settings.bufferDays" @input="updateSettings({ bufferDays: Number(($event.target as HTMLInputElement).value) })"></label>
      </div>

      <section class="panel">
        <div class="section-heading">
          <h2>阶段</h2>
          <button class="ghost strong" type="button" @click="addPhase">+ 新增阶段</button>
        </div>
        <div class="phase-cards">
          <article v-for="(item, index) in phaseProgress" :key="item.id" class="phase-card" :style="{ borderColor: item.accent }">
            <input :value="item.name" @input="updatePhase(item.id, { name: ($event.target as HTMLInputElement).value })">
            <div class="phase-date-grid">
              <label>开始日期<input type="date" :value="item.startDate" @input="updatePhase(item.id, { startDate: ($event.target as HTMLInputElement).value })"></label>
              <label>结束日期<input type="date" :value="item.endDate" @input="updatePhase(item.id, { endDate: ($event.target as HTMLInputElement).value })"></label>
            </div>
            <p>阶段天数 <strong>{{ item.days }} 天</strong></p>
            <small>今日建议量会按本阶段剩余天数动态均摊。</small>
            <button class="text-button" type="button" @click="deletePhase(item.id)">删除阶段 {{ index + 1 }}</button>
          </article>
        </div>
      </section>

      <section class="panel">
        <h2>任务</h2>
        <div v-for="group in taskGroups" :key="group.phase.id" class="phase-task-block">
          <div class="section-heading phase-task-heading">
            <div>
              <h3>{{ group.phase.name }}</h3>
              <p>{{ group.phase.startDate }} ~ {{ group.phase.endDate }}，{{ group.phase.days }} 天</p>
            </div>
            <button class="ghost strong" type="button" @click="addTask(group.phase.id)">+ 新增本阶段任务</button>
          </div>
          <div class="task-table">
            <div class="task-table-head">
              <span>任务名称</span><span>策略类型</span><span>目标数量</span><span>已完成</span><span>每日固定</span><span>累积方式</span><span>今日建议</span><span>操作</span>
            </div>
            <div v-for="task in group.tasks" :key="task.id" class="task-table-row">
              <input :value="task.name" @input="updateTask(task.id, { name: ($event.target as HTMLInputElement).value })">
              <select
                :value="task.strategy"
                @change="updateTask(task.id, {
                  strategy: ($event.target as HTMLSelectElement).value as StrategyType,
                  carryoverMode: ($event.target as HTMLSelectElement).value === 'daily_fixed' ? 'none' : 'adaptive_average',
                })"
              >
                <option v-for="strategy in strategies" :key="strategy" :value="strategy">{{ strategyLabels[strategy] }}</option>
              </select>
              <input type="number" :value="task.target" @input="updateTask(task.id, { target: Number(($event.target as HTMLInputElement).value) })">
              <input type="number" :value="task.completed" @input="updateTask(task.id, { completed: Number(($event.target as HTMLInputElement).value) })">
              <input type="number" :value="task.dailyFixed" @input="updateTask(task.id, { dailyFixed: Number(($event.target as HTMLInputElement).value) })">
              <select :value="task.carryoverMode" @change="updateTask(task.id, { carryoverMode: ($event.target as HTMLSelectElement).value as CarryoverMode })">
                <option v-for="mode in modes" :key="mode" :value="mode">{{ carryoverLabels[mode] }}</option>
              </select>
              <strong>{{ plannedDailyTarget(task, group.phase) }}</strong>
              <button class="icon-button" type="button" @click="deleteTask(task.id)">删</button>
            </div>
            <p v-if="group.tasks.length === 0" class="muted">这个阶段还没有任务。新增任务后会只记录每日完成进度，不保存题库内容。</p>
          </div>
        </div>
        <p class="hint">提示：动态均摊 = Math.ceil(剩余任务量 / 当前阶段剩余有效练习天数)。如果今天少做，未完成量会在之后的剩余天数里重新均摊。</p>
      </section>
    </section>

    <section v-else-if="tab === 'sync'" class="page">
      <div class="sync-layout">
        <section class="panel sync-form">
          <label>GitHub 用户名 / Owner<input :value="data.settings.githubOwner" @input="updateSettings({ githubOwner: ($event.target as HTMLInputElement).value })"></label>
          <label>数据仓库名<input :value="data.settings.githubRepo" @input="updateSettings({ githubRepo: ($event.target as HTMLInputElement).value })"></label>
          <label>分支名<input :value="data.settings.githubBranch" @input="updateSettings({ githubBranch: ($event.target as HTMLInputElement).value })"></label>
          <label>数据文件路径<input :value="data.settings.githubPath" @input="updateSettings({ githubPath: ($event.target as HTMLInputElement).value })"></label>
          <p class="warn">Token 每次同步时手动输入，不保存到 localStorage、sessionStorage、data.json 或代码。</p>
        </section>
        <aside class="sync-actions">
          <section class="panel token-card">
            <h2>本次同步 Token</h2>
            <div class="fake-token">••••••••••••••</div>
            <p>点击同步按钮后弹窗输入，同步完成后立即清空。</p>
          </section>
          <button class="sync-button pull" type="button" @click="pull">从 GitHub 拉取数据</button>
          <button class="sync-button push" type="button" @click="push">保存到 GitHub</button>
        </aside>
      </div>
      <section class="panel sync-log">
        <div class="section-heading">
          <h2>同步记录</h2>
          <button class="text-button" type="button">查看全部记录</button>
        </div>
        <article>
          <span class="status-dot">OK</span>
          <div>
            <strong>最近本地保存</strong>
            <p>{{ lastSyncedAt }}</p>
          </div>
        </article>
      </section>
    </section>

    <div v-if="showTokenModal" class="modal">
      <form class="modal-box" @submit.prevent="resolveToken(tokenInput)">
        <h3>输入 GitHub Token</h3>
        <p>Token 不会被保存，同步结束后会清空。</p>
        <input ref="tokenField" v-model="tokenInput" name="token" type="password" autocomplete="off" placeholder="fine-grained personal access token">
        <div class="actions">
          <button type="submit">确认</button>
          <button class="ghost" type="button" @click="resolveToken('')">取消</button>
        </div>
      </form>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { buildSchedule, currentPhase, daysBetweenInclusive, defaultData, pct, taskCurrentRound, taskRemaining, taskRoundCompleted, taskSuggestion, taskTotalTarget, todayIso } from './planner';
import { fetchGitHubData, saveGitHubData } from './github';
import type { Familiarity, FrequencyType, Phase, PhaseSchedule, PracticePlatform, ReviewPlan, StudyData, SubItem, SubItemStatus, Task, TimeLogEntry, TimeLogType, TrackingMode } from './types';

const KEY = 'pte-study-planner-data';
const GITHUB_KEY = 'pte-study-planner-github-config';
const TIMER_KEY = 'pte-study-planner-running-timer';
const practicePlatforms: PracticePlatform[] = ['多墨', '猩际', '萤火虫', '影子三千'];
const frequencyTypes: FrequencyType[] = ['全题库', '超高频', '非超高频'];
const trackingModes: { value: TrackingMode; label: string }[] = [
  { value: 'count_only', label: '只记数量' },
  { value: 'itemized', label: '记录篇目' },
];
const familiarityOptions: Familiarity[] = ['生', '半熟', '熟', '可默写'];
const subItemStatusOptions: { value: SubItemStatus; label: string }[] = [
  { value: 'not_started', label: '未开始' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
];
const tabs = [
  ['today', '今日任务'],
  ['progress', '整体进度'],
  ['settings', '计划设置'],
  ['notes', '每日备注'],
  ['sync', 'GitHub 同步'],
] as const;
const sidebarItems: { key: (typeof tabs)[number][0]; label: string }[] = [
  { key: 'today', label: '今日任务' },
  { key: 'settings', label: '阶段计划与任务管理' },
  { key: 'progress', label: '进度总览与数据统计' },
  { key: 'notes', label: '每日备注' },
  { key: 'sync', label: '进度同步' },
];

interface RunningTimer {
  type: TimeLogType;
  taskId?: string;
  reviewPlanId?: string;
  name: string;
  date: string;
  startedAt: number;
  accumulatedSeconds: number;
  paused: boolean;
}

function normalizeData(source?: Partial<StudyData>): StudyData {
  const base = defaultData();
  const settings = normalizeSettings({ ...base.settings, ...source?.settings });
  const phases = (source?.phases ?? base.phases).map((phase, index) => ({
    ...phase,
    order: phase.order ?? index + 1,
    startDate: phase.startDate || (index === 0 ? settings.startDate : undefined),
    endDate: phase.endDate || (index === 0 ? addDays(settings.deadline, -Math.max(0, settings.bufferDays)) : undefined),
  }));
  const tasks = ((source?.tasks ?? base.tasks) as Array<Partial<Task>>).map((task) => normalizeTask(task, phases[0]?.id || ''));
  return {
    ...base,
    ...source,
    settings,
    phases,
    tasks,
    dailyLogs: source?.dailyLogs ?? base.dailyLogs,
    dailyNotes: source?.dailyNotes ?? base.dailyNotes,
    reviewPlans: normalizeReviewPlans(source?.reviewPlans ?? base.reviewPlans, tasks),
    timeLogs: normalizeTimeLogs(source?.timeLogs ?? base.timeLogs),
  };
}

function normalizeSettings(settings: StudyData['settings']): StudyData['settings'] {
  const fallback = defaultData().settings;
  return {
    ...settings,
    githubOwner: settings.githubOwner?.trim() || fallback.githubOwner,
    githubRepo: settings.githubRepo?.trim() || fallback.githubRepo,
    githubBranch: settings.githubBranch?.trim() || fallback.githubBranch,
    githubPath: settings.githubPath?.trim() || fallback.githubPath,
  };
}

function normalizeTask(task: Partial<Task>, fallbackPhaseId: string): Task {
  const name = task.name ?? 'RS';
  const trackingMode = isTrackingMode(task.trackingMode) ? task.trackingMode : inferTrackingMode(name);
  const subItems = (task.subItems || []).map(normalizeSubItem);
  const doneCount = subItems.filter((item) => item.status === 'done').length;
  const target = Number(task.target ?? subItems.length ?? 0);
  const repeatCount = trackingMode === 'itemized' ? 1 : Math.max(1, Math.floor(Number(task.repeatCount ?? 1)));
  const totalTarget = Math.max(0, target * repeatCount);
  const completed = trackingMode === 'itemized' && subItems.length > 0 ? doneCount : Number(task.completed ?? 0);
  return {
    id: task.id || crypto.randomUUID(),
    phaseId: task.phaseId || fallbackPhaseId,
    name,
    startDate: task.startDate || undefined,
    endDate: task.endDate || undefined,
    platform: isPracticePlatform(task.platform) ? task.platform : '多墨',
    frequencyType: isFrequencyType(task.frequencyType) ? task.frequencyType : inferFrequencyType(name),
    trackingMode,
    reviewEnabled: Boolean(task.reviewEnabled),
    subItems,
    target,
    repeatCount,
    completed: Math.min(Math.max(0, completed), totalTarget || Math.max(0, completed)),
  };
}

function normalizeReviewPlans(source: Partial<StudyData['reviewPlans']>, tasks: Task[]): StudyData['reviewPlans'] {
  return Object.entries(source || {}).reduce<StudyData['reviewPlans']>((acc, [date, plans]) => {
    const normalized = (plans || []).map((plan) => normalizeReviewPlan(plan, tasks)).filter((plan) => plan.target > 0 || plan.completed > 0);
    if (normalized.length) acc[date] = normalized;
    return acc;
  }, {});
}

function normalizeReviewPlan(plan: Partial<ReviewPlan>, tasks: Task[]): ReviewPlan {
  const task = tasks.find((item) => item.id === plan.taskId);
  return {
    id: plan.id || crypto.randomUUID(),
    taskId: plan.taskId || task?.id || '',
    taskName: plan.taskName || task?.name || '复习任务',
    sourceDate: plan.sourceDate || todayIso(),
    target: Math.max(0, Number(plan.target ?? 0)),
    completed: Math.max(0, Number(plan.completed ?? 0)),
  };
}

function normalizeTimeLogs(source: Partial<StudyData['timeLogs']>): StudyData['timeLogs'] {
  return Object.entries(source || {}).reduce<StudyData['timeLogs']>((acc, [date, logs]) => {
    const normalized = (logs || []).map((log) => normalizeTimeLog(log, date)).filter((log) => log.durationSeconds > 0);
    if (normalized.length) acc[date] = normalized;
    return acc;
  }, {});
}

function normalizeTimeLog(log: Partial<TimeLogEntry>, fallbackDate: string): TimeLogEntry {
  const type: TimeLogType = log.type === 'review' ? 'review' : 'task';
  return {
    id: log.id || crypto.randomUUID(),
    date: log.date || fallbackDate,
    type,
    taskId: log.taskId || '',
    reviewPlanId: log.reviewPlanId || '',
    name: log.name || (type === 'review' ? '复习计时' : '任务计时'),
    durationSeconds: Math.max(0, Math.floor(Number(log.durationSeconds || 0))),
    createdAt: log.createdAt || new Date().toISOString(),
  };
}

function normalizeSubItem(item: Partial<SubItem>): SubItem {
  return {
    id: item.id || crypto.randomUUID(),
    title: item.title ?? '新篇目',
    status: isSubItemStatus(item.status) ? item.status : 'not_started',
    familiarity: isFamiliarity(item.familiarity) ? item.familiarity : '生',
    round: Number(item.round ?? 0),
    completedDate: item.completedDate || '',
    note: item.note || '',
  };
}

function isPracticePlatform(value: unknown): value is PracticePlatform {
  return practicePlatforms.includes(value as PracticePlatform);
}

function isFrequencyType(value: unknown): value is FrequencyType {
  return frequencyTypes.includes(value as FrequencyType);
}

function isTrackingMode(value: unknown): value is TrackingMode {
  return value === 'count_only' || value === 'itemized';
}

function isSubItemStatus(value: unknown): value is SubItemStatus {
  return value === 'not_started' || value === 'doing' || value === 'done';
}

function isFamiliarity(value: unknown): value is Familiarity {
  return familiarityOptions.includes(value as Familiarity);
}

function inferFrequencyType(name: string): FrequencyType {
  if (name.includes('非超高频')) return '非超高频';
  if (name.includes('超高频')) return '超高频';
  return '全题库';
}

function inferTrackingMode(name: string): TrackingMode {
  const prefix = name.trim().match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  return prefix === 'WE' || prefix === 'SST' || prefix === 'RL' ? 'itemized' : 'count_only';
}

function load(): StudyData {
  try {
    const raw = localStorage.getItem(KEY);
    const cfg = localStorage.getItem(GITHUB_KEY);
    const data = normalizeData(raw ? JSON.parse(raw) as Partial<StudyData> : undefined);
    return {
      ...data,
      settings: normalizeSettings({
        ...data.settings,
        ...(cfg ? JSON.parse(cfg) as Partial<StudyData['settings']> : {}),
      }),
    };
  } catch {
    return defaultData();
  }
}

function loadRunningTimer(): RunningTimer | null {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (!raw) return null;
    const timer = JSON.parse(raw) as Partial<RunningTimer>;
    if (timer.type !== 'task' && timer.type !== 'review') return null;
    return {
      type: timer.type,
      taskId: timer.taskId || '',
      reviewPlanId: timer.reviewPlanId || '',
      name: timer.name || (timer.type === 'review' ? '复习计时' : '任务计时'),
      date: timer.date || todayIso(),
      startedAt: Number(timer.startedAt || Date.now()),
      accumulatedSeconds: Math.max(0, Math.floor(Number(timer.accumulatedSeconds || 0))),
      paused: Boolean(timer.paused),
    };
  } catch {
    return null;
  }
}

const data = ref<StudyData>(load());
const tab = ref<(typeof tabs)[number][0]>('today');
const showTokenModal = ref(false);
const tokenInput = ref('');
const tokenField = ref<HTMLInputElement | null>(null);
const manualAmounts = ref<Record<string, number>>({});
const reviewAmounts = ref<Record<string, number>>({});
const reviewAddTaskId = ref('');
const reviewAddDate = ref<'today' | 'tomorrow'>('today');
const reviewAddTargetInput = ref(5);
const expandedItemizedTasks = ref<Record<string, boolean>>({});
const expandedSubItemLists = ref<Record<string, boolean>>({});
const selectedProgressPhaseId = ref('');
const reviewTrendRange = ref<7 | 30>(7);
const selectedNoteDate = ref(todayIso());
const noteDraft = ref(data.value.dailyNotes?.[todayIso()] || '');
const importTaskId = ref('');
const importText = ref('');
const runningTimer = ref<RunningTimer | null>(loadRunningTimer());
const showTimerModal = ref(Boolean(runningTimer.value));
const timerEditText = ref('');
const timerEditDirty = ref(false);
const nowMs = ref(Date.now());
let tokenResolver: ((token: string) => void) | null = null;
let timerInterval: number | undefined;

const schedule = computed(() => buildSchedule(data.value));
const phase = computed(() => currentPhase(schedule.value));
const todayTasks = computed(() => {
  const active = phase.value;
  if (!active) return [];
  return data.value.tasks.filter((task) => {
    if (task.phaseId !== active.id) return false;
    return todayIso() >= (task.startDate || active.startDate);
  });
});
const ghConfig = computed(() => ({
  owner: data.value.settings.githubOwner.trim(),
  repo: data.value.settings.githubRepo.trim(),
  branch: data.value.settings.githubBranch.trim(),
  path: data.value.settings.githubPath.trim(),
}));
const todayLogs = computed(() => data.value.dailyLogs[todayIso()] || []);
const todayTimeLogs = computed(() => data.value.timeLogs[todayIso()] || []);
const todayTaskSeconds = computed(() => todayTimeLogs.value.filter((log) => log.type === 'task').reduce((sum, log) => sum + log.durationSeconds, 0));
const todayReviewSeconds = computed(() => todayTimeLogs.value.filter((log) => log.type === 'review').reduce((sum, log) => sum + log.durationSeconds, 0));
const todayStudySeconds = computed(() => todayTaskSeconds.value + todayReviewSeconds.value);
const runningTimerSeconds = computed(() => currentTimerSeconds());
const todayLogByTask = computed(() => {
  const result = todayLogs.value.reduce<Record<string, number>>((acc, log) => {
    acc[log.taskId] = (acc[log.taskId] || 0) + (log.count ?? log.amount ?? 0);
    return acc;
  }, {});
  for (const task of data.value.tasks) {
    if (task.trackingMode === 'itemized') result[task.id] = todayDoneItems(task).length;
  }
  return result;
});
const todayLogTotal = computed(() => Object.values(todayLogByTask.value).reduce((sum, amount) => sum + Math.max(0, amount), 0));
const todayReviewPlans = computed(() => data.value.reviewPlans[todayIso()] || []);
const tomorrowReviewPlans = computed(() => data.value.reviewPlans[addDays(todayIso(), 1)] || []);
const reviewEnabledTasks = computed(() => data.value.tasks.filter((task) => task.reviewEnabled));
const todayReviewTarget = computed(() => todayReviewPlans.value.reduce((sum, plan) => sum + plan.target, 0));
const todayReviewDone = computed(() => todayReviewPlans.value.reduce((sum, plan) => sum + plan.completed, 0));
const tomorrowReviewTarget = computed(() => tomorrowReviewPlans.value.reduce((sum, plan) => sum + plan.target, 0));
const overallDone = computed(() => data.value.tasks.reduce((sum, task) => sum + task.completed, 0));
const overallTarget = computed(() => data.value.tasks.reduce((sum, task) => sum + taskTotalTarget(task), 0));
const overallPercent = computed(() => pct(overallDone.value, overallTarget.value));
const totalRemaining = computed(() => Math.max(0, overallTarget.value - overallDone.value));
const daysLeft = computed(() => daysBetweenInclusive(todayIso(), data.value.settings.deadline));
const estimatedHours = computed(() => Math.max(0.5, Math.round(todayTarget.value * 3.5) / 10));
const lastSyncedAt = computed(() => data.value.updatedAt ? new Date(data.value.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未同步');
const noteRows = computed(() => Object.entries(data.value.dailyNotes || {})
  .filter(([, note]) => note.trim())
  .sort(([a], [b]) => b.localeCompare(a))
  .map(([date, note]) => ({ date, note })));

const todayTaskRows = computed(() => todayTasks.value.map((task, index) => {
  const todayCompleted = todayLogByTask.value[task.id] || 0;
  const baselineTask = { ...task, completed: Math.max(0, task.completed - todayCompleted) };
  const dailyTarget = taskSuggestion(baselineTask, phase.value);
  const remainingToday = Math.max(0, dailyTarget - todayCompleted);
  const doneToday = dailyTarget > 0 ? todayCompleted >= dailyTarget : taskTotalTarget(task) > 0 && task.completed >= taskTotalTarget(task);
  const todayPercent = pct(todayCompleted, dailyTarget);
  const todayStatus = todayCompleted > dailyTarget ? '超额完成' : doneToday ? '已完成' : '待完成';
  return {
    ...task,
    accent: taskAccent(index),
    initials: taskInitials(task.name),
    totalTarget: taskTotalTarget(task),
    percent: pct(task.completed, taskTotalTarget(task)),
    remaining: taskRemaining(task),
    currentRound: taskCurrentRound(task),
    roundCompleted: taskRoundCompleted(task),
    todayCompleted,
    dailyTarget,
    todayPercent,
    todayStatus,
    remainingToday,
    doneToday,
  };
}));
const todayTarget = computed(() => todayTaskRows.value.reduce((sum, task) => sum + task.dailyTarget, 0));
const todayPercent = computed(() => pct(todayLogTotal.value, todayTarget.value));
const todayTotalTraining = computed(() => todayLogTotal.value + todayReviewDone.value);

const phaseProgress = computed(() => schedule.value.map((item, index) => {
  const tasks = data.value.tasks.filter((task) => task.phaseId === item.id);
  const done = tasks.reduce((sum, task) => sum + task.completed, 0);
  const target = tasks.reduce((sum, task) => sum + taskTotalTarget(task), 0);
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
  totalTarget: taskTotalTarget(task),
  percent: pct(task.completed, taskTotalTarget(task)),
  remaining: taskRemaining(task),
  currentRound: taskCurrentRound(task),
  roundCompleted: taskRoundCompleted(task),
  phaseName: schedule.value.find((item) => item.id === task.phaseId)?.name || '未分配阶段',
  status: task.completed >= taskTotalTarget(task) ? '完成' : '正常',
})));
const selectedProgressPhase = computed(() => phaseProgress.value.find((item) => item.id === selectedProgressPhaseId.value) || phaseProgress.value[0]);
const filteredTaskProgressRows = computed(() => taskProgressRows.value.filter((task) => !selectedProgressPhase.value || task.phaseId === selectedProgressPhase.value.id));

const activePhaseProgress = computed(() => phaseProgress.value.find((item) => item.id === phase.value?.id) || phaseProgress.value[0]);
const activePhaseDeadlineDays = computed(() => activePhaseProgress.value ? daysBetweenInclusive(todayIso(), activePhaseProgress.value.endDate) : 0);

const trendRows = computed(() => {
  const rows = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(todayIso(), index - 6);
    const mainTotal = (data.value.dailyLogs[date] || []).reduce((sum, log) => sum + (log.count ?? log.amount ?? 0), 0);
    const reviewTotal = (data.value.reviewPlans[date] || []).reduce((sum, plan) => sum + plan.completed, 0);
    return { date, label: date.slice(5), mainTotal, reviewTotal, total: mainTotal + reviewTotal };
  });
  const max = Math.max(1, ...rows.map((row) => row.total));
  return rows.map((row) => ({ ...row, height: Math.max(8, Math.round((row.total / max) * 76)) }));
});
const reviewTrendRows = computed(() => {
  const days = reviewTrendRange.value;
  return Array.from({ length: days }, (_, index) => {
    const date = addDays(todayIso(), index - days + 1);
    const reviewTotal = (data.value.reviewPlans[date] || []).reduce((sum, plan) => sum + plan.completed, 0);
    return { date, label: days === 30 ? date.slice(8) : date.slice(5), reviewTotal };
  });
});
const timeTrendRows = computed(() => {
  const rows = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(todayIso(), index - 6);
    const totalSeconds = (data.value.timeLogs[date] || []).reduce((sum, log) => sum + log.durationSeconds, 0);
    return { date, label: date.slice(5), totalSeconds };
  });
  const max = Math.max(1, ...rows.map((row) => row.totalSeconds));
  return rows.map((row) => ({ ...row, height: Math.max(8, Math.round((row.totalSeconds / max) * 76)) }));
});

onMounted(() => {
  timerInterval = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (timerInterval) window.clearInterval(timerInterval);
});

function saveLocal(next: StudyData) {
  const stamped = { ...normalizeData(next), updatedAt: new Date().toISOString() };
  data.value = stamped;
  localStorage.setItem(KEY, JSON.stringify(stamped));
  const { githubOwner, githubRepo, githubBranch, githubPath } = stamped.settings;
  localStorage.setItem(GITHUB_KEY, JSON.stringify({ githubOwner, githubRepo, githubBranch, githubPath }));
}

function timerIdentity(type: TimeLogType, id: string) {
  return `${type}:${id}`;
}

function runningTimerIdentity(timer: RunningTimer | null) {
  if (!timer) return '';
  return timerIdentity(timer.type, timer.type === 'review' ? timer.reviewPlanId || '' : timer.taskId || '');
}

function persistRunningTimer() {
  if (runningTimer.value) localStorage.setItem(TIMER_KEY, JSON.stringify(runningTimer.value));
  else localStorage.removeItem(TIMER_KEY);
}

function currentTimerSeconds() {
  const timer = runningTimer.value;
  if (!timer) return 0;
  const liveSeconds = timer.paused ? 0 : Math.floor((nowMs.value - timer.startedAt) / 1000);
  return Math.max(0, timer.accumulatedSeconds + liveSeconds);
}

function timerSeconds(type: TimeLogType, id: string) {
  return runningTimerIdentity(runningTimer.value) === timerIdentity(type, id) ? runningTimerSeconds.value : 0;
}

function timerEntryLabel(type: TimeLogType, id: string) {
  const seconds = timerSeconds(type, id);
  if (seconds <= 0) return '计时';
  return `${runningTimer.value?.paused ? '已暂停' : '计时中'} ${formatDuration(seconds)}`;
}

function savedTimeSeconds(type: TimeLogType, id: string) {
  return todayTimeLogs.value
    .filter((log) => log.type === type && (type === 'review' ? log.reviewPlanId === id : log.taskId === id))
    .reduce((sum, log) => sum + log.durationSeconds, 0);
}

function timerActionLabel() {
  if (!runningTimer.value) return '开始';
  if (!runningTimer.value.paused) return '暂停';
  return currentTimerSeconds() > 0 ? '继续' : '开始';
}

function openTimer(type: TimeLogType, id: string, name: string) {
  const identity = timerIdentity(type, id);
  if (runningTimerIdentity(runningTimer.value) === identity) {
    nowMs.value = Date.now();
    showTimerModal.value = true;
    timerEditDirty.value = false;
    return;
  }
  const timestamp = Date.now();
  nowMs.value = timestamp;
  runningTimer.value = {
    type,
    taskId: type === 'task' ? id : '',
    reviewPlanId: type === 'review' ? id : '',
    name,
    date: todayIso(),
    startedAt: timestamp,
    accumulatedSeconds: 0,
    paused: true,
  };
  showTimerModal.value = true;
  timerEditText.value = '';
  timerEditDirty.value = false;
  persistRunningTimer();
}

function toggleActiveTimer() {
  if (!runningTimer.value) return;
  const seconds = currentTimerSeconds();
  const timestamp = Date.now();
  nowMs.value = timestamp;
  runningTimer.value = {
    ...runningTimer.value,
    accumulatedSeconds: seconds,
    startedAt: timestamp,
    paused: !runningTimer.value.paused,
  };
  persistRunningTimer();
}

function resetTimer(paused = true) {
  if (!runningTimer.value) return;
  const timestamp = Date.now();
  nowMs.value = timestamp;
  runningTimer.value = {
    ...runningTimer.value,
    accumulatedSeconds: 0,
    startedAt: timestamp,
    paused,
  };
  timerEditText.value = '';
  timerEditDirty.value = false;
  persistRunningTimer();
}

function closeTimerModal() {
  runningTimer.value = null;
  showTimerModal.value = false;
  timerEditText.value = '';
  timerEditDirty.value = false;
  persistRunningTimer();
}

function updateTimerEdit(value: string) {
  timerEditText.value = value;
  timerEditDirty.value = true;
}

function saveRunningTimer() {
  const timer = runningTimer.value;
  if (!timer) return;
  const durationSeconds = timerEditDirty.value ? parseDurationInput(timerEditText.value) : currentTimerSeconds();
  if (durationSeconds === null) {
    alert('请输入有效时长，例如 25:30 或 1:02:00');
    return;
  }
  runningTimer.value = null;
  showTimerModal.value = false;
  timerEditText.value = '';
  timerEditDirty.value = false;
  persistRunningTimer();
  if (durationSeconds <= 0) return;
  const date = timer.date || todayIso();
  const entry: TimeLogEntry = {
    id: crypto.randomUUID(),
    date,
    type: timer.type,
    taskId: timer.taskId || '',
    reviewPlanId: timer.reviewPlanId || '',
    name: timer.name,
    durationSeconds,
    createdAt: new Date().toISOString(),
  };
  saveLocal({
    ...data.value,
    timeLogs: {
      ...data.value.timeLogs,
      [date]: [...(data.value.timeLogs[date] || []), entry],
    },
  });
}

function deleteTimeLog(date: string, id: string) {
  const logs = (data.value.timeLogs[date] || []).filter((log) => log.id !== id);
  saveLocal({ ...data.value, timeLogs: { ...data.value.timeLogs, [date]: logs } });
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function parseDurationInput(value: string) {
  const text = value.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Math.max(0, Number(text) * 60);
  const parts = text.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return null;
}

function formatDurationText(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  if (total <= 0) return '0 分钟';
  if (total < 60) return `${total} 秒`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${Math.max(1, Math.round(total / 60))} 分钟`;
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
  saveLocal({ ...data.value, tasks: data.value.tasks.map((task) => task.id === id ? normalizeTask({ ...task, ...patch }, data.value.phases[0]?.id || '') : task) });
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
        platform: '多墨',
        frequencyType: '超高频',
        trackingMode: inferTrackingMode('RS 超高频'),
        reviewEnabled: false,
        startDate: targetPhase?.startDate,
        endDate: targetPhase?.endDate,
        subItems: [],
        target: 100,
        repeatCount: 1,
        completed: 0,
      },
    ],
  });
}

function deleteTask(id: string) {
  saveLocal({ ...data.value, tasks: data.value.tasks.filter((task) => task.id !== id) });
}

function updateTaskSubItems(taskId: string, updater: (items: SubItem[]) => SubItem[]) {
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((task) => {
      if (task.id !== taskId) return task;
      const subItems = updater(task.subItems || []).map(normalizeSubItem);
      return normalizeTask({ ...task, subItems, target: Math.max(task.target, subItems.length) }, data.value.phases[0]?.id || '');
    }),
  });
}

function addSubItem(taskId: string) {
  updateTaskSubItems(taskId, (items) => [
    ...items,
    normalizeSubItem({ title: `新篇目 ${items.length + 1}`, status: 'not_started', familiarity: '生', round: 0, note: '' }),
  ]);
}

function updateSubItem(taskId: string, subItemId: string, patch: Partial<SubItem>) {
  updateTaskSubItems(taskId, (items) => items.map((item) => item.id === subItemId ? { ...item, ...patch } : item));
}

function deleteSubItem(taskId: string, subItemId: string) {
  updateTaskSubItems(taskId, (items) => items.filter((item) => item.id !== subItemId));
}

function generateSubItems(task: Task) {
  const prefix = taskInitials(task.name).slice(0, 3) || 'WE';
  const count = Math.max(1, task.target || 40);
  updateTaskSubItems(task.id, () => Array.from({ length: count }, (_, index) => normalizeSubItem({
    title: `${prefix}${String(index + 1).padStart(2, '0')}`,
    status: 'not_started',
    familiarity: '生',
    round: 0,
    note: '',
  })));
}

function addAmount(task: Task, amount: number) {
  const date = todayIso();
  const log = data.value.dailyLogs[date] || [];
  const todayCompleted = log.filter((entry) => entry.taskId === task.id).reduce((sum, entry) => sum + (entry.count ?? entry.amount ?? 0), 0);
  const delta = amount < 0
    ? -Math.min(Math.abs(amount), Math.max(0, task.completed), Math.max(0, todayCompleted))
    : Math.min(Math.max(0, amount), taskRemaining(task));
  if (delta === 0) return;
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((item) => item.id === task.id ? { ...item, completed: Math.max(0, item.completed + delta) } : item),
    dailyLogs: { ...data.value.dailyLogs, [date]: [...log, { taskId: task.id, count: delta }] },
  });
}

function manualAmount(id: string) {
  return manualAmounts.value[id] ?? 5;
}

function setManualAmount(id: string, value: string) {
  manualAmounts.value[id] = Math.max(0, Math.floor(Number(value) || 0));
}

function applyManualAmount(task: Task, direction: 1 | -1) {
  addAmount(task, manualAmount(task.id) * direction);
}

function reviewAmount(id: string) {
  return reviewAmounts.value[id] ?? 5;
}

function setReviewAmount(id: string, value: string) {
  reviewAmounts.value[id] = Math.max(0, Math.floor(Number(value) || 0));
}

function setTomorrowReview(task: Task) {
  const target = reviewAmount(task.id);
  const date = addDays(todayIso(), 1);
  const plans = data.value.reviewPlans[date] || [];
  const existing = plans.find((plan) => plan.taskId === task.id && plan.sourceDate === todayIso());
  const nextPlans = target > 0
    ? [
        ...plans.filter((plan) => plan.id !== existing?.id),
        {
          id: existing?.id || crypto.randomUUID(),
          taskId: task.id,
          taskName: task.name,
          sourceDate: todayIso(),
          target,
          completed: Math.min(existing?.completed || 0, target),
        },
      ]
    : plans.filter((plan) => plan.id !== existing?.id);
  saveLocal({ ...data.value, reviewPlans: { ...data.value.reviewPlans, [date]: nextPlans } });
}

function addReviewPlan() {
  const task = data.value.tasks.find((item) => item.id === reviewAddTaskId.value) || reviewEnabledTasks.value[0];
  const target = Math.max(0, Math.floor(reviewAddTargetInput.value || 0));
  if (!task || target <= 0) return;
  const date = reviewAddDate.value === 'tomorrow' ? addDays(todayIso(), 1) : todayIso();
  const plans = data.value.reviewPlans[date] || [];
  const existing = plans.find((plan) => plan.taskId === task.id);
  const nextPlans = existing
    ? plans.map((plan) => plan.id === existing.id ? { ...plan, target: plan.target + target } : plan)
    : [
        ...plans,
        {
          id: crypto.randomUUID(),
          taskId: task.id,
          taskName: task.name,
          sourceDate: todayIso(),
          target,
          completed: 0,
        },
      ];
  saveLocal({ ...data.value, reviewPlans: { ...data.value.reviewPlans, [date]: nextPlans } });
}

function setReviewTarget(date: string, plan: ReviewPlan, value: string) {
  if (value.trim() === '') return;
  const target = Math.floor(Number(value) || 0);
  if (target <= 0) return;
  updateReviewPlan(date, plan.id, { target });
}

function tomorrowReviewTargetForTask(taskId: string) {
  const date = addDays(todayIso(), 1);
  return (data.value.reviewPlans[date] || [])
    .filter((plan) => plan.taskId === taskId && plan.sourceDate === todayIso())
    .reduce((sum, plan) => sum + plan.target, 0);
}

function updateReviewPlan(date: string, planId: string, patch: Partial<ReviewPlan>) {
  const plans = data.value.reviewPlans[date] || [];
  const nextPlans = plans.map((plan) => {
    if (plan.id !== planId) return plan;
    const target = Math.max(0, Number(patch.target ?? plan.target));
    const completed = Math.min(target, Math.max(0, Number(patch.completed ?? plan.completed)));
    return { ...plan, ...patch, target, completed };
  }).filter((plan) => plan.target > 0 || plan.completed > 0);
  saveLocal({ ...data.value, reviewPlans: { ...data.value.reviewPlans, [date]: nextPlans } });
}

function addReviewProgress(date: string, plan: ReviewPlan, amount: number) {
  const delta = amount < 0
    ? -Math.min(Math.abs(amount), Math.max(0, plan.completed))
    : Math.min(amount, Math.max(0, plan.target - plan.completed));
  if (delta === 0) return;
  updateReviewPlan(date, plan.id, { completed: plan.completed + delta });
}

function deleteReviewPlan(date: string, planId: string) {
  const plans = (data.value.reviewPlans[date] || []).filter((plan) => plan.id !== planId);
  saveLocal({ ...data.value, reviewPlans: { ...data.value.reviewPlans, [date]: plans } });
}

function isItemizedExpanded(taskId: string) {
  return expandedItemizedTasks.value[taskId] ?? true;
}

function toggleItemizedDetails(taskId: string) {
  expandedItemizedTasks.value[taskId] = !isItemizedExpanded(taskId);
}

function visibleSubItems(task: Task) {
  const items = pendingSubItems(task);
  return expandedSubItemLists.value[task.id] ? items : items.slice(0, 10);
}

function toggleSubItemList(taskId: string) {
  expandedSubItemLists.value[taskId] = !expandedSubItemLists.value[taskId];
}

function toggleTodaySubItem(task: Task, itemId: string, checked: boolean) {
  const date = todayIso();
  setSubItemCompletion(task, itemId, checked, date);
}

function setSubItemCompletion(task: Task, itemId: string, checked: boolean, date = todayIso()) {
  const logs = data.value.dailyLogs[date] || [];
  const nextSubItems = task.subItems.map((item) => {
    if (item.id !== itemId) return item;
    return checked
      ? { ...item, status: 'done' as const, completedDate: date, round: Math.max(1, item.round || 0) }
      : { ...item, status: 'not_started' as const, completedDate: '' };
  });
  const nextTask = normalizeTask({ ...task, subItems: nextSubItems }, data.value.phases[0]?.id || '');
  const selectedIds = nextSubItems.filter((item) => item.completedDate === date).map((item) => item.id);
  const otherLogs = logs.filter((entry) => entry.taskId !== task.id);
  const taskLogs = selectedIds.length > 0 ? [{ taskId: task.id, count: selectedIds.length, subItemIds: selectedIds }] : [];
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((entry) => entry.id === task.id ? nextTask : entry),
    dailyLogs: {
      ...data.value.dailyLogs,
      [date]: [...otherLogs, ...taskLogs],
    },
  });
}

function undoSubItemCompletion(task: Task, item: SubItem) {
  if (item.completedDate && item.completedDate !== todayIso() && !confirm('确定取消此前已完成的篇目吗？这会同步调整历史完成记录。')) return;
  setSubItemCompletion(task, item.id, false, item.completedDate || todayIso());
}

function updateTodaySubItemFamiliarity(task: Task, itemId: string, familiarity: Familiarity) {
  const date = todayIso();
  const logs = data.value.dailyLogs[date] || [];
  const nextSubItems = task.subItems.map((item) => item.id === itemId ? {
    ...item,
    familiarity,
    status: item.completedDate === date ? 'done' as const : item.status,
  } : item);
  const nextTask = normalizeTask({ ...task, subItems: nextSubItems }, data.value.phases[0]?.id || '');
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((entry) => entry.id === task.id ? nextTask : entry),
    dailyLogs: { ...data.value.dailyLogs, [date]: logs },
  });
}

function historicalDoneCount(task: Task) {
  const today = todayIso();
  return task.subItems.filter((item) => item.status === 'done' && item.completedDate !== today).length;
}

function pendingSubItems(task: Task) {
  return task.subItems.filter((item) => item.status !== 'done');
}

function historicalDoneGroups(task: Task) {
  const today = todayIso();
  const groups = task.subItems
    .filter((item) => item.status === 'done' && item.completedDate && item.completedDate !== today)
    .reduce<Record<string, SubItem[]>>((acc, item) => {
      const date = item.completedDate || '';
      acc[date] = [...(acc[date] || []), item];
      return acc;
    }, {});
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, items]) => ({ date, items }));
}

function selectNoteDate(date: string) {
  selectedNoteDate.value = date;
  noteDraft.value = data.value.dailyNotes?.[date] || '';
}

function saveDailyNote() {
  const note = noteDraft.value.trim();
  const dailyNotes = { ...(data.value.dailyNotes || {}) };
  if (note) dailyNotes[selectedNoteDate.value] = note;
  else delete dailyNotes[selectedNoteDate.value];
  saveLocal({ ...data.value, dailyNotes });
}

function openImportModal(taskId: string) {
  importTaskId.value = taskId;
  importText.value = '';
}

function closeImportModal() {
  importTaskId.value = '';
  importText.value = '';
}

function applyImportSubItems() {
  const taskId = importTaskId.value;
  const titles = importText.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!taskId || titles.length === 0) {
    closeImportModal();
    return;
  }
  updateTaskSubItems(taskId, (items) => [
    ...items,
    ...titles.map((title) => normalizeSubItem({ title, status: 'not_started', familiarity: '生', round: 0 })),
  ]);
  closeImportModal();
}

async function copySubItems(task: Task) {
  const text = task.subItems.map((item) => item.title.trim()).filter(Boolean).join('\n');
  if (!text) {
    alert('当前任务还没有可复制的子项目。');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
  alert(`已复制 ${task.subItems.length} 个子项目，可直接粘贴到批量导入。`);
}

function deleteAllSubItems(task: Task) {
  if (task.subItems.length === 0) return;
  if (!confirm(`确定删除「${task.name || '当前任务'}」的全部子项目吗？`)) return;
  updateTaskSubItems(task.id, () => []);
}

function deleteDailyNote(date: string) {
  const dailyNotes = { ...(data.value.dailyNotes || {}) };
  delete dailyNotes[date];
  saveLocal({ ...data.value, dailyNotes });
  if (selectedNoteDate.value === date) noteDraft.value = '';
}

function plannedDailyTarget(task: Task, targetPhase: PhaseSchedule) {
  const taskStart = task.startDate || targetPhase.startDate;
  const startDate = todayIso() > taskStart ? todayIso() : taskStart;
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
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

function subItemStatusLabel(status: SubItemStatus) {
  return subItemStatusOptions.find((item) => item.value === status)?.label || '未开始';
}

function itemizedDoneCount(task: Task) {
  return task.subItems.filter((item) => item.status === 'done').length;
}

function todayDoneItems(task: Task) {
  const today = todayIso();
  return task.subItems.filter((item) => item.status === 'done' && item.completedDate === today);
}

function selectedItemTitles(task: Task) {
  const items = todayDoneItems(task);
  return items.length ? items.map((item) => item.title.split(' - ')[0]).join('、') : '暂无';
}

function taskDisplayName(task: Task) {
  return task.name.includes(task.frequencyType) ? task.name : `${task.name} ${task.frequencyType}`;
}
</script>

<template>
  <main>
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">P</span>
        <div>
          <h1>计划进度</h1>
          <p>备考计划管理器</p>
        </div>
      </div>
      <nav>
        <button
          v-for="item in sidebarItems"
          :key="item.label"
          :class="{ active: tab === item.key }"
          type="button"
          @click="tab = item.key"
        >
          {{ item.label }}
        </button>
      </nav>
      <div class="sidebar-note">
        <strong>今日格言</strong>
        <p>每天进步一点点，考试成功一大步！</p>
      </div>
    </header>

    <section v-if="tab === 'today'" class="page dashboard-page">
      <section class="plan-strip">
        <div>
          <span>计划开始日期</span>
          <strong>{{ data.settings.startDate }}</strong>
        </div>
        <div>
          <span>最终截止日期（考试日期）</span>
          <strong>{{ data.settings.deadline }}</strong>
        </div>
        <div>
          <span>距离{{ activePhaseProgress?.name || '当前阶段' }}截止日期</span>
          <strong>{{ activePhaseDeadlineDays }} 天</strong>
        </div>
        <button class="soft-button" type="button" @click="tab = 'settings'">修改计划</button>
      </section>

      <section class="dashboard-card phase-overview">
        <h2>阶段进度总览</h2>
        <div class="phase-overview-grid">
          <article v-for="item in phaseProgress" :key="item.id" :style="{ '--phase-color': item.accent }">
            <strong>{{ item.name }}</strong>
            <span>{{ item.startDate.slice(5) }} 至 {{ item.endDate.slice(5) }}（{{ item.days }}天）</span>
            <div class="ring small" :style="{ '--percent': `${item.percent}%`, '--ring-color': item.accent }">
              <b>{{ item.percent }}%</b>
            </div>
            <small>{{ item.done }} / {{ item.target }}</small>
          </article>
        </div>
      </section>

      <section class="dashboard-card today-card">
        <div class="dashboard-title">
          <div>
            <h2>今日任务</h2>
            <p>{{ todayIso() }}，当前阶段按剩余任务量动态均摊</p>
          </div>
          <button class="primary-action" type="button" @click="tab = 'settings'">更新完成进度</button>
        </div>

        <div v-if="activePhaseProgress" class="phase-banner">
          <div>
            <span>当前阶段</span>
            <strong>{{ activePhaseProgress.name }}</strong>
            <p>{{ activePhaseProgress.startDate }} 至 {{ activePhaseProgress.endDate }}</p>
          </div>
          <div>
            <span>阶段进度</span>
            <div class="progress slim"><span :style="{ width: `${activePhaseProgress.percent}%`, background: activePhaseProgress.accent }" /></div>
            <b>{{ activePhaseProgress.percent }}%</b>
          </div>
          <div>
            <span>阶段剩余天数</span>
            <strong>{{ daysBetweenInclusive(todayIso(), activePhaseProgress.endDate) }} 天</strong>
          </div>
        </div>

        <div class="dashboard-table today-table">
          <div class="dashboard-table-head">
            <span>任务</span><span>计时</span><span>今日建议</span><span>今日进度</span><span>总体进度</span><span>状态</span><span>操作</span>
          </div>
          <template v-for="task in todayTaskRows" :key="task.id">
            <div class="dashboard-table-row" :class="{ 'itemized-task-row': task.trackingMode === 'itemized' && isItemizedExpanded(task.id) }">
              <strong class="task-name-cell">
                <span class="task-name-line">{{ taskDisplayName(task) }}<b v-if="task.trackingMode === 'itemized'">背诵型</b></span>
                <small>{{ task.platform }}<b v-if="task.repeatCount > 1" class="round-chip">第 {{ task.currentRound }} / {{ task.repeatCount }} 遍</b></small>
              </strong>
              <span class="timer-entry-cell">
                <button class="timer-entry-button" type="button" @click="openTimer('task', task.id, taskDisplayName(task))">{{ timerEntryLabel('task', task.id) }}</button>
                <small v-if="savedTimeSeconds('task', task.id) > 0">今日已学 {{ formatDurationText(savedTimeSeconds('task', task.id)) }}</small>
              </span>
              <span class="daily-target-cell">{{ task.dailyTarget }} {{ task.trackingMode === 'itemized' ? '篇' : '题' }}</span>
              <span class="today-progress-cell" :class="{ boxed: task.trackingMode === 'itemized' }">
                <span class="progress-meta">
                  <strong v-if="task.trackingMode === 'itemized'">今日已完成 {{ task.todayCompleted }} / {{ task.dailyTarget }} 篇</strong>
                  <strong v-else>{{ task.todayCompleted }} / {{ task.dailyTarget }}</strong>
                  <b>{{ task.todayPercent }}%</b>
                </span>
                <span class="progress-track"><i :style="{ width: `${task.todayPercent}%`, background: task.accent }" /></span>
              </span>
              <span class="today-progress-cell overall-progress-cell">
                <span class="progress-meta">
                  <strong>{{ task.repeatCount > 1 ? task.roundCompleted : task.completed }} / {{ task.target }} {{ task.trackingMode === 'itemized' ? '篇' : '题' }}</strong>
                  <b>{{ task.repeatCount > 1 ? pct(task.roundCompleted, task.target) : task.percent }}%</b>
                </span>
                <span class="progress-track"><i :style="{ width: `${task.repeatCount > 1 ? pct(task.roundCompleted, task.target) : task.percent}%`, background: task.accent }" /></span>
              </span>
              <em :class="task.todayStatus === '超额完成' ? 'status-extra' : task.doneToday ? 'status-ok' : 'status-warn'">{{ task.todayStatus }}</em>
              <span class="row-actions">
                <button v-if="task.trackingMode === 'itemized'" class="itemized-open" type="button" @click="toggleItemizedDetails(task.id)">
                  {{ isItemizedExpanded(task.id) ? '收起详情' : '查看详情' }}
                </button>
                <template v-else>
                  <button type="button" @click="applyManualAmount(task, -1)">-</button>
                  <input class="manual-input" type="number" min="0" :value="manualAmount(task.id)" @input="setManualAmount(task.id, ($event.target as HTMLInputElement).value)">
                  <button type="button" @click="applyManualAmount(task, 1)">+</button>
                </template>
              </span>
            </div>
            <div v-if="task.trackingMode === 'itemized' && isItemizedExpanded(task.id)" class="today-itemized-panel">
              <section>
                <h3>完成详情</h3>
                <div class="done-section-title">
                  <strong>今日完成</strong>
                  <span>{{ todayDoneItems(task).length }} 篇</span>
                </div>
                <div v-if="todayDoneItems(task).length" class="today-done-items">
                  <article v-for="item in todayDoneItems(task)" :key="item.id">
                    <button type="button" title="取消完成" @click="undoSubItemCompletion(task, item)">✓</button>
                    <strong>{{ item.title }}</strong>
                    <b>{{ item.familiarity }}</b>
                  </article>
                </div>
                <p v-else class="muted">今天还没有选择完成篇目。</p>
                <details v-if="historicalDoneCount(task) > 0" class="history-done">
                  <summary>此前已完成 {{ historicalDoneCount(task) }} 篇</summary>
                  <div v-for="group in historicalDoneGroups(task)" :key="group.date" class="history-done-group">
                    <time>{{ group.date }}</time>
                    <div class="today-done-items compact">
                      <article v-for="item in group.items" :key="item.id">
                        <button type="button" title="取消完成" @click="undoSubItemCompletion(task, item)">✓</button>
                        <strong>{{ item.title }}</strong>
                        <b>{{ item.familiarity }}</b>
                      </article>
                    </div>
                  </div>
                </details>
              </section>
              <section>
                <h3>快速选择（可多选）</h3>
                <div v-if="pendingSubItems(task).length > 0" class="quick-subitems">
                  <div v-for="item in visibleSubItems(task)" :key="item.id" class="quick-subitem">
                    <label>
                      <input
                        type="checkbox"
                        :checked="false"
                        @change="toggleTodaySubItem(task, item.id, ($event.target as HTMLInputElement).checked)"
                      >
                      {{ item.title }}
                    </label>
                    <select
                      :value="item.familiarity"
                      @change="updateTodaySubItemFamiliarity(task, item.id, ($event.target as HTMLSelectElement).value as Familiarity)"
                    >
                      <option v-for="familiarity in familiarityOptions" :key="familiarity" :value="familiarity">{{ familiarity }}</option>
                    </select>
                  </div>
                </div>
                <p v-else-if="task.subItems.length === 0" class="muted">请先在计划设置中新增或批量导入篇目。</p>
                <p v-else class="muted">所有篇目都已完成，可在左侧完成详情中查看或取消。</p>
                <button v-if="pendingSubItems(task).length > 10" class="text-button" type="button" @click="toggleSubItemList(task.id)">
                  {{ expandedSubItemLists[task.id] ? '收起' : `展开未完成（${pendingSubItems(task).length}）⌄` }}
                </button>
              </section>
            </div>
            <div v-if="task.reviewEnabled && task.doneToday && tomorrowReviewTargetForTask(task.id) === 0" class="review-register-panel">
              <div>
                <strong>登记明日复习量</strong>
                <span v-if="tomorrowReviewTargetForTask(task.id) > 0">已登记 {{ tomorrowReviewTargetForTask(task.id) }} 题</span>
                <span v-else>填入明天需要复习的错题量，不计入主任务进度。</span>
              </div>
              <div class="review-register-actions">
                <input type="number" min="0" :value="reviewAmount(task.id)" @input="setReviewAmount(task.id, ($event.target as HTMLInputElement).value)">
                <button type="button" @click="setTomorrowReview(task)">保存</button>
              </div>
            </div>
          </template>
          <div v-if="todayTaskRows.length === 0" class="empty-row">今天还没有任务。</div>
        </div>

        <div class="today-footer">
          <span>今日总任务量：{{ todayTarget }} 题/篇</span>
          <span>预计完成时间：{{ estimatedHours }} 小时</span>
          <span>今日完成率：{{ todayPercent }}%</span>
        </div>
      </section>

      <section class="dashboard-card review-today-card">
        <div class="dashboard-title">
          <div>
            <h2>复习任务</h2>
            <p>复习量独立记录，不计入主任务完成率。</p>
          </div>
          <div class="review-title-metrics">
            <span>今日待复习 <strong>{{ todayReviewDone }} / {{ todayReviewTarget }}</strong></span>
            <span>明日待复习 <strong>{{ tomorrowReviewTarget }}</strong></span>
          </div>
        </div>
        <div class="review-columns">
          <div class="review-add-panel">
            <strong>新增复习计划</strong>
            <div class="review-add-form">
              <select v-model="reviewAddDate">
                <option value="today">今日复习</option>
                <option value="tomorrow">明日复习</option>
              </select>
              <select v-model="reviewAddTaskId">
                <option value="">选择任务</option>
                <option v-for="task in reviewEnabledTasks" :key="task.id" :value="task.id">{{ task.name }}</option>
              </select>
              <input v-model.number="reviewAddTargetInput" type="number" min="0">
              <button type="button" @click="addReviewPlan">添加</button>
            </div>
          </div>
          <section>
            <div class="review-section-head">
              <h3>今日待复习</h3>
            </div>
            <div v-if="todayReviewPlans.length" class="review-list">
              <article v-for="plan in todayReviewPlans" :key="plan.id" class="review-task-card">
                <div class="review-card-head">
                  <div class="review-card-info">
                    <div class="review-card-titleline">
                      <strong>{{ plan.taskName }} 错题复习</strong>
                      <button class="timer-entry-button compact" type="button" @click="openTimer('review', plan.id, `${plan.taskName} 错题复习`)">{{ timerEntryLabel('review', plan.id) }}</button>
                      <small v-if="savedTimeSeconds('review', plan.id) > 0" class="review-saved-time">今日已学 {{ formatDurationText(savedTimeSeconds('review', plan.id)) }}</small>
                    </div>
                  </div>
                  <div class="review-card-meta">
                    <small>{{ plan.sourceDate === todayIso() ? '今日手动添加' : `${plan.sourceDate} 登记` }}</small>
                    <span class="review-status" :class="plan.completed >= plan.target ? 'status-ok' : 'status-warn'">{{ plan.completed >= plan.target ? '已完成' : '待完成' }}</span>
                  </div>
                </div>
                <div class="review-card-body">
                  <label class="review-target-input">计划
                    <input type="number" min="0" :value="plan.target" @input="setReviewTarget(todayIso(), plan, ($event.target as HTMLInputElement).value)">
                  </label>
                  <span class="today-progress-cell review-progress-cell">
                    <span class="progress-meta"><strong>{{ plan.completed }} / {{ plan.target }} 题</strong><b>{{ pct(plan.completed, plan.target) }}%</b></span>
                    <span class="progress-track"><i :style="{ width: `${pct(plan.completed, plan.target)}%`, background: '#7a3ed2' }" /></span>
                  </span>
                  <div class="row-actions review-actions">
                    <button type="button" @click="addReviewProgress(todayIso(), plan, -1)">-</button>
                    <input class="manual-input" type="number" min="0" :value="reviewAmount(plan.id)" @input="setReviewAmount(plan.id, ($event.target as HTMLInputElement).value)">
                    <button type="button" @click="addReviewProgress(todayIso(), plan, reviewAmount(plan.id))">+</button>
                  </div>
                  <button class="text-danger-button" type="button" @click="deleteReviewPlan(todayIso(), plan.id)">删除</button>
                </div>
              </article>
            </div>
            <p v-else class="muted">今天没有待复习任务。可以手动添加，或使用昨天登记的明日复习。</p>
          </section>
          <section>
            <h3>明日复习计划</h3>
            <div v-if="tomorrowReviewPlans.length" class="review-list compact">
              <article v-for="plan in tomorrowReviewPlans" :key="plan.id">
                <div>
                  <strong>{{ plan.taskName }} 错题复习</strong>
                  <small>{{ plan.sourceDate === todayIso() ? '今日登记给明天' : `${plan.sourceDate} 登记` }}</small>
                </div>
                <label class="review-target-input">计划
                  <input type="number" min="0" :value="plan.target" @input="setReviewTarget(addDays(todayIso(), 1), plan, ($event.target as HTMLInputElement).value)">
                </label>
                <button class="icon-button" type="button" @click="deleteReviewPlan(addDays(todayIso(), 1), plan.id)">删除</button>
              </article>
            </div>
            <p v-else class="muted">还没有登记明日复习量。完成主任务后可在任务下方登记。</p>
          </section>
        </div>
      </section>

      <section class="dashboard-card">
        <div class="dashboard-title">
          <h2>总进度详情</h2>
          <label class="phase-filter">阶段
            <select v-model="selectedProgressPhaseId">
              <option v-for="item in phaseProgress" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </label>
        </div>
        <div class="dashboard-table detail-table">
          <div class="dashboard-table-head">
            <span>任务名称</span><span>所属阶段</span><span>已完成 / 目标</span><span>进度</span><span>剩余</span><span>状态</span>
          </div>
          <div v-for="task in filteredTaskProgressRows" :key="task.id" class="dashboard-table-row">
            <strong>{{ task.name }}</strong>
            <span>{{ task.phaseName }}</span>
            <span>{{ task.completed }} / {{ task.totalTarget }}</span>
            <span class="inline-progress"><span class="progress-track"><i :style="{ width: `${task.percent}%`, background: task.accent }" /></span><b>{{ task.percent }}%</b></span>
            <span>{{ task.remaining }} 题</span>
            <em :class="task.status === '正常' || task.status === '完成' ? 'status-ok' : 'status-warn'">{{ task.status }}</em>
          </div>
          <details v-for="task in filteredTaskProgressRows.filter((item) => item.trackingMode === 'itemized' && item.subItems.length > 0)" :key="`${task.id}-detail`" class="subitem-progress">
            <summary>{{ task.name }} 篇目明细：已完成 {{ itemizedDoneCount(task) }} / {{ task.subItems.length }}</summary>
            <div class="subitem-progress-head">
              <span>篇目</span><span>状态</span><span>熟悉度</span><span>完成日期</span>
            </div>
            <div v-for="item in task.subItems" :key="item.id" class="subitem-progress-row">
              <strong>{{ item.title }}</strong>
              <span>{{ subItemStatusLabel(item.status) }}</span>
              <span>{{ item.familiarity }}</span>
              <span>{{ item.completedDate || '-' }}</span>
            </div>
          </details>
          <div v-if="filteredTaskProgressRows.length === 0" class="empty-row">暂无任务。</div>
        </div>
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
            <p class="trend-caption">主任务 + 复习任务总训练量</p>
          </div>
        </section>

        <section class="panel review-progress-card">
          <div class="section-heading">
            <div>
              <h2>复习训练</h2>
              <p class="muted">复习完成量独立统计；今日总练习量 = 主任务完成量 + 复习完成量。</p>
            </div>
            <div class="segmented compact">
              <button type="button" :class="{ active: reviewTrendRange === 7 }" @click="reviewTrendRange = 7">近7天</button>
              <button type="button" :class="{ active: reviewTrendRange === 30 }" @click="reviewTrendRange = 30">近30天</button>
            </div>
          </div>
          <div class="review-stats">
            <article><span>今日主任务完成</span><strong>{{ todayLogTotal }}</strong></article>
            <article><span>今日复习完成</span><strong>{{ todayReviewDone }} / {{ todayReviewTarget }}</strong></article>
            <article><span>明日待复习</span><strong>{{ tomorrowReviewTarget }}</strong></article>
            <article><span>今日总训练量</span><strong>{{ todayTotalTraining }}</strong></article>
          </div>
          <div class="review-trend" :class="{ monthly: reviewTrendRange === 30 }">
            <article v-for="row in reviewTrendRows" :key="`${row.date}-review`">
              <span>{{ row.label }}</span>
              <strong>{{ row.reviewTotal }}</strong>
              <small>复习量</small>
            </article>
          </div>
        </section>

        <section class="panel time-progress-card">
          <div class="section-heading">
            <div>
              <h2>学习时长</h2>
              <p class="muted">主任务和复习任务分别计时，运行中的计时只保存在本机。</p>
            </div>
          </div>
          <div class="review-stats">
            <article><span>今日主任务</span><strong>{{ formatDurationText(todayTaskSeconds) }}</strong></article>
            <article><span>今日复习</span><strong>{{ formatDurationText(todayReviewSeconds) }}</strong></article>
            <article><span>今日总计</span><strong>{{ formatDurationText(todayStudySeconds) }}</strong></article>
          </div>
          <div class="time-trend">
            <div v-for="row in timeTrendRows" :key="`${row.date}-time`">
              <span :style="{ height: `${row.height}px` }" />
              <small>{{ row.label }}</small>
              <b>{{ formatDurationText(row.totalSeconds) }}</b>
            </div>
          </div>
          <div v-if="todayTimeLogs.length" class="time-log-list">
            <article v-for="log in todayTimeLogs" :key="log.id">
              <div>
                <strong>{{ log.name }}</strong>
                <small>{{ log.type === 'review' ? '复习' : '主任务' }}</small>
              </div>
              <span>{{ formatDurationText(log.durationSeconds) }}</span>
              <button type="button" @click="deleteTimeLog(log.date, log.id)">删除</button>
            </article>
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
              <small>{{ task.completed }} / {{ task.totalTarget }}<template v-if="task.repeatCount > 1"> · 第 {{ task.currentRound }} / {{ task.repeatCount }} 遍</template></small>
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
          <div class="task-table settings-task-table">
            <div class="task-table-head">
              <span>任务</span><span>平台</span><span>频率</span><span>记录</span><span>任务日期</span><span>复习</span><span>题库量</span><span>轮次</span><span>完成</span><span>建议</span><span>操作</span>
            </div>
            <div v-for="task in group.tasks" :key="task.id" class="task-table-row">
              <input :value="task.name" @input="updateTask(task.id, { name: ($event.target as HTMLInputElement).value })">
              <select :value="task.platform" @change="updateTask(task.id, { platform: ($event.target as HTMLSelectElement).value as PracticePlatform })">
                <option v-for="platform in practicePlatforms" :key="platform" :value="platform">{{ platform }}</option>
              </select>
              <select :value="task.frequencyType" @change="updateTask(task.id, { frequencyType: ($event.target as HTMLSelectElement).value as FrequencyType })">
                <option v-for="frequencyType in frequencyTypes" :key="frequencyType" :value="frequencyType">{{ frequencyType }}</option>
              </select>
              <select :value="task.trackingMode" @change="updateTask(task.id, { trackingMode: ($event.target as HTMLSelectElement).value as TrackingMode })">
                <option v-for="mode in trackingModes" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
              </select>
              <div class="task-date-control" :class="{ expanded: task.startDate || task.endDate }">
                <label class="task-date-toggle">
                  <input
                    type="checkbox"
                    :checked="Boolean(task.startDate || task.endDate)"
                    @change="($event.target as HTMLInputElement).checked ? updateTask(task.id, { startDate: task.startDate || group.phase.startDate, endDate: task.endDate || group.phase.endDate }) : updateTask(task.id, { startDate: undefined, endDate: undefined })"
                  >
                  设日期
                </label>
                <div v-if="task.startDate || task.endDate" class="task-date-pair">
                  <input type="date" :value="task.startDate || group.phase.startDate" @input="updateTask(task.id, { startDate: ($event.target as HTMLInputElement).value || undefined })">
                  <input type="date" :value="task.endDate || group.phase.endDate" @input="updateTask(task.id, { endDate: ($event.target as HTMLInputElement).value || undefined })">
                </div>
                <span v-else>跟随阶段</span>
              </div>
              <label class="review-toggle">
                <input type="checkbox" :checked="task.reviewEnabled" @change="updateTask(task.id, { reviewEnabled: ($event.target as HTMLInputElement).checked })">
                开启
              </label>
              <input type="number" :value="task.target" @input="updateTask(task.id, { target: Number(($event.target as HTMLInputElement).value) })">
              <input type="number" min="1" :value="task.repeatCount" :disabled="task.trackingMode === 'itemized'" @input="updateTask(task.id, { repeatCount: Number(($event.target as HTMLInputElement).value) })">
              <input
                type="number"
                :value="task.completed"
                :disabled="task.trackingMode === 'itemized' && task.subItems.length > 0"
                @input="updateTask(task.id, { completed: Number(($event.target as HTMLInputElement).value) })"
              >
              <strong class="suggestion-cell">{{ plannedDailyTarget(task, group.phase) }}</strong>
              <button class="icon-button" type="button" @click="deleteTask(task.id)">删除</button>
            </div>
            <div v-for="task in group.tasks.filter((item) => item.trackingMode === 'itemized')" :key="`${task.id}-items`" class="subitem-manager">
              <div class="subitem-toolbar">
                <strong>{{ task.name }} 子项目</strong>
                <button type="button" @click="addSubItem(task.id)">新增子项目</button>
                <button type="button" @click="openImportModal(task.id)">批量导入</button>
                <button type="button" @click="copySubItems(task)">复制全部</button>
                <button class="danger-light" type="button" @click="deleteAllSubItems(task)">批量删除</button>
              </div>
              <div class="subitem-grid">
                <div v-for="item in task.subItems" :key="item.id" class="subitem-row">
                  <input :value="item.title" @input="updateSubItem(task.id, item.id, { title: ($event.target as HTMLInputElement).value })">
                  <button type="button" @click="deleteSubItem(task.id, item.id)">删除</button>
                </div>
              </div>
              <p v-if="task.subItems.length === 0" class="muted">还没有子项目，可以新增或批量生成。</p>
            </div>
            <p v-if="group.tasks.length === 0" class="muted">这个阶段还没有任务。新增任务后会只记录每日完成进度，不保存题库内容。</p>
          </div>
        </div>
        <p class="hint">提示：动态均摊 = Math.ceil(剩余任务量 / 当前阶段剩余有效练习天数)。如果今天少做，未完成量会在之后的剩余天数里重新均摊。</p>
      </section>
    </section>

    <section v-else-if="tab === 'notes'" class="page">
      <section class="panel notes-panel">
        <div class="dashboard-title">
          <div>
            <h2>每日备注</h2>
            <p>按日期保存复盘、提醒和当天感受。</p>
          </div>
          <label class="phase-filter">日期
            <input type="date" :value="selectedNoteDate" @input="selectNoteDate(($event.target as HTMLInputElement).value)">
          </label>
        </div>
        <textarea v-model="noteDraft" class="daily-note-editor" placeholder="写下今天的复盘、注意事项或明天提醒。"></textarea>
        <div class="panel-actions">
          <button class="ghost" type="button" @click="noteDraft = data.dailyNotes?.[selectedNoteDate] || ''">取消</button>
          <button type="button" @click="saveDailyNote">保存备注</button>
        </div>
      </section>

      <section class="panel notes-panel">
        <h2>查看备注</h2>
        <div v-if="noteRows.length" class="note-list">
          <article v-for="row in noteRows" :key="row.date">
            <div class="note-list-head">
              <time @click="selectNoteDate(row.date)">{{ row.date }}</time>
              <button type="button" @click="deleteDailyNote(row.date)">删除</button>
            </div>
            <p @click="selectNoteDate(row.date)">{{ row.note }}</p>
          </article>
        </div>
        <p v-else class="muted">还没有每日备注。</p>
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

    <div v-if="showTimerModal && runningTimer" class="modal timer-modal">
      <section class="modal-box timer-modal-box">
        <button class="modal-close-button" type="button" title="关闭并清空当前计时" @click="closeTimerModal">×</button>
        <span class="timer-type">{{ runningTimer.type === 'review' ? '复习计时' : '任务计时' }}</span>
        <h3>{{ runningTimer.name }}</h3>
        <strong class="timer-display">{{ formatDuration(currentTimerSeconds()) }}</strong>
        <p>{{ runningTimer.paused ? '已暂停，可以重置或修改保存时长。' : '计时中，保存后会写入今天的学习时长。' }}</p>
        <label class="timer-edit-field">保存时长
          <input
            type="text"
            :value="timerEditDirty ? timerEditText : formatDuration(currentTimerSeconds())"
            placeholder="例如 25:30 或 1:02:00"
            @input="updateTimerEdit(($event.target as HTMLInputElement).value)"
          >
        </label>
        <div class="timer-modal-actions">
          <button type="button" @click="toggleActiveTimer">{{ timerActionLabel() }}</button>
          <button class="ghost" type="button" @click="resetTimer(true)">重置</button>
          <button class="ghost" type="button" @click="resetTimer(false)">重新开始</button>
          <button class="primary" type="button" @click="saveRunningTimer">保存</button>
        </div>
      </section>
    </div>

    <div v-if="importTaskId" class="modal">
      <form class="modal-box import-modal" @submit.prevent="applyImportSubItems">
        <h3>批量导入篇目</h3>
        <p>每行一个篇目名称，保存后会追加到当前任务的子项目列表。</p>
        <textarea v-model="importText" rows="10" placeholder="WE01 - Education&#10;WE02 - Technology&#10;WE03 - Environment"></textarea>
        <div class="actions">
          <button type="submit">导入</button>
          <button class="ghost" type="button" @click="closeImportModal">取消</button>
        </div>
      </form>
    </div>

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

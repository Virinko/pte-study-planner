<script setup lang="ts">
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { graphic, init, use, type ECharts, type EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { CalendarDays, ChevronDown, ChevronRight, ClipboardList, Flag, Hourglass, Minus, PencilLine, Plus, Trash2, TrendingUp, X } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { buildSchedule, currentPhase, daysBetweenInclusive, defaultData, pct, taskCurrentRound, taskRemaining, taskRoundCompleted, taskSuggestion, taskTotalTarget, todayIso } from './planner';
import { fetchGitHubData, saveGitHubData } from './github';
import type { Familiarity, FrequencyType, Phase, PhaseSchedule, PracticePlatform, ReviewPlan, StudyData, StudyTimeEntry, StudyTimeSource, StudyTimeType, SubItem, SubItemStatus, Task, TimeLogEntry, TimeLogType, TrackingMode } from './types';

use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

const KEY = 'pte-study-planner-data';
const GITHUB_KEY = 'pte-study-planner-github-config';
const TIMER_KEY = 'pte-study-planner-running-timer';
const practicePlatforms: PracticePlatform[] = ['多墨', '猩际', '萤火虫', '影子三千'];
const frequencyTypes: FrequencyType[] = ['全题库', '超高频', '非超高频'];
const taskScoreRows = [
  { name: 'SGD', skill: '听力', percent: 20 },
  { name: 'RS', skill: '听力', percent: 17 },
  { name: 'RL', skill: '听力', percent: 13 },
  { name: 'WFD', skill: '听力', percent: 13 },
  { name: 'SST', skill: '听力', percent: 10 },
  { name: 'FIB-L', skill: '听力', percent: 8 },
  { name: 'HIW', skill: '听力', percent: 8 },
  { name: 'ASQ', skill: '听力', percent: 4 },
  { name: 'DI', skill: '口语', percent: 31 },
  { name: 'SGD', skill: '口语', percent: 19 },
  { name: 'RS', skill: '口语', percent: 16 },
  { name: 'RL', skill: '口语', percent: 13 },
  { name: 'RTS', skill: '口语', percent: 13 },
  { name: 'RA', skill: '口语', percent: 9 },
  { name: 'FIB-RW', skill: '阅读', percent: 25 },
  { name: 'SWT', skill: '阅读', percent: 23 },
  { name: 'FIB-R', skill: '阅读', percent: 20 },
  { name: 'HIW', skill: '阅读', percent: 13 },
  { name: 'RP', skill: '阅读', percent: 9 },
  { name: 'WE', skill: '写作', percent: 31 },
  { name: 'SWT', skill: '写作', percent: 28 },
  { name: 'WFD', skill: '写作', percent: 23 },
  { name: 'SST', skill: '写作', percent: 18 },
] as const;
const taskPriorityOptions = Object.values(taskScoreRows.reduce<Record<string, { name: string; score: number; sources: { skill: string; percent: number }[] }>>((map, row) => {
  const item = map[row.name] || { name: row.name, score: 0, sources: [] };
  item.score += row.percent;
  item.sources.push({ skill: row.skill, percent: row.percent });
  map[row.name] = item;
  return map;
}, {})).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
const taskPriorityByName = new Map(taskPriorityOptions.map((item) => [item.name, item]));
const taskPriorityRankByName = new Map(taskPriorityOptions.map((item, index) => [item.name, index]));
const examTypeOptions = [...taskPriorityOptions.map((item) => item.name), 'FIB'];
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
const sidebarItems: { key: (typeof tabs)[number][0]; label: string; icon: string }[] = [
  { key: 'today', label: '今日任务', icon: '📌' },
  { key: 'settings', label: '阶段计划', icon: '🗓️' },
  { key: 'progress', label: '进度统计', icon: '📊' },
  { key: 'notes', label: '每日备注', icon: '📝' },
  { key: 'sync', label: '进度同步', icon: '🔄' },
];
type TrendRange = '7' | '30' | 'all';

interface RunningTimer {
  type: TimeLogType;
  taskId?: string;
  reviewPlanId?: string;
  name: string;
  date: string;
  firstStartedAt?: number;
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
  const studyTimeEntries = normalizeStudyTimeEntries(source?.studyTimeEntries, source?.timeLogs ?? base.timeLogs);
  return {
    ...base,
    ...source,
    settings,
    phases,
    tasks,
    dailyLogs: source?.dailyLogs ?? base.dailyLogs,
    dailyNotes: source?.dailyNotes ?? base.dailyNotes,
    reviewPlans: normalizeReviewPlans(source?.reviewPlans ?? base.reviewPlans, tasks),
    timeLogs: entriesToTimeLogs(studyTimeEntries),
    studyTimeEntries,
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

function normalizeStudyTimeEntries(source: Partial<StudyTimeEntry>[] | undefined, legacy: Partial<StudyData['timeLogs']>): StudyTimeEntry[] {
  const entries = Array.isArray(source) && source.length > 0
    ? source.map((entry) => normalizeStudyTimeEntry(entry, entry.date || todayIso()))
    : Object.entries(legacy || {}).flatMap(([date, logs]) => (logs || []).map((log) => normalizeStudyTimeEntry(log, date)));
  return entries
    .filter((entry) => entry.durationSeconds > 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function normalizeStudyTimeEntry(entry: Partial<StudyTimeEntry> & Partial<TimeLogEntry>, fallbackDate: string): StudyTimeEntry {
  const timeType: StudyTimeType = entry.timeType === 'review' || entry.type === 'review' ? 'review' : 'main';
  const taskName = entry.taskName || entry.name || (timeType === 'review' ? '复习计时' : '任务计时');
  const source: StudyTimeSource = entry.source === 'manual' ? 'manual' : 'timer';
  const createdAt = entry.createdAt || new Date().toISOString();
  const durationSeconds = Math.max(0, Math.floor(Number(entry.durationSeconds || 0)));
  const endAt = entry.endAt || createdAt;
  const startAt = entry.startAt || inferStartAt(endAt, durationSeconds);
  return {
    id: entry.id || crypto.randomUUID(),
    date: entry.date || fallbackDate,
    taskId: entry.taskId || '',
    reviewPlanId: entry.reviewPlanId || '',
    taskName,
    examType: (entry.examType || examTypeFromName(taskName)).toUpperCase(),
    durationSeconds,
    timeType,
    source,
    note: entry.note || '',
    startAt,
    endAt,
    createdAt,
  };
}

function entriesToTimeLogs(entries: StudyTimeEntry[]): StudyData['timeLogs'] {
  return entries.reduce<StudyData['timeLogs']>((acc, entry) => {
    const log: TimeLogEntry = {
      id: entry.id,
      date: entry.date,
      type: entry.timeType === 'review' ? 'review' : 'task',
      taskId: entry.taskId || '',
      reviewPlanId: entry.reviewPlanId || '',
      name: entry.taskName,
      durationSeconds: entry.durationSeconds,
      startAt: entry.startAt,
      endAt: entry.endAt,
      createdAt: entry.createdAt,
    };
    acc[entry.date] = [...(acc[entry.date] || []), log];
    return acc;
  }, {});
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
  const prefix = taskInitials(name);
  return prefix === 'WE' || prefix === 'SWT' || prefix === 'SST' || prefix === 'RL' ? 'itemized' : 'count_only';
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
    const startedAt = Number(timer.startedAt || Date.now());
    const accumulatedSeconds = Math.max(0, Math.floor(Number(timer.accumulatedSeconds || 0)));
    const paused = Boolean(timer.paused);
    const firstStartedAt = Number(timer.firstStartedAt || ((accumulatedSeconds > 0 || !paused) ? startedAt : 0));
    return {
      type: timer.type,
      taskId: timer.taskId || '',
      reviewPlanId: timer.reviewPlanId || '',
      name: timer.name || (timer.type === 'review' ? '复习计时' : '任务计时'),
      date: timer.date || todayIso(),
      firstStartedAt: firstStartedAt || undefined,
      startedAt,
      accumulatedSeconds,
      paused,
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
const progressTrendRange = ref<TrendRange>('7');
const practiceTrendRange = ref<TrendRange>('7');
const timeTrendRange = ref<TrendRange>('7');
const selectedTimePointDate = ref('');
const showAllTaskProgress = ref(false);
const showAllTimeEntries = ref(false);
const selectedNoteDate = ref(todayIso());
const noteDraft = ref(data.value.dailyNotes?.[todayIso()] || '');
const importTaskId = ref('');
const importText = ref('');
const runningTimer = ref<RunningTimer | null>(loadRunningTimer());
const showTimerModal = ref(Boolean(runningTimer.value));
const timerEditHours = ref('');
const timerEditMinutes = ref('');
const timerEditSeconds = ref('');
const timerEditDirty = ref(false);
const manualStudyExamType = ref('RS');
const manualStudyHours = ref('');
const manualStudyMinutes = ref('');
const manualStudySeconds = ref('');
const manualStudyTimeType = ref<StudyTimeType>('main');
const manualStudyNote = ref('');
const nowMs = ref(Date.now());
const progressTrendChartEl = ref<HTMLDivElement | null>(null);
const reviewTrendChartEl = ref<HTMLDivElement | null>(null);
const timeTrendChartEl = ref<HTMLDivElement | null>(null);
let tokenResolver: ((token: string) => void) | null = null;
let timerInterval: number | undefined;
let progressTrendChartInstance: ECharts | null = null;
let reviewTrendChartInstance: ECharts | null = null;
let timeTrendChartInstance: ECharts | null = null;

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
const studyTimeEntries = computed(() => data.value.studyTimeEntries || []);
const todayTimeLogs = computed(() => studyTimeEntries.value.filter((log) => log.date === todayIso()));
const todayTaskSeconds = computed(() => todayTimeLogs.value.filter((log) => log.timeType === 'main').reduce((sum, log) => sum + log.durationSeconds, 0));
const todayReviewSeconds = computed(() => todayTimeLogs.value.filter((log) => log.timeType === 'review').reduce((sum, log) => sum + log.durationSeconds, 0));
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
const planTotalDays = computed(() => daysBetweenInclusive(data.value.settings.startDate, data.value.settings.deadline));
const planRemainingDays = computed(() => {
  const today = todayIso();
  if (today < data.value.settings.startDate) return planTotalDays.value;
  if (today > data.value.settings.deadline) return 0;
  return daysBetweenInclusive(today, data.value.settings.deadline);
});
const planElapsedDays = computed(() => Math.max(0, planTotalDays.value - planRemainingDays.value));
const planTimePercent = computed(() => pct(planElapsedDays.value, planTotalDays.value));
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
    accent: taskAccentByName(task.name, index),
    initials: taskInitials(task.name),
    softColor: taskSoftColor(task.name, index),
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
    priorityScore: taskPriorityScore(task.name),
    priorityRank: taskPriorityRank(task.name),
    sourceIndex: index,
  };
}).sort((a, b) => b.priorityScore - a.priorityScore || a.priorityRank - b.priorityRank || a.sourceIndex - b.sourceIndex));
const todayTarget = computed(() => todayTaskRows.value.reduce((sum, task) => sum + task.dailyTarget, 0));
const todayPercent = computed(() => pct(todayLogTotal.value, todayTarget.value));
const todayTaskRemaining = computed(() => Math.max(0, todayTarget.value - todayLogTotal.value));
const completedTodayTaskRows = computed(() => todayTaskRows.value.filter((task) => task.doneToday));

const phaseProgress = computed(() => schedule.value.map((item, index) => {
  const tasks = data.value.tasks.filter((task) => task.phaseId === item.id);
  const done = tasks.reduce((sum, task) => sum + task.completed, 0);
  const target = tasks.reduce((sum, task) => sum + taskTotalTarget(task), 0);
  const today = todayIso();
  const status = target > 0 && done >= target ? '已完成' : today < item.startDate ? '未开始' : today > item.endDate ? '已结束' : '进行中';
  const remainingDays = today < item.startDate ? item.days : today > item.endDate ? 0 : daysBetweenInclusive(today, item.endDate);
  return { ...item, done, target, percent: pct(done, target), accent: phaseAccent(index), status, remainingDays };
}));

const taskGroups = computed(() => phaseProgress.value.map((phase) => ({
  phase,
  tasks: data.value.tasks.filter((task) => task.phaseId === phase.id),
})));

const taskProgressRows = computed(() => data.value.tasks.map((task, index) => ({
  ...task,
  accent: taskAccentByName(task.name, index),
  initials: taskInitials(task.name),
  softColor: taskSoftColor(task.name, index),
  totalTarget: taskTotalTarget(task),
  percent: pct(task.completed, taskTotalTarget(task)),
  remaining: taskRemaining(task),
  currentRound: taskCurrentRound(task),
  roundCompleted: taskRoundCompleted(task),
  totalStudySeconds: totalStudySecondsForTask(task),
  priorityScore: taskPriorityScore(task.name),
  priorityRank: taskPriorityRank(task.name),
  sourceIndex: index,
  phaseName: schedule.value.find((item) => item.id === task.phaseId)?.name || '未分配阶段',
  status: taskTotalTarget(task) > 0 && task.completed >= taskTotalTarget(task) ? '完成' : '正常',
})).sort((a, b) => b.priorityScore - a.priorityScore || a.priorityRank - b.priorityRank || a.sourceIndex - b.sourceIndex));
const visibleTaskProgressRows = computed(() => showAllTaskProgress.value ? taskProgressRows.value : taskProgressRows.value.slice(0, 6));
const selectedProgressPhase = computed(() => phaseProgress.value.find((item) => item.id === selectedProgressPhaseId.value) || activePhaseProgress.value || phaseProgress.value[0]);
const filteredTaskProgressRows = computed(() => taskProgressRows.value.filter((task) => !selectedProgressPhase.value || task.phaseId === selectedProgressPhase.value.id));

const activePhaseProgress = computed(() => phaseProgress.value.find((item) => item.id === phase.value?.id) || phaseProgress.value[0]);
const activePhaseDeadlineDays = computed(() => activePhaseProgress.value ? daysBetweenInclusive(todayIso(), activePhaseProgress.value.endDate) : 0);

const trendRows = computed(() => {
  const rows = dateRangeRows(progressTrendRange.value).map((date) => {
    const mainTotal = (data.value.dailyLogs[date] || []).reduce((sum, log) => sum + (log.count ?? log.amount ?? 0), 0);
    return { date, label: trendLabel(date, progressTrendRange.value), total: mainTotal };
  });
  const max = Math.max(1, ...rows.map((row) => row.total));
  return rows.map((row) => ({ ...row, height: Math.max(8, Math.round((row.total / max) * 88)) }));
});
const practiceTrendRows = computed(() => {
  const rows = dateRangeRows(practiceTrendRange.value).map((date) => {
    const mainTotal = (data.value.dailyLogs[date] || []).reduce((sum, log) => sum + (log.count ?? log.amount ?? 0), 0);
    const reviewTotal = (data.value.reviewPlans[date] || []).reduce((sum, plan) => sum + plan.completed, 0);
    const practiceTotal = mainTotal + reviewTotal;
    return { date, label: trendLabel(date, practiceTrendRange.value), mainTotal, reviewTotal, practiceTotal };
  });
  const max = Math.max(1, ...rows.map((row) => row.practiceTotal));
  return rows.map((row) => ({ ...row, height: Math.max(8, Math.round((row.practiceTotal / max) * 94)) }));
});
const todayPracticeTotal = computed(() => todayLogTotal.value + todayReviewDone.value);
const todayPracticeTypeCount = computed(() => new Set([
  ...todayTaskRows.value.filter((task) => task.todayCompleted > 0).map((task) => task.initials),
  ...todayReviewPlans.value.filter((plan) => plan.completed > 0).map((plan) => taskInitials(plan.taskName)),
]).size);
const timeTrendRows = computed(() => {
  const rows = dateRangeRows(timeTrendRange.value).map((date) => {
    const totalSeconds = studyTimeEntries.value.filter((log) => log.date === date).reduce((sum, log) => sum + log.durationSeconds, 0);
    return { date, label: trendLabel(date, timeTrendRange.value), totalSeconds };
  });
  const max = Math.max(1, ...rows.map((row) => row.totalSeconds));
  return rows.map((row) => ({ ...row, height: Math.max(8, Math.round((row.totalSeconds / max) * 94)) }));
});
const timeByExamTypeRows = computed(() => {
  const grouped = todayTimeLogs.value
    .reduce<Record<string, number>>((acc, entry) => {
      const type = (entry.examType || examTypeFromName(entry.taskName)).toUpperCase();
      acc[type] = (acc[type] || 0) + entry.durationSeconds;
      return acc;
    }, {});
  return Object.entries(grouped)
    .map(([type, seconds], index) => ({ type, seconds, color: taskTypeColor(type, index), softColor: taskTypeSoftColor(type, index) }))
    .sort((a, b) => b.seconds - a.seconds);
});
const recentTodayTimeEntries = computed(() => [...todayTimeLogs.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const visibleTodayTimeEntries = computed(() => showAllTimeEntries.value ? recentTodayTimeEntries.value : recentTodayTimeEntries.value.slice(0, 5));
const todayPracticeItems = computed(() => {
  const mainItems = todayTaskRows.value.filter((task) => task.doneToday || task.todayStatus === '超额完成').map((task, index) => {
    const unit = task.trackingMode === 'itemized' ? '篇' : '题';
    return {
      id: `task-${task.id}`,
      type: task.initials,
      countText: `${task.todayCompleted} ${unit}`,
      color: task.accent,
      softColor: task.softColor,
      status: task.todayStatus,
      statusClass: task.todayStatus === '超额完成' ? 'status-extra' : task.doneToday ? 'status-ok' : 'status-warn',
      label: '主任务',
      sourceOrder: index,
    };
  });
  const reviewItems = todayReviewPlans.value.filter((plan) => plan.completed >= plan.target).map((plan, index) => {
    const task = data.value.tasks.find((item) => item.id === plan.taskId);
    const type = taskInitials(plan.taskName);
    return {
      id: `review-${plan.id}`,
      type,
      countText: `${plan.completed} 题`,
      color: taskTypeColor(type, index),
      softColor: taskTypeSoftColor(type, index),
      status: plan.completed >= plan.target ? '已复习' : '待复习',
      statusClass: plan.completed >= plan.target ? 'status-ok' : 'status-warn',
      label: reviewFamiliarity(task),
      sourceOrder: todayTaskRows.value.length + index,
    };
  });
  return [...mainItems, ...reviewItems].sort((a, b) => a.sourceOrder - b.sourceOrder);
});

function timeTrendAxisInterval(rowCount: number) {
  if (rowCount <= 8) return 0;
  return Math.max(1, Math.ceil(rowCount / 7) - 1);
}

function buildProgressTrendChartOption(): EChartsCoreOption {
  const rows = trendRows.value;
  const max = Math.max(5, ...rows.map((row) => row.total));
  const interval = max <= 5 ? 1 : Math.ceil(max / 4);
  const yMax = Math.ceil(max / interval) * interval;

  return {
    animationDuration: 450,
    grid: {
      top: 20,
      right: 16,
      bottom: 40,
      left: 28,
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: '#ffffff',
      borderColor: '#edf1f7',
      borderWidth: 1,
      padding: [8, 10],
      textStyle: {
        color: '#617087',
        fontSize: 12,
        fontWeight: 400,
      },
      extraCssText: 'box-shadow: 0 10px 20px rgba(15, 23, 42, .12); border-radius: 10px;',
      formatter(params: unknown) {
        const item = (Array.isArray(params) ? params[0] : params) as { data?: { date?: string; value?: number } } | undefined;
        const data = item?.data;
        if (!data?.date) return '';
        return `<div style="line-height:1.45"><div>${data.date}</div><strong style="color:#5f7df2;font-weight:500">${data.value || 0} 项</strong></div>`;
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((row) => row.label),
      axisLine: { lineStyle: { color: '#e0e7f1' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#667389',
        fontSize: rows.length > 12 ? 10 : 12,
        fontWeight: 600,
        margin: 10,
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: yMax,
      interval,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: {
        lineStyle: {
          color: '#e6ebf4',
          type: 'solid',
        },
      },
    },
    series: [
      {
        type: 'bar',
        barWidth: rows.length > 12 ? 11 : 18,
        data: rows.map((row) => ({
          value: row.total,
          date: row.date,
        })),
        itemStyle: {
          color: '#6f95f7',
          borderRadius: [9, 9, 0, 0],
        },
      },
    ],
  };
}

function buildPracticeTrendChartOption(): EChartsCoreOption {
  const rows = practiceTrendRows.value;
  const max = Math.max(5, ...rows.map((row) => row.practiceTotal));
  const interval = max <= 5 ? 1 : Math.ceil(max / 4);
  const yMax = Math.ceil(max / interval) * interval;

  return {
    animationDuration: 450,
    grid: {
      top: 20,
      right: 16,
      bottom: 16,
      left: 10,
      containLabel: true,
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: '#ffffff',
      borderColor: '#edf1f7',
      borderWidth: 1,
      padding: [8, 10],
      textStyle: {
        color: '#617087',
        fontSize: 12,
        fontWeight: 400,
      },
      extraCssText: 'box-shadow: 0 10px 20px rgba(15, 23, 42, .12); border-radius: 10px;',
      formatter(params: unknown) {
        const item = (Array.isArray(params) ? params[0] : params) as { data?: { date?: string; value?: number } } | undefined;
        const data = item?.data;
        if (!data?.date) return '';
        return `<div style="line-height:1.45"><div>${data.date}</div><strong style="color:#7d5df2;font-weight:500">${data.value || 0} 次练习</strong></div>`;
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((row) => row.label),
      axisLine: { lineStyle: { color: '#e0e7f1' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#667389',
        fontSize: 12,
        fontWeight: 600,
        margin: 8,
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: yMax,
      interval,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        show: true,
        color: '#667389',
        fontSize: 12,
        fontWeight: 600,
        margin: 10,
      },
      splitLine: {
        lineStyle: {
          color: '#e6ebf4',
          type: 'solid',
        },
      },
    },
    series: [
      {
        type: 'bar',
        barWidth: rows.length > 12 ? 11 : 18,
        data: rows.map((row) => ({
          value: row.practiceTotal,
          date: row.date,
        })),
        itemStyle: {
          color: '#8b5cf6',
          borderRadius: [9, 9, 0, 0],
        },
      },
    ],
  };
}

function buildTimeTrendChartOption(): EChartsCoreOption {
  const rows = timeTrendRows.value;
  const rowByDate = new Map(rows.map((row) => [row.date, row]));
  const maxSeconds = Math.max(1, ...rows.map((row) => row.totalSeconds));
  const maxHours = Math.max(3, Math.ceil(maxSeconds / 3600));
  const intervalHours = maxHours <= 3 ? 1 : Math.ceil(maxHours / 3);
  const yMax = Math.ceil(maxHours / intervalHours) * intervalHours * 3600;
  const yInterval = intervalHours * 3600;

  return {
    animationDuration: 450,
    grid: {
      top: 28,
      right: 18,
      bottom: 58,
      left: 60,
    },
    tooltip: {
      trigger: 'axis',
      triggerOn: 'mousemove|click|mousewheel',
      confine: true,
      backgroundColor: '#ffffff',
      borderColor: '#edf1f7',
      borderWidth: 1,
      padding: [10, 12],
      textStyle: {
        color: '#617087',
        fontSize: 14,
        fontWeight: 400,
      },
      extraCssText: 'box-shadow: 0 12px 22px rgba(15, 23, 42, .14); border-radius: 12px;',
      formatter(params: unknown) {
        const item = (Array.isArray(params) ? params[0] : params) as { data?: { date?: string; tooltipLabel?: string } } | undefined;
        const data = item?.data as { date?: string; tooltipLabel?: string } | undefined;
        if (!data?.date) return '';
        return `<div style="line-height:1.45"><div>${data.date}</div><strong style="color:#ff6b1a;font-weight:500">${data.tooltipLabel}</strong></div>`;
      },
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: rows.map((row) => row.date),
      axisLine: { lineStyle: { color: '#e0e7f1' } },
      axisTick: { show: false },
      axisLabel: {
        interval: timeTrendAxisInterval(rows.length),
        margin: 14,
        color: '#617087',
        fontSize: 15,
        fontWeight: 400,
        lineHeight: 21,
        formatter(value: string) {
          const row = rowByDate.get(value);
          return row?.label || value;
        },
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: yMax,
      interval: yInterval,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: {
        lineStyle: {
          color: '#dfe5ee',
          type: 'dashed',
        },
      },
      axisLabel: {
        color: '#617087',
        fontSize: 15,
        fontWeight: 400,
        formatter(value: number) {
          if (value === 0) return '0';
          return `${Math.round(value / 3600)}小时`;
        },
      },
    },
    series: [
      {
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: true,
        data: rows.map((row) => ({
          value: row.totalSeconds,
          date: row.date,
          tooltipLabel: formatDurationCompact(row.totalSeconds),
        })),
        lineStyle: {
          color: '#ff6b1a',
          width: 2.5,
        },
        itemStyle: {
          color: '#ffffff',
          borderColor: '#ff6b1a',
          borderWidth: 2,
        },
        areaStyle: {
          color: new graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(251, 146, 60, .30)' },
            { offset: .72, color: 'rgba(251, 146, 60, .10)' },
            { offset: 1, color: 'rgba(251, 146, 60, 0)' },
          ]),
        },
        emphasis: {
          scale: true,
          itemStyle: {
            color: '#fff7ed',
            borderWidth: 2.5,
          },
        },
      },
    ],
  };
}

async function renderTimeTrendChart() {
  if (tab.value !== 'progress') return;
  await nextTick();
  const el = timeTrendChartEl.value;
  if (!el) return;
  if (!timeTrendChartInstance || timeTrendChartInstance.isDisposed()) {
    timeTrendChartInstance = init(el);
  }
  const chart = timeTrendChartInstance;
  chart.setOption(buildTimeTrendChartOption(), true);
  chart.off('click');
  chart.on('click', (params) => {
    const data = params.data as { date?: string } | undefined;
    if (!data?.date || typeof params.dataIndex !== 'number') return;
    selectTimePoint(data.date);
    chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: params.dataIndex });
  });
  chart.resize();
}

async function renderProgressTrendChart() {
  if (tab.value !== 'progress') return;
  await nextTick();
  const el = progressTrendChartEl.value;
  if (!el) return;
  if (!progressTrendChartInstance || progressTrendChartInstance.isDisposed()) {
    progressTrendChartInstance = init(el);
  }
  progressTrendChartInstance.setOption(buildProgressTrendChartOption(), true);
  progressTrendChartInstance.resize();
}

async function renderReviewTrendChart() {
  if (tab.value !== 'progress') return;
  await nextTick();
  const el = reviewTrendChartEl.value;
  if (!el) return;
  if (!reviewTrendChartInstance || reviewTrendChartInstance.isDisposed()) {
    reviewTrendChartInstance = init(el);
  }
  reviewTrendChartInstance.setOption(buildPracticeTrendChartOption(), true);
  reviewTrendChartInstance.resize();
}

function renderProgressCharts() {
  void renderProgressTrendChart();
  void renderReviewTrendChart();
  void renderTimeTrendChart();
}

function resizeProgressCharts() {
  progressTrendChartInstance?.resize();
  reviewTrendChartInstance?.resize();
  timeTrendChartInstance?.resize();
}

function disposeProgressCharts() {
  progressTrendChartInstance?.dispose();
  progressTrendChartInstance = null;
  reviewTrendChartInstance?.dispose();
  reviewTrendChartInstance = null;
  timeTrendChartInstance?.dispose();
  timeTrendChartInstance = null;
}

onMounted(() => {
  timerInterval = window.setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
  window.addEventListener('resize', resizeProgressCharts);
  renderProgressCharts();
});

onBeforeUnmount(() => {
  if (timerInterval) window.clearInterval(timerInterval);
  window.removeEventListener('resize', resizeProgressCharts);
  disposeProgressCharts();
});

watch(tab, (nextTab) => {
  if (nextTab === 'progress') renderProgressCharts();
  else disposeProgressCharts();
});

watch(trendRows, () => {
  void renderProgressTrendChart();
}, { deep: true });

watch(practiceTrendRows, () => {
  void renderReviewTrendChart();
}, { deep: true });

watch(timeTrendRows, () => {
  void renderTimeTrendChart();
}, { deep: true });

watch([phaseProgress, phase], () => {
  if (!selectedProgressPhaseId.value && phase.value) selectedProgressPhaseId.value = phase.value.id;
}, { immediate: true });

function saveLocal(next: StudyData) {
  const stamped = { ...normalizeData(next), updatedAt: new Date().toISOString() };
  data.value = stamped;
  localStorage.setItem(KEY, JSON.stringify(stamped));
  const { githubOwner, githubRepo, githubBranch, githubPath } = stamped.settings;
  localStorage.setItem(GITHUB_KEY, JSON.stringify({ githubOwner, githubRepo, githubBranch, githubPath }));
}

function restartStudyPlan() {
  const confirmed = window.confirm('确定清除本地所有阶段、任务、进度、复习、计时和备注数据，并重新开始吗？GitHub 配置会保留，远端数据不会自动删除。');
  if (!confirmed) return;
  const fresh = defaultData();
  const { githubOwner, githubRepo, githubBranch, githubPath } = data.value.settings;
  const settings = { ...fresh.settings, githubOwner, githubRepo, githubBranch, githubPath };
  const phases = syncPhaseBoundaries(fresh.phases, settings);
  runningTimer.value = null;
  showTimerModal.value = false;
  clearTimerEditDraft();
  timerEditDirty.value = false;
  persistRunningTimer();
  selectedProgressPhaseId.value = phases[0]?.id || '';
  selectedNoteDate.value = todayIso();
  noteDraft.value = '';
  reviewAddTaskId.value = '';
  manualAmounts.value = {};
  reviewAmounts.value = {};
  saveLocal({ ...fresh, settings, phases });
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
    .filter((log) => log.timeType === (type === 'review' ? 'review' : 'main') && (type === 'review' ? log.reviewPlanId === id : log.taskId === id))
    .reduce((sum, log) => sum + log.durationSeconds, 0);
}

function totalStudySecondsForTask(task: Task) {
  const type = taskInitials(task.name);
  return studyTimeEntries.value
    .filter((log) => log.taskId === task.id || (!log.taskId && (log.examType || examTypeFromName(log.taskName)).toUpperCase() === type))
    .reduce((sum, log) => sum + log.durationSeconds, 0);
}

function selectTimePoint(date: string) {
  selectedTimePointDate.value = date;
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
  clearTimerEditDraft();
  timerEditDirty.value = false;
  persistRunningTimer();
}

function toggleActiveTimer() {
  if (!runningTimer.value) return;
  const seconds = currentTimerSeconds();
  const timestamp = Date.now();
  const nextPaused = !runningTimer.value.paused;
  nowMs.value = timestamp;
  runningTimer.value = {
    ...runningTimer.value,
    firstStartedAt: runningTimer.value.firstStartedAt || (nextPaused ? runningTimer.value.startedAt : timestamp),
    accumulatedSeconds: seconds,
    startedAt: timestamp,
    paused: nextPaused,
  };
  persistRunningTimer();
}

function resetTimer(paused = true) {
  if (!runningTimer.value) return;
  const timestamp = Date.now();
  nowMs.value = timestamp;
  runningTimer.value = {
    ...runningTimer.value,
    firstStartedAt: paused ? undefined : timestamp,
    accumulatedSeconds: 0,
    startedAt: timestamp,
    paused,
  };
  clearTimerEditDraft();
  timerEditDirty.value = false;
  persistRunningTimer();
}

function closeTimerModal() {
  runningTimer.value = null;
  showTimerModal.value = false;
  clearTimerEditDraft();
  timerEditDirty.value = false;
  persistRunningTimer();
}

function clearTimerEditDraft() {
  timerEditHours.value = '';
  timerEditMinutes.value = '';
  timerEditSeconds.value = '';
}

function durationParts(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

function syncTimerEditDraft(seconds: number) {
  const parts = durationParts(seconds);
  timerEditHours.value = String(parts.hours);
  timerEditMinutes.value = String(parts.minutes);
  timerEditSeconds.value = String(parts.seconds);
}

function ensureTimerEditDraft() {
  if (timerEditDirty.value) return;
  syncTimerEditDraft(currentTimerSeconds());
}

function updateTimerEditPart(part: 'hours' | 'minutes' | 'seconds', value: string) {
  ensureTimerEditDraft();
  if (part === 'hours') timerEditHours.value = value;
  if (part === 'minutes') timerEditMinutes.value = value;
  if (part === 'seconds') timerEditSeconds.value = value;
  timerEditDirty.value = true;
}

function timerEditPartValue(part: 'hours' | 'minutes' | 'seconds') {
  if (timerEditDirty.value) {
    if (part === 'hours') return timerEditHours.value;
    if (part === 'minutes') return timerEditMinutes.value;
    return timerEditSeconds.value;
  }
  const parts = durationParts(currentTimerSeconds());
  return String(parts[part]);
}

function timerEditDurationSeconds() {
  if (!timerEditDirty.value) return currentTimerSeconds();
  const hours = Number(timerEditHours.value || 0);
  const minutes = Number(timerEditMinutes.value || 0);
  const seconds = Number(timerEditSeconds.value || 0);
  if (
    !Number.isFinite(hours)
    || !Number.isFinite(minutes)
    || !Number.isFinite(seconds)
    || hours < 0
    || minutes < 0
    || seconds < 0
    || minutes >= 60
    || seconds >= 60
  ) {
    return null;
  }
  return Math.floor(hours * 3600 + minutes * 60 + seconds);
}

function saveRunningTimer() {
  const timer = runningTimer.value;
  if (!timer) return;
  const saveTimestamp = Date.now();
  nowMs.value = saveTimestamp;
  const durationSeconds = timerEditDurationSeconds();
  if (durationSeconds === null) {
    alert('请输入有效时长，分钟和秒需小于 60');
    return;
  }
  const endAt = new Date(saveTimestamp).toISOString();
  const startAt = timer.firstStartedAt
    ? new Date(timer.firstStartedAt).toISOString()
    : inferStartAt(endAt, durationSeconds);
  runningTimer.value = null;
  showTimerModal.value = false;
  clearTimerEditDraft();
  timerEditDirty.value = false;
  persistRunningTimer();
  if (durationSeconds <= 0) return;
  const date = timer.date || todayIso();
  const entry: StudyTimeEntry = {
    id: crypto.randomUUID(),
    date,
    taskId: timer.taskId || '',
    reviewPlanId: timer.reviewPlanId || '',
    taskName: timer.name,
    examType: examTypeFromName(timer.name),
    durationSeconds,
    timeType: timer.type === 'review' ? 'review' : 'main',
    source: 'timer',
    note: timer.type === 'review' ? '复习计时' : '主任务计时',
    startAt,
    endAt,
    createdAt: endAt,
  };
  const studyTimeEntries = [...studyTimeEntriesFromData(data.value), entry];
  saveLocal({
    ...data.value,
    studyTimeEntries,
    timeLogs: entriesToTimeLogs(studyTimeEntries),
  });
}

function addManualStudyTime() {
  const hours = Number(manualStudyHours.value || 0);
  const minutes = Number(manualStudyMinutes.value || 0);
  const seconds = Number(manualStudySeconds.value || 0);
  const durationSeconds = Math.floor(hours * 3600 + minutes * 60 + seconds);
  if (
    !Number.isFinite(hours)
    || !Number.isFinite(minutes)
    || !Number.isFinite(seconds)
    || hours < 0
    || minutes < 0
    || seconds < 0
    || minutes >= 60
    || seconds >= 60
    || durationSeconds <= 0
  ) {
    alert('请输入有效时长，分钟和秒需小于 60');
    return;
  }
  const examType = manualStudyExamType.value.toUpperCase();
  const date = todayIso();
  const endAt = new Date().toISOString();
  const startAt = inferStartAt(endAt, durationSeconds);
  const entry: StudyTimeEntry = {
    id: crypto.randomUUID(),
    date,
    taskId: '',
    reviewPlanId: '',
    taskName: `${examType} 手动计时`,
    examType,
    durationSeconds,
    timeType: manualStudyTimeType.value,
    source: 'manual',
    note: manualStudyNote.value.trim() || '手动添加',
    startAt,
    endAt,
    createdAt: endAt,
  };
  const studyTimeEntries = [...studyTimeEntriesFromData(data.value), entry];
  manualStudyHours.value = '';
  manualStudyMinutes.value = '';
  manualStudySeconds.value = '';
  manualStudyNote.value = '';
  saveLocal({
    ...data.value,
    studyTimeEntries,
    timeLogs: entriesToTimeLogs(studyTimeEntries),
  });
}

function deleteTimeLog(date: string, id: string) {
  const studyTimeEntries = studyTimeEntriesFromData(data.value).filter((log) => !(log.date === date && log.id === id));
  saveLocal({ ...data.value, studyTimeEntries, timeLogs: entriesToTimeLogs(studyTimeEntries) });
}

function inferStartAt(endAt: string, durationSeconds: number) {
  const endMs = new Date(endAt).getTime();
  if (!Number.isFinite(endMs)) return endAt;
  return new Date(endMs - Math.max(0, durationSeconds) * 1000).toISOString();
}

function timerEndAtIso() {
  return new Date(nowMs.value).toISOString();
}

function timerPreviewStartAt(timer: RunningTimer) {
  if (!timer.firstStartedAt) return '';
  return new Date(timer.firstStartedAt).toISOString();
}

function timerPreviewRange(timer: RunningTimer) {
  const startAt = timerPreviewStartAt(timer);
  if (!startAt) return '--:-- - --:--';
  return `${formatClockTime(startAt)}-${formatClockTime(timerEndAtIso())}`;
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
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    if (text.length <= 2) return Math.max(0, Number(text) * 60);
    const minutesText = text.slice(-2);
    const hoursText = text.slice(0, -2);
    const hours = Number(hoursText);
    const minutes = Number(minutesText);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes >= 60) return null;
    return Math.max(0, hours * 3600 + minutes * 60);
  }

  const compactTime = text.replace(/\s+/g, '');
  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(compactTime)) {
    const parts = compactTime.split(':').map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
    if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
    if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }

  const spacedParts = text.split(/\s+/).filter(Boolean).map((part) => Number(part));
  if (spacedParts.length === 2 && spacedParts.every((part) => Number.isFinite(part) && part >= 0)) {
    return Math.floor(spacedParts[0] * 3600 + spacedParts[1] * 60);
  }

  const durationPattern = /(\d+(?:\.\d+)?)\s*(小时|时|h|hr|hrs|分钟|分|m|min|mins|秒|s|sec|secs)/g;
  let total = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = durationPattern.exec(text)) !== null) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || amount < 0) return null;
    if (['小时', '时', 'h', 'hr', 'hrs'].includes(unit)) total += amount * 3600;
    else if (['分钟', '分', 'm', 'min', 'mins'].includes(unit)) total += amount * 60;
    else total += amount;
  }
  if (matched) return Math.floor(total);

  return null;
}

function formatDurationText(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  if (total <= 0) return '0 秒';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${secs} 秒`;
  if (minutes > 0) return `${minutes} 分 ${secs} 秒`;
  if (total < 60) return `${total} 秒`;
  return `${total} 秒`;
}

function formatDurationCompact(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}小时${String(minutes).padStart(2, '0')}分${String(secs).padStart(2, '0')}秒`;
  return `${minutes}分${String(secs).padStart(2, '0')}秒`;
}

function formatClockRange(log: StudyTimeEntry) {
  const endAt = log.endAt || log.createdAt;
  const startAt = log.startAt || inferStartAt(endAt, log.durationSeconds);
  return `${formatClockTime(startAt)}-${formatClockTime(endAt)}`;
}

function formatClockTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function updateSettings(patch: Partial<StudyData['settings']>) {
  const settings = { ...data.value.settings, ...patch };
  const phases = syncPhaseBoundaries(data.value.phases, settings);
  saveLocal({ ...data.value, settings, phases });
}

function updatePhase(id: string, patch: Partial<Phase>) {
  const sorted = [...data.value.phases].sort((a, b) => a.order - b.order);
  const firstId = sorted[0]?.id;
  const lastId = sorted[sorted.length - 1]?.id;
  const settings = {
    ...data.value.settings,
    ...(id === firstId && patch.startDate ? { startDate: patch.startDate } : {}),
    ...(id === lastId && patch.endDate ? { deadline: patch.endDate } : {}),
  };
  const phases = syncPhaseBoundaries(
    data.value.phases.map((item) => item.id === id ? { ...item, ...patch } : item),
    settings,
  );
  saveLocal({ ...data.value, settings, phases });
}

function deletePhase(id: string) {
  const phases = syncPhaseBoundaries(data.value.phases.filter((item) => item.id !== id), data.value.settings);
  saveLocal({
    ...data.value,
    phases,
    tasks: data.value.tasks.filter((task) => task.phaseId !== id),
  });
}

function addPhase() {
  const last = schedule.value[schedule.value.length - 1];
  const startDate = last ? addDays(last.endDate, 1) : data.value.settings.startDate;
  const endDate = startDate > data.value.settings.deadline ? startDate : data.value.settings.deadline;
  saveLocal({
    ...data.value,
    phases: syncPhaseBoundaries([...data.value.phases, { id: crypto.randomUUID(), name: '新阶段', order: data.value.phases.length + 1, startDate, endDate }], data.value.settings),
  });
}

function syncPhaseBoundaries(phases: Phase[], settings: StudyData['settings']) {
  const sorted = [...phases].sort((a, b) => a.order - b.order);
  if (sorted.length === 0) return sorted;
  const firstId = sorted[0].id;
  const lastId = sorted[sorted.length - 1].id;
  return phases.map((phase) => {
    if (phase.id === firstId && phase.id === lastId) return { ...phase, startDate: settings.startDate, endDate: settings.deadline };
    if (phase.id === firstId) return { ...phase, startDate: settings.startDate };
    if (phase.id === lastId) return { ...phase, endDate: settings.deadline };
    return phase;
  });
}

function updateTask(id: string, patch: Partial<Task>) {
  saveLocal({ ...data.value, tasks: data.value.tasks.map((task) => task.id === id ? normalizeTask({ ...task, ...patch }, data.value.phases[0]?.id || '') : task) });
}

function addTask(phaseId?: string, name = '') {
  const targetPhase = schedule.value.find((item) => item.id === phaseId) || phase.value || schedule.value[0];
  saveLocal({
    ...data.value,
    tasks: [
      ...data.value.tasks,
      {
        id: crypto.randomUUID(),
        phaseId: phaseId || targetPhase?.id || data.value.phases[0]?.id || '',
        name,
        platform: '多墨',
        frequencyType: '全题库',
        trackingMode: 'count_only',
        reviewEnabled: false,
        startDate: undefined,
        endDate: undefined,
        subItems: [],
        target: 0,
        repeatCount: 1,
        completed: 0,
      },
    ],
  });
}

function sortPhaseTasksByPriority(phaseId: string) {
  const phaseTasks = data.value.tasks
    .filter((task) => task.phaseId === phaseId)
    .map((task, index) => ({ task, index }))
    .sort((a, b) => taskPriorityScore(b.task.name) - taskPriorityScore(a.task.name) || taskPriorityRank(a.task.name) - taskPriorityRank(b.task.name) || a.index - b.index)
    .map((entry) => entry.task);
  let cursor = 0;
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((task) => task.phaseId === phaseId ? phaseTasks[cursor++] : task),
  });
}

function deleteTask(id: string) {
  saveLocal({ ...data.value, tasks: data.value.tasks.filter((task) => task.id !== id) });
}

function examTypeOptionLabel(type: string) {
  const priority = taskPriorityByName.get(type);
  return priority ? `${type} ${priority.score}%` : type;
}

function taskPriorityScore(name: string) {
  return taskPriorityByName.get(taskInitials(name))?.score || 0;
}

function taskPriorityRank(name: string) {
  return taskPriorityRankByName.get(taskInitials(name)) ?? Number.MAX_SAFE_INTEGER;
}

function taskPrioritySourceText(sources: { skill: string; percent: number }[]) {
  return sources.map((source) => `${source.skill} ${source.percent}%`).join(' + ');
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
  return expandedItemizedTasks.value[taskId] ?? false;
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

function dateRangeRows(range: TrendRange) {
  const today = todayIso();
  const startDate = range === 'all' ? data.value.settings.startDate : addDays(today, -(Number(range) - 1));
  const days = daysBetweenInclusive(startDate, today);
  return Array.from({ length: days }, (_, index) => addDays(startDate, index));
}

function trendLabel(date: string, range: TrendRange) {
  return range === 'all' || range === '30' ? date.slice(5) : date.slice(5);
}

function studyTimeEntriesFromData(source: StudyData) {
  return normalizeStudyTimeEntries(source.studyTimeEntries, source.timeLogs);
}

function taskInitials(name: string) {
  const normalized = name.trim().toUpperCase();
  const priorityName = taskPriorityOptions.find((item) => normalized === item.name || normalized.startsWith(`${item.name} `))?.name;
  if (priorityName) return priorityName;
  const letters = name.match(/[A-Za-z]+/g)?.join('').slice(0, 3);
  return (letters || name.slice(0, 2) || 'T').toUpperCase();
}

function examTypeFromName(name: string) {
  return taskInitials(name).slice(0, 3) || 'GEN';
}

function taskTypeColor(type: string, fallbackIndex = 0) {
  const key = type.toUpperCase();
  const colors: Record<string, string> = {
    RA: '#D65C62',
    RS: '#D95F87',
    WE: '#D87945',
    SWT: '#E0913A',
    WFD: '#D5A42F',
    SGD: '#A8A43C',
    RL: '#4AA66D',
    FIB: '#33A88A',
    'FIB-L': '#38AA86',
    'FIB-R': '#279E9A',
    'FIB-RW': '#2A93B8',
    HIW: '#3C82C4',
    ASQ: '#5C6FD3',
    RP: '#7D63C8',
    DI: '#A965C8',
    RTS: '#C65D9E',
    SST: '#CF5F79',
  };
  return colors[key] || ['#D65C62', '#D87945', '#D5A42F', '#4AA66D', '#279E9A', '#3C82C4', '#7D63C8', '#C65D9E'][fallbackIndex % 8];
}

function taskTypeSoftColor(type: string, fallbackIndex = 0) {
  const key = type.toUpperCase();
  const colors: Record<string, string> = {
    RA: '#fff0f0',
    RS: '#fff0f5',
    WE: '#fff2e8',
    SWT: '#fff4df',
    WFD: '#fff8dc',
    SGD: '#f8f7dd',
    RL: '#ecf8ef',
    FIB: '#e9f8f3',
    'FIB-L': '#e9f8f2',
    'FIB-R': '#e6f8f6',
    'FIB-RW': '#e7f5fa',
    HIW: '#eaf3fb',
    ASQ: '#eef1ff',
    RP: '#f2effb',
    DI: '#f7effb',
    RTS: '#fff0f8',
    SST: '#fff0f3',
  };
  return colors[key] || ['#fff0f0', '#fff2e8', '#fff8dc', '#ecf8ef', '#e6f8f6', '#eaf3fb', '#f2effb', '#fff0f8'][fallbackIndex % 8];
}

function taskAccentByName(name: string, fallbackIndex = 0) {
  return taskTypeColor(taskInitials(name), fallbackIndex);
}

function taskSoftColor(name: string, fallbackIndex = 0) {
  return taskTypeSoftColor(taskInitials(name), fallbackIndex);
}

function timeLogDisplayName(log: StudyTimeEntry) {
  const type = log.examType.trim();
  const name = log.taskName.trim();
  if (!type) return name;
  return name.replace(new RegExp(`^${type}\\s+`, 'i'), '').trim() || name;
}

function taskAccent(index: number) {
  return ['#7A77B9', '#EA7186', '#F2C76E', '#BD9DEA', '#8d8386'][index % 5];
}

function phaseAccent(index: number) {
  return ['#7A77B9', '#EA7186', '#F2C76E', '#BD9DEA'][index % 4];
}

function reviewFamiliarity(task?: Task) {
  if (!task || task.subItems.length === 0) return '综合';
  const order: Familiarity[] = ['生', '半熟', '熟', '可默写'];
  const counts = task.subItems.reduce<Record<string, number>>((acc, item) => {
    acc[item.familiarity] = (acc[item.familiarity] || 0) + 1;
    return acc;
  }, {});
  return [...order].sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0] || '综合';
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
          <span class="nav-emoji" aria-hidden="true">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
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
          <CalendarDays class="plan-strip-icon" :size="18" stroke-width="2.4" aria-hidden="true" />
          <span>计划开始日期</span>
          <strong>{{ data.settings.startDate }}</strong>
        </div>
        <div>
          <Flag class="plan-strip-icon" :size="18" stroke-width="2.4" aria-hidden="true" />
          <span>最终截止日期（考试日期）</span>
          <strong>{{ data.settings.deadline }}</strong>
        </div>
        <div>
          <Hourglass class="plan-strip-icon" :size="18" stroke-width="2.4" aria-hidden="true" />
          <span>距离{{ activePhaseProgress?.name || '当前阶段' }}截止日期</span>
          <strong>{{ activePhaseDeadlineDays }} 天</strong>
        </div>
        <button class="soft-button" type="button" @click="tab = 'settings'">修改计划</button>
      </section>

      <section class="dashboard-card phase-overview">
        <h2>阶段进度</h2>
        <div class="phase-overview-grid phase-overview-flow">
          <article
            v-for="(item, index) in phaseProgress"
            :key="item.id"
            class="phase-step-card"
            :class="{ current: item.id === activePhaseProgress?.id }"
            :style="{ '--phase-color': item.accent }"
          >
            <span class="phase-index">{{ index + 1 }}</span>
            <b class="phase-status-corner" :class="{ active: item.status === '进行中' }">{{ item.status }}</b>
            <strong>{{ item.name }}</strong>
            <small>{{ item.startDate.slice(5).replace('-', '.') }} - {{ item.endDate.slice(5).replace('-', '.') }}</small>
            <div class="phase-step-progress">
              <span class="progress-track"><i :style="{ width: `${item.percent}%`, background: item.accent }" /></span>
              <b>{{ item.percent }}%</b>
            </div>
            <span class="phase-count">{{ item.done }} / {{ item.target }}</span>
            <span class="phase-extra-info">
              <em>剩余 {{ item.remainingDays }} 天</em>
            </span>
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
            <strong>{{ activePhaseProgress.remainingDays }} 天</strong>
          </div>
          <div>
            <span>阶段状态</span>
            <strong>{{ activePhaseProgress.status }}</strong>
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
                  <button type="button" @click="applyManualAmount(task, -1)">
                    <Minus :size="16" stroke-width="2.6" aria-hidden="true" />
                  </button>
                  <input class="manual-input" type="number" min="0" :value="manualAmount(task.id)" @input="setManualAmount(task.id, ($event.target as HTMLInputElement).value)">
                  <button type="button" @click="applyManualAmount(task, 1)">
                    <Plus :size="16" stroke-width="2.6" aria-hidden="true" />
                  </button>
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
                  <summary>
                    <ChevronRight class="summary-icon" :size="16" stroke-width="2.6" aria-hidden="true" />
                    <span>此前已完成 {{ historicalDoneCount(task) }} 篇</span>
                  </summary>
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
                    <label class="select-control compact-select">
                      <select
                        :value="item.familiarity"
                        @change="updateTodaySubItemFamiliarity(task, item.id, ($event.target as HTMLSelectElement).value as Familiarity)"
                      >
                        <option v-for="familiarity in familiarityOptions" :key="familiarity" :value="familiarity">{{ familiarity }}</option>
                      </select>
                      <ChevronDown class="select-control-icon" :size="15" stroke-width="2.4" aria-hidden="true" />
                    </label>
                  </div>
                </div>
                <p v-else-if="task.subItems.length === 0" class="muted">请先在计划设置中新增或批量导入篇目。</p>
                <p v-else class="muted">所有篇目都已完成，可在左侧完成详情中查看或取消。</p>
                <button v-if="pendingSubItems(task).length > 10" class="text-button" type="button" @click="toggleSubItemList(task.id)">
                  {{ expandedSubItemLists[task.id] ? '收起' : `展开未完成（${pendingSubItems(task).length}）` }}
                  <ChevronDown v-if="!expandedSubItemLists[task.id]" :size="15" stroke-width="2.4" aria-hidden="true" />
                  <ChevronRight v-else :size="15" stroke-width="2.4" aria-hidden="true" />
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
              <label class="select-control">
                <select v-model="reviewAddDate">
                  <option value="today">今日复习</option>
                  <option value="tomorrow">明日复习</option>
                </select>
                <ChevronDown class="select-control-icon" :size="16" stroke-width="2.4" aria-hidden="true" />
              </label>
              <label class="select-control">
                <select v-model="reviewAddTaskId">
                  <option value="">选择任务</option>
                  <option v-for="task in reviewEnabledTasks" :key="task.id" :value="task.id">{{ task.name }}</option>
                </select>
                <ChevronDown class="select-control-icon" :size="16" stroke-width="2.4" aria-hidden="true" />
              </label>
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
                    <button type="button" @click="addReviewProgress(todayIso(), plan, -1)">
                      <Minus :size="16" stroke-width="2.6" aria-hidden="true" />
                    </button>
                    <input class="manual-input" type="number" min="0" :value="reviewAmount(plan.id)" @input="setReviewAmount(plan.id, ($event.target as HTMLInputElement).value)">
                    <button type="button" @click="addReviewProgress(todayIso(), plan, reviewAmount(plan.id))">
                      <Plus :size="16" stroke-width="2.6" aria-hidden="true" />
                    </button>
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
            <span class="select-control">
              <select v-model="selectedProgressPhaseId">
                <option v-for="item in phaseProgress" :key="item.id" :value="item.id">{{ item.name }}</option>
              </select>
              <ChevronDown class="select-control-icon" :size="16" stroke-width="2.4" aria-hidden="true" />
            </span>
          </label>
        </div>
        <div class="dashboard-table detail-table">
          <div class="dashboard-table-head">
            <span>任务名称</span><span>权重</span><span>所属阶段</span><span>轮次</span><span>已完成 / 目标</span><span>进度</span><span>总练习时长</span><span>剩余</span><span>状态</span>
          </div>
          <div v-for="task in filteredTaskProgressRows" :key="task.id" class="dashboard-table-row">
            <strong>{{ task.name }}</strong>
            <span>{{ task.priorityScore ? `${task.priorityScore}%` : '-' }}</span>
            <span>{{ task.phaseName }}</span>
            <span>{{ task.repeatCount > 1 ? `第 ${task.currentRound} / ${task.repeatCount} 遍` : '-' }}</span>
            <span>{{ task.completed }} / {{ task.totalTarget }}</span>
            <span class="inline-progress"><span class="progress-track"><i :style="{ width: `${task.percent}%`, background: task.accent }" /></span><b>{{ task.percent }}%</b></span>
            <span>{{ formatDurationCompact(task.totalStudySeconds) }}</span>
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
    <section v-else-if="tab === 'progress'" class="page progress-page">
      <div class="progress-page-head">
        <div>
          <h2>进度总览与数据统计</h2>
          <p>温和复盘每一天的主任务、练习记录和学习时长。</p>
        </div>
        <div class="plan-summary-pills">
          <span>计划周期 <strong>{{ data.settings.startDate }} ~ {{ data.settings.deadline }}</strong></span>
          <span>计划剩余天数 <strong>{{ daysLeft }} 天</strong></span>
        </div>
      </div>

      <div class="progress-layout progress-dashboard">
        <section class="panel hero-progress warm-card">
          <div class="overview-ring-block">
            <div class="ring warm-ring" :style="{ '--percent': `${overallPercent}%` }">
              <strong>{{ overallPercent }}%</strong>
            </div>
            <div>
              <strong>总进度</strong>
              <span>总体完成率</span>
            </div>
          </div>
          <div class="overview-numbers">
            <span>已完成 / 总任务</span>
            <h2>{{ overallDone }} <small>/ {{ overallTarget }}</small></h2>
            <div>
              <article><small>已完成任务数</small><strong>{{ overallDone }}</strong></article>
              <article><small>剩余任务数</small><strong>{{ totalRemaining }}</strong></article>
              <article><small>总任务数</small><strong>{{ overallTarget }}</strong></article>
            </div>
          </div>
          <div class="trend-card warm-trend">
            <div class="chart-head">
              <h3>近期完成趋势</h3>
              <div class="segmented compact">
                <button type="button" :class="{ active: progressTrendRange === '7' }" @click="progressTrendRange = '7'">近 7 天</button>
                <button type="button" :class="{ active: progressTrendRange === '30' }" @click="progressTrendRange = '30'">近 30 天</button>
                <button type="button" :class="{ active: progressTrendRange === 'all' }" @click="progressTrendRange = 'all'">全部</button>
              </div>
            </div>
            <div ref="progressTrendChartEl" class="progress-trend-echarts" role="img" aria-label="近期完成趋势图" />
          </div>
        </section>

        <section class="panel progress-module review-progress-card">
          <div class="section-heading">
            <div>
              <h2>练习模块</h2>
              <p class="muted">汇总主任务与复习完成量，覆盖所有题型。</p>
            </div>
            <div class="segmented compact">
              <button type="button" :class="{ active: practiceTrendRange === '7' }" @click="practiceTrendRange = '7'">近 7 天</button>
              <button type="button" :class="{ active: practiceTrendRange === '30' }" @click="practiceTrendRange = '30'">近 30 天</button>
              <button type="button" :class="{ active: practiceTrendRange === 'all' }" @click="practiceTrendRange = 'all'">全部</button>
            </div>
          </div>
          <div class="review-stats soft-stats">
            <article><span>今日主任务</span><strong>{{ todayLogTotal }}</strong></article>
            <article><span>今日复习</span><strong>{{ todayReviewDone }}</strong></article>
            <article><span>今日练习合计</span><strong>{{ todayPracticeTotal }}</strong></article>
            <article><span>已练题型</span><strong>{{ todayPracticeTypeCount }}</strong></article>
          </div>
          <div ref="reviewTrendChartEl" class="review-echarts" role="img" aria-label="练习趋势图" />
          <div class="review-items-block">
            <h3>今日练习条目</h3>
            <div v-if="todayPracticeItems.length" class="review-item-list">
              <article v-for="item in todayPracticeItems" :key="`${item.id}-practice-item`">
                <span class="type-badge" :style="{ color: item.color, background: item.softColor }">{{ item.type }}</span>
                <div>
                  <strong>{{ item.countText }}</strong>
                </div>
                <em :class="item.statusClass">{{ item.status }}</em>
                <b>{{ item.label }}</b>
              </article>
            </div>
            <p v-else class="soft-empty">今天还没有练习条目。</p>
          </div>
        </section>

        <section class="panel progress-module time-progress-card">
          <div class="section-heading">
            <div>
              <h2>学习时长</h2>
              <p class="muted">从每次学习时长流水汇总，删除记录后自动重算。</p>
            </div>
            <div class="segmented compact">
              <button type="button" :class="{ active: timeTrendRange === '7' }" @click="timeTrendRange = '7'">近 7 天</button>
              <button type="button" :class="{ active: timeTrendRange === '30' }" @click="timeTrendRange = '30'">近 30 天</button>
              <button type="button" :class="{ active: timeTrendRange === 'all' }" @click="timeTrendRange = 'all'">全部</button>
            </div>
          </div>
          <div class="time-line-chart" :class="{ dense: timeTrendRows.length > 12 }">
            <div class="time-chart-title"><span aria-hidden="true"><TrendingUp :size="18" stroke-width="2.4" /></span><strong>{{ timeTrendRange === '7' ? '近 7 天' : timeTrendRange === '30' ? '近 30 天' : '全部' }}学习时长趋势</strong></div>
            <div ref="timeTrendChartEl" class="time-echarts" role="img" aria-label="学习时长趋势图" />
          </div>
          <div class="review-stats soft-stats time-stats">
            <article><span>今日主任务时长</span><strong>{{ formatDurationCompact(todayTaskSeconds) }}</strong></article>
            <article><span>今日复习时长</span><strong>{{ formatDurationCompact(todayReviewSeconds) }}</strong></article>
            <article><span>今日总计</span><strong>{{ formatDurationCompact(todayStudySeconds) }}</strong></article>
          </div>
          <div class="time-type-grid">
            <article v-for="row in timeByExamTypeRows" :key="row.type" :style="{ '--type-color': row.color, '--type-soft': row.softColor }">
              <span>{{ row.type }}</span>
              <strong>{{ formatDurationCompact(row.seconds) }}</strong>
            </article>
            <p v-if="timeByExamTypeRows.length === 0" class="soft-empty">今天还没有学习时长记录。</p>
          </div>
          <div class="time-log-block">
            <div class="chart-head">
              <h3>今日添加记录</h3>
              <button v-if="recentTodayTimeEntries.length > 5" class="text-button expand-button" type="button" @click="showAllTimeEntries = !showAllTimeEntries">
                {{ showAllTimeEntries ? '收起' : '展开全部' }}
              </button>
              <form class="manual-time-form" @submit.prevent="addManualStudyTime">
                <label class="select-control">
                  <select v-model="manualStudyExamType" aria-label="题型">
                    <option v-for="type in examTypeOptions" :key="type" :value="type">{{ type }}</option>
                  </select>
                  <ChevronDown class="select-control-icon" :size="16" stroke-width="2.4" aria-hidden="true" />
                </label>
                <div class="duration-split-input" aria-label="学习时长">
                  <input v-model="manualStudyHours" aria-label="小时" type="number" inputmode="numeric" min="0" placeholder="时">
                  <input v-model="manualStudyMinutes" aria-label="分钟" type="number" inputmode="numeric" min="0" max="59" placeholder="分">
                  <input v-model="manualStudySeconds" aria-label="秒" type="number" inputmode="numeric" min="0" max="59" placeholder="秒">
                </div>
                <label class="select-control">
                  <select v-model="manualStudyTimeType" aria-label="类型">
                    <option value="main">主任务</option>
                    <option value="review">复习</option>
                  </select>
                  <ChevronDown class="select-control-icon" :size="16" stroke-width="2.4" aria-hidden="true" />
                </label>
                <button type="submit">添加</button>
              </form>
            </div>
            <div v-if="visibleTodayTimeEntries.length" class="time-log-list rich-time-log-list">
              <article v-for="log in visibleTodayTimeEntries" :key="log.id">
                <span class="type-badge time-log-type" :style="{ color: taskTypeColor(log.examType), background: taskTypeSoftColor(log.examType) }">{{ log.examType }}</span>
                <strong class="time-log-title">{{ timeLogDisplayName(log) }}</strong>
                <time class="time-log-range">{{ formatClockRange(log) }}</time>
                <span class="time-log-duration">{{ formatDurationCompact(log.durationSeconds) }}</span>
                <small class="time-log-kind">{{ log.timeType === 'review' ? '复习' : '主任务' }}</small>
                <button class="trash-button" type="button" title="删除记录" @click="deleteTimeLog(log.date, log.id)">
                  <X :size="17" stroke-width="3" aria-hidden="true" />
                </button>
              </article>
            </div>
            <p v-else class="soft-empty">今天还没有添加学习时长记录。</p>
          </div>
        </section>
      </div>
    </section>

    <section v-else-if="tab === 'settings'" class="page settings-page">
      <section class="settings-planner-panel">
        <div class="settings-hero">
          <span class="settings-hero-icon"><CalendarDays :size="30" stroke-width="2.3" aria-hidden="true" /></span>
          <div>
            <h2>备考计划设置</h2>
            <p>科学规划备考周期与阶段任务，合理分配时间，高效达成学习目标。</p>
          </div>
        </div>

        <div class="settings-subheading">
          <CalendarDays :size="18" stroke-width="2.4" aria-hidden="true" />
          <h3>计划周期</h3>
        </div>
        <div class="settings-cycle-card">
          <label class="settings-date-field">开始日期
            <span class="settings-input-shell">
              <CalendarDays :size="16" stroke-width="2.4" aria-hidden="true" />
              <input type="date" :value="data.settings.startDate" @input="updateSettings({ startDate: ($event.target as HTMLInputElement).value })">
            </span>
          </label>
          <label class="settings-date-field">结束日期
            <span class="settings-input-shell">
              <CalendarDays :size="16" stroke-width="2.4" aria-hidden="true" />
              <input type="date" :value="data.settings.deadline" @input="updateSettings({ deadline: ($event.target as HTMLInputElement).value })">
            </span>
          </label>
          <div class="settings-stat-card">
            <span class="settings-stat-icon purple"><CalendarDays :size="23" stroke-width="2.4" aria-hidden="true" /></span>
            <div>
              <span>计划总天数</span>
              <strong>{{ planTotalDays }} <small>天</small></strong>
            </div>
          </div>
          <div class="settings-stat-card">
            <span class="settings-stat-icon teal"><Hourglass :size="24" stroke-width="2.4" aria-hidden="true" /></span>
            <div>
              <span>剩余天数</span>
              <strong>{{ planRemainingDays }} <small>天</small></strong>
            </div>
          </div>
          <div class="settings-progress-stat">
            <div>
              <span>完成进度</span>
              <strong>{{ planTimePercent }}%</strong>
            </div>
            <span class="settings-progress-track"><i :style="{ width: `${planTimePercent}%` }" /></span>
            <p><span>已学习 {{ planElapsedDays }} 天/阶段</span><span>{{ planRemainingDays }} 天/未完成</span></p>
          </div>
        </div>

        <div class="section-heading settings-phase-heading">
          <div class="settings-subheading">
            <Flag :size="18" stroke-width="2.4" aria-hidden="true" />
            <h3>阶段安排</h3>
          </div>
          <button class="ghost strong" type="button" @click="addPhase">+ 新增阶段</button>
        </div>
        <div class="phase-cards">
          <article v-for="(item, index) in phaseProgress" :key="item.id" class="phase-card" :style="{ '--phase-color': item.accent }">
            <div class="phase-card-title">
              <span class="phase-card-index">{{ index + 1 }}</span>
              <span class="phase-name-shell">
                <input :value="item.name" @input="updatePhase(item.id, { name: ($event.target as HTMLInputElement).value })">
                <PencilLine :size="15" stroke-width="2.3" aria-hidden="true" />
              </span>
              <span class="phase-days-pill">阶段天数 {{ item.days }} 天</span>
            </div>
            <div class="phase-date-grid">
              <label>时间范围
                <span class="phase-range-shell">
                  <input type="date" :value="item.startDate" @input="updatePhase(item.id, { startDate: ($event.target as HTMLInputElement).value })">
                  <b>→</b>
                  <input type="date" :value="item.endDate" @input="updatePhase(item.id, { endDate: ($event.target as HTMLInputElement).value })">
                </span>
              </label>
            </div>
            <div class="phase-card-footer">
              <small>今日建议量会按本阶段剩余天数动态均摊。</small>
              <button class="text-button danger" type="button" @click="deletePhase(item.id)"><Trash2 :size="15" stroke-width="2.4" aria-hidden="true" /> 删除</button>
            </div>
          </article>
        </div>
      </section>

      <section class="panel settings-task-panel">
        <div class="settings-task-title">
          <span class="settings-task-title-icon"><ClipboardList :size="24" stroke-width="2.4" aria-hidden="true" /></span>
          <h2>任务</h2>
        </div>
        <div class="task-priority-panel">
          <div class="task-priority-heading">
            <div>
              <h3>题型优先级</h3>
              <p>按跨科目贡分合并排序，新增任务时会按这个列表选择。</p>
            </div>
            <span><TrendingUp :size="16" stroke-width="2.4" aria-hidden="true" /> 交叉贡分</span>
          </div>
          <div class="task-priority-list">
            <article v-for="(item, index) in taskPriorityOptions" :key="item.name">
              <b>{{ index + 1 }}</b>
              <strong>{{ item.name }}</strong>
              <em>{{ item.score }}%</em>
              <small>{{ taskPrioritySourceText(item.sources) }}</small>
            </article>
          </div>
        </div>
        <div v-for="group in taskGroups" :key="group.phase.id" class="phase-task-block">
          <div class="section-heading phase-task-heading">
            <div>
              <h3>{{ group.phase.name }}</h3>
              <p>{{ group.phase.startDate }} ~ {{ group.phase.endDate }}，{{ group.phase.days }} 天</p>
            </div>
            <div class="phase-task-actions">
              <button class="ghost strong weight-sort-button" type="button" :disabled="group.tasks.length < 2" @click="sortPhaseTasksByPriority(group.phase.id)">按权重排序</button>
              <button class="ghost strong purple-soft-button" type="button" @click="addTask(group.phase.id)">+ 新增本阶段任务</button>
            </div>
          </div>
          <div class="task-table settings-task-table">
            <div class="task-table-head">
              <span>任务</span><span>平台</span><span>频率</span><span>记录</span><span>任务日期</span><span>复习</span><span>题库量</span><span>轮次</span><span>完成</span><span>建议</span><span>操作</span>
            </div>
            <div v-for="task in group.tasks" :key="task.id" class="task-table-row">
              <label class="select-control table-select task-type-select table-field" data-label="任务">
                <select :value="task.name" @change="updateTask(task.id, { name: ($event.target as HTMLSelectElement).value })">
                  <option v-if="!examTypeOptions.includes(task.name)" :value="task.name">{{ task.name }}</option>
                  <option v-for="type in examTypeOptions" :key="type" :value="type">{{ examTypeOptionLabel(type) }}</option>
                </select>
                <ChevronDown class="select-control-icon" :size="15" stroke-width="2.4" aria-hidden="true" />
              </label>
              <label class="select-control table-select table-field" data-label="平台">
                <select :value="task.platform" @change="updateTask(task.id, { platform: ($event.target as HTMLSelectElement).value as PracticePlatform })">
                  <option v-for="platform in practicePlatforms" :key="platform" :value="platform">{{ platform }}</option>
                </select>
                <ChevronDown class="select-control-icon" :size="15" stroke-width="2.4" aria-hidden="true" />
              </label>
              <label class="select-control table-select table-field" data-label="频率">
                <select :value="task.frequencyType" @change="updateTask(task.id, { frequencyType: ($event.target as HTMLSelectElement).value as FrequencyType })">
                  <option v-for="frequencyType in frequencyTypes" :key="frequencyType" :value="frequencyType">{{ frequencyType }}</option>
                </select>
                <ChevronDown class="select-control-icon" :size="15" stroke-width="2.4" aria-hidden="true" />
              </label>
              <label class="select-control table-select table-field" data-label="记录">
                <select :value="task.trackingMode" @change="updateTask(task.id, { trackingMode: ($event.target as HTMLSelectElement).value as TrackingMode })">
                  <option v-for="mode in trackingModes" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
                </select>
                <ChevronDown class="select-control-icon" :size="15" stroke-width="2.4" aria-hidden="true" />
              </label>
              <div class="task-date-control table-field" data-label="任务日期" :class="{ expanded: task.startDate || task.endDate }">
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
              <label class="review-toggle table-field" data-label="复习">
                <input type="checkbox" :checked="task.reviewEnabled" @change="updateTask(task.id, { reviewEnabled: ($event.target as HTMLInputElement).checked })">
                开启
              </label>
              <label class="table-field number-field" data-label="题库量">
                <input type="number" :value="task.target || ''" @input="updateTask(task.id, { target: Number(($event.target as HTMLInputElement).value) })">
              </label>
              <label class="table-field number-field" data-label="轮次">
                <input type="number" min="1" :value="task.repeatCount" :disabled="task.trackingMode === 'itemized'" @input="updateTask(task.id, { repeatCount: Number(($event.target as HTMLInputElement).value) })">
              </label>
              <label class="table-field number-field" data-label="完成">
                <input
                  type="number"
                  :value="task.completed"
                  :disabled="task.trackingMode === 'itemized' && task.subItems.length > 0"
                  @input="updateTask(task.id, { completed: Number(($event.target as HTMLInputElement).value) })"
                >
              </label>
              <strong class="suggestion-cell table-field" data-label="建议">{{ plannedDailyTarget(task, group.phase) }}</strong>
              <div class="action-cell table-field" data-label="操作">
                <button class="icon-button" type="button" @click="deleteTask(task.id)">删除</button>
              </div>
            </div>
            <div v-for="task in group.tasks.filter((item) => item.trackingMode === 'itemized')" :key="`${task.id}-items`" class="subitem-manager">
              <div class="subitem-toolbar">
                <strong>{{ task.name }} 子项目</strong>
                <button class="purple-soft-button" type="button" @click="addSubItem(task.id)">+ 新增子项目</button>
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

      <section class="panel restart-panel">
        <div>
          <h2>重新开始</h2>
          <p>清空本地阶段、任务、每日进度、复习计划、学习时长和备注，重新生成一个新的默认计划。GitHub 配置会保留，远端数据不会自动删除。</p>
        </div>
        <button class="danger-restart-button" type="button" @click="restartStudyPlan">清除所有数据并重新开始</button>
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
        <div class="timer-time-range">
          <span>计时时段</span>
          <strong>{{ timerPreviewRange(runningTimer) }}</strong>
        </div>
        <p>{{ !runningTimer.firstStartedAt ? '尚未开始，点击开始后会记录起点。' : runningTimer.paused ? '已暂停，可以重置或修改保存时长。' : '计时中，保存后会写入今天的学习时长。' }}</p>
        <label class="timer-edit-field">保存时长
          <span class="timer-duration-inputs">
            <input
              type="number"
              inputmode="numeric"
              min="0"
              :value="timerEditPartValue('hours')"
              aria-label="小时"
              @input="updateTimerEditPart('hours', ($event.target as HTMLInputElement).value)"
            >
            <small>时</small>
            <input
              type="number"
              inputmode="numeric"
              min="0"
              max="59"
              :value="timerEditPartValue('minutes')"
              aria-label="分钟"
              @input="updateTimerEditPart('minutes', ($event.target as HTMLInputElement).value)"
            >
            <small>分</small>
            <input
              type="number"
              inputmode="numeric"
              min="0"
              max="59"
              :value="timerEditPartValue('seconds')"
              aria-label="秒"
              @input="updateTimerEditPart('seconds', ($event.target as HTMLInputElement).value)"
            >
            <small>秒</small>
          </span>
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

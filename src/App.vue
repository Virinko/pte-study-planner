<script setup lang="ts">
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { graphic, init, use, type ECharts, type EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { Bold, BookOpen, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock, Copy, FileDown, Flag, GripVertical, Hourglass, Italic, List, Minus, Pause, PencilLine, Play, Plus, RotateCcw, Save, Sparkles, Trash2, TrendingUp, X } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { buildSchedule, currentPhase, daysBetweenInclusive, defaultData, pct, taskCurrentRound, taskProgressCompleted, taskRemaining, taskRoundCompleted, taskRoundPlanEndDate, taskRoundStageEndDate, taskSuggestion, taskTotalTarget, todayIso } from './planner';
import type { AnswerEntry, DailyNoteEntry, Familiarity, FrequencyType, MockExam, Phase, PhaseSchedule, PlatformQuestionRef, PracticePlatform, ReviewLogEntry, ReviewPlan, StudyData, StudyTimeEntry, StudyTimeSource, StudyTimeType, SubItem, SubItemStatus, Task, TaskPlanStatus, TaskRoundHistoryEntry, TaskRoundStage, TimeLogEntry, TimeLogType, TrackingMode } from './types';

use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

const KEY = 'pte_progress_backup';
const LEGACY_KEY = 'pte-study-planner-data';
const TIMER_KEY = 'pte-study-planner-running-timer';
const POMODORO_KEY = 'pte-study-planner-running-pomodoro';
const APP_PASSWORD_KEY = 'pte_app_password';
const DIRTY_KEY = 'pte_progress_dirty';
const LAST_SYNCED_KEY = 'pte_progress_last_synced_at';
const LAST_SYNC_LABEL_KEY = 'pte_progress_last_sync_label';
const LAST_SYNC_MESSAGE_KEY = 'pte_progress_last_sync_message';
const CLOUD_SAVE_DEBOUNCE_MS = 1500;
const CLOUD_SAVE_MIN_INTERVAL_MS = 2000;
const IS_LOCAL_DEV = import.meta.env.DEV;
const practicePlatforms: PracticePlatform[] = ['多墨', '猩际', '萤火虫', '影子三千'];
const answerReferencePlatforms: PracticePlatform[] = ['多墨', '萤火虫', '猩际'];
const frequencyTypes: FrequencyType[] = ['全题库', '月预测', '超高频', '非超高频', '句乐部', '错题复习'];
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
const examTypeOptions = taskPriorityOptions.map((item) => item.name);
const noteExamTypeOptions = ['综合', ...examTypeOptions];
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
  ['answers', '答案库'],
] as const;
const sidebarItems: { key: (typeof tabs)[number][0]; label: string; icon: string }[] = [
  { key: 'today', label: '今日任务', icon: '📌' },
  { key: 'settings', label: '计划设置', icon: '🗓️' },
  { key: 'progress', label: '进度统计', icon: '📊' },
  { key: 'notes', label: '每日备注', icon: '📝' },
  { key: 'answers', label: '答案库', icon: '📚' },
];
type TrendRange = '7' | '30' | 'all';
type StudyTypeTimeRange = 'week' | 'all';
type TodayTargetDiffRow = { task: Task; current: number; latest: number };
type PomodoroDurationSeconds = 5 | 1500 | 1800 | 2700;
type PomodoroStage = 'focus' | 'break';

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

interface RunningPomodoro {
  taskId: string;
  name: string;
  date: string;
  stage: PomodoroStage;
  durationSeconds: PomodoroDurationSeconds;
  focusCompletedAt?: number;
  focusSaved: boolean;
  firstStartedAt?: number;
  startedAt: number;
  accumulatedSeconds: number;
  paused: boolean;
}

type ReviewPlanRow = ReviewPlan & { dueDate: string; overdue: boolean };
const pomodoroDurationOptions = [
  { seconds: 5, value: 5, unit: '秒测试' },
  { seconds: 1500, value: 25, unit: '分钟' },
  { seconds: 1800, value: 30, unit: '分钟' },
  { seconds: 2700, value: 45, unit: '分钟' },
] as const satisfies readonly { seconds: PomodoroDurationSeconds; value: number; unit: string }[];
const showPomodoroTestDuration = false;
const visiblePomodoroDurationOptions = pomodoroDurationOptions.filter((option) => showPomodoroTestDuration || option.seconds !== 5);
const POMODORO_SHORT_BREAK_SECONDS = 5 * 60;
const POMODORO_LONG_BREAK_SECONDS = 10 * 60;

function pomodoroBreakSeconds(durationSeconds: PomodoroDurationSeconds) {
  if (durationSeconds === 5) return 5;
  return durationSeconds === 1500 ? POMODORO_SHORT_BREAK_SECONDS : POMODORO_LONG_BREAK_SECONDS;
}

function pomodoroBreakDurationLabel(durationSeconds: PomodoroDurationSeconds) {
  if (durationSeconds === 5) return '5 秒';
  return `${pomodoroBreakSeconds(durationSeconds) / 60} 分钟`;
}

function normalizeData(source?: Partial<StudyData>): StudyData {
  const base = defaultData();
  const settings = normalizeSettings({ ...base.settings, ...source?.settings });
  const phases = normalizePhases(source?.phases ?? base.phases, settings);
  const planId = phases[0]?.id || '';
  const normalizedTasks = ((source?.tasks ?? base.tasks) as Array<Partial<Task>>).map((task) => ({ ...normalizeTask(task, planId), phaseId: planId }));
  const planPhase: PhaseSchedule = {
    ...phases[0],
    startDate: settings.startDate,
    endDate: settings.deadline,
    days: daysBetweenInclusive(settings.startDate, settings.deadline),
    totalWork: 0,
  };
  const isLegacyRoundDeadline = Number(source?.version || 0) < 5;
  const tasks = normalizedTasks.map((task) => {
    if (!task.roundModeEnabled || task.roundCleared) return task;
    if (!task.roundStageEndDate) return { ...task, roundStageEndDate: taskRoundStageEndDate(task, planPhase) };
    const completedFirstRound = task.roundHistory.some((entry) => entry.cycle === task.roundCycle && entry.stage === 1);
    if (isLegacyRoundDeadline && task.roundStage === 2 && completedFirstRound) {
      const plannedSecondRoundStart = addDays(task.roundStageEndDate, 1);
      return { ...task, roundStageEndDate: taskRoundStageEndDate(task, planPhase, plannedSecondRoundStart) };
    }
    return task;
  });
  const studyTimeEntries = normalizeStudyTimeEntries(source?.studyTimeEntries, source?.timeLogs ?? base.timeLogs);
  const reviewPlans = normalizeReviewPlans(source?.reviewPlans ?? base.reviewPlans, tasks);
  const reviewLogs = normalizeReviewLogs(source?.reviewLogs, reviewPlans, studyTimeEntries);
  return {
    ...base,
    ...source,
    version: base.version,
    settings,
    phases,
    tasks,
    dailyLogs: source?.dailyLogs ?? base.dailyLogs,
    dailyTargets: source?.dailyTargets ?? base.dailyTargets,
    dailyNotes: normalizeDailyNotes(source?.dailyNotes),
    answerEntries: normalizeAnswerEntries(source?.answerEntries),
    reviewPlans,
    reviewLogs,
    skippedReviewRegistrations: normalizeSkippedReviewRegistrations(source?.skippedReviewRegistrations ?? base.skippedReviewRegistrations, tasks),
    timeLogs: entriesToTimeLogs(studyTimeEntries),
    studyTimeEntries,
  };
}

function normalizePhases(source: unknown, settings: StudyData['settings']): Phase[] {
  const raw = Array.isArray(source) ? source as Array<Phase & { kind?: string; mockCompleted?: boolean; isDraft?: boolean }> : [];
  const studyPhases = raw.filter((phase) => phase.kind !== 'mock' && !phase.isDraft);
  const primary = [...studyPhases].sort((a, b) => (a.order || 0) - (b.order || 0))[0];
  const embeddedMocks = studyPhases.flatMap((phase) => normalizeMockExams(phase.mockExams));
  const legacyMocks = raw
    .filter((phase) => phase.kind === 'mock' && phase.startDate)
    .map((mock) => ({ id: mock.id || crypto.randomUUID(), date: mock.startDate!, name: mock.name || '模考日', completed: Boolean(mock.mockCompleted) }));
  const mockExams = normalizeMockExams([...embeddedMocks, ...legacyMocks]).filter((exam, index, exams) => exams.findIndex((item) => item.id === exam.id) === index);
  return [{
    id: primary?.id || crypto.randomUUID(),
    name: '备考总计划',
    order: 1,
    startDate: settings.startDate,
    endDate: settings.deadline,
    mockExams,
  }];
}

function normalizeMockExams(source: unknown): MockExam[] {
  if (!Array.isArray(source)) return [];
  return source
    .map((exam) => {
      const item = (exam || {}) as Partial<MockExam>;
      return { id: item.id || crypto.randomUUID(), date: item.date || '', name: item.name?.trim() || '模考日', completed: Boolean(item.completed) };
    })
    .filter((exam) => Boolean(exam.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeSettings(settings: StudyData['settings']): StudyData['settings'] {
  const fallback = defaultData().settings;
  return {
    startDate: settings.startDate || fallback.startDate,
    deadline: settings.deadline || fallback.deadline,
  };
}

function normalizeDailyNotes(source: unknown): StudyData['dailyNotes'] {
  return Object.entries((source || {}) as Record<string, unknown>).reduce<StudyData['dailyNotes']>((acc, [date, value]) => {
    const entries = Array.isArray(value)
      ? value.map((entry) => normalizeDailyNoteEntry(entry, date))
      : typeof value === 'string' && value.trim()
        ? [normalizeDailyNoteEntry({ content: value, date }, date)]
        : [];
    const validEntries = entries.filter((entry) => entry.content.trim());
    if (validEntries.length) {
      acc[date] = validEntries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return acc;
  }, {});
}

function normalizeDailyNoteEntry(source: unknown, fallbackDate: string): DailyNoteEntry {
  const note = (source || {}) as Partial<DailyNoteEntry>;
  const date = note.date || fallbackDate || todayIso();
  const createdAt = note.createdAt || `${date}T${note.time || '09:00'}:00`;
  const time = note.time || formatTime(createdAt);
  const examTypes = normalizeNoteExamTypes(note.examTypes || (note.examType ? [note.examType] : []), Boolean(note.examType));
  return {
    id: note.id || crypto.randomUUID(),
    date,
    time,
    examType: examTypes[0] || '综合',
    examTypes,
    content: note.content || '',
    createdAt,
    updatedAt: note.updatedAt,
  };
}

function normalizeAnswerEntries(source: unknown): AnswerEntry[] {
  if (!Array.isArray(source)) return [];
  const entries = source
    .map((entry) => {
      const answer = (entry || {}) as Partial<AnswerEntry> & { platform?: unknown; questionNumber?: unknown };
      const createdAt = answer.createdAt || new Date().toISOString();
      const rawRefs = Array.isArray(answer.platformRefs)
        ? answer.platformRefs
        : [{ platform: answer.platform, questionNumber: answer.questionNumber }];
      const platformRefs = rawRefs
        .map((ref) => ({
          platform: isPracticePlatform(ref?.platform) ? ref.platform : '多墨',
          questionNumber: String(ref?.questionNumber || '').trim(),
        }))
        .filter((ref) => ref.questionNumber);
      return {
        id: answer.id || crypto.randomUUID(),
        examType: answer.examType?.trim() || 'DI',
        platformRefs,
        title: answer.title?.trim() || '未命名答案',
        answer: answer.answer || '',
        createdAt,
        updatedAt: answer.updatedAt,
        sortOrder: Number.isFinite(answer.sortOrder) ? Math.floor(answer.sortOrder as number) : undefined,
      };
    })
    .filter((entry) => entry.answer.trim() || entry.platformRefs.length || entry.title !== '未命名答案');
  const nextOrderByType = new Map<string, number>();
  entries.forEach((entry) => {
    if (typeof entry.sortOrder !== 'number') return;
    nextOrderByType.set(entry.examType, Math.max(nextOrderByType.get(entry.examType) || 0, entry.sortOrder + 1));
  });
  return entries.map((entry) => {
    if (typeof entry.sortOrder === 'number') return entry;
    const nextOrder = nextOrderByType.get(entry.examType) || 0;
    nextOrderByType.set(entry.examType, nextOrder + 1);
    return { ...entry, sortOrder: nextOrder };
  });
}

function fixedAnswerPlatformRefs(source: PlatformQuestionRef[] = []): PlatformQuestionRef[] {
  return answerReferencePlatforms.map((platform) => ({
    platform,
    questionNumber: source.find((ref) => ref.platform === platform)?.questionNumber || '',
  }));
}

function normalizeTask(task: Partial<Task>, fallbackPhaseId: string): Task {
  const name = task.name ?? 'RS';
  const trackingMode = isTrackingMode(task.trackingMode) ? task.trackingMode : inferTrackingMode(name);
  const subItems = (task.subItems || []).map(normalizeSubItem);
  const doneCount = subItems.filter((item) => item.status === 'done').length;
  const target = Number(task.target ?? subItems.length ?? 0);
  const roundModeEnabled = trackingMode === 'count_only' && Boolean(task.roundModeEnabled);
  const repeatCount = trackingMode === 'count_only' && !roundModeEnabled
    ? Math.max(1, Math.floor(Number(task.repeatCount ?? 1) || 1))
    : 1;
  const totalTarget = Math.max(0, target * repeatCount);
  const completed = trackingMode === 'itemized' && subItems.length > 0 ? doneCount : Number(task.completed ?? 0);
  const roundStage = isTaskRoundStage(task.roundStage) ? task.roundStage : 1;
  const roundPass = Math.max(1, Math.floor(Number(task.roundPass ?? 1)));
  const roundHistory = normalizeTaskRoundHistory(task.roundHistory);
  const roundTarget = roundModeEnabled ? Math.max(0, Math.floor(Number(task.roundTarget ?? target))) : 0;
  const storedRoundCompleted = Math.max(0, Math.floor(Number(task.roundCompleted ?? 0)));
  const previousRoundProgress = target > 0 && completed > 0
    ? Math.max(0, Math.floor(completed)) % target || target
    : 0;
  const shouldRestoreInitialRoundProgress = roundModeEnabled
    && roundStage === 1
    && roundPass === 1
    && roundHistory.length === 0
    && storedRoundCompleted === 0
    && previousRoundProgress > 0;
  const roundCompleted = roundModeEnabled
    ? Math.min(roundTarget, shouldRestoreInitialRoundProgress ? previousRoundProgress : storedRoundCompleted)
    : 0;
  const roundCleared = roundModeEnabled && Boolean(task.roundCleared);
  return {
    id: task.id || crypto.randomUUID(),
    phaseId: task.phaseId || fallbackPhaseId,
    planStatus: isTaskPlanStatus(task.planStatus) ? task.planStatus : 'active',
    shelvedAt: task.shelvedAt || undefined,
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
    completed: Math.max(0, completed),
    completionArchived: roundModeEnabled
      ? roundCleared ? task.completionArchived !== false : true
      : totalTarget > 0 && completed >= totalTarget ? task.completionArchived !== false : true,
    roundModeEnabled,
    roundCycle: Math.max(1, Math.floor(Number(task.roundCycle ?? 1))),
    roundStage,
    roundPass,
    roundTarget,
    roundCompleted,
    roundStageEndDate: roundModeEnabled && task.roundStageEndDate ? task.roundStageEndDate : undefined,
    roundPracticeTotal: Math.max(0, Math.floor(Number(task.roundPracticeTotal ?? (roundModeEnabled ? completed : 0)))),
    roundCleared,
    roundHistory,
  };
}

function normalizeTaskRoundHistory(source: unknown): TaskRoundHistoryEntry[] {
  if (!Array.isArray(source)) return [];
  return source.map((entry) => {
    const item = (entry || {}) as Partial<TaskRoundHistoryEntry>;
    const target = Math.max(0, Math.floor(Number(item.target || 0)));
    const remainingMarked = item.remainingMarked === undefined ? undefined : Math.max(0, Math.floor(Number(item.remainingMarked || 0)));
    return {
      id: item.id || crypto.randomUUID(),
      cycle: Math.max(1, Math.floor(Number(item.cycle || 1))),
      stage: isTaskRoundStage(item.stage) ? item.stage : 1,
      pass: Math.max(1, Math.floor(Number(item.pass || 1))),
      target,
      completed: Math.min(target, Math.max(0, Math.floor(Number(item.completed || 0)))),
      remainingMarked,
      completedAt: item.completedAt || new Date().toISOString(),
    };
  });
}

function normalizeReviewPlans(source: Partial<StudyData['reviewPlans']>, tasks: Task[]): StudyData['reviewPlans'] {
  return Object.entries(source || {}).reduce<StudyData['reviewPlans']>((acc, [date, plans]) => {
    const normalized = (plans || []).map((plan) => normalizeReviewPlan(plan, tasks)).filter((plan) => plan.target > 0 || plan.completed > 0 || (plan.subItemIds?.length || 0) > 0);
    if (normalized.length) acc[date] = normalized;
    return acc;
  }, {});
}

function normalizeReviewPlan(plan: Partial<ReviewPlan>, tasks: Task[]): ReviewPlan {
  const task = tasks.find((item) => item.id === plan.taskId);
  const validSubItemIds = new Set(task?.subItems.map((item) => item.id) || []);
  const subItemIds = [...new Set(plan.subItemIds || [])].filter((id) => validSubItemIds.has(id));
  const completedSubItemIds = [...new Set(plan.completedSubItemIds || [])].filter((id) => subItemIds.includes(id));
  const target = subItemIds.length > 0 ? subItemIds.length : Math.max(0, Number(plan.target ?? 0));
  const completed = subItemIds.length > 0 ? completedSubItemIds.length : Math.max(0, Number(plan.completed ?? 0));
  return {
    id: plan.id || crypto.randomUUID(),
    taskId: plan.taskId || task?.id || '',
    taskName: plan.taskName || task?.name || '复习任务',
    sourceDate: plan.sourceDate || todayIso(),
    target,
    completed,
    subItemIds,
    completedSubItemIds,
  };
}

function normalizeReviewLogs(source: Partial<StudyData['reviewLogs']> | undefined, reviewPlans: StudyData['reviewPlans'], timeEntries: StudyTimeEntry[]): StudyData['reviewLogs'] {
  if (source === undefined) return legacyReviewLogs(reviewPlans, timeEntries);
  return Object.entries(source || {}).reduce<StudyData['reviewLogs']>((acc, [date, logs]) => {
    const normalized = (logs || []).map((log) => normalizeReviewLog(log, date)).filter((log) => log.amount > 0);
    if (normalized.length) acc[date] = normalized;
    return acc;
  }, {});
}

function normalizeReviewLog(log: Partial<ReviewLogEntry>, date: string): ReviewLogEntry {
  return {
    id: log.id || crypto.randomUUID(),
    reviewPlanId: log.reviewPlanId || '',
    taskId: log.taskId || '',
    taskName: log.taskName || '复习任务',
    amount: Math.max(0, Math.floor(Number(log.amount || 0))),
    createdAt: log.createdAt || `${date}T12:00:00`,
  };
}

function legacyReviewLogs(reviewPlans: StudyData['reviewPlans'], timeEntries: StudyTimeEntry[]): StudyData['reviewLogs'] {
  const latestActivityByPlan = timeEntries.reduce<Record<string, StudyTimeEntry>>((acc, entry) => {
    if (entry.timeType !== 'review' || !entry.reviewPlanId) return acc;
    const current = acc[entry.reviewPlanId];
    if (!current || entry.createdAt > current.createdAt) acc[entry.reviewPlanId] = entry;
    return acc;
  }, {});

  return Object.entries(reviewPlans).reduce<StudyData['reviewLogs']>((acc, [dueDate, plans]) => {
    (plans || []).forEach((plan) => {
      const amount = Math.max(0, Math.floor(plan.completed));
      if (amount <= 0) return;
      const activity = latestActivityByPlan[plan.id];
      const date = activity?.date && activity.date > dueDate ? activity.date : dueDate;
      acc[date] = [...(acc[date] || []), {
        id: crypto.randomUUID(),
        reviewPlanId: plan.id,
        taskId: plan.taskId,
        taskName: plan.taskName,
        amount,
        createdAt: activity?.createdAt || `${date}T12:00:00`,
      }];
    });
    return acc;
  }, {});
}

function normalizeSkippedReviewRegistrations(source: Partial<StudyData['skippedReviewRegistrations']>, tasks: Task[]): StudyData['skippedReviewRegistrations'] {
  const taskIds = new Set(tasks.map((task) => task.id));
  return Object.entries(source || {}).reduce<StudyData['skippedReviewRegistrations']>((acc, [date, ids]) => {
    const uniqueIds = [...new Set(ids || [])].filter((id) => taskIds.has(id));
    if (uniqueIds.length) acc[date] = uniqueIds;
    return acc;
  }, {});
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

function answerPlatformTagClass(platform: PracticePlatform) {
  return {
    '多墨': 'is-duomo',
    '猩际': 'is-xingji',
    '萤火虫': 'is-yinghuochong',
    '影子三千': 'is-yingzi',
  }[platform];
}

function isFrequencyType(value: unknown): value is FrequencyType {
  return frequencyTypes.includes(value as FrequencyType);
}

function isTrackingMode(value: unknown): value is TrackingMode {
  return value === 'count_only' || value === 'itemized';
}

function isTaskPlanStatus(value: unknown): value is TaskPlanStatus {
  return value === 'active' || value === 'shelved';
}

function isTaskRoundStage(value: unknown): value is TaskRoundStage {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function isSubItemStatus(value: unknown): value is SubItemStatus {
  return value === 'not_started' || value === 'doing' || value === 'done';
}

function isFamiliarity(value: unknown): value is Familiarity {
  return familiarityOptions.includes(value as Familiarity);
}

function inferFrequencyType(name: string): FrequencyType {
  if (name.includes('句乐部')) return '句乐部';
  if (name.includes('非超高频')) return '非超高频';
  if (name.includes('超高频')) return '超高频';
  return '全题库';
}

function inferTrackingMode(name: string): TrackingMode {
  const prefix = taskInitials(name);
  return prefix === 'WE' || prefix === 'SWT' || prefix === 'SST' || prefix === 'RL' ? 'itemized' : 'count_only';
}

function readStoredPassword() {
  try {
    return localStorage.getItem(APP_PASSWORD_KEY) || '';
  } catch {
    return '';
  }
}

function readStoredDirty() {
  try {
    return localStorage.getItem(DIRTY_KEY) === 'true';
  } catch {
    return false;
  }
}

function readStoredLastSyncedAt() {
  try {
    return localStorage.getItem(LAST_SYNCED_KEY) || '';
  } catch {
    return '';
  }
}

function readStoredLastSyncLabel() {
  try {
    return localStorage.getItem(LAST_SYNC_LABEL_KEY) || '';
  } catch {
    return '';
  }
}

function readStoredLastSyncMessage() {
  try {
    return localStorage.getItem(LAST_SYNC_MESSAGE_KEY) || '';
  } catch {
    return '';
  }
}

function hasStoredProgressBackup() {
  try {
    return Boolean(localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY));
  } catch {
    return false;
  }
}

function load(): StudyData {
  try {
    const raw = localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY);
    return normalizeData(raw ? JSON.parse(raw) as Partial<StudyData> : undefined);
  } catch {
    return defaultData();
  }
}

function loadRunningTimer(): RunningTimer | null {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (!raw) return null;
    const timer = JSON.parse(raw) as Partial<RunningTimer> & { mode?: string };
    if (timer.type !== 'task' && timer.type !== 'review') return null;
    if (timer.mode === 'pomodoro') return null;
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

function loadRunningPomodoro(): RunningPomodoro | null {
  try {
    const stored = localStorage.getItem(POMODORO_KEY);
    const legacy = stored ? null : localStorage.getItem(TIMER_KEY);
    const raw = stored || legacy;
    if (!raw) return null;
    const source = JSON.parse(raw) as Partial<RunningPomodoro> & { durationMinutes?: number; mode?: string; plannedSeconds?: number };
    if (!stored && source.mode !== 'pomodoro') return null;
    if (!source.taskId) return null;
    const requestedSeconds = Number(source.durationSeconds || source.plannedSeconds || Number(source.durationMinutes || 25) * 60);
    const durationSeconds = pomodoroDurationOptions.some((option) => option.seconds === requestedSeconds)
      ? requestedSeconds as PomodoroDurationSeconds
      : 1500;
    const stage: PomodoroStage = source.stage === 'break' ? 'break' : 'focus';
    const plannedSeconds = stage === 'break' ? pomodoroBreakSeconds(durationSeconds) : durationSeconds;
    const startedAt = Number(source.startedAt || Date.now());
    const accumulatedSeconds = Math.min(plannedSeconds, Math.max(0, Math.floor(Number(source.accumulatedSeconds || 0))));
    const paused = Boolean(source.paused);
    const firstStartedAt = Number(source.firstStartedAt || ((accumulatedSeconds > 0 || !paused) ? startedAt : 0));
    const pomodoro: RunningPomodoro = {
      taskId: source.taskId,
      name: source.name || '番茄钟',
      date: source.date || todayIso(),
      stage,
      durationSeconds,
      focusCompletedAt: Number(source.focusCompletedAt || 0) || undefined,
      focusSaved: Boolean(source.focusSaved),
      firstStartedAt: firstStartedAt || undefined,
      startedAt,
      accumulatedSeconds,
      paused,
    };
    if (!stored || source.durationSeconds !== durationSeconds || source.stage !== stage || source.focusSaved === undefined) {
      localStorage.setItem(POMODORO_KEY, JSON.stringify(pomodoro));
    }
    if (!stored) {
      localStorage.removeItem(TIMER_KEY);
    }
    return pomodoro;
  } catch {
    return null;
  }
}

const data = ref<StudyData>(load());
const tab = ref<(typeof tabs)[number][0]>('today');
const manualAmounts = ref<Record<string, number>>({});
const reviewAmounts = ref<Record<string, number>>({});
const selectedReviewSubItems = ref<Record<string, string[]>>({});
const reviewAddTaskId = ref('');
const reviewAddDate = ref<'today' | 'tomorrow'>('today');
const reviewAddTargetInput = ref(5);
const expandedItemizedTasks = ref<Record<string, boolean>>({});
const expandedSubItemLists = ref<Record<string, boolean>>({});
const selectedProgressPhaseId = ref('');
const mockExamDateDrafts = ref<Record<string, string>>({});
const mockExamNameDrafts = ref<Record<string, string>>({});
const practiceTrendRange = ref<TrendRange>('7');
const timeTrendRange = ref<TrendRange>('7');
const studyTypeTimeRange = ref<StudyTypeTimeRange>('week');
const selectedStudyWeekNumber = ref(0);
const showPlanAverageStudyTime = ref(false);
const practiceReportDate = ref(todayIso());
const selectedTimePointDate = ref('');
const showAllTaskProgress = ref(false);
const showAllTimeEntries = ref(false);
const selectedNoteDate = ref(todayIso());
const noteDraft = ref('');
const selectedNoteExamTypes = ref<string[]>([]);
const editingNoteId = ref('');
const noteEditorRef = ref<HTMLDivElement | null>(null);
const answerExamType = ref('DI');
const answerPlatformRefs = ref<PlatformQuestionRef[]>(fixedAnswerPlatformRefs());
const answerTitle = ref('');
const answerContent = ref('');
const editingAnswerId = ref('');
const answerSearch = ref('');
const answerTypeFilter = ref('全部');
const answerPlatformFilter = ref<'全部' | PracticePlatform>('全部');
const answerManualSortMode = ref(false);
const draggingAnswerId = ref('');
const exportAnswerType = ref('DI');
const isExportingAnswersPdf = ref(false);
const importTaskId = ref('');
const importText = ref('');
const correctionTaskId = ref('');
const correctionAmountInput = ref('');
const correctionError = ref('');
const correctionField = ref<HTMLInputElement | null>(null);
const roundSetupTaskId = ref('');
const roundSetupStage = ref<TaskRoundStage>(1);
const roundSetupTargetInput = ref('');
const roundSetupCurrentTargetInput = ref('');
const roundSetupError = ref('');
const roundAdvanceTaskId = ref('');
const roundRemainingInput = ref('');
const roundAdvanceError = ref('');
const platformSwitchTaskId = ref('');
const platformSwitchTarget = ref<PracticePlatform>('猩际');
const platformSwitchFrequency = ref<FrequencyType>('月预测');
const platformSwitchTargetCount = ref(0);
const platformSwitchPhaseId = ref('');
const platformSwitchError = ref('');
const restoreTaskId = ref('');
const restorePhaseId = ref('');
const showShelvedProgress = ref(false);
const runningTimer = ref<RunningTimer | null>(loadRunningTimer());
const runningPomodoro = ref<RunningPomodoro | null>(loadRunningPomodoro());
const appPassword = ref(readStoredPassword());
const passwordInput = ref('');
const passwordError = ref('');
const isDirty = ref(readStoredDirty());
const isCloudLoading = ref(false);
const isCloudSaving = ref(false);
const cloudSaveError = ref(false);
const cloudLoadError = ref(false);
const lastCloudSyncedAt = ref(readStoredLastSyncedAt());
const lastCloudSyncLabel = ref(readStoredLastSyncLabel());
const lastCloudSyncMessage = ref(readStoredLastSyncMessage());
const hasCheckedCloudBaseline = ref(IS_LOCAL_DEV);
const hasLocalProgressBackup = ref(hasStoredProgressBackup());
let cloudSaveTimer: number | undefined;
let lastCloudSaveAttemptAt = 0;
const showTimerModal = ref(false);
const showPomodoroModal = ref(false);
const timerEditHours = ref('');
const timerEditMinutes = ref('');
const timerEditSeconds = ref('');
const timerEditDirty = ref(false);
const pomodoroProgressInput = ref('');
const pomodoroProgressError = ref('');
const manualStudyExamType = ref('RS');
const manualStudyHours = ref('');
const manualStudyMinutes = ref('');
const manualStudySeconds = ref('');
const manualStudyTimeType = ref<StudyTimeType>('main');
const manualStudyNote = ref('');
const copiedCheckInKey = ref('');
const nowMs = ref(Date.now());
const dailyMottos = ['先开始，进度会自己出现。', '慢一点没关系，别停下来。'] as const;
const todayMotto = computed(() => {
  const now = new Date(nowMs.value);
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return dailyMottos[Math.floor(localMidnight / 86400000) % dailyMottos.length];
});
const reviewTrendChartEl = ref<HTMLDivElement | null>(null);
const timeTrendChartEl = ref<HTMLDivElement | null>(null);
const studyTypeChartEl = ref<HTMLDivElement | null>(null);
let timerInterval: number | undefined;
let pomodoroAudioContext: AudioContext | null = null;
let pomodoroTitleFlashTimer: number | undefined;
let pomodoroOriginalTitle = '';
let reviewTrendChartInstance: ECharts | null = null;
let timeTrendChartInstance: ECharts | null = null;
let studyTypeChartInstance: ECharts | null = null;
let copiedCheckInTimer: number | undefined;

const activePlanTasks = computed(() => data.value.tasks.filter((task) => task.planStatus === 'active'));
const activeRoundTaskCount = computed(() => activePlanTasks.value.filter((task) => task.roundModeEnabled && !task.roundCleared).length);
const shelvedTasks = computed(() => data.value.tasks
  .filter((task) => task.planStatus === 'shelved')
  .sort((a, b) => (b.shelvedAt || '').localeCompare(a.shelvedAt || '')));
const schedule = computed(() => buildSchedule(data.value));
const phase = computed(() => currentPhase(schedule.value));
const todayMockExams = computed(() => schedule.value.flatMap((scheduledPhase) => {
  const sourcePhase = data.value.phases.find((item) => item.id === scheduledPhase.id);
  return (sourcePhase?.mockExams || [])
    .filter((exam) => exam.date === todayIso())
    .map((exam) => ({ ...exam, phaseId: scheduledPhase.id, phaseName: scheduledPhase.name }));
}));
const todayTasks = computed(() => {
  const active = phase.value;
  if (!active) return [];
  return data.value.tasks.filter((task) => {
    if (task.planStatus !== 'active') return false;
    if (task.phaseId !== active.id) return false;
    return todayIso() >= (task.startDate || active.startDate);
  });
});
const todayLogs = computed(() => data.value.dailyLogs[todayIso()] || []);
const studyTimeEntries = computed(() => data.value.studyTimeEntries || []);
const firstStudyTimeLogDate = computed(() => studyTimeEntries.value
  .map((log) => log.date)
  .filter((date) => date <= todayIso())
  .sort()[0] || todayIso());
const todayTimeLogs = computed(() => studyTimeEntries.value.filter((log) => log.date === todayIso()));
const todayCheckInText = computed(() => {
  const totalSeconds = todayTimeLogs.value.reduce((sum, log) => sum + log.durationSeconds, 0);
  return totalSeconds > 0 ? formatTotalCheckInDuration(totalSeconds) : '';
});
const todayReviewLogs = computed(() => data.value.reviewLogs[todayIso()] || []);
const todayReviewedPlanIds = computed(() => new Set(todayReviewLogs.value.map((log) => log.reviewPlanId)));
const todayTaskSeconds = computed(() => todayTimeLogs.value.filter((log) => log.timeType === 'main').reduce((sum, log) => sum + log.durationSeconds, 0));
const todayReviewSeconds = computed(() => todayTimeLogs.value.filter((log) => log.timeType === 'review').reduce((sum, log) => sum + log.durationSeconds, 0));
const todayStudySeconds = computed(() => todayTaskSeconds.value + todayReviewSeconds.value);
const planAverageStudyDays = computed(() => {
  const today = todayIso();
  const startDate = data.value.settings.startDate;
  if (today < startDate) return 0;
  return daysBetweenInclusive(startDate, today);
});
const planAverageDailyStudySeconds = computed(() => {
  if (planAverageStudyDays.value <= 0) return 0;
  const today = todayIso();
  const startDate = data.value.settings.startDate;
  const totalSeconds = studyTimeEntries.value
    .filter((log) => log.date >= startDate && log.date <= today)
    .reduce((sum, log) => sum + log.durationSeconds, 0);
  return Math.floor(totalSeconds / planAverageStudyDays.value);
});
const allAverageStudyDays = computed(() => studyTimeEntries.value.length > 0
  ? daysBetweenInclusive(firstStudyTimeLogDate.value, todayIso())
  : 0);
const allAverageDailyStudySeconds = computed(() => {
  if (allAverageStudyDays.value <= 0) return 0;
  const totalSeconds = studyTimeEntries.value
    .filter((log) => log.date <= todayIso())
    .reduce((sum, log) => sum + log.durationSeconds, 0);
  return Math.floor(totalSeconds / allAverageStudyDays.value);
});
const displayedAverageStudySeconds = computed(() => showPlanAverageStudyTime.value
  ? planAverageDailyStudySeconds.value
  : allAverageDailyStudySeconds.value);
const runningTimerSeconds = computed(() => currentTimerSeconds());
const pomodoroElapsedSeconds = computed(() => currentPomodoroSeconds());
const pomodoroRemainingSeconds = computed(() => Math.max(0, pomodoroPlannedSeconds() - pomodoroElapsedSeconds.value));
const pomodoroTask = computed(() => data.value.tasks.find((task) => task.id === runningPomodoro.value?.taskId));
const pomodoroProgressPercent = computed(() => {
  const task = pomodoroTask.value;
  return task ? pct(taskQuestionProgress(task), taskTotalTarget(task)) : 0;
});
const pomodoroProgressPreview = computed(() => {
  const task = pomodoroTask.value;
  const raw = pomodoroProgressInput.value.trim();
  if (!task || task.trackingMode !== 'count_only' || !raw) return '';
  const endpoint = Number(raw);
  const current = taskQuestionProgress(task);
  if (!Number.isInteger(endpoint) || endpoint <= current || endpoint > taskTotalTarget(task)) return '';
  const delta = endpoint - current;
  return `将新增 ${delta} 题：今日进度 +${delta}，${task.roundModeEnabled ? '本轮' : '总'}进度更新为 ${taskProgressCompleted(task) + delta} / ${taskTotalTarget(task)}`;
});
const todayLogByTask = computed(() => {
  const result = todayLogs.value.reduce<Record<string, number>>((acc, log) => {
    const task = data.value.tasks.find((item) => item.id === log.taskId);
    if (task?.roundModeEnabled) {
      const belongsToCurrentRound = log.roundCycle === task.roundCycle && log.roundStage === task.roundStage && log.roundPass === task.roundPass;
      if (!belongsToCurrentRound) return acc;
    }
    acc[log.taskId] = (acc[log.taskId] || 0) + (log.count ?? log.amount ?? 0);
    return acc;
  }, {});
  for (const task of data.value.tasks) {
    if (task.trackingMode === 'itemized') result[task.id] = todayDoneItems(task).length;
    else result[task.id] = Math.min(Math.max(0, result[task.id] || 0), taskProgressCompleted(task));
  }
  return result;
});
const todayLogTotal = computed(() => Object.values(todayLogByTask.value).reduce((sum, amount) => sum + Math.max(0, amount), 0));
const todayReviewPlans = computed<ReviewPlanRow[]>(() => {
  const today = todayIso();
  return Object.entries(data.value.reviewPlans || {})
    .filter(([date]) => date <= today)
    .flatMap(([date, plans]) => (plans || [])
      .filter((plan) => data.value.tasks.find((task) => task.id === plan.taskId)?.planStatus !== 'shelved')
      .filter((plan) => date === today || plan.completed < plan.target || todayReviewedPlanIds.value.has(plan.id))
      .map((plan) => ({ ...plan, dueDate: date, overdue: date < today })))
    .sort((a, b) => Number(a.overdue) - Number(b.overdue) || a.dueDate.localeCompare(b.dueDate) || a.taskName.localeCompare(b.taskName));
});
const tomorrowReviewPlans = computed(() => (data.value.reviewPlans[addDays(todayIso(), 1)] || [])
  .filter((plan) => data.value.tasks.find((task) => task.id === plan.taskId)?.planStatus !== 'shelved'));
const reviewEnabledTasks = computed(() => activePlanTasks.value.filter((task) => task.reviewEnabled));
const countReviewEnabledTasks = computed(() => reviewEnabledTasks.value.filter((task) => task.trackingMode !== 'itemized'));
const todayReviewTarget = computed(() => todayReviewPlans.value.reduce((sum, plan) => sum + plan.target, 0));
const todayReviewPlanDone = computed(() => todayReviewPlans.value.reduce((sum, plan) => sum + plan.completed, 0));
const todayReviewDone = computed(() => todayReviewLogs.value.reduce((sum, log) => sum + log.amount, 0));
const tomorrowReviewTarget = computed(() => tomorrowReviewPlans.value.reduce((sum, plan) => sum + plan.target, 0));
const overallDone = computed(() => activePlanTasks.value.reduce((sum, task) => sum + taskProgressCompleted(task), 0));
const overallTarget = computed(() => activePlanTasks.value.reduce((sum, task) => sum + taskTotalTarget(task), 0));
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
const saveStatusText = computed(() => {
  if (IS_LOCAL_DEV) return '本地测试模式';
  if (!appPassword.value) return '请输入访问密码';
  if (passwordError.value) return passwordError.value;
  if (isCloudLoading.value) return '正在检查云端最新进度...';
  if (isCloudSaving.value) return '保存中...';
  if (cloudSaveError.value || cloudLoadError.value) return '网络异常，已暂存在本地';
  if (lastCloudSyncMessage.value) return lastCloudSyncLabel.value || '云端已同步';
  if (isDirty.value) return '有未同步改动';
  return lastCloudSyncedAt.value ? '已保存本地并同步云端' : '本地已保存';
});
const saveStatusClass = computed(() => ({
  saving: !IS_LOCAL_DEV && (isCloudLoading.value || isCloudSaving.value),
  pending: !IS_LOCAL_DEV && isDirty.value && !isCloudLoading.value && !isCloudSaving.value,
  error: !IS_LOCAL_DEV && (Boolean(passwordError.value) || cloudSaveError.value || cloudLoadError.value),
  saved: IS_LOCAL_DEV || (!isDirty.value && !isCloudLoading.value && !isCloudSaving.value && !passwordError.value && !cloudSaveError.value && !cloudLoadError.value),
}));
const syncStatusDetail = computed(() => {
  if (IS_LOCAL_DEV) return '仅保存到本机浏览器，不读写 Cloudflare KV';
  if (isCloudLoading.value) return '正在比较本地与云端更新时间';
  if (lastCloudSyncMessage.value) return lastCloudSyncMessage.value;
  return lastCloudSyncedAt.value ? new Date(lastCloudSyncedAt.value).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
});
const noteRows = computed(() => Object.entries(data.value.dailyNotes || {})
  .flatMap(([date, notes]) => (notes || []).map((note) => ({ ...note, date: note.date || date })))
  .filter((note) => !isNoteContentEmpty(note.content))
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const answerRows = computed(() => {
  const keyword = answerSearch.value.trim().toLocaleLowerCase();
  const rows = [...(data.value.answerEntries || [])]
    .filter((entry) => answerTypeFilter.value === '全部' || entry.examType === answerTypeFilter.value)
    .filter((entry) => answerPlatformFilter.value === '全部' || entry.platformRefs.some((ref) => ref.platform === answerPlatformFilter.value))
    .filter((entry) => !keyword || [...entry.platformRefs.map((ref) => ref.questionNumber), entry.title, entry.answer].some((value) => value.toLocaleLowerCase().includes(keyword)));
  if (answerManualSortMode.value) {
    return rows.sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});
const answerExamTypeOptions = computed(() => [...new Set(['DI', 'RS', ...examTypeOptions, ...data.value.answerEntries.map((entry) => entry.examType)])]);
const exportAnswerTypeOptions = computed(() => {
  const savedTypes = new Set(data.value.answerEntries.map((entry) => entry.examType));
  return answerExamTypeOptions.value.filter((type) => savedTypes.has(type));
});
const exportAnswerRows = computed(() => {
  const rows = [...data.value.answerEntries].filter((entry) => entry.examType === exportAnswerType.value);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
});
const todayDynamicTargetByTask = computed(() => buildTodayTargetSnapshot());
const todayFrozenTargetByTask = computed(() => data.value.dailyTargets?.[todayIso()] || {});
const todayDynamicTargetSignature = computed(() => JSON.stringify(todayDynamicTargetByTask.value));
const todayProgressSignature = computed(() => JSON.stringify(todayLogByTask.value));
const todayTargetDiffRows = computed<TodayTargetDiffRow[]>(() => todayTasks.value
  .map((task) => ({
    task,
    current: todayFrozenTargetByTask.value[task.id] ?? 0,
    latest: todayDynamicTargetByTask.value[task.id] ?? 0,
  }))
  .filter((row) => row.current !== row.latest && (todayLogByTask.value[row.task.id] || 0) > 0));
const todayTargetDiffRowsByPhase = computed(() => todayTargetDiffRows.value.reduce<Record<string, TodayTargetDiffRow[]>>((acc, row) => {
  const rows = acc[row.task.phaseId] || [];
  rows.push(row);
  acc[row.task.phaseId] = rows;
  return acc;
}, {}));
const hasTodayTargetSnapshot = computed(() => Boolean(data.value.dailyTargets?.[todayIso()]));
const shouldShowTodayTargetRefresh = computed(() => hasTodayTargetSnapshot.value && todayTargetDiffRows.value.length > 0);

function formatTodayTargetRefreshSummary(rows: TodayTargetDiffRow[]) {
  const changed = rows.length;
  const currentTotal = rows.reduce((sum, row) => sum + row.current, 0);
  const latestTotal = rows.reduce((sum, row) => sum + row.latest, 0);
  return `${changed} 个任务的最新建议已变化：当前合计 ${currentTotal}，最新建议 ${latestTotal}`;
}

function shouldShowTodayTargetRefreshForPhase(phaseId: string) {
  return shouldShowTodayTargetRefresh.value && Boolean(todayTargetDiffRowsByPhase.value[phaseId]?.length);
}

function todayTargetRefreshSummaryForPhase(phaseId: string) {
  return formatTodayTargetRefreshSummary(todayTargetDiffRowsByPhase.value[phaseId] || []);
}

const todayTaskRows = computed(() => todayTasks.value.map((task, index) => {
  const todayCompleted = todayLogByTask.value[task.id] || 0;
  const dailyTarget = todayFrozenTargetByTask.value[task.id] ?? todayDynamicTargetByTask.value[task.id] ?? 0;
  const remainingToday = Math.max(0, dailyTarget - todayCompleted);
  const progressCompleted = taskProgressCompleted(task);
  const completedOverall = isTaskCompletedOverall(task);
  const doneToday = dailyTarget > 0 ? todayCompleted >= dailyTarget : completedOverall;
  const todayPercent = pct(todayCompleted, dailyTarget);
  const overdue = taskIsOverdue(task);
  const todayStatus = completedOverall
    ? task.roundModeEnabled ? '已清零' : '已完成'
    : overdue
      ? '已超时'
      : todayCompleted > dailyTarget
        ? '超额完成'
        : doneToday
          ? '已完成'
          : '待完成';
  return {
    ...task,
    accent: taskAccentByName(task.name, index),
    initials: taskInitials(task.name),
    softColor: taskSoftColor(task.name, index),
    totalTarget: taskTotalTarget(task),
    progressCompleted,
    completedDate: taskCompletionDate(task),
    percent: pct(progressCompleted, taskTotalTarget(task)),
    remaining: taskRemaining(task),
    currentRound: taskCurrentRound(task),
    roundCompleted: taskRoundCompleted(task),
    todayCompleted,
    dailyTarget,
    todayPercent,
    todayStatus,
    todayStatusClass: todayStatus === '已超时'
      ? 'status-overdue'
      : todayStatus === '超额完成'
        ? 'status-extra'
        : todayStatus === '已完成' || todayStatus === '已清零'
          ? 'status-ok'
          : 'status-warn',
    remainingToday,
    doneToday,
    priorityScore: taskPriorityScore(task.name),
    priorityRank: taskPriorityRank(task.name),
    sourceIndex: index,
  };
}).sort((a, b) => b.priorityScore - a.priorityScore || a.priorityRank - b.priorityRank || a.sourceIndex - b.sourceIndex));
const completedOverallTaskRows = computed(() => todayTaskRows.value.filter((task) => isTaskCompletedOverall(task)));
const activeTodayTaskRows = computed(() => todayTaskRows.value.filter((task) => !isTaskCompletedOverall(task)));
const todayPomodoroTasks = computed(() => activeTodayTaskRows.value.filter((task) => task.target > 0));
const activeTodayLogTotal = computed(() => activeTodayTaskRows.value.reduce((sum, task) => sum + Math.max(0, task.todayCompleted), 0));
const todayTarget = computed(() => activeTodayTaskRows.value.reduce((sum, task) => sum + task.dailyTarget, 0));
const todayPercent = computed(() => pct(activeTodayLogTotal.value, todayTarget.value));
const todayTaskRemaining = computed(() => Math.max(0, todayTarget.value - activeTodayLogTotal.value));
const completedTodayTaskRows = computed(() => todayTaskRows.value.filter((task) => task.doneToday));

function taskCompletionDate(task: Task) {
  const totalTarget = taskTotalTarget(task);
  if (!isTaskCompletedOverall(task)) return '';
  if (task.roundModeEnabled) {
    return task.roundHistory[task.roundHistory.length - 1]?.completedAt.slice(0, 10) || '';
  }
  if (task.trackingMode === 'itemized') {
    const completedDates = task.subItems
      .filter((item) => item.status === 'done' && item.completedDate)
      .map((item) => item.completedDate || '')
      .sort((a, b) => a.localeCompare(b));
    return completedDates[completedDates.length - 1] || '';
  }

  let cumulative = 0;
  let latestProgressDate = '';
  for (const [date, logs] of Object.entries(data.value.dailyLogs).sort(([a], [b]) => a.localeCompare(b))) {
    const count = (logs || [])
      .filter((log) => log.taskId === task.id)
      .reduce((sum, log) => sum + (log.count ?? log.amount ?? 0), 0);
    if (count <= 0) continue;
    cumulative += count;
    latestProgressDate = date;
    if (cumulative >= totalTarget) return date;
  }
  return latestProgressDate;
}

function taskEffectiveEndDate(task: Task) {
  const phase = schedule.value.find((item) => item.id === task.phaseId);
  return task.endDate || phase?.endDate || data.value.settings.deadline;
}

function taskIsOverdue(task: Task, date = todayIso()) {
  if (task.planStatus === 'shelved') return false;
  const totalTarget = taskTotalTarget(task);
  return totalTarget > 0 && !isTaskCompletedOverall(task) && date > taskEffectiveEndDate(task);
}

const phaseProgress = computed(() => schedule.value.map((item, index) => {
  const tasks = activePlanTasks.value.filter((task) => task.phaseId === item.id);
  const done = tasks.reduce((sum, task) => sum + taskProgressCompleted(task), 0);
  const target = tasks.reduce((sum, task) => sum + taskTotalTarget(task), 0);
  const today = todayIso();
  const allTasksCompleted = tasks.length > 0 && tasks.every((task) => isTaskCompletedOverall(task));
  const status = allTasksCompleted ? '已完成' : today < item.startDate ? '未开始' : today > item.endDate ? '已结束' : '进行中';
  const remainingDays = today < item.startDate ? item.days : today > item.endDate ? 0 : daysBetweenInclusive(today, item.endDate);
  const timingSummary = today < item.startDate
    ? `共 ${item.days} 天，剩余 ${remainingDays} 天（未开始）`
    : today > item.endDate
      ? `共 ${item.days} 天，已结束`
      : `共 ${item.days} 天，剩余 ${remainingDays} 天（含今天）`;
  return { ...item, done, target, percent: pct(done, target), accent: phaseAccent(index), status, remainingDays, timingSummary };
}));

const taskGroups = computed(() => phaseProgress.value.map((phase) => ({
  phase,
  tasks: activePlanTasks.value.filter((task) => task.phaseId === phase.id && (!isTaskCompletedOverall(task) || task.completionArchived === false)),
})));
const completedSettingsTasks = computed(() => activePlanTasks.value
  .filter((task) => isTaskCompletedOverall(task) && task.completionArchived !== false)
  .map((task) => ({
    ...task,
    phaseName: phaseProgress.value.find((phase) => phase.id === task.phaseId)?.name || '未分配阶段',
    totalTarget: taskTotalTarget(task),
    progressCompleted: taskProgressCompleted(task),
    completedDate: taskCompletionDate(task),
  }))
  .sort((a, b) => (b.completedDate || '').localeCompare(a.completedDate || '')));
const correctionTask = computed(() => data.value.tasks.find((task) => task.id === correctionTaskId.value));
const roundSetupTask = computed(() => data.value.tasks.find((task) => task.id === roundSetupTaskId.value));
const roundAdvanceTask = computed(() => data.value.tasks.find((task) => task.id === roundAdvanceTaskId.value));
const platformSwitchTask = computed(() => data.value.tasks.find((task) => task.id === platformSwitchTaskId.value));
const platformSwitchExistingTask = computed(() => {
  const source = platformSwitchTask.value;
  if (!source) return undefined;
  return data.value.tasks.find((task) => task.id !== source.id
    && task.name === source.name
    && task.platform === platformSwitchTarget.value
    && task.frequencyType === platformSwitchFrequency.value);
});
const restoreTask = computed(() => data.value.tasks.find((task) => task.id === restoreTaskId.value));
const restoreConflictTask = computed(() => {
  const source = restoreTask.value;
  if (!source) return undefined;
  return data.value.tasks.find((task) => task.id !== source.id
    && task.planStatus === 'active'
    && task.name === source.name
    && !isTaskCompletedOverall(task));
});

const taskProgressRows = computed(() => data.value.tasks.map((task, index) => {
  const overdue = taskIsOverdue(task);
  const progressCompleted = taskProgressCompleted(task);
  const completed = isTaskCompletedOverall(task);
  return {
    ...task,
    accent: taskAccentByName(task.name, index),
    initials: taskInitials(task.name),
    softColor: taskSoftColor(task.name, index),
    totalTarget: taskTotalTarget(task),
    progressCompleted,
    percent: pct(progressCompleted, taskTotalTarget(task)),
    remaining: taskRemaining(task),
    currentRound: taskCurrentRound(task),
    roundCompleted: taskRoundCompleted(task),
    totalStudySeconds: totalStudySecondsForTask(task),
    priorityScore: taskPriorityScore(task.name),
    priorityRank: taskPriorityRank(task.name),
    sourceIndex: index,
    status: task.planStatus === 'shelved' ? '暂不安排' : completed ? '已结束' : overdue ? '已超时' : '进行中',
    statusClass: task.planStatus === 'shelved' ? 'is-shelved' : completed ? 'is-ended' : overdue ? 'status-overdue' : 'is-active',
  };
}).sort((a, b) => b.priorityScore - a.priorityScore || a.priorityRank - b.priorityRank || a.sourceIndex - b.sourceIndex));
const visibleTaskProgressRows = computed(() => showAllTaskProgress.value ? taskProgressRows.value : taskProgressRows.value.slice(0, 6));
const selectedProgressPhase = computed(() => phaseProgress.value.find((item) => item.id === selectedProgressPhaseId.value) || activePhaseProgress.value || phaseProgress.value[0]);
const filteredTaskProgressRows = computed(() => taskProgressRows.value.filter((task) => {
  if (!showShelvedProgress.value && task.planStatus === 'shelved') return false;
  return !selectedProgressPhase.value || task.phaseId === selectedProgressPhase.value.id;
}));

const activePhaseProgress = computed(() => phaseProgress.value.find((item) => item.id === phase.value?.id) || phaseProgress.value[0]);
const activePhaseDeadlineDays = computed(() => activePhaseProgress.value ? daysBetweenInclusive(todayIso(), activePhaseProgress.value.endDate) : 0);

const totalTrackedStudySeconds = computed(() => studyTimeEntries.value.reduce((sum, log) => sum + log.durationSeconds, 0));
const totalMainStudySeconds = computed(() => studyTimeEntries.value.filter((log) => log.timeType === 'main').reduce((sum, log) => sum + log.durationSeconds, 0));
const totalReviewStudySeconds = computed(() => studyTimeEntries.value.filter((log) => log.timeType === 'review').reduce((sum, log) => sum + log.durationSeconds, 0));
const planStudyWeekOptions = computed(() => {
  const planStart = data.value.settings.startDate;
  const planEnd = data.value.settings.deadline;
  const today = todayIso();
  const visibleEnd = today < planStart ? planStart : today > planEnd ? planEnd : today;
  const weekCount = Math.max(1, Math.ceil(daysBetweenInclusive(planStart, visibleEnd) / 7));
  return Array.from({ length: weekCount }, (_, index) => {
    const startDate = addDays(planStart, index * 7);
    const fullWeekEnd = addDays(startDate, 6);
    return {
      number: index + 1,
      startDate,
      endDate: fullWeekEnd > planEnd ? planEnd : fullWeekEnd,
    };
  });
});
const currentPlanStudyWeekNumber = computed(() => {
  const planStart = data.value.settings.startDate;
  const planEnd = data.value.settings.deadline;
  const today = todayIso();
  if (today <= planStart) return 1;
  const effectiveToday = today > planEnd ? planEnd : today;
  return Math.max(1, Math.ceil(daysBetweenInclusive(planStart, effectiveToday) / 7));
});
const selectedStudyWeek = computed(() => planStudyWeekOptions.value.find((week) => week.number === selectedStudyWeekNumber.value)
  || planStudyWeekOptions.value[planStudyWeekOptions.value.length - 1]);
const displayedStudyTypeEntries = computed(() => {
  if (studyTypeTimeRange.value === 'all' || !selectedStudyWeek.value) return studyTimeEntries.value;
  return studyTimeEntries.value.filter((entry) => entry.date >= selectedStudyWeek.value!.startDate && entry.date <= selectedStudyWeek.value!.endDate);
});
const displayedStudyTypeTotalSeconds = computed(() => displayedStudyTypeEntries.value.reduce((sum, entry) => sum + entry.durationSeconds, 0));
const trackedStudyTypeRows = computed(() => {
  const secondsByType = displayedStudyTypeEntries.value.reduce<Record<string, number>>((acc, log) => {
    const type = studyTimeExamType(log);
    acc[type] = (acc[type] || 0) + log.durationSeconds;
    return acc;
  }, {});
  const types = [
    ...examTypeOptions,
    ...Object.keys(secondsByType).filter((type) => !examTypeOptions.includes(type)).sort(),
  ];

  return types.map((type, index) => ({
    type,
    seconds: secondsByType[type] || 0,
    color: taskTypeColor(type, index),
    softColor: taskTypeSoftColor(type, index),
  }));
});
const peakStudyDay = computed(() => {
  const rows = Object.entries(studyTimeEntries.value.reduce<Record<string, number>>((acc, log) => {
    acc[log.date] = (acc[log.date] || 0) + log.durationSeconds;
    return acc;
  }, {})).map(([date, seconds]) => ({ date, seconds }));
  return rows.sort((a, b) => b.seconds - a.seconds || b.date.localeCompare(a.date))[0] || { date: '', seconds: 0 };
});
const firstPracticeLogDate = computed(() => [
  ...Object.keys(data.value.dailyLogs),
  ...Object.keys(data.value.reviewLogs),
].filter((date) => date <= todayIso()).sort()[0] || todayIso());
const practiceTrendRows = computed(() => {
  const rows = dateRangeRows(practiceTrendRange.value, firstPracticeLogDate.value).map((date) => {
    const mainTotal = (data.value.dailyLogs[date] || []).reduce((sum, log) => sum + (log.count ?? log.amount ?? 0), 0);
    const reviewTotal = (data.value.reviewLogs[date] || []).reduce((sum, log) => sum + log.amount, 0);
    const practiceTotal = mainTotal + reviewTotal;
    return { date, label: trendLabel(date, practiceTrendRange.value), mainTotal, reviewTotal, practiceTotal };
  });
  const max = Math.max(1, ...rows.map((row) => row.practiceTotal));
  return rows.map((row) => ({ ...row, height: Math.max(8, Math.round((row.practiceTotal / max) * 94)) }));
});
const todayPracticeTotal = computed(() => todayLogTotal.value + todayReviewDone.value);
const todayPracticeTypeCount = computed(() => new Set([
  ...todayTaskRows.value.filter((task) => task.todayCompleted > 0).map((task) => task.initials),
  ...todayReviewLogs.value.map((log) => taskInitials(data.value.tasks.find((task) => task.id === log.taskId)?.name || log.taskName)),
]).size);
const timeTrendRows = computed(() => {
  const rows = dateRangeRows(timeTrendRange.value, firstStudyTimeLogDate.value).map((date) => {
    const totalSeconds = studyTimeEntries.value.filter((log) => log.date === date).reduce((sum, log) => sum + log.durationSeconds, 0);
    return { date, label: trendLabel(date, timeTrendRange.value), totalSeconds };
  });
  const max = Math.max(1, ...rows.map((row) => row.totalSeconds));
  return rows.map((row) => ({ ...row, height: Math.max(8, Math.round((row.totalSeconds / max) * 94)) }));
});
const timeByExamTypeRows = computed(() => {
  const grouped = todayTimeLogs.value
    .reduce<Record<string, number>>((acc, entry) => {
      const type = studyTimeExamType(entry);
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
  const mainItems = todayTaskRows.value.filter((task) => task.todayCompleted > 0).map((task, index) => {
    const unit = task.trackingMode === 'itemized' ? '篇' : '题';
    return {
      id: `task-${task.id}`,
      type: task.initials,
      countText: `${task.todayCompleted} ${unit}`,
      color: task.accent,
      softColor: task.softColor,
      status: task.todayStatus,
      statusClass: task.todayStatusClass,
      label: '主任务',
      sourceOrder: index,
    };
  });
  const reviewAmountsByPlan = todayReviewLogs.value.reduce<Record<string, { amount: number; log: ReviewLogEntry }>>((acc, log) => {
    const current = acc[log.reviewPlanId];
    acc[log.reviewPlanId] = { amount: (current?.amount || 0) + log.amount, log: current?.log || log };
    return acc;
  }, {});
  const reviewItems = Object.entries(reviewAmountsByPlan).map(([planId, entry], index) => {
    const plan = reviewPlanForId(planId);
    const task = data.value.tasks.find((item) => item.id === (plan?.taskId || entry.log.taskId));
    const type = taskInitials(plan?.taskName || entry.log.taskName);
    const unit = plan && isItemizedReviewPlan(plan) ? '篇' : '题';
    const completed = Boolean(plan && plan.completed >= plan.target);
    return {
      id: `review-${planId}`,
      type,
      countText: `${entry.amount} ${unit}`,
      color: taskTypeColor(type, index),
      softColor: taskTypeSoftColor(type, index),
      status: completed ? '已复习' : '待复习',
      statusClass: completed ? 'status-ok' : 'status-warn',
      label: reviewFamiliarity(task),
      sourceOrder: todayTaskRows.value.length + index,
    };
  });
  return [...mainItems, ...reviewItems].sort((a, b) => a.sourceOrder - b.sourceOrder);
});
const practiceReportQuickDates = computed(() => [
  { label: '今天', date: todayIso() },
  { label: '昨天', date: addDays(todayIso(), -1) },
]);
const practiceReportDisplayDate = computed(() => practiceReportDate.value.replaceAll('-', '/'));
const practiceReportTimeEntries = computed(() => studyTimeEntries.value
  .filter((log) => log.date === practiceReportDate.value)
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const practiceReportRows = computed(() => {
  const rows = new Map<string, {
    type: string;
    color: string;
    softColor: string;
    mainCount: number;
    reviewCount: number;
    mainSeconds: number;
    reviewSeconds: number;
  }>();
  const ensureRow = (type: string) => {
    const key = (type || 'GEN').toUpperCase();
    if (!rows.has(key)) {
      const index = rows.size;
      rows.set(key, {
        type: key,
        color: taskTypeColor(key, index),
        softColor: taskTypeSoftColor(key, index),
        mainCount: 0,
        reviewCount: 0,
        mainSeconds: 0,
        reviewSeconds: 0,
      });
    }
    return rows.get(key)!;
  };

  const taskById = new Map(data.value.tasks.map((task) => [task.id, task]));
  const mainCountByTask = (data.value.dailyLogs[practiceReportDate.value] || []).reduce<Record<string, number>>((acc, log) => {
    acc[log.taskId] = (acc[log.taskId] || 0) + (log.count ?? log.amount ?? 0);
    return acc;
  }, {});
  Object.entries(mainCountByTask).forEach(([taskId, amount]) => {
    const count = Math.max(0, Math.floor(amount));
    if (count <= 0) return;
    const task = taskById.get(taskId);
    const row = ensureRow(task ? taskInitials(task.name) : 'GEN');
    row.mainCount += count;
  });

  (data.value.reviewLogs[practiceReportDate.value] || []).forEach((log) => {
    const count = Math.max(0, Math.floor(log.amount));
    if (count <= 0) return;
    const task = taskById.get(log.taskId);
    const row = ensureRow(taskInitials(task?.name || log.taskName));
    row.reviewCount += count;
  });

  practiceReportTimeEntries.value.forEach((log) => {
    const seconds = Math.max(0, Math.floor(log.durationSeconds));
    if (seconds <= 0) return;
    const row = ensureRow(studyTimeExamType(log));
    if (log.timeType === 'review') row.reviewSeconds += seconds;
    else row.mainSeconds += seconds;
  });

  return [...rows.values()]
    .map((row) => ({
      ...row,
      totalCount: row.mainCount + row.reviewCount,
      totalSeconds: row.mainSeconds + row.reviewSeconds,
    }))
    .sort((a, b) => b.totalCount - a.totalCount || b.totalSeconds - a.totalSeconds || a.type.localeCompare(b.type));
});
const practiceReportTotals = computed(() => practiceReportRows.value.reduce((acc, row) => ({
  mainCount: acc.mainCount + row.mainCount,
  reviewCount: acc.reviewCount + row.reviewCount,
  totalCount: acc.totalCount + row.totalCount,
  mainSeconds: acc.mainSeconds + row.mainSeconds,
  reviewSeconds: acc.reviewSeconds + row.reviewSeconds,
  totalSeconds: acc.totalSeconds + row.totalSeconds,
  typeCount: acc.typeCount + 1,
}), {
  mainCount: 0,
  reviewCount: 0,
  totalCount: 0,
  mainSeconds: 0,
  reviewSeconds: 0,
  totalSeconds: 0,
  typeCount: 0,
}));

function timeTrendAxisInterval(rowCount: number) {
  if (rowCount <= 8) return 0;
  return Math.max(1, Math.ceil(rowCount / 7) - 1);
}

function buildPracticeTrendChartOption(): EChartsCoreOption {
  const rows = practiceTrendRows.value;
  const max = Math.max(5, ...rows.map((row) => row.practiceTotal));
  const interval = max <= 5 ? 1 : Math.ceil(max / 4);
  const yMax = Math.ceil(max / interval) * interval;
  const barWidth = rows.length > 30 ? 4 : rows.length > 12 ? 8 : 18;
  const barRadius = rows.length > 30 ? 2 : rows.length > 12 ? 4 : 8;

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
        interval: timeTrendAxisInterval(rows.length),
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
        barWidth,
        data: rows.map((row) => ({
          value: row.practiceTotal,
          date: row.date,
        })),
        itemStyle: {
          color: '#8b5cf6',
          borderRadius: [barRadius, barRadius, 0, 0],
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

function buildStudyTypeChartOption(): EChartsCoreOption {
  const rows = trackedStudyTypeRows.value;
  const rowByType = new Map(rows.map((row) => [row.type, row]));
  const maxSeconds = Math.max(1, ...rows.map((row) => row.seconds));
  const maxHours = Math.max(1, Math.ceil(maxSeconds / 3600));
  const intervalHours = Math.max(1, Math.ceil(maxHours / 3));
  const yMax = Math.ceil(maxHours / intervalHours) * intervalHours * 3600;

  return {
    animationDuration: 420,
    grid: { top: 12, right: 10, bottom: 12, left: 10, containLabel: true },
    tooltip: {
      trigger: 'item',
      confine: true,
      backgroundColor: 'transparent',
      borderWidth: 0,
      padding: 0,
      textStyle: { color: '#172033', fontSize: 13, fontWeight: 400 },
      extraCssText: 'box-shadow:none; border-radius:999px;',
      formatter(params: unknown) {
        const data = (params as { data?: { type?: string; seconds?: number; color?: string; softColor?: string } }).data;
        if (!data?.type || typeof data.seconds !== 'number') return '';
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 14px;background:${data.softColor};border-radius:999px;line-height:1.45;white-space:nowrap"><strong style="color:${data.color};font-size:16px;font-weight:700">${data.type}</strong><span style="color:#172033;font-size:14px;font-weight:400">${formatDurationCompact(data.seconds)}</span></div>`;
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((row) => row.type),
      axisLine: { lineStyle: { color: '#e1e7f0' } },
      axisTick: { show: false },
      axisLabel: {
        interval: 0,
        rotate: 28,
        margin: 14,
        fontSize: 12,
        fontWeight: 700,
        color(value: string) {
          return rowByType.get(value)?.color || '#617087';
        },
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: yMax,
      interval: intervalHours * 3600,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: '#edf1f6', type: 'dashed' } },
      axisLabel: {
        color: '#8a98ac',
        fontSize: 13,
        fontWeight: 500,
        formatter(value: number) {
          return value === 0 ? '0' : `${Math.round(value / 3600)}h`;
        },
      },
    },
    series: [{
      type: 'bar',
      barWidth: 12,
      barMaxWidth: 12,
      data: rows.map((row) => ({
        value: row.seconds,
        type: row.type,
        seconds: row.seconds,
        color: row.color,
        softColor: row.softColor,
        itemStyle: { color: row.color, borderRadius: [7, 7, 0, 0] },
      })),
    }],
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

async function renderStudyTypeChart() {
  if (tab.value !== 'progress') return;
  await nextTick();
  const el = studyTypeChartEl.value;
  if (!el) return;
  if (!studyTypeChartInstance || studyTypeChartInstance.isDisposed()) {
    studyTypeChartInstance = init(el);
  }
  studyTypeChartInstance.setOption(buildStudyTypeChartOption(), true);
  studyTypeChartInstance.resize();
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
  void renderReviewTrendChart();
  void renderTimeTrendChart();
  void renderStudyTypeChart();
}

function resizeProgressCharts() {
  reviewTrendChartInstance?.resize();
  timeTrendChartInstance?.resize();
  studyTypeChartInstance?.resize();
}

function disposeProgressCharts() {
  reviewTrendChartInstance?.dispose();
  reviewTrendChartInstance = null;
  timeTrendChartInstance?.dispose();
  timeTrendChartInstance = null;
  studyTypeChartInstance?.dispose();
  studyTypeChartInstance = null;
}

onMounted(() => {
  timerInterval = window.setInterval(() => {
    nowMs.value = Date.now();
    finishPomodoroIfNeeded();
  }, 1000);
  window.addEventListener('resize', resizeProgressCharts);
  window.addEventListener('online', handleWindowOnline);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('beforeunload', handleBeforeUnload);
  renderProgressCharts();
  if (!IS_LOCAL_DEV) void loadCloudProgress();
});

onBeforeUnmount(() => {
  if (timerInterval) window.clearInterval(timerInterval);
  if (pomodoroAudioContext) void pomodoroAudioContext.close();
  stopPomodoroTitleFlash();
  window.removeEventListener('resize', resizeProgressCharts);
  window.removeEventListener('online', handleWindowOnline);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('pagehide', handlePageHide);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  if (cloudSaveTimer) window.clearTimeout(cloudSaveTimer);
  disposeProgressCharts();
});

watch(tab, (nextTab) => {
  if (nextTab === 'progress') renderProgressCharts();
  else disposeProgressCharts();
});

watch(practiceTrendRows, () => {
  void renderReviewTrendChart();
}, { deep: true });

watch(timeTrendRows, () => {
  void renderTimeTrendChart();
}, { deep: true });

watch(trackedStudyTypeRows, () => {
  void renderStudyTypeChart();
}, { deep: true });

watch([() => data.value.settings.startDate, () => data.value.settings.deadline], () => {
  selectedStudyWeekNumber.value = currentPlanStudyWeekNumber.value;
}, { immediate: true });

watch(exportAnswerTypeOptions, (options) => {
  if (!options.includes(exportAnswerType.value)) exportAnswerType.value = options[0] || '';
}, { immediate: true });

watch([phaseProgress, phase], () => {
  if (!selectedProgressPhaseId.value && phase.value) selectedProgressPhaseId.value = phase.value.id;
}, { immediate: true });

watch([todayDynamicTargetSignature, todayProgressSignature, hasTodayTargetSnapshot], () => {
  refreshUnstartedTodayTargets(hasTodayTargetSnapshot.value
    ? {}
    : { markDirty: false, scheduleSync: false });
}, { immediate: true });

function persistProgressBackup(next: StudyData) {
  localStorage.setItem(KEY, JSON.stringify(next));
  localStorage.setItem(LEGACY_KEY, JSON.stringify(next));
  hasLocalProgressBackup.value = true;
}

function persistDirty(value: boolean) {
  isDirty.value = value;
  localStorage.setItem(DIRTY_KEY, value ? 'true' : 'false');
}

function persistLastCloudSyncState(label: string, message: string) {
  lastCloudSyncLabel.value = label;
  lastCloudSyncMessage.value = message;
  localStorage.setItem(LAST_SYNC_LABEL_KEY, label);
  localStorage.setItem(LAST_SYNC_MESSAGE_KEY, message);
}

function saveLocal(next: StudyData, options: { markDirty?: boolean; scheduleSync?: boolean } = {}) {
  const { markDirty = true, scheduleSync = true } = options;
  const normalized = normalizeData(next);
  const stamped = {
    ...normalized,
    updatedAt: normalized.updatedAt || data.value.updatedAt || '',
  };
  data.value = stamped;
  persistProgressBackup(stamped);
  cloudLoadError.value = false;
  if (markDirty) {
    persistLastCloudSyncState('', '');
    persistDirty(true);
    cloudSaveError.value = false;
    if (scheduleSync) scheduleCloudSave();
  }
}

function applyRemoteProgress(remote: StudyData) {
  const normalized = normalizeData(remote);
  data.value = normalized;
  persistProgressBackup(normalized);
  persistDirty(false);
  cloudLoadError.value = false;
  cloudSaveError.value = false;
  lastCloudSyncedAt.value = normalized.updatedAt || lastCloudSyncedAt.value || '';
  localStorage.setItem(LAST_SYNCED_KEY, lastCloudSyncedAt.value);
  persistLastCloudSyncState(
    '已拉取云端最新进度',
    normalized.updatedAt ? `云端最新更新时间：${new Date(normalized.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '云端最新更新时间：尚未记录',
  );
  if (!selectedProgressPhaseId.value && normalized.phases[0]) selectedProgressPhaseId.value = normalized.phases[0].id;
}

function clearAppPassword() {
  appPassword.value = '';
  passwordInput.value = '';
  localStorage.removeItem(APP_PASSWORD_KEY);
}

function handleUnauthorized() {
  clearAppPassword();
  passwordError.value = '访问密码错误，请重新输入';
  cloudSaveError.value = false;
  cloudLoadError.value = false;
}

function submitPassword() {
  if (IS_LOCAL_DEV) return;
  const nextPassword = passwordInput.value.trim();
  if (!nextPassword) {
    passwordError.value = '访问密码错误，请重新输入';
    return;
  }
  appPassword.value = nextPassword;
  localStorage.setItem(APP_PASSWORD_KEY, nextPassword);
  passwordInput.value = '';
  passwordError.value = '';
  void loadCloudProgress();
}

async function fetchCloudProgress() {
  if (IS_LOCAL_DEV) return null;
  const res = await fetch('/api/progress', {
    headers: { 'x-app-password': appPassword.value },
    cache: 'no-store',
  });
  if (res.status === 401) {
    handleUnauthorized();
    return null;
  }
  if (!res.ok) throw new Error(`Cloudflare 读取失败：HTTP ${res.status}`);
  return normalizeData(await res.json() as Partial<StudyData>);
}

async function loadCloudProgress() {
  if (IS_LOCAL_DEV || !appPassword.value) return;
  if (isCloudLoading.value) return;
  isCloudLoading.value = true;
  cloudLoadError.value = false;
  try {
    const remote = await fetchCloudProgress();
    if (!remote) return;
    hasCheckedCloudBaseline.value = true;
    applyRemoteProgress(remote);
  } catch {
    cloudLoadError.value = true;
  } finally {
    isCloudLoading.value = false;
  }
}

function scheduleCloudSave(delay = CLOUD_SAVE_DEBOUNCE_MS) {
  if (IS_LOCAL_DEV || !isDirty.value || !appPassword.value || !hasCheckedCloudBaseline.value) return;
  if (cloudSaveTimer) window.clearTimeout(cloudSaveTimer);
  const elapsed = Date.now() - lastCloudSaveAttemptAt;
  const waitForMinInterval = Math.max(0, CLOUD_SAVE_MIN_INTERVAL_MS - elapsed);
  cloudSaveTimer = window.setTimeout(() => {
    cloudSaveTimer = undefined;
    void syncCloudProgress();
  }, Math.max(delay, waitForMinInterval));
}

async function syncCloudProgress() {
  if (IS_LOCAL_DEV || !isDirty.value || !appPassword.value || isCloudSaving.value || !hasCheckedCloudBaseline.value) return false;
  lastCloudSaveAttemptAt = Date.now();
  isCloudSaving.value = true;
  cloudSaveError.value = false;
  try {
    const { updatedAt: _updatedAt, ...payload } = normalizeData(data.value);
    const res = await fetch('/api/progress', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-app-password': appPassword.value,
        'x-progress-base-updated-at': lastCloudSyncedAt.value || '',
      },
      body: JSON.stringify(payload),
      keepalive: JSON.stringify(payload).length < 60000,
    });
    if (res.status === 401) {
      handleUnauthorized();
      return false;
    }
    if (res.status === 409) {
      const result = await res.json() as { remote?: Partial<StudyData>; progress?: Partial<StudyData> };
      const remote = result.remote || result.progress;
      if (remote) applyRemoteProgress(normalizeData(remote));
      return false;
    }
    if (!res.ok) throw new Error(`Cloudflare 保存失败：HTTP ${res.status}`);
    const result = await res.json() as { updatedAt?: string; progress?: Partial<StudyData> };
    const saved = normalizeData(result.progress || payload);
    data.value = saved;
    persistProgressBackup(saved);
    persistDirty(false);
    cloudSaveError.value = false;
    cloudLoadError.value = false;
    lastCloudSyncedAt.value = saved.updatedAt || '';
    localStorage.setItem(LAST_SYNCED_KEY, lastCloudSyncedAt.value);
    persistLastCloudSyncState(
      '已保存并同步云端',
      saved.updatedAt ? `最新修改时间：${new Date(saved.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '最新修改时间：尚未记录',
    );
    return true;
  } catch {
    persistDirty(true);
    cloudSaveError.value = true;
    return false;
  } finally {
    isCloudSaving.value = false;
  }
}

function tryImmediateCloudSave() {
  if (IS_LOCAL_DEV || !isDirty.value || !appPassword.value) return;
  if (cloudSaveTimer) {
    window.clearTimeout(cloudSaveTimer);
    cloudSaveTimer = undefined;
  }
  void syncCloudProgress();
}

function handleVisibilityChange() {
  nowMs.value = Date.now();
  finishPomodoroIfNeeded();
  if (document.visibilityState === 'visible') {
    stopPomodoroTitleFlash();
  } else {
    tryImmediateCloudSave();
  }
}

function handleWindowOnline() {
  if (document.visibilityState === 'visible') void refreshCloudProgress();
}

async function refreshCloudProgress() {
  if (isDirty.value && !await syncCloudProgress()) return;
  await loadCloudProgress();
}

function handlePageHide() {
  tryImmediateCloudSave();
}

function handleBeforeUnload() {
  tryImmediateCloudSave();
}

function restartStudyPlan() {
  const confirmed = window.confirm('确定清除本地总计划、任务、进度、复习、计时和备注数据，并重新开始吗？云端数据会在下次自动保存时更新。');
  if (!confirmed) return;
  const fresh = defaultData();
  const phases = syncPhaseBoundaries(fresh.phases, fresh.settings);
  runningTimer.value = null;
  runningPomodoro.value = null;
  stopPomodoroTitleFlash();
  showTimerModal.value = false;
  showPomodoroModal.value = false;
  clearTimerEditDraft();
  clearPomodoroProgressDraft();
  timerEditDirty.value = false;
  persistRunningTimer();
  persistRunningPomodoro();
  selectedProgressPhaseId.value = phases[0]?.id || '';
  selectedNoteDate.value = todayIso();
  noteDraft.value = '';
  reviewAddTaskId.value = '';
  manualAmounts.value = {};
  reviewAmounts.value = {};
  saveLocal({ ...fresh, phases });
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

function isTimerRunning(type: TimeLogType, id: string) {
  return timerSeconds(type, id) > 0 && !runningTimer.value?.paused;
}

function isTimerPaused(type: TimeLogType, id: string) {
  return timerSeconds(type, id) > 0 && Boolean(runningTimer.value?.paused);
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
  return studyTimeEntries.value
    .filter((log) => log.taskId === task.id || (!log.taskId && log.timeType === 'review' && reviewPlanForId(log.reviewPlanId || '')?.taskId === task.id))
    .reduce((sum, log) => sum + log.durationSeconds, 0);
}

function studyTimeExamType(log: StudyTimeEntry) {
  const linkedTask = data.value.tasks.find((task) => task.id === log.taskId)
    || data.value.tasks.find((task) => task.id === reviewPlanForId(log.reviewPlanId || '')?.taskId);
  return taskInitials(linkedTask?.name || log.examType || log.taskName);
}

function selectTimePoint(date: string) {
  selectedTimePointDate.value = date;
}

function timerActionLabel() {
  if (!runningTimer.value) return '开始计时';
  if (!runningTimer.value.paused) return '暂停计时';
  return currentTimerSeconds() > 0 ? '继续计时' : '开始计时';
}

function openTimer(type: TimeLogType, id: string, name: string, linkedTaskId = '') {
  const identity = timerIdentity(type, id);
  if (runningTimerIdentity(runningTimer.value) === identity) {
    nowMs.value = Date.now();
    showTimerModal.value = true;
    timerEditDirty.value = false;
    return;
  }
  if (runningTimer.value && currentTimerSeconds() > 0) {
    showTimerModal.value = true;
    alert('请先保存或取消当前计时，再开始另一项任务。');
    return;
  }
  const timestamp = Date.now();
  nowMs.value = timestamp;
  runningTimer.value = {
    type,
    taskId: type === 'task' ? id : linkedTaskId,
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

function resetTimer() {
  if (!runningTimer.value) return;
  const timestamp = Date.now();
  nowMs.value = timestamp;
  runningTimer.value = {
    ...runningTimer.value,
    firstStartedAt: undefined,
    accumulatedSeconds: 0,
    startedAt: timestamp,
    paused: true,
  };
  clearTimerEditDraft();
  timerEditDirty.value = false;
  persistRunningTimer();
}

function closeTimerModal() {
  showTimerModal.value = false;
  if (runningTimer.value && !runningTimer.value.firstStartedAt) {
    runningTimer.value = null;
  }
  clearTimerEditDraft();
  timerEditDirty.value = false;
  persistRunningTimer();
}

function discardRunningTimer() {
  if (!runningTimer.value) return;
  if (currentTimerSeconds() > 0 && !window.confirm('确定取消本次计时吗？不会保存任何学习时长。')) return;
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

function taskQuestionProgress(task: Task) {
  if (task.roundModeEnabled) return taskProgressCompleted(task);
  return task.repeatCount > 1 ? taskRoundCompleted(task) : Math.min(task.completed, task.target);
}

function taskWithProgressDelta(task: Task, delta: number): Task {
  if (!task.roundModeEnabled) {
    return { ...task, completed: Math.max(0, Math.min(taskTotalTarget(task), task.completed + delta)) };
  }
  const nextRoundCompleted = Math.max(0, Math.min(task.roundTarget, task.roundCompleted + delta));
  const actualDelta = nextRoundCompleted - task.roundCompleted;
  return {
    ...task,
    roundCompleted: nextRoundCompleted,
    roundPracticeTotal: Math.max(0, task.roundPracticeTotal + actualDelta),
  };
}

function roundLogMetadata(task: Task) {
  return task.roundModeEnabled
    ? { roundCycle: task.roundCycle, roundStage: task.roundStage, roundPass: task.roundPass }
    : {};
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
  const linkedTaskId = timer.taskId || (timer.type === 'review' ? reviewPlanForId(timer.reviewPlanId || '')?.taskId || '' : '');
  const linkedTask = data.value.tasks.find((task) => task.id === linkedTaskId);
  const entry: StudyTimeEntry = {
    id: crypto.randomUUID(),
    date,
    taskId: linkedTaskId,
    reviewPlanId: timer.reviewPlanId || '',
    taskName: timer.name,
    examType: linkedTask ? taskInitials(linkedTask.name) : examTypeFromName(timer.name),
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

function persistRunningPomodoro() {
  if (runningPomodoro.value) localStorage.setItem(POMODORO_KEY, JSON.stringify(runningPomodoro.value));
  else localStorage.removeItem(POMODORO_KEY);
}

function pomodoroPlannedSeconds() {
  const pomodoro = runningPomodoro.value;
  if (!pomodoro) return 1500;
  return pomodoro.stage === 'break' ? pomodoroBreakSeconds(pomodoro.durationSeconds) : pomodoro.durationSeconds;
}

function rawPomodoroElapsedSeconds(pomodoro: RunningPomodoro) {
  const liveSeconds = pomodoro.paused ? 0 : Math.floor((nowMs.value - pomodoro.startedAt) / 1000);
  return Math.max(0, pomodoro.accumulatedSeconds + liveSeconds);
}

function currentPomodoroSeconds() {
  const pomodoro = runningPomodoro.value;
  if (!pomodoro) return 0;
  return Math.min(pomodoroPlannedSeconds(), rawPomodoroElapsedSeconds(pomodoro));
}

function pomodoroDurationLabel(durationSeconds: PomodoroDurationSeconds) {
  return durationSeconds < 60 ? `${durationSeconds} 秒` : `${durationSeconds / 60} 分钟`;
}

function preparePomodoroCompletionAlert() {
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission().catch(() => undefined);
  }
  try {
    pomodoroAudioContext ||= new AudioContext();
    if (pomodoroAudioContext.state === 'suspended') void pomodoroAudioContext.resume();
  } catch {
    pomodoroAudioContext = null;
  }
}

function playPomodoroCompletionSound() {
  try {
    pomodoroAudioContext ||= new AudioContext();
    const audioContext = pomodoroAudioContext;
    void audioContext.resume().then(() => {
      const firstBeepAt = audioContext.currentTime + .04;
      [0, .72, 1.44].forEach((delay) => {
        const startsAt = firstBeepAt + delay;
        [1046.5, 2093].forEach((frequency, index) => {
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          oscillator.type = index === 0 ? 'triangle' : 'sine';
          oscillator.frequency.setValueAtTime(frequency, startsAt);
          gain.gain.setValueAtTime(.0001, startsAt);
          gain.gain.exponentialRampToValueAtTime(index === 0 ? .2 : .045, startsAt + .012);
          gain.gain.exponentialRampToValueAtTime(.0001, startsAt + .48);
          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.start(startsAt);
          oscillator.stop(startsAt + .5);
        });
      });
    }).catch(() => undefined);
  } catch {
    // The system notification still works when browser audio is unavailable.
  }
}

function playPomodoroBreakCompletionSound() {
  try {
    pomodoroAudioContext ||= new AudioContext();
    const audioContext = pomodoroAudioContext;
    void audioContext.resume().then(() => {
      const firstChimeAt = audioContext.currentTime + .04;
      [
        { delay: 0, frequency: 987.8 },
        { delay: .32, frequency: 659.3 },
        { delay: 1, frequency: 987.8 },
        { delay: 1.32, frequency: 659.3 },
      ].forEach(({ delay, frequency }) => {
        const startsAt = firstChimeAt + delay;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, startsAt);
        gain.gain.setValueAtTime(.0001, startsAt);
        gain.gain.exponentialRampToValueAtTime(.18, startsAt + .012);
        gain.gain.exponentialRampToValueAtTime(.0001, startsAt + .42);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(startsAt);
        oscillator.stop(startsAt + .44);
      });
    }).catch(() => undefined);
  } catch {
    // The system notification still works when browser audio is unavailable.
  }
}

function stopPomodoroTitleFlash() {
  if (pomodoroTitleFlashTimer) window.clearInterval(pomodoroTitleFlashTimer);
  pomodoroTitleFlashTimer = undefined;
  if (pomodoroOriginalTitle) document.title = pomodoroOriginalTitle;
  pomodoroOriginalTitle = '';
}

function startPomodoroTitleFlash(alertTitle = '🍅 番茄钟结束') {
  stopPomodoroTitleFlash();
  pomodoroOriginalTitle = document.title;
  let showCompleteTitle = true;
  const updateTitle = () => {
    document.title = showCompleteTitle ? alertTitle : pomodoroOriginalTitle;
    showCompleteTitle = !showCompleteTitle;
  };
  updateTitle();
  pomodoroTitleFlashTimer = window.setInterval(updateTitle, 600);
}

function alertPomodoroComplete(pomodoro: RunningPomodoro) {
  playPomodoroCompletionSound();
  startPomodoroTitleFlash();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification('🍅 番茄钟结束', {
      body: `${pomodoro.name} · ${pomodoroDurationLabel(pomodoro.durationSeconds)}专注已完成，${pomodoroBreakDurationLabel(pomodoro.durationSeconds)}休息已自动开始。`,
      tag: 'pomodoro-complete',
      silent: true,
    });
  } catch {
    // Some browsers expose Notification but do not allow constructing one here.
  }
}

function alertPomodoroBreakComplete(pomodoro: RunningPomodoro) {
  playPomodoroBreakCompletionSound();
  startPomodoroTitleFlash('☕ 休息结束');
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification('☕ 休息结束', {
      body: `${pomodoroBreakDurationLabel(pomodoro.durationSeconds)}休息已结束，准备好后手动开始下一轮番茄钟。`,
      tag: 'pomodoro-break-complete',
      silent: true,
    });
  } catch {
    // Some browsers expose Notification but do not allow constructing one here.
  }
}

function finishPomodoroIfNeeded() {
  const pomodoro = runningPomodoro.value;
  if (!pomodoro || pomodoro.paused) return;
  const breakSeconds = pomodoroBreakSeconds(pomodoro.durationSeconds);
  const plannedSeconds = pomodoro.stage === 'break' ? breakSeconds : pomodoro.durationSeconds;
  const elapsedSeconds = rawPomodoroElapsedSeconds(pomodoro);
  if (elapsedSeconds < plannedSeconds) return;
  const timestamp = Date.now();
  nowMs.value = timestamp;
  if (pomodoro.stage === 'focus') {
    const breakElapsedSeconds = Math.max(0, elapsedSeconds - pomodoro.durationSeconds);
    const breakComplete = breakElapsedSeconds >= breakSeconds;
    runningPomodoro.value = {
      ...pomodoro,
      stage: 'break',
      focusCompletedAt: timestamp - breakElapsedSeconds * 1000,
      focusSaved: false,
      accumulatedSeconds: Math.min(breakSeconds, breakElapsedSeconds),
      startedAt: timestamp,
      paused: breakComplete,
    };
    persistRunningPomodoro();
    if (breakComplete) alertPomodoroBreakComplete(pomodoro);
    else alertPomodoroComplete(pomodoro);
    return;
  }
  runningPomodoro.value = {
    ...pomodoro,
    accumulatedSeconds: breakSeconds,
    startedAt: timestamp,
    paused: true,
  };
  persistRunningPomodoro();
  alertPomodoroBreakComplete(pomodoro);
}

function isPomodoroComplete() {
  const pomodoro = runningPomodoro.value;
  return Boolean(pomodoro && currentPomodoroSeconds() >= pomodoroPlannedSeconds());
}

function pomodoroActionLabel() {
  const pomodoro = runningPomodoro.value;
  if (!pomodoro) return '开始专注';
  if (pomodoro.stage === 'break') {
    if (isPomodoroComplete()) return '休息已结束';
    return pomodoro.paused ? '继续休息' : '暂停休息';
  }
  if (isPomodoroComplete()) return '本轮已完成';
  if (!pomodoro.paused) return '暂停番茄钟';
  return currentPomodoroSeconds() > 0 ? '继续专注' : '开始专注';
}

function pomodoroLaunchLabel() {
  const pomodoro = runningPomodoro.value;
  if (!pomodoro?.firstStartedAt) return '开始番茄钟';
  const remaining = formatTimerDisplay(pomodoroRemainingSeconds.value);
  if (pomodoro.stage === 'break') {
    if (isPomodoroComplete()) return '休息已结束';
    return pomodoro.paused ? `休息暂停 · ${remaining}` : `休息中 · ${remaining}`;
  }
  if (isPomodoroComplete()) return '番茄钟已完成';
  return pomodoro.paused ? `已暂停 · ${remaining}` : remaining;
}

function pomodoroStatusMessage() {
  const pomodoro = runningPomodoro.value;
  if (!pomodoro) return '';
  if (pomodoro.stage === 'break') {
    if (isPomodoroComplete()) return '休息已结束，保存本轮后可手动开始下一轮。';
    if (pomodoro.paused) return '休息已暂停，可以随时继续。';
    return `休息一下，${pomodoroBreakDurationLabel(pomodoro.durationSeconds)}后提醒你。`;
  }
  if (isPomodoroComplete()) return '本轮专注已完成，可以填写进度后保存。';
  if (pomodoro.firstStartedAt && pomodoro.paused) return '番茄钟已暂停，可以随时继续。';
  return '专注当下，高效完成每一题';
}

function openPomodoro() {
  stopPomodoroTitleFlash();
  if (runningPomodoro.value) {
    nowMs.value = Date.now();
    showPomodoroModal.value = true;
    return;
  }
  const task = todayPomodoroTasks.value[0];
  if (!task) {
    alert('今天还没有可选择的任务，请先在计划设置中添加任务。');
    return;
  }
  const timestamp = Date.now();
  nowMs.value = timestamp;
  runningPomodoro.value = {
    taskId: task.id,
    name: taskDisplayName(task),
    date: todayIso(),
    stage: 'focus',
    durationSeconds: 1500,
    focusSaved: false,
    startedAt: timestamp,
    accumulatedSeconds: 0,
    paused: true,
  };
  showPomodoroModal.value = true;
  clearPomodoroProgressDraft();
  persistRunningPomodoro();
}

function setPomodoroDuration(durationSeconds: PomodoroDurationSeconds) {
  const pomodoro = runningPomodoro.value;
  if (!pomodoro || pomodoro.firstStartedAt) return;
  runningPomodoro.value = { ...pomodoro, durationSeconds };
  persistRunningPomodoro();
}

function changePomodoroTask(taskId: string) {
  const pomodoro = runningPomodoro.value;
  const task = todayPomodoroTasks.value.find((item) => item.id === taskId);
  if (!pomodoro || pomodoro.firstStartedAt || !task) return;
  runningPomodoro.value = { ...pomodoro, taskId: task.id, name: taskDisplayName(task) };
  clearPomodoroProgressDraft();
  persistRunningPomodoro();
}

function togglePomodoro() {
  const pomodoro = runningPomodoro.value;
  if (!pomodoro || isPomodoroComplete()) return;
  const seconds = currentPomodoroSeconds();
  const timestamp = Date.now();
  const nextPaused = !pomodoro.paused;
  if (!nextPaused) preparePomodoroCompletionAlert();
  nowMs.value = timestamp;
  runningPomodoro.value = {
    ...pomodoro,
    firstStartedAt: pomodoro.firstStartedAt || (nextPaused ? pomodoro.startedAt : timestamp),
    accumulatedSeconds: seconds,
    startedAt: timestamp,
    paused: nextPaused,
  };
  persistRunningPomodoro();
}

function resetPomodoro() {
  const pomodoro = runningPomodoro.value;
  if (!pomodoro) return;
  stopPomodoroTitleFlash();
  const timestamp = Date.now();
  nowMs.value = timestamp;
  runningPomodoro.value = {
    ...pomodoro,
    stage: 'focus',
    focusCompletedAt: undefined,
    focusSaved: false,
    firstStartedAt: undefined,
    accumulatedSeconds: 0,
    startedAt: timestamp,
    paused: true,
  };
  clearPomodoroProgressDraft();
  persistRunningPomodoro();
}

function closePomodoroModal() {
  showPomodoroModal.value = false;
  if (runningPomodoro.value && !runningPomodoro.value.firstStartedAt) {
    runningPomodoro.value = null;
    clearPomodoroProgressDraft();
  }
  persistRunningPomodoro();
}

function cancelPomodoro() {
  if (!runningPomodoro.value) return;
  const confirmMessage = runningPomodoro.value.focusSaved
    ? '确定结束当前休息吗？已保存的专注记录不会受影响。'
    : '确定取消本次番茄钟吗？不会保存专注时长和进度。';
  if (runningPomodoro.value.firstStartedAt && !window.confirm(confirmMessage)) return;
  stopPomodoroTitleFlash();
  runningPomodoro.value = null;
  showPomodoroModal.value = false;
  clearPomodoroProgressDraft();
  persistRunningPomodoro();
}

function clearPomodoroProgressDraft() {
  pomodoroProgressInput.value = '';
  pomodoroProgressError.value = '';
}

function updatePomodoroProgressInput(value: string) {
  pomodoroProgressInput.value = value;
  pomodoroProgressError.value = '';
}

function savePomodoro() {
  const pomodoro = runningPomodoro.value;
  if (!pomodoro) return;
  const task = data.value.tasks.find((item) => item.id === pomodoro.taskId);
  let progressDelta = 0;
  if (task?.trackingMode === 'count_only' && pomodoroProgressInput.value.trim()) {
    const endpoint = Number(pomodoroProgressInput.value);
    const currentQuestion = taskQuestionProgress(task);
    if (!Number.isInteger(endpoint) || endpoint < currentQuestion || endpoint > taskTotalTarget(task)) {
      pomodoroProgressError.value = `请输入 ${currentQuestion} 到 ${taskTotalTarget(task)} 之间的整数；如需回退请使用“修正进度”。`;
      return;
    }
    progressDelta = endpoint - currentQuestion;
  }

  const saveTimestamp = Date.now();
  stopPomodoroTitleFlash();
  nowMs.value = saveTimestamp;
  const keepBreakRunning = pomodoro.stage === 'break' && !isPomodoroComplete();
  const durationSeconds = pomodoro.stage === 'break' ? pomodoro.durationSeconds : currentPomodoroSeconds();
  const saveFocusTime = durationSeconds > 0 && !pomodoro.focusSaved;
  const endAt = new Date(pomodoro.focusCompletedAt || saveTimestamp).toISOString();
  const startAt = pomodoro.firstStartedAt
    ? new Date(pomodoro.firstStartedAt).toISOString()
    : inferStartAt(endAt, durationSeconds);
  runningPomodoro.value = keepBreakRunning ? { ...pomodoro, focusSaved: true } : null;
  showPomodoroModal.value = false;
  clearPomodoroProgressDraft();
  persistRunningPomodoro();
  if (!saveFocusTime && progressDelta <= 0) return;

  const progressDate = todayIso();
  const nextTasks = progressDelta > 0 && task
    ? data.value.tasks.map((item) => item.id === task.id ? taskWithProgressDelta(item, progressDelta) : item)
    : data.value.tasks;
  const nextDailyLogs = progressDelta > 0 && task
    ? { ...data.value.dailyLogs, [progressDate]: [...(data.value.dailyLogs[progressDate] || []), { taskId: task.id, count: progressDelta, ...roundLogMetadata(task) }] }
    : data.value.dailyLogs;
  const studyTimeEntries = saveFocusTime
    ? [...studyTimeEntriesFromData(data.value), {
      id: crypto.randomUUID(),
      date: pomodoro.date || todayIso(),
      taskId: pomodoro.taskId,
      reviewPlanId: '',
      taskName: pomodoro.name,
      examType: task ? taskInitials(task.name) : examTypeFromName(pomodoro.name),
      durationSeconds,
      timeType: 'main' as const,
      source: 'timer' as const,
      note: `番茄钟 · ${pomodoroDurationLabel(pomodoro.durationSeconds)}`,
      startAt,
      endAt,
      createdAt: endAt,
    }]
    : studyTimeEntriesFromData(data.value);
  saveLocal({
    ...data.value,
    tasks: nextTasks,
    dailyLogs: nextDailyLogs,
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

function formatTimerDisplay(seconds: number) {
  const parts = durationParts(seconds);
  return `${String(parts.hours).padStart(2, '0')}:${String(parts.minutes).padStart(2, '0')}:${String(parts.seconds).padStart(2, '0')}`;
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

function formatCheckInDuration(seconds: number) {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}min`;
  return `${hours}h${minutes}min`;
}

function formatTotalCheckInDuration(seconds: number) {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}min` : `${hours}h`;
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

function addMockExam(phase: PhaseSchedule) {
  const date = mockExamDateDrafts.value[phase.id] || '';
  if (!date || date < phase.startDate) {
    alert(`请选择不早于 ${phase.startDate} 的模考日期。`);
    return;
  }
  const source = data.value.phases.find((item) => item.id === phase.id);
  if (!source || source.mockExams?.some((exam) => exam.date === date)) {
    alert('总计划在该日期已经安排了模考。');
    return;
  }
  const name = mockExamNameDrafts.value[phase.id]?.trim() || '模考日';
  const mockExams = [...(source.mockExams || []), { id: crypto.randomUUID(), date, name, completed: false }];
  mockExamDateDrafts.value = { ...mockExamDateDrafts.value, [phase.id]: '' };
  mockExamNameDrafts.value = { ...mockExamNameDrafts.value, [phase.id]: '' };
  saveLocal({ ...data.value, phases: data.value.phases.map((item) => item.id === phase.id ? { ...item, mockExams } : item) });
}

function toggleMockExam(phaseId: string, examId: string) {
  saveLocal({ ...data.value, phases: data.value.phases.map((phase) => phase.id === phaseId
    ? { ...phase, mockExams: (phase.mockExams || []).map((exam) => exam.id === examId ? { ...exam, completed: !exam.completed } : exam) }
    : phase) });
}

function deleteMockExam(phaseId: string, examId: string) {
  saveLocal({ ...data.value, phases: data.value.phases.map((phase) => phase.id === phaseId
    ? { ...phase, mockExams: (phase.mockExams || []).filter((exam) => exam.id !== examId) }
    : phase) });
}

function deletePhase(id: string) {
  const phases = syncPhaseBoundaries(data.value.phases.filter((item) => item.id !== id), data.value.settings);
  saveLocal({
    ...data.value,
    phases,
    tasks: data.value.tasks.filter((task) => task.phaseId !== id || task.planStatus === 'shelved'),
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
  const task = data.value.tasks.find((item) => item.id === id);
  if (task && Object.prototype.hasOwnProperty.call(patch, 'completed')) {
    updateTaskCompleted(task, Number(patch.completed ?? 0), patch);
    return;
  }
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((item) => {
      if (item.id !== id) return item;
      return normalizeTask({ ...item, ...patch }, data.value.phases[0]?.id || '');
    }),
  });
}

function recalculateRoundPlanDates() {
  const targetSchedule = buildSchedule(data.value);
  const tasks = data.value.tasks.map((task) => {
    if (!task.roundModeEnabled || task.roundCleared) return task;
    const targetPhase = targetSchedule.find((item) => item.id === task.phaseId) || targetSchedule[0];
    return targetPhase
      ? { ...task, roundStageEndDate: taskRoundPlanEndDate(task, targetPhase, todayIso()) }
      : task;
  });
  saveLocal({ ...data.value, tasks });
}

function resetRoundStageEndDate(task: Task, targetSchedule = schedule.value, planningStartDate = todayIso()): Task {
  if (!task.roundModeEnabled || task.roundCleared) return { ...task, roundStageEndDate: undefined };
  const targetPhase = targetSchedule.find((item) => item.id === task.phaseId) || targetSchedule[0];
  return targetPhase
    ? { ...task, roundStageEndDate: taskRoundStageEndDate(task, targetPhase, planningStartDate) }
    : task;
}

function roundStageLabel(task: Task) {
  if (!task.roundModeEnabled) return '未开启轮刷';
  if (task.roundCleared) return `第 ${task.roundCycle} 个大轮次已清零`;
  if (task.roundStage === 4 && task.roundPass > 1) return `第 ${task.roundCycle} 个大轮次 · 第 4 轮巩固第 ${task.roundPass} 遍`;
  return `第 ${task.roundCycle} 个大轮次 · 第 ${task.roundStage} 轮`;
}

function roundHistoryLabel(entry: TaskRoundHistoryEntry) {
  const stage = entry.stage === 4 && entry.pass > 1 ? `第 4 轮巩固第 ${entry.pass} 遍` : `第 ${entry.stage} 轮`;
  return `大轮次 ${entry.cycle} · ${stage}`;
}

function roundInstruction(task: Task) {
  if (task.roundStage === 1) return '刷全量；完成后填写平台剩余标记数。';
  if (task.roundStage === 2) return '只刷第一轮留下的标记题；完成后填写新的剩余标记数。';
  if (task.roundStage === 3) return '刷第二轮留下的标记题；完成后直接进入题量相同的第四轮。';
  return '继续刷平台标记题；每遍结束填写剩余数量，直到清零。';
}

function dailyTargetsWithoutTaskToday(taskId: string): StudyData['dailyTargets'] {
  const date = todayIso();
  const current = { ...(data.value.dailyTargets[date] || {}) };
  delete current[taskId];
  const dailyTargets = { ...data.value.dailyTargets };
  if (Object.keys(current).length) dailyTargets[date] = current;
  else delete dailyTargets[date];
  return dailyTargets;
}

function openRoundSetup(task: Task) {
  if (task.trackingMode !== 'count_only') return;
  roundSetupTaskId.value = task.id;
  roundSetupStage.value = 1;
  roundSetupTargetInput.value = String(Math.max(0, task.target || 0));
  roundSetupCurrentTargetInput.value = '';
  roundSetupError.value = '';
}

function closeRoundSetup() {
  roundSetupTaskId.value = '';
  roundSetupStage.value = 1;
  roundSetupTargetInput.value = '';
  roundSetupCurrentTargetInput.value = '';
  roundSetupError.value = '';
}

function selectRoundSetupStage(stage: TaskRoundStage) {
  roundSetupStage.value = stage;
  roundSetupError.value = '';
}

function submitRoundSetup() {
  const task = roundSetupTask.value;
  if (!task || task.trackingMode !== 'count_only') return;
  const target = Math.floor(Number(roundSetupTargetInput.value));
  if (!Number.isFinite(target) || target <= 0) {
    roundSetupError.value = '请输入大于 0 的题库总量。';
    return;
  }
  const currentTarget = roundSetupStage.value === 1
    ? target
    : Math.floor(Number(roundSetupCurrentTargetInput.value));
  if (!Number.isFinite(currentTarget) || currentTarget <= 0 || currentTarget > target) {
    roundSetupError.value = `当前轮题量需为 1 到 ${target} 之间的整数。`;
    return;
  }
  const previousCycles = task.roundHistory.map((entry) => entry.cycle);
  const cycle = Math.max(1, task.roundCycle || 1, ...previousCycles);
  const startingRoundCompleted = roundSetupStage.value === 1
    ? Math.min(currentTarget, taskRoundCompleted(task))
    : 0;
  const nextTask = resetRoundStageEndDate(normalizeTask({
    ...task,
    target,
    repeatCount: 1,
    roundModeEnabled: true,
    roundCycle: cycle,
    roundStage: roundSetupStage.value,
    roundPass: 1,
    roundTarget: currentTarget,
    roundCompleted: startingRoundCompleted,
    roundPracticeTotal: Math.max(task.roundPracticeTotal || 0, task.completed || 0),
    roundCleared: false,
    completionArchived: true,
  }, data.value.phases[0]?.id || ''));
  saveLocal({ ...data.value, tasks: data.value.tasks.map((item) => item.id === task.id ? nextTask : item), dailyTargets: dailyTargetsWithoutTaskToday(task.id) });
  closeRoundSetup();
}

function openRoundAdvance(task: Task) {
  if (!task.roundModeEnabled || task.roundCleared || task.roundCompleted < task.roundTarget) return;
  if (task.roundStage === 3) {
    advanceRoundTask(task);
    return;
  }
  roundAdvanceTaskId.value = task.id;
  roundRemainingInput.value = '';
  roundAdvanceError.value = '';
}

function closeRoundAdvance() {
  roundAdvanceTaskId.value = '';
  roundRemainingInput.value = '';
  roundAdvanceError.value = '';
}

function submitRoundAdvance() {
  const task = roundAdvanceTask.value;
  if (!task) return;
  const remaining = Math.floor(Number(roundRemainingInput.value));
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > task.roundTarget) {
    roundAdvanceError.value = `请输入 0 到 ${task.roundTarget} 之间的整数。`;
    return;
  }
  advanceRoundTask(task, remaining);
  closeRoundAdvance();
}

function advanceRoundTask(task: Task, remainingMarked?: number) {
  if (!task.roundModeEnabled || task.roundCleared || task.roundCompleted < task.roundTarget) return;
  const historyEntry: TaskRoundHistoryEntry = {
    id: crypto.randomUUID(),
    cycle: task.roundCycle,
    stage: task.roundStage,
    pass: task.roundPass,
    target: task.roundTarget,
    completed: task.roundCompleted,
    remainingMarked,
    completedAt: new Date().toISOString(),
  };
  const cleared = task.roundStage !== 3 && remainingMarked === 0;
  let patch: Partial<Task>;
  if (cleared) {
    patch = { roundCleared: true, roundTarget: 0, roundCompleted: 0, roundStageEndDate: undefined, completionArchived: true };
  } else if (task.roundStage === 1) {
    patch = { roundStage: 2, roundPass: 1, roundTarget: remainingMarked || 0, roundCompleted: 0 };
  } else if (task.roundStage === 2) {
    patch = { roundStage: 3, roundPass: 1, roundTarget: remainingMarked || 0, roundCompleted: 0 };
  } else if (task.roundStage === 3) {
    patch = { roundStage: 4, roundPass: 1, roundTarget: task.roundTarget, roundCompleted: 0 };
  } else {
    patch = { roundStage: 4, roundPass: task.roundPass + 1, roundTarget: remainingMarked || 0, roundCompleted: 0 };
  }
  const normalizedNextTask = normalizeTask({ ...task, ...patch, roundHistory: [...task.roundHistory, historyEntry] }, data.value.phases[0]?.id || '');
  const nextStageStartDate = task.roundStageEndDate ? addDays(task.roundStageEndDate, 1) : todayIso();
  const nextTask = cleared ? normalizedNextTask : resetRoundStageEndDate(normalizedNextTask, schedule.value, nextStageStartDate);
  saveLocal({ ...data.value, tasks: data.value.tasks.map((item) => item.id === task.id ? nextTask : item), dailyTargets: dailyTargetsWithoutTaskToday(task.id) });
}

function restartRoundCycle(task: Task) {
  if (!task.roundModeEnabled || !task.roundCleared) return;
  const nextTask = resetRoundStageEndDate(normalizeTask({
    ...task,
    roundCycle: task.roundCycle + 1,
    roundStage: 1,
    roundPass: 1,
    roundTarget: task.target,
    roundCompleted: 0,
    roundCleared: false,
    completionArchived: true,
  }, data.value.phases[0]?.id || ''));
  saveLocal({ ...data.value, tasks: data.value.tasks.map((item) => item.id === task.id ? nextTask : item), dailyTargets: dailyTargetsWithoutTaskToday(task.id) });
}

function disableRoundMode(task: Task) {
  if (!task.roundModeEnabled) return;
  if (!window.confirm('关闭轮刷后，将以当前轮完成量作为普通累计进度；轮刷历史仍会保留。确定关闭吗？')) return;
  const nextTask = normalizeTask({
    ...task,
    roundModeEnabled: false,
    completed: Math.min(task.target, task.roundCompleted),
    repeatCount: 1,
    completionArchived: true,
  }, data.value.phases[0]?.id || '');
  saveLocal({ ...data.value, tasks: data.value.tasks.map((item) => item.id === task.id ? nextTask : item), dailyTargets: dailyTargetsWithoutTaskToday(task.id) });
}

function handleTaskPlatformChange(task: Task, event: Event) {
  const select = event.target as HTMLSelectElement;
  const nextPlatform = select.value as PracticePlatform;
  if (nextPlatform === task.platform) return;
  if (taskProgressCompleted(task) <= 0 && (!task.roundModeEnabled || task.roundPracticeTotal <= 0)) {
    updateTask(task.id, { platform: nextPlatform });
    return;
  }
  select.value = task.platform;
  openPlatformSwitchModal(task, nextPlatform);
}

function openPlatformSwitchModal(task: Task, nextPlatform: PracticePlatform) {
  platformSwitchTaskId.value = task.id;
  platformSwitchTarget.value = nextPlatform;
  platformSwitchFrequency.value = nextPlatform === '猩际' && task.name === 'DI' ? '月预测' : task.frequencyType;
  platformSwitchTargetCount.value = 0;
  platformSwitchPhaseId.value = task.phaseId || phase.value?.id || schedule.value[0]?.id || '';
  platformSwitchError.value = '';
}

function closePlatformSwitchModal() {
  platformSwitchTaskId.value = '';
  platformSwitchTargetCount.value = 0;
  platformSwitchError.value = '';
}

function submitPlatformSwitch() {
  const source = platformSwitchTask.value;
  if (!source) return;
  if (platformSwitchTarget.value === source.platform) {
    platformSwitchError.value = '请选择与当前任务不同的平台。';
    return;
  }
  const existing = platformSwitchExistingTask.value;
  if (existing?.planStatus === 'active') {
    platformSwitchError.value = `当前计划中已存在“${existing.platform} ${taskDisplayName(existing)}”，请直接使用该任务。`;
    return;
  }
  const target = Math.max(0, Math.floor(Number(platformSwitchTargetCount.value) || 0));
  if (!existing && target <= 0) {
    platformSwitchError.value = '请输入新平台的题库量。';
    return;
  }

  const now = new Date().toISOString();
  const tasks = data.value.tasks.map((task) => {
    if (task.id === source.id) return { ...task, planStatus: 'shelved' as const, shelvedAt: now };
    if (existing && task.id === existing.id) {
      return {
        ...task,
        phaseId: platformSwitchPhaseId.value,
        planStatus: 'active' as const,
        shelvedAt: undefined,
        startDate: undefined,
        endDate: undefined,
      };
    }
    return task;
  });

  if (!existing) {
    tasks.push({
      id: crypto.randomUUID(),
      phaseId: platformSwitchPhaseId.value,
      planStatus: 'active',
      shelvedAt: undefined,
      name: source.name,
      platform: platformSwitchTarget.value,
      frequencyType: platformSwitchFrequency.value,
      trackingMode: source.trackingMode,
      reviewEnabled: source.reviewEnabled,
      startDate: undefined,
      endDate: undefined,
      subItems: [],
      target,
      repeatCount: source.trackingMode === 'itemized' ? 1 : source.repeatCount,
      completed: 0,
      roundModeEnabled: false,
      roundCycle: 1,
      roundStage: 1,
      roundPass: 1,
      roundTarget: 0,
      roundCompleted: 0,
      roundPracticeTotal: 0,
      roundCleared: false,
      roundHistory: [],
    });
  }

  saveLocal({ ...data.value, tasks });
  closePlatformSwitchModal();
}

function shelveTask(task: Task) {
  if (!window.confirm(`将“${task.platform} ${taskDisplayName(task)}”移入暂不安排吗？已有进度会完整保留。`)) return;
  const shelvedAt = new Date().toISOString();
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((item) => item.id === task.id ? { ...item, planStatus: 'shelved', shelvedAt } : item),
  });
}

function openRestoreTaskModal(task: Task) {
  restoreTaskId.value = task.id;
  restorePhaseId.value = phase.value?.id || schedule.value[0]?.id || '';
}

function closeRestoreTaskModal() {
  restoreTaskId.value = '';
  restorePhaseId.value = '';
}

function submitRestoreTask() {
  const task = restoreTask.value;
  if (!task || !restorePhaseId.value || restoreConflictTask.value) return;
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((item) => item.id === task.id ? {
      ...item,
      phaseId: restorePhaseId.value,
      planStatus: 'active',
      shelvedAt: undefined,
      startDate: undefined,
      endDate: undefined,
    } : item),
  });
  closeRestoreTaskModal();
}

function updateTaskCompleted(task: Task, completed: number, patch: Partial<Task> = {}) {
  const nextCompleted = Math.max(0, Math.floor(Number(completed) || 0));
  const nextTask = normalizeTask({ ...task, ...patch, completed: nextCompleted }, data.value.phases[0]?.id || '');
  if (nextTask.trackingMode === 'itemized' && nextTask.subItems.length > 0) {
    saveLocal({ ...data.value, tasks: data.value.tasks.map((item) => item.id === task.id ? nextTask : item) });
    return;
  }
  saveLocal({ ...data.value, tasks: data.value.tasks.map((item) => item.id === task.id ? nextTask : item) });
}

function openCorrectionModal(task: Task) {
  correctionTaskId.value = task.id;
  correctionAmountInput.value = String(Math.min(taskProgressCompleted(task), taskTotalTarget(task)));
  correctionError.value = '';
  void nextTick(() => correctionField.value?.focus());
}

function closeCorrectionModal() {
  correctionTaskId.value = '';
  correctionAmountInput.value = '';
  correctionError.value = '';
}

function applyTaskProgressCorrectionToDailyLogs(task: Task, delta: number) {
  const nextLogs = Object.entries(data.value.dailyLogs).reduce<StudyData['dailyLogs']>((acc, [date, logs]) => {
    acc[date] = logs.map((log) => ({ ...log }));
    return acc;
  }, {});

  if (delta > 0) {
    const date = todayIso();
    nextLogs[date] = [...(nextLogs[date] || []), { taskId: task.id, count: delta, ...roundLogMetadata(task) }];
    return nextLogs;
  }

  let remaining = Math.abs(delta);
  Object.keys(nextLogs).sort((a, b) => b.localeCompare(a)).forEach((date) => {
    if (remaining <= 0) return;
    const logs = nextLogs[date];
    for (let index = logs.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const log = logs[index];
      if (log.taskId !== task.id) continue;
      if (task.roundModeEnabled && (log.roundCycle !== task.roundCycle || log.roundStage !== task.roundStage || log.roundPass !== task.roundPass)) continue;
      const count = log.count ?? log.amount ?? 0;
      if (count <= 0) continue;
      const removed = Math.min(count, remaining);
      const nextCount = count - removed;
      remaining -= removed;
      if (nextCount <= 0) {
        logs.splice(index, 1);
      } else if (typeof log.count === 'number') {
        log.count = nextCount;
      } else {
        log.amount = nextCount;
      }
    }
    if (logs.length === 0) delete nextLogs[date];
  });
  return nextLogs;
}

function submitCorrection() {
  const task = correctionTask.value;
  if (!task) return;
  const totalTarget = taskTotalTarget(task);
  if (totalTarget <= 0) return;
  const nextCompleted = Math.floor(Number(correctionAmountInput.value));
  if (!Number.isFinite(nextCompleted) || nextCompleted < 0 || nextCompleted > totalTarget) {
    correctionError.value = `请输入 0 到 ${totalTarget} 之间的整数。`;
    return;
  }

  if (task.trackingMode === 'itemized' && task.subItems.length > 0) {
    const doneEntries = task.subItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.status === 'done')
      .sort((a, b) => (a.item.completedDate || '').localeCompare(b.item.completedDate || '') || a.index - b.index);
    const keepIds = new Set(doneEntries.slice(0, nextCompleted).map(({ item }) => item.id));
    const nextSubItems = task.subItems.map((item) => item.status === 'done' && !keepIds.has(item.id)
      ? { ...item, status: 'not_started' as const, completedDate: '' }
      : item);
    const affectedDates = new Set(task.subItems.map((item) => item.completedDate).filter((date): date is string => Boolean(date)));
    const dailyLogs = { ...data.value.dailyLogs };
    affectedDates.forEach((date) => {
      const logs = dailyLogs[date] || [];
      const selectedIds = nextSubItems.filter((item) => item.completedDate === date).map((item) => item.id);
      const otherLogs = logs.filter((entry) => entry.taskId !== task.id);
      dailyLogs[date] = selectedIds.length > 0 ? [...otherLogs, { taskId: task.id, count: selectedIds.length, subItemIds: selectedIds }] : otherLogs;
    });
    saveLocal({
      ...data.value,
      tasks: data.value.tasks.map((item) => item.id === task.id ? normalizeTask({ ...task, subItems: nextSubItems }, data.value.phases[0]?.id || '') : item),
      dailyLogs,
    });
    closeCorrectionModal();
    return;
  }

  const currentCompleted = taskProgressCompleted(task);
  const correctionDelta = nextCompleted - currentCompleted;
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((item) => item.id === task.id ? taskWithProgressDelta(item, correctionDelta) : item),
    dailyLogs: correctionDelta === 0
      ? data.value.dailyLogs
      : applyTaskProgressCorrectionToDailyLogs(task, correctionDelta),
  });
  closeCorrectionModal();
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
        planStatus: 'active',
        shelvedAt: undefined,
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
        roundModeEnabled: false,
        roundCycle: 1,
        roundStage: 1,
        roundPass: 1,
        roundTarget: 0,
        roundCompleted: 0,
        roundPracticeTotal: 0,
        roundCleared: false,
        roundHistory: [],
      },
    ],
  });
}

function sortPhaseTasksByPriority(phaseId: string) {
  const phaseTasks = data.value.tasks
    .filter((task) => task.phaseId === phaseId && task.planStatus === 'active')
    .map((task, index) => ({ task, index }))
    .sort((a, b) => taskPriorityScore(b.task.name) - taskPriorityScore(a.task.name) || taskPriorityRank(a.task.name) - taskPriorityRank(b.task.name) || a.index - b.index)
    .map((entry) => entry.task);
  let cursor = 0;
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((task) => task.phaseId === phaseId && task.planStatus === 'active' ? phaseTasks[cursor++] : task),
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
  const progressCompleted = taskProgressCompleted(task);
  const delta = amount < 0
    ? -Math.min(Math.abs(amount), progressCompleted, Math.max(0, todayCompleted))
    : Math.min(Math.max(0, amount), taskRemaining(task));
  if (delta === 0) return;
  saveLocal({
    ...data.value,
    tasks: data.value.tasks.map((item) => item.id === task.id ? taskWithProgressDelta(item, delta) : item),
    dailyLogs: { ...data.value.dailyLogs, [date]: [...log, { taskId: task.id, count: delta, ...roundLogMetadata(task) }] },
  });
}

function manualAmount(id: string) {
  return manualAmounts.value[id] ?? 5;
}

function setManualAmount(id: string, value: string) {
  manualAmounts.value[id] = Math.max(0, Math.floor(Number(value) || 0));
}

function setManualAmountValue(id: string, value: number) {
  manualAmounts.value[id] = Math.max(0, Math.floor(Number(value) || 0));
}

function applyManualAmount(task: Task, direction: 1 | -1) {
  addAmount(task, manualAmount(task.id) * direction);
}

function deleteTodayPracticeItem(itemId: string) {
  const date = todayIso();
  if (itemId.startsWith('task-')) {
    const task = data.value.tasks.find((entry) => entry.id === itemId.slice('task-'.length));
    if (!task) return;
    const logs = data.value.dailyLogs[date] || [];
    const isCurrentTaskLog = (entry: StudyData['dailyLogs'][string][number]) => entry.taskId === task.id && (!task.roundModeEnabled
      || (entry.roundCycle === task.roundCycle && entry.roundStage === task.roundStage && entry.roundPass === task.roundPass));
    const todayCompleted = logs
      .filter(isCurrentTaskLog)
      .reduce((sum, entry) => sum + (entry.count ?? entry.amount ?? 0), 0);
    if (todayCompleted <= 0) return;
    if (!confirm(`删除「${taskDisplayName(task)}」今天的 ${todayCompleted} ${task.trackingMode === 'itemized' ? '篇' : '题'}练习记录？累计总进度也会相应减少。`)) return;

    const nextLogs = logs.filter((entry) => !isCurrentTaskLog(entry));
    const dailyLogs = { ...data.value.dailyLogs };
    if (nextLogs.length > 0) dailyLogs[date] = nextLogs;
    else delete dailyLogs[date];
    if (task.trackingMode === 'itemized') {
      const subItems = task.subItems.map((item) => item.completedDate === date
        ? { ...item, status: 'not_started' as const, completedDate: '' }
        : item);
      const nextTask = normalizeTask({ ...task, subItems }, data.value.phases[0]?.id || '');
      saveLocal({ ...data.value, tasks: data.value.tasks.map((entry) => entry.id === task.id ? nextTask : entry), dailyLogs });
    } else {
      saveLocal({ ...data.value, tasks: data.value.tasks.map((entry) => entry.id === task.id ? taskWithProgressDelta(entry, -todayCompleted) : entry), dailyLogs });
    }
    return;
  }

  if (!itemId.startsWith('review-')) return;
  const reviewPlanId = itemId.slice('review-'.length);
  const logs = data.value.reviewLogs[date] || [];
  const todayCompleted = logs
    .filter((entry) => entry.reviewPlanId === reviewPlanId)
    .reduce((sum, entry) => sum + entry.amount, 0);
  if (todayCompleted <= 0) return;
  const plan = reviewPlanForId(reviewPlanId);
  const unit = plan && isItemizedReviewPlan(plan) ? '篇' : '题';
  if (!confirm(`删除今天的 ${todayCompleted} ${unit}复习记录？复习计划的累计完成量也会相应减少。`)) return;

  const nextLogs = logs.filter((entry) => entry.reviewPlanId !== reviewPlanId);
  const reviewLogs = { ...data.value.reviewLogs };
  if (nextLogs.length > 0) reviewLogs[date] = nextLogs;
  else delete reviewLogs[date];
  const reviewPlans = Object.entries(data.value.reviewPlans).reduce<StudyData['reviewPlans']>((acc, [dueDate, plans]) => {
    acc[dueDate] = plans.map((entry) => {
      if (entry.id !== reviewPlanId) return entry;
      if (isItemizedReviewPlan(entry)) {
        const completedSubItemIds = (entry.completedSubItemIds || []).slice(0, Math.max(0, (entry.completedSubItemIds || []).length - todayCompleted));
        return { ...entry, completedSubItemIds, completed: completedSubItemIds.length };
      }
      return { ...entry, completed: Math.max(0, entry.completed - todayCompleted) };
    });
    return acc;
  }, {});
  saveLocal({ ...data.value, reviewPlans, reviewLogs });
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

function isTaskCompletedOverall(task: Task) {
  if (task.roundModeEnabled) return task.roundCleared;
  const totalTarget = taskTotalTarget(task);
  return totalTarget > 0 && task.completed >= totalTarget;
}

function restoreCompletedTask(task: Task) {
  updateTask(task.id, { completionArchived: false });
}

function isTomorrowReviewRegistrationSkipped(task: Task) {
  return (data.value.skippedReviewRegistrations[todayIso()] || []).includes(task.id);
}

function shouldShowTomorrowReviewRegister(task: Task & { doneToday: boolean; completedDate?: string }) {
  const completedOverall = isTaskCompletedOverall(task);
  return task.reviewEnabled
    && task.doneToday
    && (!completedOverall || task.completedDate === todayIso())
    && task.trackingMode !== 'itemized'
    && tomorrowReviewTargetForTask(task.id) === 0
    && !isTomorrowReviewRegistrationSkipped(task);
}

function reviewSelectionKey(taskId: string) {
  return `${todayIso()}-${taskId}`;
}

function selectedReviewItemIds(taskId: string) {
  return selectedReviewSubItems.value[reviewSelectionKey(taskId)] || [];
}

function isReviewSubItemSelected(taskId: string, itemId: string) {
  return selectedReviewItemIds(taskId).includes(itemId);
}

function toggleReviewSubItem(taskId: string, itemId: string, checked: boolean) {
  const key = reviewSelectionKey(taskId);
  const current = selectedReviewSubItems.value[key] || [];
  selectedReviewSubItems.value[key] = checked
    ? [...new Set([...current, itemId])]
    : current.filter((id) => id !== itemId);
}

function completedSubItems(task: Task) {
  return task.subItems.filter((item) => item.status === 'done');
}

function clearReviewSubItemSelection(taskId: string) {
  selectedReviewSubItems.value[reviewSelectionKey(taskId)] = [];
}

function addSelectedSubItemsToReview(task: Task, date: string) {
  const selectedIds = selectedReviewItemIds(task.id).filter((id) => task.subItems.some((item) => item.id === id && item.status === 'done'));
  if (!selectedIds.length) return;
  const plans = data.value.reviewPlans[date] || [];
  const existing = plans.find((plan) => plan.taskId === task.id && plan.sourceDate === todayIso() && isItemizedReviewPlan(plan));
  const nextSubItemIds = [...new Set([...(existing?.subItemIds || []), ...selectedIds])];
  const completedSubItemIds = (existing?.completedSubItemIds || []).filter((id) => nextSubItemIds.includes(id));
  const nextPlan: ReviewPlan = {
    id: existing?.id || crypto.randomUUID(),
    taskId: task.id,
    taskName: task.name,
    sourceDate: todayIso(),
    target: nextSubItemIds.length,
    completed: completedSubItemIds.length,
    subItemIds: nextSubItemIds,
    completedSubItemIds,
  };
  saveLocal({
    ...data.value,
    reviewPlans: {
      ...data.value.reviewPlans,
      [date]: [...plans.filter((plan) => plan.id !== existing?.id), nextPlan],
    },
  });
  clearReviewSubItemSelection(task.id);
}

function addSelectedSubItemsToTodayReview(task: Task) {
  addSelectedSubItemsToReview(task, todayIso());
}

function addSelectedSubItemsToTomorrowReview(task: Task) {
  addSelectedSubItemsToReview(task, addDays(todayIso(), 1));
}

function cancelTomorrowReviewRegistration(task: Task) {
  const date = todayIso();
  const skippedToday = data.value.skippedReviewRegistrations[date] || [];
  const nextSkipped = skippedToday.includes(task.id) ? skippedToday : [...skippedToday, task.id];
  saveLocal({
    ...data.value,
    skippedReviewRegistrations: {
      ...data.value.skippedReviewRegistrations,
      [date]: nextSkipped,
    },
  });
}

function addReviewPlan() {
  const task = countReviewEnabledTasks.value.find((item) => item.id === reviewAddTaskId.value) || countReviewEnabledTasks.value[0];
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

function reviewPlanForId(planId: string) {
  return Object.values(data.value.reviewPlans).flat().find((plan) => plan.id === planId);
}

function reviewPlanDate(plan: ReviewPlan & { dueDate?: string }) {
  return plan.dueDate || todayIso();
}

function reviewPlanTaskName(plan: ReviewPlan) {
  const task = data.value.tasks.find((item) => item.id === plan.taskId);
  return task ? taskDisplayName(task) : plan.taskName;
}

function isItemizedReviewPlan(plan: ReviewPlan) {
  return (plan.subItemIds?.length || 0) > 0;
}

function reviewPlanTask(plan: ReviewPlan) {
  return data.value.tasks.find((item) => item.id === plan.taskId);
}

function reviewPlanSubItems(plan: ReviewPlan) {
  const task = reviewPlanTask(plan);
  const ids = plan.subItemIds || [];
  return ids
    .map((id) => task?.subItems.find((item) => item.id === id))
    .filter((item): item is SubItem => Boolean(item));
}

function isReviewPlanSubItemDone(plan: ReviewPlan, itemId: string) {
  return (plan.completedSubItemIds || []).includes(itemId);
}

function toggleReviewPlanSubItem(date: string, plan: ReviewPlan, itemId: string, checked: boolean) {
  const current = plan.completedSubItemIds || [];
  const completedSubItemIds = checked
    ? [...new Set([...current, itemId])]
    : current.filter((id) => id !== itemId);
  updateReviewPlan(date, plan.id, { completedSubItemIds });
}

function updateReviewSubItemFamiliarity(taskId: string, itemId: string, familiarity: Familiarity) {
  if (!isFamiliarity(familiarity)) return;
  const nextTasks = data.value.tasks.map((task) => {
    if (task.id !== taskId) return task;
    const nextSubItems = task.subItems.map((item) => item.id === itemId ? { ...item, familiarity } : item);
    return normalizeTask({ ...task, subItems: nextSubItems }, data.value.phases[0]?.id || '');
  });
  saveLocal({ ...data.value, tasks: nextTasks });
}

function applyReviewProgressDelta(reviewLogs: StudyData['reviewLogs'], plan: ReviewPlan, delta: number): StudyData['reviewLogs'] {
  const next = Object.entries(reviewLogs || {}).reduce<StudyData['reviewLogs']>((acc, [date, logs]) => {
    acc[date] = logs.map((log) => ({ ...log }));
    return acc;
  }, {});

  if (delta > 0) {
    const date = todayIso();
    const entry: ReviewLogEntry = {
      id: crypto.randomUUID(),
      reviewPlanId: plan.id,
      taskId: plan.taskId,
      taskName: plan.taskName,
      amount: delta,
      createdAt: new Date().toISOString(),
    };
    next[date] = [...(next[date] || []), entry];
    return next;
  }

  let remaining = Math.abs(delta);
  Object.keys(next).sort((a, b) => b.localeCompare(a)).forEach((date) => {
    if (remaining <= 0) return;
    const logs = next[date];
    for (let index = logs.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const log = logs[index];
      if (log.reviewPlanId !== plan.id) continue;
      const removed = Math.min(log.amount, remaining);
      log.amount -= removed;
      remaining -= removed;
      if (log.amount <= 0) logs.splice(index, 1);
    }
    if (logs.length === 0) delete next[date];
  });
  return next;
}

function updateReviewPlan(date: string, planId: string, patch: Partial<ReviewPlan>) {
  const plans = data.value.reviewPlans[date] || [];
  const previousPlan = plans.find((plan) => plan.id === planId);
  let updatedPlan: ReviewPlan | undefined;
  const nextPlans = plans.map((plan) => {
    if (plan.id !== planId) return plan;
    const nextSubItemIds = patch.subItemIds ?? plan.subItemIds ?? [];
    if (nextSubItemIds.length > 0) {
      const completedSubItemIds = [...new Set(patch.completedSubItemIds ?? plan.completedSubItemIds ?? [])].filter((id) => nextSubItemIds.includes(id));
      updatedPlan = { ...plan, ...patch, subItemIds: nextSubItemIds, completedSubItemIds, target: nextSubItemIds.length, completed: completedSubItemIds.length };
      return updatedPlan;
    }
    const target = Math.max(0, Number(patch.target ?? plan.target));
    const completed = Math.min(target, Math.max(0, Number(patch.completed ?? plan.completed)));
    updatedPlan = { ...plan, ...patch, target, completed, subItemIds: [], completedSubItemIds: [] };
    return updatedPlan;
  }).filter((plan) => plan.target > 0 || plan.completed > 0 || (plan.subItemIds?.length || 0) > 0);
  const delta = previousPlan && updatedPlan ? updatedPlan.completed - previousPlan.completed : 0;
  const reviewLogs = delta !== 0 && updatedPlan
    ? applyReviewProgressDelta(data.value.reviewLogs, updatedPlan, delta)
    : data.value.reviewLogs;
  saveLocal({ ...data.value, reviewPlans: { ...data.value.reviewPlans, [date]: nextPlans }, reviewLogs });
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
  const reviewLogs = Object.entries(data.value.reviewLogs).reduce<StudyData['reviewLogs']>((acc, [logDate, logs]) => {
    const nextLogs = logs.filter((log) => log.reviewPlanId !== planId);
    if (nextLogs.length) acc[logDate] = nextLogs;
    return acc;
  }, {});
  saveLocal({ ...data.value, reviewPlans: { ...data.value.reviewPlans, [date]: plans }, reviewLogs });
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

function formatTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '09:00';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function normalizeNoteExamTypes(types: unknown, fallbackToGeneral = false) {
  const source = Array.isArray(types) ? types : [];
  const allowed = new Set(noteExamTypeOptions);
  const normalized = [...new Set(source.map((type) => String(type || '').trim()).filter(Boolean))]
    .filter((type) => allowed.has(type));
  return normalized.length ? normalized : fallbackToGeneral ? ['综合'] : [];
}

function noteExamTypes(note: DailyNoteEntry) {
  return normalizeNoteExamTypes(note.examTypes || [note.examType], Boolean(note.examType));
}

function toggleNoteExamType(type: string) {
  const current = new Set(selectedNoteExamTypes.value);
  if (current.has(type)) current.delete(type);
  else current.add(type);
  selectedNoteExamTypes.value = normalizeNoteExamTypes([...current]);
}

function noteTypeStyle(type: string) {
  const index = Math.max(0, noteExamTypeOptions.indexOf(type));
  const background = type === '综合' ? '#8b6df6' : taskTypeColor(type, index);
  return { color: '#fff', background, borderColor: background };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderNoteMarkdown(value: string) {
  const lines = value.split(/\r?\n/);
  const html: string[] = [];
  let inList = false;
  for (const line of lines) {
    const listMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (listMatch) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderInlineMarkdown(listMatch[1])}</li>`);
      continue;
    }
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
    html.push(line.trim() ? `<p>${renderInlineMarkdown(line)}</p>` : '<br>');
  }
  if (inList) html.push('</ul>');
  return html.join('');
}

function isHtmlNote(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function sanitizeNoteHtml(value: string) {
  if (typeof document === 'undefined') return escapeHtml(value);
  const template = document.createElement('template');
  template.innerHTML = value;
  const allowedTags = new Set(['B', 'STRONG', 'I', 'EM', 'UL', 'OL', 'LI', 'P', 'DIV', 'BR', 'CODE']);
  const cleanNode = (node: Node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as HTMLElement;
        if (!allowedTags.has(element.tagName)) {
          if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') {
            element.remove();
            return;
          }
          cleanNode(element);
          element.replaceWith(...Array.from(element.childNodes));
          return;
        }
        [...element.attributes].forEach((attr) => element.removeAttribute(attr.name));
        cleanNode(element);
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove();
      }
    });
  };
  cleanNode(template.content);
  return template.innerHTML;
}

function renderNoteContent(value: string) {
  return isHtmlNote(value) ? sanitizeNoteHtml(value) : renderNoteMarkdown(value);
}

function noteTextContent(value: string) {
  if (typeof document === 'undefined') return value.replace(/<[^>]+>/g, '').trim();
  const container = document.createElement('div');
  container.innerHTML = renderNoteContent(value);
  return (container.textContent || '').replace(/\u00a0/g, ' ').trim();
}

function isNoteContentEmpty(value: string) {
  return !noteTextContent(value);
}

function setNoteEditorHtml(value: string) {
  const editor = noteEditorRef.value;
  if (!editor) return;
  editor.innerHTML = value ? renderNoteContent(value) : '';
  noteDraft.value = sanitizeNoteHtml(editor.innerHTML).trim();
}

function syncNoteDraftFromEditor() {
  const editor = noteEditorRef.value;
  if (!editor) return;
  noteDraft.value = sanitizeNoteHtml(editor.innerHTML).trim();
}

function ensureEditorFocus() {
  noteEditorRef.value?.focus();
}

function editorSelectionRange() {
  const editor = noteEditorRef.value;
  const selection = window.getSelection();
  if (!editor || !selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer) ? range : null;
}

function formatNote(command: 'bold' | 'italic' | 'insertUnorderedList') {
  ensureEditorFocus();
  document.execCommand(command, false);
  syncNoteDraftFromEditor();
}

function formatInlineCode() {
  const editor = noteEditorRef.value;
  if (!editor) return;
  ensureEditorFocus();
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
  const selectedText = selection.toString() || '文本';
  const code = document.createElement('code');
  code.textContent = selectedText;
  range.deleteContents();
  range.insertNode(code);
  placeCursorAfterElement(code);
  syncNoteDraftFromEditor();
}

function closestNoteElement(node: Node | null, tagName: string) {
  const editor = noteEditorRef.value;
  let current = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element | null;
  while (current && current !== editor) {
    if (current.tagName === tagName) return current;
    current = current.parentElement;
  }
  return null;
}

function placeCursorAfterElement(element: Element) {
  const range = document.createRange();
  const selection = window.getSelection();
  range.setStartAfter(element);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function clearInlineFormattingAfterBreak() {
  const range = editorSelectionRange();
  if (!range) return;
  if (document.queryCommandState('bold')) document.execCommand('bold', false);
  if (document.queryCommandState('italic')) document.execCommand('italic', false);
  const code = closestNoteElement(range.startContainer, 'CODE');
  if (code) placeCursorAfterElement(code);
  syncNoteDraftFromEditor();
}

function handleNoteKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
  window.setTimeout(clearInlineFormattingAfterBreak, 0);
}

function handleNotePaste(event: ClipboardEvent) {
  event.preventDefault();
  const text = event.clipboardData?.getData('text/plain') || '';
  document.execCommand('insertText', false, text);
  syncNoteDraftFromEditor();
}

function selectNoteDate(date: string) {
  selectedNoteDate.value = date;
  editingNoteId.value = '';
}

function saveDailyNote() {
  syncNoteDraftFromEditor();
  const content = sanitizeNoteHtml(noteDraft.value).trim();
  if (isNoteContentEmpty(content)) return;
  const dailyNotes = { ...(data.value.dailyNotes || {}) };
  const existingNotes = dailyNotes[selectedNoteDate.value] || [];
  const now = new Date();
  if (editingNoteId.value) {
    let updatedNote: DailyNoteEntry | undefined;
    for (const [date, notes] of Object.entries(dailyNotes)) {
      const match = notes.find((note) => note.id === editingNoteId.value);
      if (!match) continue;
      updatedNote = {
        ...match,
        date: selectedNoteDate.value,
        examType: selectedNoteExamTypes.value[0] || '综合',
        examTypes: normalizeNoteExamTypes(selectedNoteExamTypes.value),
        content,
        updatedAt: now.toISOString(),
      };
      dailyNotes[date] = notes.filter((note) => note.id !== editingNoteId.value);
      if (!dailyNotes[date].length) delete dailyNotes[date];
      break;
    }
    if (updatedNote) {
      dailyNotes[selectedNoteDate.value] = [updatedNote, ...(dailyNotes[selectedNoteDate.value] || [])];
    }
  } else {
    const entry: DailyNoteEntry = {
      id: crypto.randomUUID(),
      date: selectedNoteDate.value,
      time: formatTime(now.toISOString()),
      examType: selectedNoteExamTypes.value[0] || '综合',
      examTypes: normalizeNoteExamTypes(selectedNoteExamTypes.value),
      content,
      createdAt: now.toISOString(),
    };
    dailyNotes[selectedNoteDate.value] = [entry, ...existingNotes];
  }
  dailyNotes[selectedNoteDate.value] = (dailyNotes[selectedNoteDate.value] || []).filter((note) => !isNoteContentEmpty(note.content));
  if (!dailyNotes[selectedNoteDate.value].length) delete dailyNotes[selectedNoteDate.value];
  saveLocal({ ...data.value, dailyNotes });
  resetNoteDraft();
}

function editDailyNote(note: DailyNoteEntry) {
  selectedNoteDate.value = note.date;
  selectedNoteExamTypes.value = noteExamTypes(note);
  noteDraft.value = note.content;
  editingNoteId.value = note.id;
  nextTick(() => {
    setNoteEditorHtml(note.content);
    noteEditorRef.value?.focus();
  });
}

function resetNoteDraft() {
  noteDraft.value = '';
  selectedNoteExamTypes.value = [];
  editingNoteId.value = '';
  nextTick(() => setNoteEditorHtml(''));
}

function resetAnswerDraft(preserveExamType = false) {
  if (!preserveExamType) answerExamType.value = 'DI';
  answerPlatformRefs.value = fixedAnswerPlatformRefs();
  answerTitle.value = '';
  answerContent.value = '';
  editingAnswerId.value = '';
}

function nextAnswerSortOrder(examType: string) {
  const orders = data.value.answerEntries
    .filter((entry) => entry.examType === examType && typeof entry.sortOrder === 'number')
    .map((entry) => entry.sortOrder as number);
  return orders.length ? Math.min(...orders) - 1 : -1;
}

function toggleAnswerManualSort() {
  if (answerManualSortMode.value) {
    answerManualSortMode.value = false;
    draggingAnswerId.value = '';
    return;
  }
  if (answerTypeFilter.value === '全部') {
    alert('请先选择一个题型，再调整该题型内的答案顺序。');
    return;
  }
  answerSearch.value = '';
  answerPlatformFilter.value = '全部';
  answerManualSortMode.value = true;
}

function startAnswerDrag(id: string, event: DragEvent) {
  if (!answerManualSortMode.value) return;
  event.dataTransfer?.setData('text/plain', id);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    const row = (event.currentTarget as HTMLElement).closest('.answer-row');
    if (row) event.dataTransfer.setDragImage(row, 36, 36);
  }
  draggingAnswerId.value = id;
}

function finishAnswerDrag() {
  draggingAnswerId.value = '';
}

function dropAnswerAt(targetId: string) {
  const sourceId = draggingAnswerId.value;
  if (!answerManualSortMode.value || !sourceId || sourceId === targetId) return;
  const ordered = [...answerRows.value];
  const sourceIndex = ordered.findIndex((entry) => entry.id === sourceId);
  const targetIndex = ordered.findIndex((entry) => entry.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;

  const [source] = ordered.splice(sourceIndex, 1);
  ordered.splice(targetIndex, 0, source);
  const sortOrderById = new Map(ordered.map((entry, index) => [entry.id, index]));
  saveLocal({
    ...data.value,
    answerEntries: data.value.answerEntries.map((entry) => sortOrderById.has(entry.id)
      ? { ...entry, sortOrder: sortOrderById.get(entry.id) }
      : entry),
  });
  draggingAnswerId.value = '';
}

function optimizeAnswerText() {
  const normalizeLine = (line: string) => {
    const text = line.trim().replace(/\s+([,.;:!?])/g, '$1');
    if (!text) return '';
    const capitalized = text
      .replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`)
      .replace(/\bi\b/g, 'I');
    if (/[.!?。！？…:：]$/.test(capitalized)) return capitalized;
    return `${capitalized}${/[A-Za-z]/.test(capitalized) ? '.' : '。'}`;
  };

  answerContent.value = answerContent.value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map(normalizeLine)
    .filter(Boolean)
    .join('\n')
    .trim();
}

function saveAnswer() {
  const platformRefs = answerPlatformRefs.value
    .map((ref) => ({ platform: ref.platform, questionNumber: ref.questionNumber.trim() }))
    .filter((ref) => ref.questionNumber);
  const title = answerTitle.value.trim();
  const answer = answerContent.value.trim();
  if (!platformRefs.length || !title || !answer) {
    alert('请至少填写一个平台题号、答案标题和答案内容。');
    return;
  }
  const now = new Date().toISOString();
  const entry: AnswerEntry = {
    id: editingAnswerId.value || crypto.randomUUID(),
    examType: answerExamType.value.trim() || 'DI',
    platformRefs,
    title,
    answer,
    createdAt: now,
    updatedAt: now,
    ...(editingAnswerId.value ? {} : { sortOrder: nextAnswerSortOrder(answerExamType.value.trim() || 'DI') }),
  };
  const answerEntries = editingAnswerId.value
    ? data.value.answerEntries.map((item) => item.id === editingAnswerId.value ? { ...item, ...entry, createdAt: item.createdAt, updatedAt: now } : item)
    : [entry, ...data.value.answerEntries];
  saveLocal({ ...data.value, answerEntries });
  resetAnswerDraft(true);
}

function editAnswer(entry: AnswerEntry) {
  answerExamType.value = entry.examType;
  answerPlatformRefs.value = fixedAnswerPlatformRefs(entry.platformRefs);
  answerTitle.value = entry.title;
  answerContent.value = entry.answer;
  editingAnswerId.value = entry.id;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function deleteAnswer(id: string) {
  const entry = data.value.answerEntries.find((item) => item.id === id);
  if (!entry || !confirm(`确定删除「${entry.title}」吗？`)) return;
  saveLocal({ ...data.value, answerEntries: data.value.answerEntries.filter((item) => item.id !== id) });
  if (editingAnswerId.value === id) resetAnswerDraft();
}

function escapePrintHtml(value: string) {
  return value.replace(/[&<>\"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character] || character));
}

function answerPrintHtml(value: string) {
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t \u00a0]+/g, ' ')
    .replace(/(\d)\s*[‐‑‒–—−]\s*(\d)/g, '$1-$2')
    .replace(/\n{3,}/g, '\n\n');
  return normalized
    .split('\n')
    .map((line) => line ? `<p>${escapePrintHtml(line)}</p>` : '<p class="body-gap" aria-hidden="true"></p>')
    .join('');
}

function answerPdfFilename(title: string) {
  const safeTitle = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return `${safeTitle || 'PTE 答案'}.pdf`;
}

async function exportAnswersToPdf() {
  const entries = exportAnswerRows.value;
  if (!entries.length) {
    alert(`还没有 ${exportAnswerType.value} 题型的答案可导出。`);
    return;
  }
  if (isExportingAnswersPdf.value) return;

  const exportTitle = `${exportAnswerType.value} 答案`;
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const content = entries.map((entry, index) => `
    <article class="answer-pdf-answer">
      <div class="answer-head">
        <div class="answer-tags"><span class="type-tag">${escapePrintHtml(entry.examType)}</span>${entry.platformRefs.map((ref) => `<span class="platform-tag">${escapePrintHtml(ref.platform)} #${escapePrintHtml(ref.questionNumber)}</span>`).join('')}</div>
        <span class="number">${String(index + 1).padStart(2, '0')}</span>
      </div>
      <h2>${escapePrintHtml(entry.title)}</h2>
      <div class="body">${answerPrintHtml(entry.answer)}</div>
    </article>`).join('');

  const exportStyle = document.createElement('style');
  const exportMount = document.createElement('div');
  const source = document.createElement('div');
  exportStyle.textContent = `
    .answer-pdf-document, .answer-pdf-document * { box-sizing: border-box; }
    .answer-pdf-document { width: 180mm; margin: 0; color: #17233c; background: #fff; font-family: Arial, Helvetica, "Microsoft YaHei", sans-serif; }
    .answer-pdf-document .answer-pdf-cover { position: relative; display: grid; gap: 13px; min-height: 158px; padding: 20px 25px 19px; overflow: hidden; background: linear-gradient(112deg, #fbfdff 0%, #f6f8ff 54%, #f0efff 100%); border: 1px solid #d9e2ff; border-radius: 15px; break-inside: avoid; page-break-inside: avoid; }
    .answer-pdf-document .answer-pdf-cover::before { position: absolute; top: 25px; right: 56px; width: 85px; height: 75px; content: ""; background-image: radial-gradient(circle, #b8c7ff 1.6px, transparent 1.8px); background-size: 12px 12px; opacity: .62; }
    .answer-pdf-document .answer-pdf-cover::after { position: absolute; right: -30px; bottom: -55px; width: 190px; height: 190px; content: ""; border: 1px solid #cbd4ff; border-radius: 50%; box-shadow: 0 0 0 36px rgba(206, 213, 255, .37), 0 0 0 72px rgba(226, 229, 255, .42); }
    .answer-pdf-document .cover-brand, .answer-pdf-document h1, .answer-pdf-document .cover-rule, .answer-pdf-document .cover-meta { position: relative; z-index: 1; }
    .answer-pdf-document .cover-brand { display: flex; align-items: center; gap: 9px; color: #4d66bc; font-size: 11px; font-weight: 800; letter-spacing: .1em; }
    .answer-pdf-document .brand-mark, .answer-pdf-document .meta-icon { display: grid; place-items: center; flex: 0 0 auto; color: #5472db; background: linear-gradient(145deg, #dff1ff, #d8ddff); border-radius: 8px; }
    .answer-pdf-document .brand-mark { width: 25px; height: 25px; box-shadow: 0 5px 10px rgba(85, 111, 210, .18); }
    .answer-pdf-document .brand-mark svg { width: 15px; height: 15px; }
    .answer-pdf-document h1 { margin: 5px 0 0; color: #192c59; font-size: 34px; line-height: 1.1; letter-spacing: .01em; }
    .answer-pdf-document .cover-rule { width: min(74%, 540px); height: 1px; margin-top: 3px; background: #dce4f4; }
    .answer-pdf-document .cover-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 0; color: #4e5f84; font-size: 10.5px; }
    .answer-pdf-document .cover-meta span { display: inline-flex; align-items: center; gap: 7px; min-height: 26px; padding: 0 16px; border-right: 1px solid #dbe2f1; }
    .answer-pdf-document .cover-meta span:first-child { padding-left: 0; }
    .answer-pdf-document .cover-meta span:last-child { border-right: 0; }
    .answer-pdf-document .meta-icon { width: 22px; height: 22px; }
    .answer-pdf-document .meta-icon svg { width: 13px; height: 13px; }
    .answer-pdf-document .answers { margin-top: 15px; }
    .answer-pdf-document .answer-pdf-answer { position: relative; margin-bottom: 12px; padding: 16px 18px 17px; background: #f8faff; border: 1px solid #dbe4fb; border-left: 5px solid #496fe1; border-radius: 10px; break-inside: avoid; page-break-inside: avoid; }
    .answer-pdf-document .answer-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .answer-pdf-document .answer-tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .answer-pdf-document .answer-tags span { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; line-height: 1.25; }
    .answer-pdf-document .type-tag { color: #fff; background: #496fe1; }
    .answer-pdf-document .platform-tag { color: #375081; background: #e7eefc; }
    .answer-pdf-document .number { flex: 0 0 auto; color: #496fe1; font-size: 15px; font-weight: 800; letter-spacing: .08em; }
    .answer-pdf-document h2 { margin: 11px 0 9px; color: #17233c; font-size: 18px; line-height: 1.35; }
    .answer-pdf-document .body { color: #40506d; font-family: Arial, Helvetica, "Microsoft YaHei", sans-serif; font-size: 12px; font-weight: 400; line-height: 1.65; font-kerning: normal; font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0; letter-spacing: 0; word-spacing: 0; text-align: left; text-rendering: auto; transform: none; white-space: normal; overflow-wrap: normal; word-break: normal; hyphens: none; }
    .answer-pdf-document .body p { margin: 0; break-inside: avoid; page-break-inside: avoid; }
    .answer-pdf-document .body-gap { min-height: 1.65em; }
    .answer-pdf-document .document-footer { margin-top: 14px; color: #8a96ab; font-size: 9px; text-align: center; }
  `;
  exportMount.style.cssText = 'position: fixed; left: -100000px; top: 0; pointer-events: none;';
  source.className = 'answer-pdf-document';
  source.innerHTML = `<header class="answer-pdf-cover"><div class="cover-brand"><span class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5M4 19h16M7 16l4-5 3 3 5-7"/><circle cx="7" cy="16" r="1"/><circle cx="11" cy="11" r="1"/><circle cx="14" cy="14" r="1"/><circle cx="19" cy="7" r="1"/></svg></span>PTE STUDY · ANSWER COLLECTION</div><h1>${escapePrintHtml(exportTitle)}</h1><div class="cover-rule"></div><div class="cover-meta"><span><i class="meta-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h4M9 12h6M9 16h6"/></svg></i>共 ${entries.length} 条答案</span><span><i class="meta-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg></i>导出于 ${generatedAt}</span><span><i class="meta-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 8V3h10v5M6 17H4v-6h16v6h-2M7 14h10v7H7z"/></svg></i>按平台题号整理，适合打印或电子复习。</span></div></header><section class="answers">${content}</section><footer class="document-footer">PTE Study Planner · ${escapePrintHtml(exportTitle)}</footer>`;

  isExportingAnswersPdf.value = true;
  document.head.appendChild(exportStyle);
  exportMount.appendChild(source);
  document.body.appendChild(exportMount);
  try {
    const { default: html2pdf } = await import('html2pdf.js');
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const options = {
      margin: [14, 15, 14, 15] as [number, number, number, number],
      filename: answerPdfFilename(exportTitle),
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['.answer-pdf-cover', '.answer-pdf-answer'] },
    };
    await html2pdf().set(options).from(source).save();
  } catch (error) {
    console.error('Failed to export answers PDF', error);
    alert('PDF 生成失败，请稍后重试。');
  } finally {
    exportMount.remove();
    exportStyle.remove();
    isExportingAnswersPdf.value = false;
  }
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

async function copyCheckInText(text: string, copiedKey: string) {
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
  copiedCheckInKey.value = copiedKey;
  if (copiedCheckInTimer) window.clearTimeout(copiedCheckInTimer);
  copiedCheckInTimer = window.setTimeout(() => { copiedCheckInKey.value = ''; }, 1600);
}

async function copyTodayCheckIn() {
  const text = todayCheckInText.value;
  if (!text) return;
  await copyCheckInText(text, 'all');
}

async function copyExamTypeCheckIn(type: string, seconds: number) {
  await copyCheckInText(`${type}${formatCheckInDuration(seconds)}`, `type:${type}`);
}

function deleteAllSubItems(task: Task) {
  if (task.subItems.length === 0) return;
  if (!confirm(`确定删除「${task.name || '当前任务'}」的全部子项目吗？`)) return;
  updateTaskSubItems(task.id, () => []);
}

function deleteDailyNote(date: string, noteId: string) {
  const dailyNotes = { ...(data.value.dailyNotes || {}) };
  dailyNotes[date] = (dailyNotes[date] || []).filter((note) => note.id !== noteId);
  if (!dailyNotes[date]?.length) delete dailyNotes[date];
  saveLocal({ ...data.value, dailyNotes });
  if (editingNoteId.value === noteId) resetNoteDraft();
}

function buildTodayTargetSnapshot() {
  return todayTasks.value.reduce<Record<string, number>>((acc, task) => {
    acc[task.id] = plannedDailyTarget(task, schedule.value.find((item) => item.id === task.phaseId));
    return acc;
  }, {});
}

function sameTargetSnapshot(a: Record<string, number> = {}, b: Record<string, number> = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => Number(a[key] || 0) === Number(b[key] || 0));
}

function refreshTodayTargets(options: { markDirty?: boolean; scheduleSync?: boolean } = {}) {
  const date = todayIso();
  const nextTargets = buildTodayTargetSnapshot();
  const currentTargets = data.value.dailyTargets?.[date] || {};
  if (sameTargetSnapshot(currentTargets, nextTargets)) return;
  saveLocal({
    ...data.value,
    dailyTargets: {
      ...(data.value.dailyTargets || {}),
      [date]: nextTargets,
    },
  }, options);
}

function refreshUnstartedTodayTargets(options: { markDirty?: boolean; scheduleSync?: boolean } = {}) {
  const date = todayIso();
  const latestTargets = buildTodayTargetSnapshot();
  const currentTargets = data.value.dailyTargets?.[date] || {};
  const todayTaskIds = new Set(todayTasks.value.map((task) => task.id));
  const nextTargets = Object.entries(currentTargets).reduce<Record<string, number>>((acc, [taskId, target]) => {
    if (todayTaskIds.has(taskId)) acc[taskId] = target;
    return acc;
  }, {});

  todayTasks.value.forEach((task) => {
    const hasProgress = (todayLogByTask.value[task.id] || 0) > 0;
    if (!hasProgress || !Object.prototype.hasOwnProperty.call(nextTargets, task.id)) {
      nextTargets[task.id] = latestTargets[task.id] || 0;
    }
  });

  if (sameTargetSnapshot(currentTargets, nextTargets)) return;
  saveLocal({
    ...data.value,
    dailyTargets: {
      ...(data.value.dailyTargets || {}),
      [date]: nextTargets,
    },
  }, options);
}

function plannedDailyTarget(task: Task, targetPhase?: PhaseSchedule) {
  if (!targetPhase) return 0;
  const taskStart = task.startDate || targetPhase.startDate;
  const startDate = todayIso() > taskStart ? todayIso() : taskStart;
  return taskSuggestion(task, targetPhase, startDate);
}

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatStudyWeekRange(startDate: string, endDate: string) {
  const startMonth = Number(startDate.slice(5, 7));
  const startDay = Number(startDate.slice(8, 10));
  const endMonth = Number(endDate.slice(5, 7));
  const endDay = Number(endDate.slice(8, 10));
  return `${startMonth}月${startDay}日–${endMonth}月${endDay}日`;
}

function shiftStudyWeek(offset: number) {
  const nextNumber = selectedStudyWeekNumber.value + offset;
  if (planStudyWeekOptions.value.some((week) => week.number === nextNumber)) {
    selectedStudyWeekNumber.value = nextNumber;
  }
}

function dateRangeRows(range: TrendRange, allRangeStartDate: string) {
  const today = todayIso();
  const startDate = range === 'all' ? allRangeStartDate : addDays(today, -(Number(range) - 1));
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
  const type = studyTimeExamType(log).trim();
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

function taskLastStudyDate(task: Task) {
  const dates = [
    ...Object.entries(data.value.dailyLogs)
      .filter(([, logs]) => logs.some((log) => log.taskId === task.id && (log.count ?? log.amount ?? 0) > 0))
      .map(([date]) => date),
    ...task.subItems.map((item) => item.completedDate || '').filter(Boolean),
    ...data.value.studyTimeEntries.filter((entry) => entry.taskId === task.id).map((entry) => entry.date),
  ].sort((a, b) => b.localeCompare(a));
  return dates[0] || '';
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
      <div class="cloud-save-status" :class="saveStatusClass">
        <span class="cloud-save-dot" aria-hidden="true"></span>
        <div>
          <strong>{{ saveStatusText }}</strong>
          <p>{{ syncStatusDetail }}</p>
        </div>
      </div>
      <div class="sidebar-note">
        <strong>今日格言</strong>
        <p>{{ todayMotto }}</p>
      </div>
    </header>

    <div v-if="!IS_LOCAL_DEV && isCloudLoading && (!hasCheckedCloudBaseline || isDirty)" class="cloud-refresh-guard" role="status" aria-live="polite">
      <div>
        <span class="cloud-refresh-spinner" aria-hidden="true"></span>
        <strong>正在同步最新进度</strong>
        <p>检查完成前暂时锁定编辑，避免旧页面覆盖新数据。</p>
      </div>
    </div>

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
          <span>距离总计划截止日期</span>
          <strong>{{ activePhaseDeadlineDays }} 天</strong>
        </div>
        <button class="soft-button" type="button" @click="tab = 'settings'">修改计划</button>
      </section>

      <section class="dashboard-card phase-overview">
        <h2>总计划进度</h2>
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
            <p>{{ todayIso() }}，按当前任务或当前轮剩余量动态均摊</p>
          </div>
          <div class="dashboard-title-actions">
            <button
              class="pomodoro-launch"
              :class="{
                'is-running': Boolean(runningPomodoro?.firstStartedAt && !runningPomodoro.paused && !isPomodoroComplete()),
                'is-paused': Boolean(runningPomodoro?.firstStartedAt && runningPomodoro.paused && !isPomodoroComplete())
              }"
              type="button"
              @click="openPomodoro"
            >
              <span class="pomodoro-launch-icon" aria-hidden="true">🍅</span>
              {{ pomodoroLaunchLabel() }}
            </button>
            <button class="primary-action" type="button" @click="tab = 'settings'">更新完成进度</button>
          </div>
        </div>

        <div v-if="activePhaseProgress" class="phase-banner">
          <div>
            <span>当前计划</span>
            <strong>{{ activePhaseProgress.name }}</strong>
            <p>{{ activePhaseProgress.startDate }} 至 {{ activePhaseProgress.endDate }}</p>
          </div>
          <div>
            <span>任务进度</span>
            <div class="progress slim"><span :style="{ width: `${activePhaseProgress.percent}%`, background: activePhaseProgress.accent }" /></div>
            <b>{{ activePhaseProgress.percent }}%</b>
          </div>
          <div>
            <span>计划剩余天数</span>
            <strong>{{ activePhaseProgress.remainingDays }} 天</strong>
          </div>
          <div>
            <span>计划状态</span>
            <strong>{{ activePhaseProgress.status }}</strong>
          </div>
        </div>

        <section v-if="todayMockExams.length" class="mock-day-panel">
          <div><span>今日模考安排</span><h3>{{ todayMockExams.map((exam) => exam.name).join('、') }}</h3><p>模考与常规学习可以并行安排，完成状态不会影响今日任务量。</p></div>
          <div class="mock-day-actions"><button v-for="exam in todayMockExams" :key="exam.id" class="mock-complete-button" :class="{ completed: exam.completed }" type="button" @click="toggleMockExam(exam.phaseId, exam.id)"><Sparkles :size="17" />{{ exam.completed ? '模考已完成' : '标记模考完成' }}</button></div>
        </section>

        <div class="dashboard-table today-table">
          <div class="dashboard-table-head">
            <span>任务</span><span>计时</span><span>今日目标</span><span>今日进度</span><span>总体进度</span><span>状态</span><span>操作</span>
          </div>
          <template v-for="task in activeTodayTaskRows" :key="task.id">
            <div class="dashboard-table-row" :class="{ 'itemized-task-row': task.trackingMode === 'itemized' && isItemizedExpanded(task.id) }">
              <strong class="task-name-cell">
                <span class="task-name-line">{{ taskDisplayName(task) }}<b v-if="task.trackingMode === 'itemized'">背诵型</b></span>
                <small><span class="today-platform-tag" :class="answerPlatformTagClass(task.platform)">{{ task.platform }}</span><b v-if="task.roundModeEnabled" class="round-chip">{{ roundStageLabel(task) }}</b><b v-else-if="task.repeatCount > 1" class="round-chip">第 {{ task.currentRound }} / {{ task.repeatCount }} 遍</b></small>
              </strong>
              <span class="timer-entry-cell">
                <button class="timer-entry-button" :class="{ 'is-running': isTimerRunning('task', task.id), 'is-paused': isTimerPaused('task', task.id) }" type="button" @click="openTimer('task', task.id, taskDisplayName(task))">{{ timerEntryLabel('task', task.id) }}</button>
                <small v-if="savedTimeSeconds('task', task.id) > 0">今日已学 {{ formatDurationText(savedTimeSeconds('task', task.id)) }}</small>
              </span>
              <span class="daily-target-cell">
                {{ task.dailyTarget }} {{ task.trackingMode === 'itemized' ? '篇' : '题' }}
              </span>
              <span class="today-progress-cell" :class="{ boxed: task.trackingMode === 'itemized' }">
                <span class="progress-meta">
                  <strong v-if="task.trackingMode === 'itemized'">今日已完成 {{ task.todayCompleted }} / {{ task.dailyTarget }} 篇</strong>
                  <strong v-else>{{ task.todayCompleted }} / {{ task.dailyTarget }}</strong>
                  <b>{{ task.todayPercent }}%</b>
                </span>
                <span class="progress-track"><i :style="{ width: `${task.todayPercent}%`, background: task.accent }" /></span>
                <small class="progress-support-text">今日剩余 {{ Math.max(0, task.dailyTarget - task.todayCompleted) }} {{ task.trackingMode === 'itemized' ? '篇' : '题' }}</small>
              </span>
              <span class="today-progress-cell overall-progress-cell">
                <span class="progress-meta">
                  <strong>{{ task.progressCompleted }} / {{ task.totalTarget }} {{ task.trackingMode === 'itemized' ? '篇' : '题' }}</strong>
                  <b>{{ task.percent }}%</b>
                </span>
                <span class="progress-track"><i :style="{ width: `${task.percent}%`, background: task.accent }" /></span>
                <small class="progress-support-text">{{ task.roundModeEnabled ? `累计练习 ${task.roundPracticeTotal} 题` : `总剩余 ${Math.max(0, task.totalTarget - task.progressCompleted)} ${task.trackingMode === 'itemized' ? '篇' : '题'}` }}</small>
              </span>
              <em :class="task.todayStatusClass">{{ task.todayStatus }}</em>
              <span class="row-actions">
                <button v-if="task.trackingMode === 'itemized'" class="itemized-open" type="button" @click="toggleItemizedDetails(task.id)">
                  {{ isItemizedExpanded(task.id) ? '收起详情' : '查看详情' }}
                </button>
                <span v-else class="manual-action-group">
                  <span class="manual-stepper">
                    <button type="button" @click="applyManualAmount(task, -1)">
                      <Minus :size="16" stroke-width="2.6" aria-hidden="true" />
                    </button>
                    <input class="manual-input" type="number" min="0" :value="manualAmount(task.id)" @input="setManualAmount(task.id, ($event.target as HTMLInputElement).value)">
                    <button type="button" @click="applyManualAmount(task, 1)">
                      <Plus :size="16" stroke-width="2.6" aria-hidden="true" />
                    </button>
                  </span>
                  <span class="manual-quick-buttons">
                    <button type="button" @click="setManualAmountValue(task.id, 1)">1</button>
                    <button type="button" @click="setManualAmountValue(task.id, 2)">2</button>
                    <button type="button" @click="setManualAmountValue(task.id, task.dailyTarget)">{{ task.dailyTarget }}</button>
                  </span>
                  <button v-if="task.roundModeEnabled && task.roundCompleted >= task.roundTarget" class="round-complete-button" type="button" @click="openRoundAdvance(task)">{{ task.roundStage === 3 ? '进入第 4 轮' : '完成本轮' }}</button>
                </span>
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
                    <label v-if="task.reviewEnabled" class="done-review-picker">
                      <input
                        type="checkbox"
                        :checked="isReviewSubItemSelected(task.id, item.id)"
                        @change="toggleReviewSubItem(task.id, item.id, ($event.target as HTMLInputElement).checked)"
                      >
                      选中
                    </label>
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
                        <label v-if="task.reviewEnabled" class="done-review-picker">
                          <input
                            type="checkbox"
                            :checked="isReviewSubItemSelected(task.id, item.id)"
                            @change="toggleReviewSubItem(task.id, item.id, ($event.target as HTMLInputElement).checked)"
                          >
                          选中
                        </label>
                      </article>
                    </div>
                  </div>
                </details>
                <div v-if="task.reviewEnabled && completedSubItems(task).length" class="itemized-review-actions review-register-actions">
                  <span>已选 {{ selectedReviewItemIds(task.id).length }} 篇</span>
                  <button class="review-register-cancel" type="button" @click="clearReviewSubItemSelection(task.id)">清空</button>
                  <button class="review-register-cancel" type="button" :disabled="selectedReviewItemIds(task.id).length === 0" @click="addSelectedSubItemsToTodayReview(task)">加入今日复习</button>
                  <button class="review-register-save" type="button" :disabled="selectedReviewItemIds(task.id).length === 0" @click="addSelectedSubItemsToTomorrowReview(task)">加入明日复习</button>
                </div>
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
            <div v-if="shouldShowTomorrowReviewRegister(task)" class="review-register-panel">
              <div>
                <strong>登记明日复习量</strong>
                <span v-if="tomorrowReviewTargetForTask(task.id) > 0">已登记 {{ tomorrowReviewTargetForTask(task.id) }} 题</span>
                <span v-else>填入明天需要复习的错题量，不计入主任务进度。</span>
              </div>
              <div class="review-register-actions">
                <input type="number" min="0" :value="reviewAmount(task.id)" @input="setReviewAmount(task.id, ($event.target as HTMLInputElement).value)">
                <button class="review-register-cancel" type="button" @click="cancelTomorrowReviewRegistration(task)">取消</button>
                <button class="review-register-save" type="button" @click="setTomorrowReview(task)">保存</button>
              </div>
            </div>
          </template>
          <div v-if="activeTodayTaskRows.length === 0" class="empty-row">今天还没有待完成任务。</div>
        </div>

        <div class="today-footer">
          <span>今日总任务量：{{ todayTarget }} 题/篇</span>
          <span>今日完成率：{{ todayPercent }}%</span>
        </div>

        <section v-if="completedOverallTaskRows.length" class="completed-task-module">
          <div class="completed-task-heading">
            <div>
              <h3>已完成与已清零</h3>
              <p>普通任务完成或轮刷清零后会收纳在这里，等待你决定下一步。</p>
            </div>
            <strong>{{ completedOverallTaskRows.length }} 项</strong>
          </div>
          <div class="completed-task-list">
            <div v-for="task in completedOverallTaskRows" :key="`completed-${task.id}`" class="completed-task-item" :style="{ '--task-accent': task.accent }">
              <article class="completed-task-row">
                <strong class="task-name-cell">
                  <span class="task-name-line">{{ taskDisplayName(task) }}<b v-if="task.trackingMode === 'itemized'">背诵型</b></span>
                  <small><span class="today-platform-tag" :class="answerPlatformTagClass(task.platform)">{{ task.platform }}</span><b v-if="task.roundModeEnabled" class="round-chip">{{ roundStageLabel(task) }}</b><b v-else-if="task.repeatCount > 1" class="round-chip">第 {{ task.currentRound }} / {{ task.repeatCount }} 遍</b></small>
                </strong>
                <span class="completed-task-metrics">
                  <span class="today-progress-cell overall-progress-cell">
                    <span class="progress-meta">
                      <strong v-if="task.roundModeEnabled">累计练习 {{ task.roundPracticeTotal }} 题</strong>
                      <strong v-else>{{ task.progressCompleted }} / {{ task.totalTarget }} {{ task.trackingMode === 'itemized' ? '篇' : '题' }}</strong>
                      <b>{{ task.percent }}%</b>
                    </span>
                    <span class="progress-track"><i :style="{ width: `${task.percent}%`, background: task.accent }" /></span>
                    <span v-if="task.todayCompleted > 0" class="completed-task-today">
                      <small>今日完成</small>
                      <strong>{{ task.todayCompleted }} {{ task.trackingMode === 'itemized' ? '篇' : '题' }}</strong>
                    </span>
                    <span v-else-if="task.completedDate" class="completed-task-today">
                      <small>完成于</small>
                      <strong>{{ task.completedDate }}</strong>
                    </span>
                  </span>
                  <span class="completed-task-state">
                    <em class="completed-task-status status-ok">{{ task.roundModeEnabled ? '本轮已清零' : '已结束' }}</em>
                    <button v-if="task.roundModeEnabled" class="completed-task-restore" type="button" title="重新全量开始" @click="restartRoundCycle(task)">
                      <RotateCcw :size="15" stroke-width="2.5" aria-hidden="true" />
                      <span>重新全量</span>
                    </button>
                    <button v-else class="completed-task-restore" type="button" title="修正完成数量" @click="openCorrectionModal(task)">
                      <RotateCcw :size="15" stroke-width="2.5" aria-hidden="true" />
                      <span>恢复</span>
                    </button>
                  </span>
                </span>
              </article>
              <div v-if="shouldShowTomorrowReviewRegister(task)" class="review-register-panel completed-review-register">
                <div>
                  <strong>登记明日复习量</strong>
                  <span v-if="tomorrowReviewTargetForTask(task.id) > 0">已登记 {{ tomorrowReviewTargetForTask(task.id) }} 题</span>
                  <span v-else>填入明天需要复习的错题量，不计入主任务进度。</span>
                </div>
                <div class="review-register-actions">
                  <input type="number" min="0" :value="reviewAmount(task.id)" @input="setReviewAmount(task.id, ($event.target as HTMLInputElement).value)">
                  <button class="review-register-cancel" type="button" @click="cancelTomorrowReviewRegistration(task)">取消</button>
                  <button class="review-register-save" type="button" @click="setTomorrowReview(task)">保存</button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </section>

      <section class="dashboard-card review-today-card">
        <div class="dashboard-title">
          <div>
            <h2>复习任务</h2>
            <p>复习量独立记录，不计入主任务完成率。</p>
          </div>
          <div class="review-title-metrics">
            <span>今日待复习 <strong>{{ todayReviewPlanDone }} / {{ todayReviewTarget }}</strong></span>
            <span>明日待复习 <strong>{{ tomorrowReviewTarget }}</strong></span>
          </div>
        </div>
        <div class="review-columns">
          <div class="review-add-panel">
            <div class="review-add-copy">
              <strong>新增复习计划</strong>
              <span>背诵型复习请到对应题型详情里勾选已完成篇目。</span>
            </div>
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
                  <option v-for="task in countReviewEnabledTasks" :key="task.id" :value="task.id">{{ taskDisplayName(task) }}</option>
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
              <article v-for="plan in todayReviewPlans" :key="plan.id" class="review-task-card" :class="{ 'itemized-review-card': isItemizedReviewPlan(plan) }">
                <div class="review-card-head">
                  <div class="review-card-info">
                    <div class="review-card-titleline">
                      <strong>{{ reviewPlanTaskName(plan) }}</strong>
                      <button class="timer-entry-button compact" type="button" @click="openTimer('review', plan.id, reviewPlanTaskName(plan), plan.taskId)">{{ timerEntryLabel('review', plan.id) }}</button>
                      <small v-if="savedTimeSeconds('review', plan.id) > 0" class="review-saved-time">今日已学 {{ formatDurationText(savedTimeSeconds('review', plan.id)) }}</small>
                    </div>
                  </div>
                  <div class="review-card-meta">
                    <small>{{ plan.sourceDate === todayIso() ? '今日手动添加' : `${plan.sourceDate} 登记` }}</small>
                    <span class="review-status" :class="plan.completed >= plan.target ? 'status-ok' : plan.overdue ? 'status-overdue' : 'status-warn'">{{ plan.completed >= plan.target ? '已完成' : plan.overdue ? '已逾期' : '待完成' }}</span>
                  </div>
                </div>
                <div v-if="isItemizedReviewPlan(plan)" class="review-card-body itemized-review-card-body">
                  <span class="today-progress-cell review-progress-cell">
                    <span class="progress-meta"><strong>{{ plan.completed }} / {{ plan.target }} 篇</strong><b>{{ pct(plan.completed, plan.target) }}%</b></span>
                    <span class="progress-track"><i :style="{ width: `${pct(plan.completed, plan.target)}%`, background: '#7a3ed2' }" /></span>
                  </span>
                  <div class="review-subitem-list">
                    <div v-for="item in reviewPlanSubItems(plan)" :key="item.id" class="review-subitem-row">
                      <input
                        type="checkbox"
                        :checked="isReviewPlanSubItemDone(plan, item.id)"
                        @change="toggleReviewPlanSubItem(reviewPlanDate(plan), plan, item.id, ($event.target as HTMLInputElement).checked)"
                      >
                      <span>{{ item.title }}</span>
                      <select
                        class="review-familiarity-select"
                        :value="item.familiarity"
                        @change="updateReviewSubItemFamiliarity(plan.taskId, item.id, ($event.target as HTMLSelectElement).value as Familiarity)"
                      >
                        <option v-for="familiarity in familiarityOptions" :key="familiarity" :value="familiarity">{{ familiarity }}</option>
                      </select>
                    </div>
                  </div>
                  <button class="text-danger-button" type="button" @click="deleteReviewPlan(reviewPlanDate(plan), plan.id)">删除</button>
                </div>
                <div v-else class="review-card-body">
                  <label class="review-target-input">计划
                    <input type="number" min="0" :value="plan.target" @input="setReviewTarget(reviewPlanDate(plan), plan, ($event.target as HTMLInputElement).value)">
                  </label>
                  <span class="today-progress-cell review-progress-cell">
                    <span class="progress-meta"><strong>{{ plan.completed }} / {{ plan.target }} 题</strong><b>{{ pct(plan.completed, plan.target) }}%</b></span>
                    <span class="progress-track"><i :style="{ width: `${pct(plan.completed, plan.target)}%`, background: '#7a3ed2' }" /></span>
                  </span>
                  <div class="row-actions review-actions">
                    <button type="button" @click="addReviewProgress(reviewPlanDate(plan), plan, -reviewAmount(plan.id))">
                      <Minus :size="16" stroke-width="2.6" aria-hidden="true" />
                    </button>
                    <input class="manual-input" type="number" min="0" :value="reviewAmount(plan.id)" @input="setReviewAmount(plan.id, ($event.target as HTMLInputElement).value)">
                    <button type="button" @click="addReviewProgress(reviewPlanDate(plan), plan, reviewAmount(plan.id))">
                      <Plus :size="16" stroke-width="2.6" aria-hidden="true" />
                    </button>
                  </div>
                  <button class="text-danger-button" type="button" @click="deleteReviewPlan(reviewPlanDate(plan), plan.id)">删除</button>
                </div>
              </article>
            </div>
            <p v-else class="muted">今天没有待复习任务。可以手动添加，或使用昨天登记的明日复习。</p>
          </section>
          <section>
            <h3>明日复习计划</h3>
            <div v-if="tomorrowReviewPlans.length" class="review-list compact">
              <article v-for="plan in tomorrowReviewPlans" :key="plan.id" :class="{ 'tomorrow-itemized-review-row': isItemizedReviewPlan(plan) }">
                <div>
                  <strong>{{ reviewPlanTaskName(plan) }}</strong>
                  <small>{{ plan.sourceDate === todayIso() ? '今日登记给明天' : `${plan.sourceDate} 登记` }}</small>
                </div>
                <div v-if="isItemizedReviewPlan(plan)" class="tomorrow-review-items">
                  <span v-for="item in reviewPlanSubItems(plan)" :key="item.id">{{ item.title }}</span>
                </div>
                <label v-if="!isItemizedReviewPlan(plan)" class="review-target-input">计划
                  <input type="number" min="0" :value="plan.target" @input="setReviewTarget(addDays(todayIso(), 1), plan, ($event.target as HTMLInputElement).value)">
                </label>
                <span v-else class="review-itemized-count">{{ plan.target }} 篇</span>
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
          <div class="progress-detail-filters">
            <label class="shelved-progress-toggle">
              <input v-model="showShelvedProgress" type="checkbox">
              包含暂不安排
            </label>
          </div>
        </div>
        <div class="dashboard-table detail-table">
          <div class="dashboard-table-head">
            <span>任务名称</span><span>权重</span><span>频率类型</span><span>轮次</span><span>已完成 / 目标</span><span>进度</span><span>总练习时长</span><span>剩余</span><span>状态</span>
          </div>
          <div v-for="task in filteredTaskProgressRows" :key="task.id" class="dashboard-table-row">
            <strong>{{ task.name }}</strong>
            <span>{{ task.priorityScore ? `${task.priorityScore}%` : '-' }}</span>
            <span>{{ task.frequencyType }}</span>
            <span>{{ task.roundModeEnabled ? roundStageLabel(task) : task.repeatCount > 1 ? `第 ${task.currentRound} / ${task.repeatCount} 遍` : '-' }}</span>
            <span>{{ task.progressCompleted }} / {{ task.totalTarget }}</span>
            <span class="inline-progress"><span class="progress-track"><i :style="{ width: `${task.percent}%`, background: task.accent }" /></span><b>{{ task.percent }}%</b></span>
            <span>{{ formatDurationCompact(task.totalStudySeconds) }}</span>
            <span>{{ task.remaining }} 题</span>
            <em class="detail-progress-status" :class="task.statusClass">{{ task.status }}</em>
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
          <div class="hero-progress-overview">
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
          </div>
          <div class="study-investment-card">
            <div class="study-investment-summary">
              <div class="study-investment-head">
                <span>学习投入总览</span>
                <strong>{{ formatDurationCompact(totalTrackedStudySeconds) }}</strong>
                <small>累计学习</small>
              </div>
              <div class="peak-study-day">
                <span>最高学习日</span>
                <strong>{{ peakStudyDay.date || '--' }}</strong>
                <b>{{ peakStudyDay.seconds > 0 ? formatDurationCompact(peakStudyDay.seconds) : '暂无计时' }}</b>
              </div>
            </div>
          </div>
          <div class="study-type-time-block">
            <div class="study-type-time-head">
              <div class="study-type-time-title">
                <span>{{ studyTypeTimeRange === 'week' && selectedStudyWeek ? `计划第 ${selectedStudyWeek.number} 周题型计时` : '已学习的题型总计时' }}</span>
                <strong>{{ studyTypeTimeRange === 'week' ? '本周总计' : '总计' }} {{ formatDurationCompact(displayedStudyTypeTotalSeconds) }}</strong>
              </div>
              <div class="study-week-picker" :class="{ 'all-time': studyTypeTimeRange === 'all' }">
                <template v-if="studyTypeTimeRange === 'week' && selectedStudyWeek">
                  <button
                    type="button"
                    title="上一周"
                    aria-label="查看上一周"
                    :disabled="selectedStudyWeek.number <= 1"
                    @click="shiftStudyWeek(-1)"
                  >
                    <ChevronLeft :size="18" stroke-width="2.5" aria-hidden="true" />
                  </button>
                  <label class="study-week-select">
                    <select v-model.number="selectedStudyWeekNumber" aria-label="选择计划周">
                      <option v-for="week in planStudyWeekOptions" :key="week.number" :value="week.number">
                        计划第 {{ week.number }} 周（{{ formatStudyWeekRange(week.startDate, week.endDate) }}）
                      </option>
                    </select>
                    <ChevronDown :size="16" stroke-width="2.4" aria-hidden="true" />
                  </label>
                  <button
                    type="button"
                    title="下一周"
                    aria-label="查看下一周"
                    :disabled="selectedStudyWeek.number >= planStudyWeekOptions.length"
                    @click="shiftStudyWeek(1)"
                  >
                    <ChevronRight :size="18" stroke-width="2.5" aria-hidden="true" />
                  </button>
                </template>
              </div>
              <div class="segmented compact study-type-range-switch">
                <button type="button" :class="{ active: studyTypeTimeRange === 'week' }" @click="studyTypeTimeRange = 'week'">按周</button>
                <button type="button" :class="{ active: studyTypeTimeRange === 'all' }" @click="studyTypeTimeRange = 'all'">全部</button>
              </div>
            </div>
            <div ref="studyTypeChartEl" class="study-type-echarts" role="img" aria-label="各题型学习时长柱状图" />
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
                <button class="practice-item-delete" type="button" title="删除今日练习记录" :aria-label="`删除 ${item.type} 的今日练习记录`" @click="deleteTodayPracticeItem(item.id)">
                  <Trash2 :size="16" stroke-width="2.4" aria-hidden="true" />
                </button>
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
          <div class="time-average-note">
            <span>{{ showPlanAverageStudyTime ? '本计划开始至今' : '全部学习记录' }}，平均每天学习</span>
            <strong>{{ formatDurationCompact(displayedAverageStudySeconds) }}</strong>
            <button class="time-average-toggle" type="button" @click="showPlanAverageStudyTime = !showPlanAverageStudyTime">
              {{ showPlanAverageStudyTime ? '查看全部平均' : '查看本计划平均' }}
            </button>
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
              <button
                class="copy-time-type-button"
                :class="{ copied: copiedCheckInKey === `type:${row.type}` }"
                type="button"
                :title="copiedCheckInKey === `type:${row.type}` ? '已复制' : `复制 ${row.type} 时长`"
                :aria-label="copiedCheckInKey === `type:${row.type}` ? `${row.type} 时长已复制` : `复制 ${row.type} 时长`"
                @click="copyExamTypeCheckIn(row.type, row.seconds)"
              >
                <Check v-if="copiedCheckInKey === `type:${row.type}`" :size="16" stroke-width="2.6" aria-hidden="true" />
                <Copy v-else :size="16" stroke-width="2.3" aria-hidden="true" />
              </button>
            </article>
            <p v-if="timeByExamTypeRows.length === 0" class="soft-empty">今天还没有学习时长记录。</p>
          </div>
          <div class="time-log-block">
            <div class="chart-head">
              <h3>今日添加记录</h3>
              <button v-if="recentTodayTimeEntries.length > 5" class="text-button expand-button" type="button" @click="showAllTimeEntries = !showAllTimeEntries">
                {{ showAllTimeEntries ? '收起' : '展开全部' }}
              </button>
              <button class="copy-checkin-button" type="button" :disabled="!todayCheckInText" @click="copyTodayCheckIn">
                <ClipboardList :size="15" stroke-width="2.4" aria-hidden="true" />
                {{ copiedCheckInKey === 'all' ? '已复制' : '复制打卡' }}
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
                <span class="type-badge time-log-type" :style="{ color: taskTypeColor(studyTimeExamType(log)), background: taskTypeSoftColor(studyTimeExamType(log)) }">{{ studyTimeExamType(log) }}</span>
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

        <section class="panel progress-module practice-report-card">
          <div class="practice-report-top">
            <div class="practice-report-title">
              <span class="practice-report-title-icon">
                <ClipboardList :size="24" stroke-width="2.4" aria-hidden="true" />
              </span>
              <div>
                <h2>练习日报</h2>
                <p>按日期查看题型练习量、学习时长和当天计时记录。</p>
              </div>
            </div>
            <div class="practice-report-controls">
              <div class="segmented compact report-day-tabs">
                <button
                  v-for="item in practiceReportQuickDates"
                  :key="item.label"
                  type="button"
                  :class="{ active: practiceReportDate === item.date }"
                  @click="practiceReportDate = item.date"
                >
                  {{ item.label }}
                </button>
              </div>
              <label class="report-date-picker">
                <CalendarDays :size="17" stroke-width="2.4" aria-hidden="true" />
                <span>{{ practiceReportDisplayDate }}</span>
                <input v-model="practiceReportDate" type="date" aria-label="选择练习日报日期">
                <ChevronDown :size="15" stroke-width="2.5" aria-hidden="true" />
              </label>
            </div>
          </div>

          <div class="practice-report-hero">
            <article class="report-stat-card purple">
              <span class="report-stat-icon"><CalendarDays :size="24" stroke-width="2.4" aria-hidden="true" /></span>
              <div>
                <span>练习日期</span>
                <strong>{{ practiceReportDate }}</strong>
              </div>
            </article>
            <article class="report-stat-card blue">
              <span class="report-stat-icon"><PencilLine :size="24" stroke-width="2.4" aria-hidden="true" /></span>
              <div>
                <span>练习量</span>
                <strong>{{ practiceReportTotals.totalCount }} <small>题</small></strong>
              </div>
            </article>
            <article class="report-stat-card green">
              <span class="report-stat-icon"><Clock :size="24" stroke-width="2.4" aria-hidden="true" /></span>
              <div>
                <span>学习时长</span>
                <strong>{{ formatDurationCompact(practiceReportTotals.totalSeconds) }}</strong>
              </div>
            </article>
            <article class="report-stat-card orange">
              <span class="report-stat-icon"><TrendingUp :size="24" stroke-width="2.4" aria-hidden="true" /></span>
              <div>
                <span>题型数</span>
                <strong>{{ practiceReportTotals.typeCount }} <small>类</small></strong>
              </div>
            </article>
          </div>

          <div class="practice-report-record-panel">
            <div class="practice-report-record-head">
              <div>
                <TrendingUp :size="20" stroke-width="2.4" aria-hidden="true" />
                <h3>题型练习记录</h3>
              </div>
            </div>

            <div v-if="practiceReportRows.length" class="practice-report-type-list">
              <article
                v-for="row in practiceReportRows"
                :key="row.type"
                :style="{ '--type-color': row.color, '--type-soft': row.softColor }"
              >
                <span class="type-badge">{{ row.type }}</span>
                <div>
                  <strong>{{ row.totalCount }} 题</strong>
                  <small>主 {{ row.mainCount }} · 复习 {{ row.reviewCount > 0 ? row.reviewCount : '--' }}</small>
                </div>
                <span class="report-row-time">
                  <Clock :size="16" stroke-width="2.4" aria-hidden="true" />
                  <b>{{ formatDurationCompact(row.totalSeconds) }}</b>
                </span>
              </article>
            </div>
            <p v-else class="soft-empty">这一天还没有练习量或学习时长记录。</p>
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
            <p>用一个总计划管理备考周期、模考安排和各题型的独立进度。</p>
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
            <p><span>已学习 {{ planElapsedDays }} 天</span><span>剩余 {{ planRemainingDays }} 天</span></p>
          </div>
        </div>
        <div v-if="activeRoundTaskCount" class="today-target-refresh round-plan-recalculate">
          <div>
            <strong>轮刷日期需要手动重算</strong>
            <p>修改计划周期、任务日期等数据后，点击按钮按今天至最新截止日重新排列完整轮次；当前第 2 轮会排在新的第 1 轮节点之后。</p>
          </div>
          <button type="button" @click="recalculateRoundPlanDates">重新计算轮刷日期</button>
        </div>

        <div class="section-heading settings-phase-heading">
          <div class="settings-subheading">
            <Flag :size="18" stroke-width="2.4" aria-hidden="true" />
            <h3>模考安排</h3>
          </div>
        </div>
        <div v-for="item in phaseProgress" :key="item.id" class="phase-mock-exams">
          <div class="phase-mock-exam-form">
            <input v-model="mockExamDateDrafts[item.id]" type="date" :min="item.startDate" aria-label="模考日期">
            <input v-model="mockExamNameDrafts[item.id]" type="text" placeholder="模考名称（可选）" aria-label="模考名称">
            <button type="button" @click="addMockExam(item)">+ 添加</button>
            <span class="mock-exam-count">已安排 {{ item.mockExams?.length || 0 }} 次</span>
          </div>
          <div v-if="item.mockExams?.length" class="phase-mock-exam-list">
            <article v-for="exam in item.mockExams" :key="exam.id" :class="{ completed: exam.completed }">
              <button class="mock-exam-check" type="button" :title="exam.completed ? '标记未完成' : '标记完成'" @click="toggleMockExam(item.id, exam.id)">{{ exam.completed ? '✓' : '' }}</button>
              <time>{{ exam.date }}</time><strong>{{ exam.name }}</strong>
              <button class="mock-exam-delete" type="button" title="删除模考安排" @click="deleteMockExam(item.id, exam.id)"><Trash2 :size="14" /></button>
            </article>
          </div>
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
              <h3>题型任务</h3>
              <p>{{ group.phase.startDate }} ~ {{ group.phase.endDate }}，所有题型独立推进</p>
            </div>
            <div class="phase-task-actions">
              <button class="ghost strong weight-sort-button" type="button" :disabled="group.tasks.length < 2" @click="sortPhaseTasksByPriority(group.phase.id)">按权重排序</button>
              <button class="ghost strong purple-soft-button" type="button" @click="addTask(group.phase.id)">+ 新增任务</button>
            </div>
          </div>
          <div v-if="shouldShowTodayTargetRefreshForPhase(group.phase.id)" class="today-target-refresh settings-target-refresh">
            <div>
              <strong>今日目标可能已过期</strong>
              <p>{{ todayTargetRefreshSummaryForPhase(group.phase.id) }}。已有进度的任务不会自动变化，可在这里按最新计划手动刷新。</p>
            </div>
            <button type="button" @click="refreshTodayTargets()">刷新今日目标</button>
          </div>
          <div class="task-table settings-task-table">
            <div class="task-table-head">
              <span>任务</span><span>平台</span><span>频率</span><span>记录</span><span>任务日期</span><span>复习</span><span>题库量</span><span>重复</span><span>轮刷</span><span>完成</span><span>建议</span><span>操作</span>
            </div>
            <div v-for="task in group.tasks" :key="task.id" class="task-table-row" :class="{ 'is-completed': isTaskCompletedOverall(task) }">
              <label class="select-control table-select task-type-select table-field" data-label="任务">
                <select :value="task.name" @change="updateTask(task.id, { name: ($event.target as HTMLSelectElement).value })">
                  <option v-if="!examTypeOptions.includes(task.name)" :value="task.name">{{ task.name }}</option>
                  <option v-for="type in examTypeOptions" :key="type" :value="type">{{ examTypeOptionLabel(type) }}</option>
                </select>
                <ChevronDown class="select-control-icon" :size="15" stroke-width="2.4" aria-hidden="true" />
              </label>
              <label class="select-control table-select table-field" data-label="平台">
                <select
                  :value="task.platform"
                  :disabled="isTaskCompletedOverall(task)"
                  :title="isTaskCompletedOverall(task) ? '已完成任务不能直接切换平台，请新增任务' : '有进度时切换平台会保留原任务并创建新任务'"
                  @change="handleTaskPlatformChange(task, $event)"
                >
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
                <select :value="task.trackingMode" :disabled="task.roundModeEnabled" @change="updateTask(task.id, { trackingMode: ($event.target as HTMLSelectElement).value as TrackingMode })">
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
                <span v-else>跟随总计划</span>
              </div>
              <label class="review-toggle table-field" data-label="复习">
                <input type="checkbox" :checked="task.reviewEnabled" @change="updateTask(task.id, { reviewEnabled: ($event.target as HTMLInputElement).checked })">
                开启
              </label>
              <label class="table-field number-field" data-label="题库量">
                <input type="number" :value="task.target || ''" :disabled="task.roundModeEnabled" @input="updateTask(task.id, { target: Number(($event.target as HTMLInputElement).value) })">
              </label>
              <label class="table-field number-field" data-label="重复">
                <input
                  v-if="task.trackingMode === 'count_only' && !task.roundModeEnabled"
                  type="number"
                  min="1"
                  max="99"
                  :value="task.repeatCount"
                  title="全题库重复遍数，不进行错题筛选"
                  @input="updateTask(task.id, { repeatCount: Number(($event.target as HTMLInputElement).value) })"
                >
                <span v-else class="round-mode-unavailable">—</span>
              </label>
              <div class="table-field round-mode-control" data-label="轮刷">
                <span v-if="task.trackingMode === 'itemized'" class="round-mode-unavailable">背诵不适用</span>
                <button v-else-if="!task.roundModeEnabled" class="round-mode-enable" type="button" @click="openRoundSetup(task)">手动开启</button>
                <span v-else class="round-mode-active"><b>第 {{ task.roundStage }} 轮</b><button type="button" @click="disableRoundMode(task)">关闭</button></span>
              </div>
              <label class="table-field number-field" data-label="完成">
                <input
                  v-if="!task.roundModeEnabled"
                  type="number"
                  :value="task.completed"
                  :disabled="task.trackingMode === 'itemized' && task.subItems.length > 0"
                  @input="updateTask(task.id, { completed: Number(($event.target as HTMLInputElement).value) })"
                >
                <span v-else class="round-progress-mini">{{ task.roundCompleted }} / {{ task.roundTarget }}</span>
              </label>
              <strong class="suggestion-cell table-field" data-label="建议">{{ plannedDailyTarget(task, group.phase) }}</strong>
              <div class="action-cell table-field" data-label="操作">
                <button v-if="!isTaskCompletedOverall(task)" class="shelve-task-button" type="button" @click="shelveTask(task)">暂不安排</button>
                <button class="icon-button" type="button" @click="deleteTask(task.id)">删除</button>
              </div>
            </div>
            <section v-for="task in group.tasks.filter((item) => item.roundModeEnabled)" :key="`${task.id}-rounds`" class="round-plan-detail">
              <div class="round-plan-summary">
                <div><strong>{{ task.name }} · {{ roundStageLabel(task) }}</strong><span>本轮 {{ task.roundCompleted }} / {{ task.roundTarget }} 题 · 累计练习 {{ task.roundPracticeTotal }} 题<template v-if="task.roundStageEndDate"> · 计划 {{ task.roundStageEndDate }} 前完成</template></span><p>{{ roundInstruction(task) }}</p></div>
                <button v-if="task.roundCompleted >= task.roundTarget" type="button" @click="openRoundAdvance(task)">{{ task.roundStage === 3 ? '进入第 4 轮' : '完成本轮' }}</button>
              </div>
              <details v-if="task.roundHistory.length" class="round-history-list">
                <summary>查看轮刷历史（{{ task.roundHistory.length }}）</summary>
                <div v-for="entry in [...task.roundHistory].reverse()" :key="entry.id">
                  <span>{{ roundHistoryLabel(entry) }}</span>
                  <strong>{{ entry.completed }} / {{ entry.target }}</strong>
                  <b>{{ entry.remainingMarked === undefined ? '题量保持' : `剩余标记 ${entry.remainingMarked}` }}</b>
                  <time>{{ entry.completedAt.slice(0, 10) }}</time>
                </div>
              </details>
            </section>
            <details v-for="task in group.tasks.filter((item) => item.trackingMode === 'itemized')" :key="`${task.id}-items`" class="subitem-manager">
              <summary class="subitem-manager-summary">
                <span class="subitem-summary-title">
                  <strong>{{ task.name }} 子项目</strong>
                  <small>{{ task.subItems.length }} 个子项目</small>
                </span>
                <span class="subitem-summary-action">
                  编辑子项目
                  <ChevronDown :size="18" stroke-width="2.5" aria-hidden="true" />
                </span>
              </summary>
              <div class="subitem-manager-content">
                <div class="subitem-toolbar">
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
            </details>
            <p v-if="group.tasks.length === 0" class="muted">总计划暂无进行中的任务。新增任务后会只记录每日完成进度，不保存题库内容。</p>
          </div>
        </div>
        <details v-if="completedSettingsTasks.length" class="shelved-task-section completed-settings-section">
          <summary>
            <span><Check :size="18" stroke-width="2.7" aria-hidden="true" />已完成</span>
            <b>{{ completedSettingsTasks.length }}</b>
            <small>普通任务完成或轮刷清零后会收纳在这里</small>
          </summary>
          <div class="shelved-task-list completed-settings-list">
            <article v-for="task in completedSettingsTasks" :key="task.id" class="shelved-task-row completed-settings-row">
              <div class="shelved-task-name">
                <strong>{{ task.name }}</strong>
                <span>{{ task.platform }} · {{ task.frequencyType }}<template v-if="task.roundModeEnabled"> · {{ roundStageLabel(task) }}</template></span>
              </div>
              <div class="shelved-task-progress">
                <span>{{ task.roundModeEnabled ? '累计练习' : '总进度' }}</span>
                <strong>{{ task.roundModeEnabled ? `${task.roundPracticeTotal} 题` : `${task.progressCompleted} / ${task.totalTarget}` }}</strong>
                <span class="progress-track"><i style="width: 100%" /></span>
              </div>
              <div class="shelved-task-last-study">
                <span>完成时间</span>
                <strong>{{ task.completedDate || '未记录日期' }}</strong>
              </div>
              <div class="shelved-task-actions">
                <button v-if="task.roundModeEnabled" class="completed-settings-restore-button" type="button" @click="restartRoundCycle(task)">重新全量开始</button>
                <button v-else class="completed-settings-restore-button" type="button" @click="restoreCompletedTask(task)">重新纳入计划</button>
                <button class="delete-shelved-task-button" type="button" @click="deleteTask(task.id)">删除</button>
              </div>
            </article>
          </div>
        </details>
        <details v-if="shelvedTasks.length" class="shelved-task-section">
          <summary>
            <span><Pause :size="18" stroke-width="2.5" aria-hidden="true" />暂不安排</span>
            <b>{{ shelvedTasks.length }}</b>
            <small>不参与每日任务、动态均摊和默认进度统计</small>
          </summary>
          <div class="shelved-task-list">
            <article v-for="task in shelvedTasks" :key="task.id" class="shelved-task-row">
              <div class="shelved-task-name">
                <strong>{{ task.name }}</strong>
                <span>{{ task.platform }} · {{ task.frequencyType }}</span>
              </div>
              <div class="shelved-task-progress">
                <span>已完成</span>
                <strong>{{ taskProgressCompleted(task) }} / {{ taskTotalTarget(task) }}</strong>
                <span class="progress-track"><i :style="{ width: `${pct(taskProgressCompleted(task), taskTotalTarget(task))}%` }" /></span>
              </div>
              <div class="shelved-task-last-study">
                <span>最近学习</span>
                <strong>{{ taskLastStudyDate(task) || (taskProgressCompleted(task) > 0 ? '未记录日期' : '尚未学习') }}</strong>
              </div>
              <div class="shelved-task-actions">
                <button class="restore-task-button" type="button" @click="openRestoreTaskModal(task)">重新纳入计划</button>
                <button class="delete-shelved-task-button" type="button" @click="deleteTask(task.id)">删除</button>
              </div>
            </article>
          </div>
        </details>
        <p class="hint">提示：普通任务按全部重复遍数的剩余总量均摊；错题轮刷按时间配额推进：第 1 轮使用剩余时间的 1/2，第 2 轮使用 2/5，第 3 轮使用 1/3，第 4 轮每遍使用 1/2 并为继续清零预留时间。</p>
      </section>

      <section class="panel restart-panel">
        <div>
          <h2>重新开始</h2>
          <p>清空本地总计划、任务、每日进度、复习计划、学习时长和备注，重新生成一个新的默认计划。云端数据会在下次自动保存时更新。</p>
        </div>
        <button class="danger-restart-button" type="button" @click="restartStudyPlan">清除所有数据并重新开始</button>
      </section>
    </section>

    <section v-else-if="tab === 'notes'" class="page notes-page">
      <section class="panel notes-panel note-compose-panel">
        <div class="notes-panel-head">
          <div class="notes-title">
            <span class="notes-title-icon"><PencilLine :size="30" /></span>
            <div>
              <h2>{{ editingNoteId ? '编辑备注' : '每日备注' }}</h2>
              <p>按日期、题型保存复盘和提醒，支持 Markdown 文本。</p>
            </div>
          </div>
          <div class="note-meta-controls">
            <label class="note-meta-field">
              <span>日期</span>
              <div>
                <CalendarDays :size="20" />
                <input type="date" :value="selectedNoteDate" @input="selectNoteDate(($event.target as HTMLInputElement).value)">
              </div>
            </label>
          </div>
        </div>

        <div class="note-toolbar" aria-label="Markdown 工具栏">
          <div class="note-toolbar-left">
            <button type="button" title="加粗" @click="formatNote('bold')"><Bold :size="17" /></button>
            <button type="button" title="斜体" @click="formatNote('italic')"><Italic :size="17" /></button>
            <button type="button" title="项目符号" @click="formatNote('insertUnorderedList')"><List :size="18" /></button>
            <button type="button" title="行内代码" @click="formatInlineCode">`</button>
          </div>
          <details class="note-type-picker">
            <summary>
              <BookOpen :size="16" />
              <span>题型</span>
              <strong>{{ selectedNoteExamTypes.length ? selectedNoteExamTypes.length : '选择' }}</strong>
              <ChevronDown :size="15" />
            </summary>
            <div class="note-type-menu">
              <button
                v-for="option in noteExamTypeOptions"
                :key="option"
                type="button"
                :class="{ active: selectedNoteExamTypes.includes(option) }"
                :style="noteTypeStyle(option)"
                @click="toggleNoteExamType(option)"
              >
                {{ option }}
              </button>
            </div>
          </details>
        </div>

        <div class="daily-note-editor rich-note-shell">
          <div
            ref="noteEditorRef"
            class="rich-note-editor"
            contenteditable="true"
            data-placeholder="cause /kɔːz/&#10;course 英 /kɔːs/ 美 /kɔːrs/&#10;worn: wear（过去分词）：穿着"
            @input="syncNoteDraftFromEditor"
            @keydown="handleNoteKeydown"
            @paste="handleNotePaste"
          ></div>
          <div v-if="selectedNoteExamTypes.length" class="note-editor-tags">
            <span
              v-for="type in selectedNoteExamTypes"
              :key="type"
              class="note-type-badge"
              :style="noteTypeStyle(type)"
            >
              {{ type }}
            </span>
          </div>
        </div>

        <div class="note-compose-foot">
          <p><Sparkles :size="18" /> 小贴士：可记录单词、语音重点、错题回顾或明日提醒等内容。</p>
          <div class="panel-actions">
            <button class="ghost" type="button" @click="resetNoteDraft"><X :size="18" />取消</button>
            <button type="button" @click="saveDailyNote"><Save :size="18" />{{ editingNoteId ? '更新备注' : '保存备注' }}</button>
          </div>
        </div>
      </section>

      <section class="panel notes-panel note-history-panel">
        <div class="notes-section-title">
          <BookOpen :size="22" />
          <h2>查看备注</h2>
          <Sparkles :size="18" />
        </div>
        <div v-if="noteRows.length" class="note-list">
          <article v-for="row in noteRows" :key="row.id">
            <div class="note-list-head">
              <div class="note-list-meta">
                <span class="note-date-badge"><CalendarDays :size="18" />{{ row.date }}</span>
                <time>{{ row.time }}</time>
                <span
                  v-for="type in noteExamTypes(row)"
                  :key="type"
                  class="note-type-badge"
                  :style="noteTypeStyle(type)"
                >
                  {{ type }}
                </span>
              </div>
              <div class="note-list-actions">
                <button type="button" title="编辑" @click="editDailyNote(row)"><PencilLine :size="16" />编辑</button>
                <button type="button" title="删除" @click="deleteDailyNote(row.date, row.id)"><Trash2 :size="16" />删除</button>
              </div>
            </div>
            <div class="note-rendered" v-html="renderNoteContent(row.content)"></div>
          </article>
        </div>
        <p v-else class="muted">还没有每日备注。</p>
      </section>
    </section>

    <section v-else-if="tab === 'answers'" class="page answers-page">
      <section class="panel answers-panel answer-compose-panel">
        <div class="answers-panel-head">
          <div class="answers-title">
            <span class="answers-title-icon"><BookOpen :size="30" /></span>
            <div>
              <h2>{{ editingAnswerId ? '编辑答案' : '录入答案' }}</h2>
              <p>保存平台、题号、标题和完整答案，资料会随现有进度自动同步。</p>
            </div>
          </div>
        </div>

        <div class="answer-meta-grid">
          <label>
            <span>题型</span>
            <span class="answer-select-control">
              <select v-model="answerExamType">
                <option v-for="option in answerExamTypeOptions" :key="option" :value="option">{{ option }}</option>
              </select>
              <ChevronDown :size="18" aria-hidden="true" />
            </span>
          </label>
          <label class="answer-title-field">
            <span>答案标题</span>
            <input v-model="answerTitle" type="text" placeholder="例如：城市交通题通用模板">
          </label>
          <label v-for="ref in answerPlatformRefs" :key="ref.platform" class="answer-platform-number">
            <span>{{ ref.platform }}题号</span>
            <input v-model="ref.questionNumber" type="text" :placeholder="`${ref.platform}题号`">
          </label>
        </div>

        <label class="answer-content-field">
          <span>答案内容</span>
          <textarea v-model="answerContent" placeholder="在这里录入完整答案，换行会在导出的 PDF 中保留。"></textarea>
        </label>
        <div class="answer-compose-foot">
          <p><Sparkles :size="18" /> 小贴士：三个平台固定，只需填写各自对应题号。</p>
          <div class="panel-actions">
            <button class="ghost" type="button" :disabled="!answerContent.trim()" @click="optimizeAnswerText"><Sparkles :size="18" />文本优化</button>
            <button class="ghost" type="button" @click="resetAnswerDraft()"><X :size="18" />取消</button>
            <button type="button" @click="saveAnswer"><Save :size="18" />{{ editingAnswerId ? '更新答案' : '保存答案' }}</button>
          </div>
        </div>
      </section>

      <section class="panel answers-panel answer-library-panel">
        <div class="answer-library-head">
          <div>
            <h2>我的答案</h2>
            <p>已显示 {{ answerRows.length }} 条答案</p>
          </div>
          <div class="answer-export-controls">
            <label>
              <span>导出题型</span>
              <span class="answer-select-control">
                <select v-model="exportAnswerType" :disabled="exportAnswerTypeOptions.length === 0">
                  <option v-for="option in exportAnswerTypeOptions" :key="option" :value="option">{{ option }}</option>
                </select>
                <ChevronDown :size="17" aria-hidden="true" />
              </span>
            </label>
            <button class="answer-export-button" type="button" :disabled="exportAnswerTypeOptions.length === 0 || isExportingAnswersPdf" @click="exportAnswersToPdf"><FileDown :size="18" />{{ isExportingAnswersPdf ? '正在生成 PDF…' : `下载 ${exportAnswerType} 答案 PDF` }}</button>
          </div>
        </div>
        <div class="answer-filters">
          <input v-model="answerSearch" :disabled="answerManualSortMode" type="search" placeholder="搜索题号、标题或答案内容">
          <span class="answer-select-control">
            <select v-model="answerTypeFilter" :disabled="answerManualSortMode">
              <option value="全部">全部题型</option>
              <option v-for="option in answerExamTypeOptions" :key="option" :value="option">{{ option }}</option>
            </select>
            <ChevronDown :size="17" aria-hidden="true" />
          </span>
          <span class="answer-select-control">
            <select v-model="answerPlatformFilter" :disabled="answerManualSortMode">
              <option value="全部">全部平台</option>
              <option v-for="option in answerReferencePlatforms" :key="option" :value="option">{{ option }}</option>
            </select>
            <ChevronDown :size="17" aria-hidden="true" />
          </span>
          <button class="answer-sort-button" :class="{ 'is-active': answerManualSortMode }" type="button" @click="toggleAnswerManualSort"><List :size="17" />{{ answerManualSortMode ? '完成排序' : '调整排序' }}</button>
        </div>
        <p v-if="answerManualSortMode" class="answer-sort-hint"><GripVertical :size="16" />正在调整 {{ answerTypeFilter }} 的答案顺序，拖动左侧手柄即可保存。</p>

        <div v-if="answerRows.length" class="answer-list">
          <article v-for="entry in answerRows" :key="entry.id" class="answer-row" :class="{ 'is-sortable': answerManualSortMode, 'is-dragging': draggingAnswerId === entry.id }" @dragover.prevent @drop="dropAnswerAt(entry.id)">
            <span v-if="answerManualSortMode" class="answer-drag-handle" draggable="true" aria-label="拖动调整顺序" @dragstart="startAnswerDrag(entry.id, $event)" @dragend="finishAnswerDrag"><GripVertical :size="21" /></span>
            <div class="answer-row-content">
              <div class="answer-row-meta">
                <span class="answer-exam-type" :style="noteTypeStyle(entry.examType)">{{ entry.examType }}</span>
                <template v-for="ref in entry.platformRefs" :key="`${ref.platform}-${ref.questionNumber}`">
                  <span class="answer-platform-tag" :class="answerPlatformTagClass(ref.platform)">{{ ref.platform }} #{{ ref.questionNumber }}</span>
                </template>
              </div>
              <h3>{{ entry.title }}</h3>
              <p>{{ entry.answer }}</p>
              <time v-if="entry.updatedAt">更新于 {{ new Date(entry.updatedAt).toLocaleString('zh-CN', { hour12: false }) }}</time>
            </div>
            <div class="answer-row-actions">
              <button type="button" @click="editAnswer(entry)"><PencilLine :size="16" />编辑</button>
              <button type="button" @click="deleteAnswer(entry.id)"><Trash2 :size="16" />删除</button>
            </div>
          </article>
        </div>
        <p v-else class="muted answer-empty">还没有符合条件的答案，先录入第一条吧。</p>
      </section>
    </section>

    <div v-if="showTimerModal && runningTimer" class="modal timer-modal">
      <section class="modal-box timer-modal-box">
        <button class="modal-close-button" type="button" title="关闭计时弹窗" @click="closeTimerModal">
          <X :size="30" stroke-width="3" aria-hidden="true" />
        </button>
        <div class="timer-hero">
          <span class="timer-type"><Clock :size="19" stroke-width="2.6" aria-hidden="true" />{{ runningTimer.type === 'review' ? '复习计时' : '任务计时' }}</span>
          <h3>{{ runningTimer.name }}</h3>
          <strong class="timer-display">{{ formatTimerDisplay(currentTimerSeconds()) }}</strong>
          <p>{{ !runningTimer.firstStartedAt ? '尚未开始，点击开始后会记录起点。' : runningTimer.paused ? '已暂停，可以继续计时或修改保存时长。' : '计时中，保存后会写入今天的学习时长。' }}</p>
        </div>
        <div class="timer-body">
          <div class="timer-time-range">
            <span><Clock :size="22" stroke-width="2.6" aria-hidden="true" />计时时段</span>
            <strong>{{ timerPreviewRange(runningTimer) }}</strong>
            <ChevronRight :size="26" stroke-width="2.4" aria-hidden="true" />
          </div>
          <div class="timer-edit-field">
            <span class="timer-edit-title"><i aria-hidden="true"></i>保存时长</span>
            <div class="timer-duration-inputs">
              <label class="timer-duration-card timer-duration-card-hours">
                <span class="timer-duration-icon"><Clock :size="23" stroke-width="2.4" aria-hidden="true" /></span>
                <input
                  type="number"
                  inputmode="numeric"
                  min="0"
                  :value="timerEditPartValue('hours')"
                  aria-label="小时"
                  @input="updateTimerEditPart('hours', ($event.target as HTMLInputElement).value)"
                >
                <small>时</small>
              </label>
              <span class="timer-duration-separator" aria-hidden="true">:</span>
              <label class="timer-duration-card timer-duration-card-minutes">
                <span class="timer-duration-icon"><Clock :size="23" stroke-width="2.4" aria-hidden="true" /></span>
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
              </label>
              <span class="timer-duration-separator" aria-hidden="true">:</span>
              <label class="timer-duration-card timer-duration-card-seconds">
                <span class="timer-duration-icon"><Clock :size="23" stroke-width="2.4" aria-hidden="true" /></span>
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
              </label>
            </div>
          </div>
          <div class="timer-control-row">
            <button class="timer-start-button" type="button" @click="toggleActiveTimer">
              <span class="timer-start-icon">
                <Pause v-if="!runningTimer.paused" :size="25" fill="currentColor" stroke-width="0" aria-hidden="true" />
                <Play v-else :size="25" fill="currentColor" stroke-width="0" aria-hidden="true" />
              </span>
              <span>{{ timerActionLabel() }}</span>
              <small v-if="!runningTimer.firstStartedAt">（点击开始后记录起点）</small>
            </button>
            <button class="timer-restart-button" type="button" @click="resetTimer">
              <RotateCcw :size="25" stroke-width="2.5" aria-hidden="true" />
              <span>重新计时</span>
              <small>清零并重新开始</small>
            </button>
          </div>
        </div>
        <div class="timer-footer-actions">
          <button class="timer-discard-button" type="button" @click="discardRunningTimer">
            <span class="timer-footer-title">
              <Trash2 :size="26" stroke-width="2.4" aria-hidden="true" />
              <span>取消计时</span>
            </span>
            <small>放弃此次计时，不保存记录</small>
          </button>
          <button class="timer-save-button primary" type="button" @click="saveRunningTimer">
            <span class="timer-footer-title">
              <Save :size="27" stroke-width="2.4" aria-hidden="true" />
              <span>保存时长</span>
            </span>
            <small>保存当前时长记录</small>
          </button>
        </div>
      </section>
    </div>

    <div v-if="showPomodoroModal && runningPomodoro" class="modal pomodoro-modal">
      <section class="modal-box pomodoro-modal-box">
        <button class="modal-close-button" type="button" title="关闭番茄钟弹窗" @click="closePomodoroModal">
          <X :size="28" stroke-width="3" aria-hidden="true" />
        </button>
        <div class="pomodoro-hero">
          <span class="pomodoro-type"><Clock :size="18" stroke-width="2.6" aria-hidden="true" />{{ runningPomodoro.stage === 'break' ? '休息时间' : '独立番茄钟' }}</span>
          <h3>{{ runningPomodoro.name }}</h3>
          <strong class="pomodoro-display" :class="{ 'is-complete': isPomodoroComplete() }">{{ formatTimerDisplay(pomodoroRemainingSeconds) }}</strong>
          <p>{{ pomodoroStatusMessage() }}</p>
        </div>

        <div class="pomodoro-body">
          <section class="pomodoro-setting-block">
            <div class="pomodoro-setting-heading">
              <span class="pomodoro-setting-title">专注时长</span>
              <span class="pomodoro-duration-design-label" aria-hidden="true"><Clock :size="15" stroke-width="2.5" />自定义时长</span>
            </div>
            <div class="pomodoro-duration-options">
              <button
                v-for="option in visiblePomodoroDurationOptions"
                :key="option.seconds"
                type="button"
                :class="{ active: runningPomodoro.durationSeconds === option.seconds }"
                :disabled="Boolean(runningPomodoro.firstStartedAt)"
                @click="setPomodoroDuration(option.seconds)"
              >
                <strong>{{ option.value }}</strong>
                <small>{{ option.unit }}</small>
                <span v-if="runningPomodoro.durationSeconds === option.seconds" class="pomodoro-duration-check"><Check :size="12" stroke-width="3.2" aria-hidden="true" /></span>
              </button>
            </div>
          </section>

          <label class="pomodoro-setting-block pomodoro-task-picker">
            <span class="pomodoro-setting-title">今天专注的任务</span>
            <span class="select-control">
              <Save class="pomodoro-task-icon" :size="17" stroke-width="2.4" aria-hidden="true" />
              <select :value="runningPomodoro.taskId" :disabled="Boolean(runningPomodoro.firstStartedAt)" @change="changePomodoroTask(($event.target as HTMLSelectElement).value)">
                <option v-for="task in todayPomodoroTasks" :key="task.id" :value="task.id">
                  {{ task.platform }} · {{ taskDisplayName(task) }}（{{ taskProgressCompleted(task) }}/{{ taskTotalTarget(task) }}）
                </option>
              </select>
              <ChevronDown class="select-control-icon" :size="16" stroke-width="2.5" aria-hidden="true" />
            </span>
          </label>

          <section v-if="pomodoroTask?.trackingMode === 'count_only'" class="pomodoro-setting-block pomodoro-progress-field">
            <span class="pomodoro-setting-title">本次进度（可不填）</span>
            <div class="pomodoro-progress-layout">
              <div class="pomodoro-progress-main">
                <div class="pomodoro-progress-input-row">
                  <div>
                    <span>当前这一遍</span>
                    <strong>{{ taskQuestionProgress(pomodoroTask) }} / {{ taskTotalTarget(pomodoroTask) }}</strong>
                  </div>
                  <label>
                    <span>学到第</span>
                    <input
                      type="number"
                      inputmode="numeric"
                      :min="taskQuestionProgress(pomodoroTask)"
                      :max="taskTotalTarget(pomodoroTask)"
                      :placeholder="String(taskQuestionProgress(pomodoroTask))"
                      :value="pomodoroProgressInput"
                      @input="updatePomodoroProgressInput(($event.target as HTMLInputElement).value)"
                    >
                    <span>题</span>
                  </label>
                </div>
                <p v-if="pomodoroProgressError" class="pomodoro-progress-message error">{{ pomodoroProgressError }}</p>
                <p v-else-if="pomodoroProgressPreview" class="pomodoro-progress-message">{{ pomodoroProgressPreview }}</p>
                <p v-else class="pomodoro-progress-message muted">留空只保存番茄时长；填写后自动更新今日和{{ pomodoroTask.roundModeEnabled ? '当前轮' : '总' }}进度。</p>
              </div>
              <div class="pomodoro-progress-overview" :style="{ '--pomodoro-progress-angle': `${pomodoroProgressPercent * 3.6}deg` }">
                <span>今日进度</span>
                <strong>{{ pomodoroProgressPercent }}%</strong>
                <small>{{ pomodoroTask.roundModeEnabled ? '当前轮' : '全题库' }} {{ taskQuestionProgress(pomodoroTask) }}/{{ taskTotalTarget(pomodoroTask) }}</small>
              </div>
            </div>
          </section>
          <section v-else-if="pomodoroTask" class="pomodoro-setting-block pomodoro-itemized-note">
            <strong>该任务按篇目记录</strong>
            <p>可以保存番茄时长；完成篇目请回到今日任务中勾选。</p>
          </section>

          <div class="pomodoro-control-row">
            <button class="pomodoro-start-button" type="button" :disabled="isPomodoroComplete()" @click="togglePomodoro">
              <span class="pomodoro-start-icon">
                <Pause v-if="!runningPomodoro.paused" :size="23" fill="currentColor" stroke-width="0" aria-hidden="true" />
                <Play v-else :size="23" fill="currentColor" stroke-width="0" aria-hidden="true" />
              </span>
              {{ pomodoroActionLabel() }}
            </button>
            <button class="pomodoro-reset-button" type="button" @click="resetPomodoro">
              <RotateCcw :size="21" stroke-width="2.5" aria-hidden="true" />
              重置番茄钟
            </button>
          </div>
        </div>

        <div class="pomodoro-footer-actions">
          <button class="pomodoro-cancel-button" type="button" @click="cancelPomodoro">
            <Trash2 :size="21" stroke-width="2.4" aria-hidden="true" />
            <span><strong>取消番茄钟</strong><small>不保存本次记录</small></span>
          </button>
          <button class="pomodoro-save-button" type="button" @click="savePomodoro">
            <Save :size="22" stroke-width="2.4" aria-hidden="true" />
            <span>
              <strong>{{ runningPomodoro.focusSaved ? '关闭弹窗' : '保存番茄钟' }}</strong>
              <small>{{ runningPomodoro.focusSaved ? '专注已保存，休息继续计时' : pomodoroTask?.trackingMode === 'count_only' ? '保存时长和可选进度' : '保存本次专注时长' }}</small>
            </span>
          </button>
        </div>
      </section>
    </div>

    <div v-if="roundSetupTask" class="modal">
      <form class="modal-box round-flow-modal" @submit.prevent="submitRoundSetup">
        <button class="modal-close-button" type="button" title="关闭弹窗" @click="closeRoundSetup">×</button>
        <span class="timer-type">手动开启错题轮刷</span>
        <div class="modal-title">
          <h3>{{ roundSetupTask.platform }} · {{ taskDisplayName(roundSetupTask) }}</h3>
          <p>选择你当前要开始的轮次。系统只记录每轮题量，不记录颜色或具体题目。</p>
        </div>
        <div class="round-stage-picker">
          <span>从第几轮开始</span>
          <div>
            <button v-for="stage in ([1, 2, 3, 4] as TaskRoundStage[])" :key="stage" type="button" :class="{ active: roundSetupStage === stage }" @click="selectRoundSetupStage(stage)">第 {{ stage }} 轮</button>
          </div>
        </div>
        <label class="round-flow-field">
          <span>完整题库总量</span>
          <input v-model="roundSetupTargetInput" type="number" min="1" inputmode="numeric" placeholder="例如 200" @input="roundSetupError = ''">
        </label>
        <label v-if="roundSetupStage > 1" class="round-flow-field">
          <span>第 {{ roundSetupStage }} 轮当前题量</span>
          <input v-model="roundSetupCurrentTargetInput" type="number" min="1" :max="roundSetupTargetInput || undefined" inputmode="numeric" placeholder="填写平台当前标记数" @input="roundSetupError = ''">
        </label>
        <div class="round-flow-explainer">
          <span>第 1 轮：全量</span><span>第 2 轮：第一轮标记数</span><span>第 3、4 轮：第二轮标记数</span><span>第 4 轮持续到清零</span>
        </div>
        <p v-if="roundSetupTask.completed > 0 && roundSetupStage === 1" class="round-flow-note">现有进度会继承到第 1 轮，开启后从 {{ Math.min(Math.max(0, Number(roundSetupTargetInput) || 0), taskRoundCompleted(roundSetupTask)) }} / {{ Math.max(0, Number(roundSetupTargetInput) || 0) }} 继续。</p>
        <p v-else-if="roundSetupTask.completed > 0" class="round-flow-note">现有 {{ roundSetupTask.completed }} 题进度会保留在累计练习量中，第 {{ roundSetupStage }} 轮从 0 开始。</p>
        <p v-if="roundSetupStage > 1" class="round-flow-note">完整题库总量用于以后重新全量开始；本次进度按第 {{ roundSetupStage }} 轮当前题量计算。</p>
        <p v-if="roundSetupError" class="correction-error">{{ roundSetupError }}</p>
        <div class="timer-modal-actions correction-actions">
          <button class="ghost" type="button" @click="closeRoundSetup">取消</button>
          <button class="primary" type="submit">开启第 {{ roundSetupStage }} 轮</button>
        </div>
      </form>
    </div>

    <div v-if="roundAdvanceTask" class="modal">
      <form class="modal-box round-flow-modal" @submit.prevent="submitRoundAdvance">
        <button class="modal-close-button" type="button" title="关闭弹窗" @click="closeRoundAdvance">×</button>
        <span class="timer-type">完成{{ roundAdvanceTask.roundStage === 4 ? '本遍巩固' : `第 ${roundAdvanceTask.roundStage} 轮` }}</span>
        <div class="modal-title">
          <h3>{{ roundAdvanceTask.platform }} · {{ taskDisplayName(roundAdvanceTask) }}</h3>
          <p>本轮 {{ roundAdvanceTask.roundCompleted }} / {{ roundAdvanceTask.roundTarget }} 已完成，请填写刷题平台当前剩余的标记题数量。</p>
        </div>
        <label class="round-flow-field">
          <span>平台剩余标记数</span>
          <input v-model="roundRemainingInput" type="number" min="0" :max="roundAdvanceTask.roundTarget" inputmode="numeric" placeholder="输入 0 表示清零" @input="roundAdvanceError = ''">
        </label>
        <p class="round-flow-note">{{ roundAdvanceTask.roundStage === 4 ? '大于 0 将继续第 4 轮；等于 0 后停止，等待你决定是否重新全量开始。' : '系统会把这个数字作为下一轮的目标题量。' }}</p>
        <p v-if="roundAdvanceError" class="correction-error">{{ roundAdvanceError }}</p>
        <div class="timer-modal-actions correction-actions">
          <button class="ghost" type="button" @click="closeRoundAdvance">取消</button>
          <button class="primary" type="submit">{{ Number(roundRemainingInput) === 0 && roundRemainingInput !== '' ? '确认清零' : '进入下一轮' }}</button>
        </div>
      </form>
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

    <div v-if="correctionTask" class="modal">
      <form class="modal-box correction-modal" @submit.prevent="submitCorrection">
        <button class="modal-close-button" type="button" title="关闭弹窗" @click="closeCorrectionModal">×</button>
        <span class="timer-type">修正{{ correctionTask.roundModeEnabled ? '当前轮' : '总' }}进度</span>
        <div class="modal-title">
          <h3>{{ taskDisplayName(correctionTask) }}</h3>
          <p>请输入截至今天{{ correctionTask.roundModeEnabled ? '当前轮' : '总' }}进度的真实完成数量，不是今天新增完成量。</p>
        </div>
        <div class="correction-summary">
          <span>当前记录</span>
          <strong>{{ taskProgressCompleted(correctionTask) }} / {{ taskTotalTarget(correctionTask) }} {{ correctionTask.trackingMode === 'itemized' ? '篇' : '题' }}</strong>
        </div>
        <label class="correction-field">
          <span>截至今天{{ correctionTask.roundModeEnabled ? '当前轮' : '总' }}进度的真实完成数量</span>
          <input
            ref="correctionField"
            v-model="correctionAmountInput"
            type="number"
            inputmode="numeric"
            min="0"
            :max="taskTotalTarget(correctionTask)"
            :aria-label="`${taskDisplayName(correctionTask)} 截至今天进度的真实完成数量`"
            @input="correctionError = ''"
          >
        </label>
        <p v-if="correctionError" class="correction-error">{{ correctionError }}</p>
        <div class="timer-modal-actions correction-actions">
          <button class="ghost" type="button" @click="closeCorrectionModal">取消</button>
          <button class="primary" type="submit">保存修正</button>
        </div>
      </form>
    </div>

    <div v-if="platformSwitchTask" class="modal">
      <form class="modal-box platform-switch-modal" @submit.prevent="submitPlatformSwitch">
        <button class="modal-close-button" type="button" title="关闭弹窗" @click="closePlatformSwitchModal">×</button>
        <span class="timer-type">切换学习平台</span>
        <div class="modal-title">
          <h3>切换 {{ platformSwitchTask.name }} 学习平台</h3>
          <p>原任务会进入“暂不安排”，已有进度和学习记录不会被覆盖。</p>
        </div>
        <div class="platform-switch-source">
          <div>
            <span>当前任务</span>
            <strong>{{ platformSwitchTask.platform }} · {{ platformSwitchTask.frequencyType }}</strong>
          </div>
          <b>{{ platformSwitchTask.completed }} / {{ taskTotalTarget(platformSwitchTask) }}</b>
        </div>
        <div class="platform-switch-fields">
          <label>切换到
            <span class="select-control">
              <select v-model="platformSwitchTarget" @change="platformSwitchError = ''">
                <option v-for="platform in practicePlatforms" :key="platform" :value="platform" :disabled="platform === platformSwitchTask.platform">{{ platform }}</option>
              </select>
              <ChevronDown class="select-control-icon" :size="16" stroke-width="2.4" aria-hidden="true" />
            </span>
          </label>
          <label>题库类型
            <span class="select-control">
              <select v-model="platformSwitchFrequency" @change="platformSwitchError = ''">
                <option v-for="frequencyType in frequencyTypes" :key="frequencyType" :value="frequencyType">{{ frequencyType }}</option>
              </select>
              <ChevronDown class="select-control-icon" :size="16" stroke-width="2.4" aria-hidden="true" />
            </span>
          </label>
          <label v-if="!platformSwitchExistingTask">题库量
            <input v-model.number="platformSwitchTargetCount" type="number" min="1" inputmode="numeric" placeholder="请输入题库数量" @input="platformSwitchError = ''">
          </label>
        </div>
        <div v-if="platformSwitchExistingTask" class="platform-switch-existing" :class="{ active: platformSwitchExistingTask.planStatus === 'active' }">
          <strong>{{ platformSwitchExistingTask.planStatus === 'shelved' ? '找到之前暂不安排的任务' : '当前计划已存在相同任务' }}</strong>
          <p>{{ platformSwitchExistingTask.platform }} · {{ taskDisplayName(platformSwitchExistingTask) }}，已完成 {{ platformSwitchExistingTask.completed }} / {{ taskTotalTarget(platformSwitchExistingTask) }}。</p>
          <span v-if="platformSwitchExistingTask.planStatus === 'shelved'">确认后会继续这项已有任务，不会重复创建。</span>
        </div>
        <div class="platform-switch-impact">
          <p><Check :size="15" />{{ platformSwitchTask.platform }}进度保留为 {{ platformSwitchTask.completed }} / {{ taskTotalTarget(platformSwitchTask) }}</p>
          <p><Check :size="15" />原任务不再生成每日学习量，也不会计算逾期</p>
        </div>
        <p v-if="platformSwitchError" class="correction-error">{{ platformSwitchError }}</p>
        <div class="timer-modal-actions correction-actions">
          <button class="ghost" type="button" @click="closePlatformSwitchModal">取消</button>
          <button class="primary" type="submit">{{ platformSwitchExistingTask?.planStatus === 'shelved' ? `暂不安排${platformSwitchTask.platform}，继续${platformSwitchTarget}` : `暂不安排${platformSwitchTask.platform}，开始${platformSwitchTarget}` }}</button>
        </div>
      </form>
    </div>

    <div v-if="restoreTask" class="modal">
      <form class="modal-box restore-task-modal" @submit.prevent="submitRestoreTask">
        <button class="modal-close-button" type="button" title="关闭弹窗" @click="closeRestoreTaskModal">×</button>
        <span class="timer-type">重新纳入计划</span>
        <div class="modal-title">
          <h3>{{ restoreTask.platform }} · {{ taskDisplayName(restoreTask) }}</h3>
          <p>已有进度 {{ restoreTask.completed }} / {{ taskTotalTarget(restoreTask) }}，重新安排后将从现有进度继续。</p>
        </div>
        <div v-if="restoreConflictTask" class="restore-conflict-warning">
          <strong>{{ restoreConflictTask.platform }} · {{ taskDisplayName(restoreConflictTask) }} 仍在进行中</strong>
          <p>同一题型一次只安排一个未完成的平台任务。请先完成或暂不安排当前 {{ restoreConflictTask.name }} 任务。</p>
        </div>
        <p class="restore-task-note">任务日期将重新跟随总计划，今日建议量会按剩余数量重新计算。</p>
        <div class="timer-modal-actions correction-actions">
          <button class="ghost" type="button" @click="closeRestoreTaskModal">取消</button>
          <button class="primary" type="submit" :disabled="Boolean(restoreConflictTask)">加入计划</button>
        </div>
      </form>
    </div>

    <div v-if="!IS_LOCAL_DEV && !appPassword" class="modal password-modal">
      <form class="modal-box password-modal-box" @submit.prevent="submitPassword">
        <h3>输入访问密码</h3>
        <p>密码会保存在本机浏览器，用于读取和保存 Cloudflare KV 中的学习进度。</p>
        <input v-model="passwordInput" name="app-password" type="password" autocomplete="current-password" placeholder="访问密码">
        <p v-if="passwordError" class="password-error">{{ passwordError }}</p>
        <div class="actions">
          <button type="submit">进入</button>
        </div>
      </form>
    </div>

  </main>
</template>

import type { CarryoverMode, PhaseSchedule, Priority, StrategyType, StudyData, Task } from './types';

export const todayIso = () => new Date().toISOString().slice(0, 10);

export const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

export const daysBetweenInclusive = (start: string, end: string) => {
  const diff = Math.floor((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000) + 1;
  return Math.max(0, diff);
};

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
export const progressPercent = (done: number, target: number) => (target <= 0 ? 0 : clamp(Math.round((done / target) * 100), 0, 100));

const defaultPhases = () => [
  { id: crypto.randomUUID(), name: '第一阶段：超高频优先', order: 1 },
  { id: crypto.randomUUID(), name: '第二阶段：剩余题推进', order: 2 },
  { id: crypto.randomUUID(), name: '第三阶段：全库复刷', order: 3 },
];

export function defaultCarryover(strategyType: StrategyType): CarryoverMode {
  return strategyType === 'daily_fixed' ? 'none' : 'adaptive_average';
}

export function defaultData(): StudyData {
  const today = todayIso();
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    settings: {
      startDate: today,
      deadline: addDays(today, 60),
      bufferDays: 7,
      githubOwner: 'Virinko',
      githubRepo: 'pte-study-data',
      githubBranch: 'main',
      githubPath: 'data.json',
    },
    phases: defaultPhases(),
    tasks: [],
    dailyLogs: {},
  };
}

export function normalizeData(input: unknown): StudyData {
  const base = defaultData();
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<StudyData> & { tasks?: unknown[]; phases?: unknown[] };
  const phases = Array.isArray(raw.phases) && raw.phases.length > 0
    ? raw.phases.map((p, index) => {
      const phase = p as { id?: string; name?: string; order?: number };
      return { id: phase.id || crypto.randomUUID(), name: phase.name || `阶段 ${index + 1}`, order: phase.order || index + 1 };
    })
    : base.phases;
  const fallbackPhaseId = phases[0]?.id || crypto.randomUUID();
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((t) => normalizeTask(t, fallbackPhaseId))
    : [];

  return {
    version: 2,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    settings: { ...base.settings, ...(raw.settings || {}) },
    phases,
    tasks,
    dailyLogs: raw.dailyLogs || {},
  };
}

function normalizeTask(input: unknown, fallbackPhaseId: string): Task {
  const t = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const strategyType = (t.strategyType || t.strategy || 'phased_pool') as StrategyType;
  return {
    id: String(t.id || crypto.randomUUID()),
    taskName: String(t.taskName || t.name || '新任务'),
    examType: String(t.examType || 'RS'),
    phaseId: String(t.phaseId || fallbackPhaseId),
    strategyType,
    targetCount: Number(t.targetCount ?? t.target ?? 0),
    completedCount: Number(t.completedCount ?? t.completed ?? 0),
    fixedDailyCount: Number(t.fixedDailyCount ?? t.dailyFixed ?? 0),
    carryoverMode: (t.carryoverMode as CarryoverMode) || defaultCarryover(strategyType),
    priority: (t.priority as Priority) || 'medium',
  };
}

export function buildSchedule(data: StudyData): PhaseSchedule[] {
  const phases = [...data.phases].sort((a, b) => a.order - b.order);
  if (phases.length === 0) return [];
  const totalEffectiveDays = Math.max(1, daysBetweenInclusive(data.settings.startDate, data.settings.deadline) - Math.max(0, data.settings.bufferDays));
  const weights = phases.map((phase) => data.tasks.filter((task) => task.phaseId === phase.id).reduce((sum, task) => sum + Math.max(0, task.targetCount), 0));
  const totalWeight = weights.reduce((sum, n) => sum + n, 0);
  const evenDays = Math.max(1, Math.floor(totalEffectiveDays / phases.length));
  let cursor = data.settings.startDate;
  let usedDays = 0;

  return phases.map((phase, index) => {
    const remainingPhases = phases.length - index;
    const idealDays = totalWeight > 0 ? Math.ceil((totalEffectiveDays * weights[index]) / totalWeight) : evenDays;
    const maxAllowed = Math.max(1, totalEffectiveDays - usedDays - (remainingPhases - 1));
    const days = index === phases.length - 1 ? Math.max(1, totalEffectiveDays - usedDays) : Math.min(Math.max(1, idealDays), maxAllowed);
    const startDate = cursor;
    const endDate = addDays(startDate, days - 1);
    cursor = addDays(endDate, 1);
    usedDays += days;
    return { ...phase, startDate, endDate, days, totalWork: weights[index] };
  });
}

export function currentPhase(schedule: PhaseSchedule[], date = todayIso()) {
  return schedule.find((phase) => date >= phase.startDate && date <= phase.endDate) || schedule.find((phase) => date < phase.startDate) || schedule[schedule.length - 1];
}

export function taskSuggestion(task: Task, phase?: PhaseSchedule, date = todayIso()) {
  if (!phase) return 0;
  if (task.carryoverMode === 'none') return Math.max(0, task.fixedDailyCount);
  const remaining = Math.max(0, task.targetCount - task.completedCount);
  if (remaining === 0) return 0;
  const remainingDays = Math.max(1, daysBetweenInclusive(date, phase.endDate));
  if (task.carryoverMode === 'next_day') return Math.max(task.fixedDailyCount, remaining);
  return Math.ceil(remaining / remainingDays);
}

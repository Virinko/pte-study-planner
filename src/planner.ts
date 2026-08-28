import type { Phase, PhaseSchedule, StudyData, Task } from './types';

const formatLocalDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
export const todayIso = () => formatLocalDate(new Date());
export const addDays = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + days); return formatLocalDate(d); };
export const daysBetweenInclusive = (start: string, end: string) => Math.max(0, Math.floor((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000) + 1);
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function defaultData(): StudyData {
  const today = todayIso();
  const deadline = addDays(today, 60);
  return {
    version: 4,
    updatedAt: '',
    settings: { startDate: today, deadline },
    phases: [{ id: crypto.randomUUID(), name: '备考总计划', order: 1, startDate: today, endDate: deadline }],
    tasks: [],
    dailyLogs: {},
    dailyTargets: {},
    dailyNotes: {},
    answerEntries: [],
    reviewPlans: {},
    reviewLogs: {},
    skippedReviewRegistrations: {},
    timeLogs: {},
    studyTimeEntries: [],
  };
}

export const taskRepeatCount = (task: Task) => Math.max(1, Math.floor(Number(task.repeatCount || 1)));
export const taskProgressCompleted = (task: Task) => task.roundModeEnabled
  ? task.roundCleared ? Math.max(0, Number(task.target || 0)) : Math.max(0, Number(task.roundCompleted || 0))
  : Math.max(0, Number(task.completed || 0));
export const taskTotalTarget = (task: Task) => task.roundModeEnabled
  ? task.roundCleared ? Math.max(0, Number(task.target || 0)) : Math.max(0, Number(task.roundTarget || 0))
  : Math.max(0, Number(task.target || 0) * taskRepeatCount(task));
export const taskRemaining = (task: Task) => Math.max(0, taskTotalTarget(task) - taskProgressCompleted(task));
export const taskCurrentRound = (task: Task) => {
  if (task.roundModeEnabled) return task.roundStage;
  const target = Math.max(1, Number(task.target || 0));
  const repeatCount = taskRepeatCount(task);
  if (taskTotalTarget(task) <= 0) return 1;
  return clamp(Math.floor(Math.max(0, task.completed) / target) + 1, 1, repeatCount);
};
export const taskRoundCompleted = (task: Task) => {
  if (task.roundModeEnabled) return taskProgressCompleted(task);
  const target = Math.max(0, Number(task.target || 0));
  if (target <= 0) return 0;
  if (Math.max(0, task.completed) >= taskTotalTarget(task)) return target;
  return Math.max(0, task.completed) % target;
};

const taskWork = (t: Task) => t.planStatus === 'shelved' ? 0 : taskRemaining(t);

export function buildSchedule(data: StudyData): PhaseSchedule[] {
  const phases = [...data.phases].sort((a, b) => a.order - b.order);
  const planStart = data.settings.startDate;
  const planEnd = data.settings.deadline;
  const totalDays = Math.max(1, daysBetweenInclusive(planStart, planEnd));
  const weights = phases.map((p) => Math.max(1, data.tasks.filter((t) => t.phaseId === p.id).reduce((s, t) => s + taskWork(t), 0)));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || phases.length || 1;
  let cursor = planStart;
  let used = 0;
  return phases.map((p, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === phases.length - 1;
    if (p.startDate && p.endDate) {
      const startDate = isFirst ? planStart : p.startDate;
      const requestedEnd = isLast ? planEnd : p.endDate;
      const endDate = requestedEnd < startDate ? startDate : requestedEnd;
      const days = daysBetweenInclusive(startDate, endDate);
      cursor = addDays(endDate, 1);
      used += days;
      return { ...p, startDate, endDate, days, totalWork: weights[idx] };
    }
    const remainingPhases = phases.length - idx;
    const remainingDays = Math.max(remainingPhases, totalDays - used);
    const days = idx === phases.length - 1 ? remainingDays : Math.max(1, Math.round((weights[idx] / totalWeight) * totalDays));
    const adjustedDays = Math.max(1, Math.min(days, remainingDays - (remainingPhases - 1)));
    const startDate = cursor;
    const endDate = addDays(startDate, adjustedDays - 1);
    cursor = addDays(endDate, 1); used += adjustedDays;
    return { ...p, startDate, endDate, days: adjustedDays, totalWork: weights[idx] };
  });
}

export function currentPhase(schedule: PhaseSchedule[], date = todayIso()) { return schedule.find((p) => date >= p.startDate && date <= p.endDate) || schedule.find((p) => date < p.startDate) || schedule[schedule.length - 1]; }
export function taskRoundStageEndDate(task: Task, phase: PhaseSchedule, date = todayIso()) {
  const startDate = task.startDate || phase.startDate;
  const endDate = task.endDate || phase.endDate;
  const effectiveStart = date < startDate ? startDate : date;
  const effectiveEnd = endDate < effectiveStart ? effectiveStart : endDate;
  const remainingDays = Math.max(1, daysBetweenInclusive(effectiveStart, effectiveEnd));
  const stageShare = task.roundStage === 1
    ? 1 / 2
    : task.roundStage === 2
      ? 2 / 5
      : task.roundStage === 3
        ? 1 / 3
        : 1 / 2;
  const futureStageMinimumDays = task.roundStage === 1 ? 3 : task.roundStage === 2 ? 2 : task.roundStage === 3 ? 1 : 0;
  const stageDayBudget = Math.max(1, Math.min(
    Math.max(1, remainingDays - futureStageMinimumDays),
    Math.floor(remainingDays * stageShare),
  ));
  return addDays(effectiveStart, stageDayBudget - 1);
}

export function taskSuggestion(task: Task, phase?: PhaseSchedule, date = todayIso()) {
  if (!phase || task.planStatus === 'shelved') return 0;
  const remaining = taskRemaining(task);
  if (!remaining) return 0;
  const startDate = task.startDate || phase.startDate;
  const endDate = task.endDate || phase.endDate;
  const effectiveStart = date < startDate ? startDate : date;
  const effectiveEnd = endDate < effectiveStart ? effectiveStart : endDate;
  const remainingDays = Math.max(1, daysBetweenInclusive(effectiveStart, effectiveEnd));
  if (!task.roundModeEnabled) return Math.ceil(remaining / remainingDays);
  const plannedStageEnd = task.roundStageEndDate || taskRoundStageEndDate(task, phase, date);
  const stageEnd = plannedStageEnd < effectiveStart
    ? effectiveStart
    : plannedStageEnd > effectiveEnd ? effectiveEnd : plannedStageEnd;
  return Math.ceil(remaining / Math.max(1, daysBetweenInclusive(effectiveStart, stageEnd)));
}
export const pct = (done: number, target: number) => target <= 0 ? 0 : clamp(Math.round((done / target) * 100), 0, 100);

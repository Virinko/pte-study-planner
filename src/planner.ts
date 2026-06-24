import type { Phase, PhaseSchedule, StudyData, Task } from './types';

export const todayIso = () => new Date().toISOString().slice(0, 10);
export const addDays = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
export const daysBetweenInclusive = (start: string, end: string) => Math.max(0, Math.floor((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86400000) + 1);
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function defaultData(): StudyData {
  const today = todayIso();
  const deadline = addDays(today, 60);
  const effectiveEnd = addDays(deadline, -7);
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { startDate: today, deadline, bufferDays: 7, githubOwner: 'Virinko', githubRepo: 'pte-study-data', githubBranch: 'main', githubPath: 'data.json' },
    phases: [{ id: crypto.randomUUID(), name: '基础推进期', order: 1, startDate: today, endDate: effectiveEnd }],
    tasks: [],
    dailyLogs: {},
  };
}

const taskWork = (t: Task) => t.strategy === 'daily_fixed' && t.carryoverMode === 'none' ? Math.max(1, t.dailyFixed) : Math.max(0, t.target - t.completed);

export function buildSchedule(data: StudyData): PhaseSchedule[] {
  const phases = [...data.phases].sort((a, b) => a.order - b.order);
  const effectiveEnd = addDays(data.settings.deadline, -Math.max(0, data.settings.bufferDays));
  const totalDays = Math.max(1, daysBetweenInclusive(data.settings.startDate, effectiveEnd));
  const weights = phases.map((p) => Math.max(1, data.tasks.filter((t) => t.phaseId === p.id).reduce((s, t) => s + taskWork(t), 0)));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || phases.length || 1;
  let cursor = data.settings.startDate;
  let used = 0;
  return phases.map((p, idx) => {
    if (p.startDate && p.endDate) {
      const startDate = p.startDate;
      const endDate = p.endDate < startDate ? startDate : p.endDate;
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
export function taskSuggestion(task: Task, phase?: PhaseSchedule, date = todayIso()) {
  if (!phase) return 0;
  if (task.carryoverMode === 'none') return task.dailyFixed;
  const remaining = Math.max(0, task.target - task.completed);
  if (!remaining) return 0;
  if (task.carryoverMode === 'next_day') return Math.max(0, task.dailyFixed || Math.ceil(remaining / Math.max(1, daysBetweenInclusive(date, phase.endDate))));
  return Math.ceil(remaining / Math.max(1, daysBetweenInclusive(date, phase.endDate)));
}
export const pct = (done: number, target: number) => target <= 0 ? 0 : clamp(Math.round((done / target) * 100), 0, 100);

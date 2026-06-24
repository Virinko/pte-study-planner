export type StrategyType = 'phased_pool' | 'fixed_pool' | 'daily_fixed' | 'memorization';
export type CarryoverMode = 'adaptive_average' | 'none' | 'next_day';

export interface Settings {
  startDate: string;
  deadline: string;
  bufferDays: number;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubPath: string;
}

export interface Phase { id: string; name: string; order: number; startDate?: string; endDate?: string; }

export interface Task {
  id: string;
  phaseId: string;
  name: string;
  strategy: StrategyType;
  target: number;
  completed: number;
  dailyFixed: number;
  carryoverMode: CarryoverMode;
}

export interface DailyLogEntry { taskId: string; amount: number; }
export interface DailyLogs { [date: string]: DailyLogEntry[]; }
export interface StudyData { version: number; updatedAt: string; settings: Settings; phases: Phase[]; tasks: Task[]; dailyLogs: DailyLogs; }
export interface PhaseSchedule extends Phase { startDate: string; endDate: string; days: number; totalWork: number; }

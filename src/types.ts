export type StrategyType = 'phased_pool' | 'fixed_pool' | 'daily_fixed' | 'memorization';
export type CarryoverMode = 'adaptive_average' | 'none' | 'next_day';
export type Priority = 'high' | 'medium' | 'low';

export interface Settings {
  startDate: string;
  deadline: string;
  bufferDays: number;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubPath: string;
}

export interface Phase {
  id: string;
  name: string;
  order: number;
}

export interface Task {
  id: string;
  taskName: string;
  examType: string;
  phaseId: string;
  strategyType: StrategyType;
  targetCount: number;
  completedCount: number;
  fixedDailyCount: number;
  carryoverMode: CarryoverMode;
  priority: Priority;
}

export interface DailyLogEntry {
  taskId: string;
  amount: number;
}

export interface DailyLogs {
  [date: string]: DailyLogEntry[];
}

export interface StudyData {
  version: number;
  updatedAt: string;
  settings: Settings;
  phases: Phase[];
  tasks: Task[];
  dailyLogs: DailyLogs;
}

export interface PhaseSchedule extends Phase {
  startDate: string;
  endDate: string;
  days: number;
  totalWork: number;
}

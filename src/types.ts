export type PracticePlatform = '多墨' | '猩际' | '萤火虫' | '影子三千';
export type FrequencyType = '全题库' | '超高频' | '非超高频';

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
  platform: PracticePlatform;
  frequencyType: FrequencyType;
  target: number;
  completed: number;
}

export interface DailyLogEntry { taskId: string; amount: number; }
export interface DailyLogs { [date: string]: DailyLogEntry[]; }
export interface StudyData { version: number; updatedAt: string; settings: Settings; phases: Phase[]; tasks: Task[]; dailyLogs: DailyLogs; }
export interface PhaseSchedule extends Phase { startDate: string; endDate: string; days: number; totalWork: number; }

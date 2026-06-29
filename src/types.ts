export type PracticePlatform = '多墨' | '猩际' | '萤火虫' | '影子三千';
export type FrequencyType = '全题库' | '超高频' | '非超高频';
export type TrackingMode = 'count_only' | 'itemized';
export type SubItemStatus = 'not_started' | 'doing' | 'done';
export type Familiarity = '生' | '半熟' | '熟' | '可默写';

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

export interface SubItem {
  id: string;
  title: string;
  status: SubItemStatus;
  familiarity: Familiarity;
  round: number;
  completedDate?: string;
  note: string;
}

export interface Task {
  id: string;
  phaseId: string;
  name: string;
  startDate?: string;
  endDate?: string;
  platform: PracticePlatform;
  frequencyType: FrequencyType;
  trackingMode: TrackingMode;
  reviewEnabled: boolean;
  subItems: SubItem[];
  target: number;
  repeatCount: number;
  completed: number;
}

export interface DailyLogEntry { taskId: string; amount?: number; count?: number; subItemIds?: string[]; note?: string; }
export interface DailyLogs { [date: string]: DailyLogEntry[]; }
export interface DailyNotes { [date: string]: string; }
export interface ReviewPlan { id: string; taskId: string; taskName: string; sourceDate: string; target: number; completed: number; }
export interface ReviewPlans { [date: string]: ReviewPlan[]; }
export type TimeLogType = 'task' | 'review';
export interface TimeLogEntry {
  id: string;
  date: string;
  type: TimeLogType;
  taskId?: string;
  reviewPlanId?: string;
  name: string;
  durationSeconds: number;
  createdAt: string;
}
export interface TimeLogs { [date: string]: TimeLogEntry[]; }
export interface StudyData { version: number; updatedAt: string; settings: Settings; phases: Phase[]; tasks: Task[]; dailyLogs: DailyLogs; dailyNotes: DailyNotes; reviewPlans: ReviewPlans; timeLogs: TimeLogs; }
export interface PhaseSchedule extends Phase { startDate: string; endDate: string; days: number; totalWork: number; }

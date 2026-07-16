export type PracticePlatform = '多墨' | '猩际' | '萤火虫' | '影子三千';
export type FrequencyType = '全题库' | '超高频' | '非超高频' | '错题复习';
export type TrackingMode = 'count_only' | 'itemized';
export type SubItemStatus = 'not_started' | 'doing' | 'done';
export type Familiarity = '生' | '半熟' | '熟' | '可默写';

export interface Settings {
  startDate: string;
  deadline: string;
  bufferDays: number;
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
export interface DailyTargets { [date: string]: Record<string, number>; }
export interface DailyNoteEntry {
  id: string;
  date: string;
  time: string;
  examType: string;
  examTypes?: string[];
  content: string;
  createdAt: string;
  updatedAt?: string;
}
export interface DailyNotes { [date: string]: DailyNoteEntry[]; }
export interface AnswerEntry {
  id: string;
  examType: string;
  platform: PracticePlatform;
  questionNumber: string;
  title: string;
  answer: string;
  createdAt: string;
  updatedAt?: string;
}
export interface ReviewPlan {
  id: string;
  taskId: string;
  taskName: string;
  sourceDate: string;
  target: number;
  completed: number;
  subItemIds?: string[];
  completedSubItemIds?: string[];
}
export interface ReviewPlans { [date: string]: ReviewPlan[]; }
export interface ReviewLogEntry {
  id: string;
  reviewPlanId: string;
  taskId: string;
  taskName: string;
  amount: number;
  createdAt: string;
}
export interface ReviewLogs { [date: string]: ReviewLogEntry[]; }
export interface SkippedReviewRegistrations { [date: string]: string[]; }
export type TimeLogType = 'task' | 'review';
export type StudyTimeType = 'main' | 'review';
export type StudyTimeSource = 'manual' | 'timer';
export interface TimeLogEntry {
  id: string;
  date: string;
  type: TimeLogType;
  taskId?: string;
  reviewPlanId?: string;
  name: string;
  durationSeconds: number;
  startAt?: string;
  endAt?: string;
  createdAt: string;
}
export interface TimeLogs { [date: string]: TimeLogEntry[]; }
export interface StudyTimeEntry {
  id: string;
  date: string;
  taskId?: string;
  reviewPlanId?: string;
  taskName: string;
  examType: string;
  durationSeconds: number;
  timeType: StudyTimeType;
  source: StudyTimeSource;
  note: string;
  startAt?: string;
  endAt?: string;
  createdAt: string;
}
export interface StudyData { version: number; updatedAt: string; settings: Settings; phases: Phase[]; tasks: Task[]; dailyLogs: DailyLogs; dailyTargets: DailyTargets; dailyNotes: DailyNotes; answerEntries: AnswerEntry[]; reviewPlans: ReviewPlans; reviewLogs: ReviewLogs; skippedReviewRegistrations: SkippedReviewRegistrations; timeLogs: TimeLogs; studyTimeEntries: StudyTimeEntry[]; }
export interface PhaseSchedule extends Phase { startDate: string; endDate: string; days: number; totalWork: number; }

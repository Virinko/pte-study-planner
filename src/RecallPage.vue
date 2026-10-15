<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { todayIso } from './planner';
import { extractTemplateSlots } from './recallTemplate';
import type { AnswerEntry, Familiarity, RecallTemplates, StudyData, StudyTimeEntry } from './types';

type ExamType = 'WE' | 'SST';
type View = 'choose' | 'write' | 'result';
type Mark = '' | 'missing' | 'wrong' | 'extra';
type Detail = { kind: Exclude<Mark, ''>; text: string };
type Token = { text: string; index: number };
type Segment = { text: string; mark: Mark };
type ResultPart = { label: string; referenceSegments: Segment[]; writtenSegments: Segment[] };
type LocalAnswer = Pick<AnswerEntry, 'id' | 'examType' | 'title' | 'answer' | 'createdAt'>;
type RecallEntry = { key: string; id: string; source: 'own' | 'library'; examType: ExamType; title: string; question?: string; answer: string; platformRefs: AnswerEntry['platformRefs'] };
type SavedFamiliarity = Record<string, { level: Familiarity; linkedKey?: string; taskId?: string; updatedAt: string }>;

const OWN_KEY = 'pte_recall_answers_v1';
const FAMILIARITY_KEY = 'pte_recall_familiarity_v1';
const TEMPLATE_KEY = 'pte_recall_templates_v1';
const levels: Familiarity[] = ['生', '半熟', '熟', '可默写'];
const props = defineProps<{ data: StudyData; active: boolean; todayTaskIds: string[]; saveProgress: (next: StudyData) => void }>();

function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}

const storedAnswers = readJson<unknown>(OWN_KEY, []);
const storedFamiliarity = readJson<unknown>(FAMILIARITY_KEY, {});
const storedTemplates = readJson<unknown>(TEMPLATE_KEY, {});
const ownAnswers = ref<LocalAnswer[]>(Array.isArray(storedAnswers) ? storedAnswers : []);
const familiarity = ref<SavedFamiliarity>(storedFamiliarity && typeof storedFamiliarity === 'object' && !Array.isArray(storedFamiliarity) ? storedFamiliarity as SavedFamiliarity : {});
const legacyTemplates = storedTemplates && typeof storedTemplates === 'object' && !Array.isArray(storedTemplates) ? storedTemplates as Record<string, unknown> : {};
const legacyCommon = (examType: ExamType) => typeof legacyTemplates[`type:${examType}`] === 'string' ? legacyTemplates[`type:${examType}`] as string : '';
const templateDrafts = reactive<RecallTemplates>({
  WE: props.data.recallTemplates?.WE || legacyCommon('WE'),
  SST: props.data.recallTemplates?.SST || legacyCommon('SST'),
});
const templateDirty = reactive<Record<ExamType, boolean>>({
  WE: !props.data.recallTemplates?.WE && !!legacyCommon('WE'),
  SST: !props.data.recallTemplates?.SST && !!legacyCommon('SST'),
});
const templateTouched = reactive<Record<ExamType, boolean>>({ WE: false, SST: false });
const templateSaveStatus = reactive<Record<ExamType, string>>({
  WE: templateDirty.WE ? '检测到旧版仅保存在本机的模板，请点击保存模板以同步。' : '',
  SST: templateDirty.SST ? '检测到旧版仅保存在本机的模板，请点击保存模板以同步。' : '',
});
const templateSaveError = reactive<Record<ExamType, boolean>>({ WE: false, SST: false });
const templateSaveTimers: Partial<Record<ExamType, number>> = {};
const type = ref<ExamType>('WE');
const view = ref<View>('choose');
const search = ref('');
const current = ref<RecallEntry | null>(null);
const written = ref('');
const checkCase = ref(true);
const compareNonTemplate = ref(false);
const resultMode = ref<'full' | 'slots'>('full');
const slotDrafts = ref<string[]>([]);
const checkTimer = ref(true);
const timerAccumulated = ref(0);
const timerStartedAt = ref<number | null>(null);
const clock = ref(Date.now());
const durationSeconds = ref(0);
const saveDuration = ref(true);
const selectedLevel = ref<Familiarity>('生');
const selectedLinkedKey = ref('');
const selectedTaskId = ref('');
const resultReady = ref(false);
const sessionSaved = ref(false);
const saveStatus = ref('');
const saveError = ref(false);
const assignmentDraft = reactive<Record<string, string>>({});
const assignmentStatus = ref('');
const resultParts = ref<ResultPart[]>([]);
const details = ref<Detail[]>([]);
let interval: number | undefined;

const entries = computed<RecallEntry[]>(() => {
  const convert = (rows: Array<LocalAnswer | AnswerEntry>, source: RecallEntry['source']) => rows
    .filter((entry) => entry && typeof entry.examType === 'string' && ['WE', 'SST'].includes(entry.examType.toUpperCase()) && typeof entry.answer === 'string' && entry.answer.trim())
    .map((entry) => ({
      key: `${source}:${entry.id}`, id: entry.id, source,
      examType: entry.examType.toUpperCase() as ExamType,
      title: entry.title || '未命名答案', question: 'question' in entry ? entry.question : undefined, answer: entry.answer,
      platformRefs: 'platformRefs' in entry ? entry.platformRefs : [],
    }));
  return [...convert(ownAnswers.value, 'own'), ...convert(props.data.answerEntries, 'library')];
});
const visibleEntries = computed(() => entries.value.filter((entry) => entry.examType === type.value)
  .filter((entry) => !search.value.trim() || `${entry.title} ${entry.question || ''} ${entry.answer}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())));
const wordCount = computed(() => written.value.trim().match(/\S+/g)?.length || 0);
const activeTemplate = computed(() => current.value ? templateDrafts[current.value.examType] : '');
const templatePreview = computed(() => activeTemplate.value.replace(/\*\*(【[^【】]*】)\*\*/g, '$1'));
const templateMatch = computed(() => extractTemplateSlots(activeTemplate.value, current.value?.answer || ''));
const elapsedMs = computed(() => timerAccumulated.value + (timerStartedAt.value === null ? 0 : Math.max(0, clock.value - timerStartedAt.value)));
const timerText = computed(() => checkTimer.value ? formatDuration(Math.floor(elapsedMs.value / 1000)) : '已关闭');
const countByKind = computed(() => ({
  missing: details.value.filter((item) => item.kind === 'missing').length,
  wrong: details.value.filter((item) => item.kind === 'wrong').length,
  extra: details.value.filter((item) => item.kind === 'extra').length,
}));
const linkOptions = computed(() => props.data.tasks
  .filter((task) => task.name.trim().toUpperCase().startsWith(current.value?.examType || '____'))
  .flatMap((task) => task.subItems.map((item) => ({ key: `${task.id}:${item.id}`, taskId: task.id, subItemId: item.id, label: `${task.name} · ${item.title}` }))));
function todayTasksForType(examType: string) {
  return props.data.tasks.filter((task) => props.todayTaskIds.includes(task.id)
    && (task.name.trim().toUpperCase() === examType
      || task.name.trim().toUpperCase().startsWith(`${examType} `)));
}
const matchingTodayTasks = computed(() => todayTasksForType(current.value?.examType || ''));
const unassignedRecallEntries = computed(() => props.data.studyTimeEntries.filter((entry) =>
  entry.date === todayIso() && !entry.taskId && entry.durationSeconds > 0
  && ['WE', 'SST'].includes(entry.examType.toUpperCase()) && entry.note.startsWith('默写检查：')));
function taskOptionLabel(task: StudyData['tasks'][number]) {
  const name = task.name.includes(task.frequencyType) ? task.name : `${task.name} ${task.frequencyType}`;
  return `${name} · ${task.platform}`;
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
function pauseTimer() {
  if (timerStartedAt.value !== null) {
    timerAccumulated.value += Date.now() - timerStartedAt.value;
    timerStartedAt.value = null;
  }
  clock.value = Date.now();
}
function resumeTimer() {
  if (props.active && view.value === 'write' && checkTimer.value && timerStartedAt.value === null) {
    timerStartedAt.value = Date.now();
    clock.value = timerStartedAt.value;
  }
}
function goTo(next: View) {
  if (next === 'result' && !resultReady.value) return;
  if (next === 'write' && !current.value) return;
  if (view.value === 'write') pauseTimer();
  view.value = next;
  resumeTimer();
}
function startPractice(entry: RecallEntry) {
  if (templateTouched[entry.examType] && !saveTemplate(entry.examType)) return;
  current.value = entry;
  written.value = '';
  compareNonTemplate.value = false;
  slotDrafts.value = [];
  resultReady.value = false;
  sessionSaved.value = false;
  durationSeconds.value = 0;
  timerAccumulated.value = 0;
  timerStartedAt.value = null;
  clock.value = Date.now();
  goTo('write');
}
function saveTemplate(examType: ExamType) {
  if (templateSaveTimers[examType] !== undefined) window.clearTimeout(templateSaveTimers[examType]);
  delete templateSaveTimers[examType];
  if (!templateDirty[examType]) return true;
  try {
    props.saveProgress({ ...props.data, recallTemplates: { ...props.data.recallTemplates, [examType]: templateDrafts[examType] } });
    templateDirty[examType] = false;
    templateTouched[examType] = false;
    templateSaveError[examType] = false;
    templateSaveStatus[examType] = '已保存到学习进度；云端同步状态请查看页面顶部。';
    delete legacyTemplates[`type:${examType}`];
    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(legacyTemplates)); } catch { /* The synced progress already holds the template. */ }
    return true;
  } catch {
    templateSaveError[examType] = true;
    templateSaveStatus[examType] = '保存失败，请重试。';
    return false;
  }
}
function scheduleTemplateSave(examType: ExamType) {
  templateDirty[examType] = true;
  templateTouched[examType] = true;
  templateSaveError[examType] = false;
  templateSaveStatus[examType] = '正在保存模板…';
  if (templateSaveTimers[examType] !== undefined) window.clearTimeout(templateSaveTimers[examType]);
  templateSaveTimers[examType] = window.setTimeout(() => { saveTemplate(examType); }, 600);
  resultReady.value = false;
}
function toggleTimer() {
  pauseTimer();
  timerAccumulated.value = 0;
  resultReady.value = false;
  resumeTimer();
}
watch(() => props.active, (active) => { if (active) resumeTimer(); else pauseTimer(); });
watch(() => props.data.recallTemplates, (templates) => {
  for (const examType of ['WE', 'SST'] as const) {
    const synced = templates?.[examType] || '';
    if (templateTouched[examType]) continue;
    if (synced || !templateDirty[examType]) {
      templateDrafts[examType] = synced;
      templateDirty[examType] = false;
      if (synced) templateSaveStatus[examType] = '';
    }
  }
}, { immediate: true });
watch(activeTemplate, (value) => {
  slotDrafts.value = [];
  resultReady.value = false;
  if (!value.trim()) compareNonTemplate.value = false;
});
watch([selectedTaskId, saveDuration], () => {
  if (saveError.value) { saveError.value = false; saveStatus.value = '选择熟练度后，可保存本次练习。'; }
});
onMounted(() => { interval = window.setInterval(() => { if (timerStartedAt.value !== null) clock.value = Date.now(); }, 500); });
onBeforeUnmount(() => {
  for (const examType of ['WE', 'SST'] as const) if (templateTouched[examType]) saveTemplate(examType);
  pauseTimer();
  if (interval !== undefined) window.clearInterval(interval);
});

function tokenize(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|[^\s]/gu)]
    .map((match) => ({ text: match[0], index: match.index || 0 }));
}
function compare(reference: string, submitted: string, caseSensitive: boolean) {
  const left = tokenize(reference);
  const right = tokenize(submitted);
  if (left.length > 1000 || right.length > 1000) throw new Error('单篇内容过长，请控制在 1000 个词或符号以内。');
  const same = (a: string, b: string) => caseSensitive ? a === b : a.toLocaleLowerCase('en') === b.toLocaleLowerCase('en');
  const rows = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = 0; i <= left.length; i++) rows[i][0] = i;
  for (let j = 0; j <= right.length; j++) rows[0][j] = j;
  for (let i = 1; i <= left.length; i++) for (let j = 1; j <= right.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1,
      rows[i - 1][j - 1] + (same(left[i - 1].text, right[j - 1].text) ? 0 : 1));
  }
  const leftMarks: Mark[] = Array(left.length).fill('');
  const rightMarks: Mark[] = Array(right.length).fill('');
  const resultDetails: Detail[] = [];
  let i = left.length;
  let j = right.length;
  while (i || j) {
    if (i && j && same(left[i - 1].text, right[j - 1].text) && rows[i][j] === rows[i - 1][j - 1]) { i--; j--; continue; }
    if (i && j && rows[i][j] === rows[i - 1][j - 1] + 1) {
      leftMarks[i - 1] = 'wrong'; rightMarks[j - 1] = 'wrong';
      resultDetails.push({ kind: 'wrong', text: `${right[j - 1].text} → ${left[i - 1].text}` }); i--; j--; continue;
    }
    if (i && rows[i][j] === rows[i - 1][j] + 1) {
      leftMarks[i - 1] = 'missing'; resultDetails.push({ kind: 'missing', text: left[i - 1].text }); i--; continue;
    }
    rightMarks[j - 1] = 'extra'; resultDetails.push({ kind: 'extra', text: right[j - 1].text }); j--;
  }
  return { left, right, leftMarks, rightMarks, details: resultDetails.reverse() };
}
function makeSegments(source: string, tokens: Token[], marks: Mark[]): Segment[] {
  if (!tokens.length) return [{ text: '（未填写）', mark: '' }];
  const parts: Segment[] = [];
  let position = 0;
  tokens.forEach((token, index) => {
    if (token.index > position) parts.push({ text: source.slice(position, token.index), mark: '' });
    parts.push({ text: token.text, mark: marks[index] });
    position = token.index + token.text.length;
  });
  if (position < source.length) parts.push({ text: source.slice(position), mark: '' });
  return parts;
}
function submitPractice() {
  if (!current.value) return;
  const reference = current.value.answer.trim();
  const submitted = written.value.trim();
  try {
    if (compareNonTemplate.value) {
      const match = templateMatch.value;
      if (match.error) throw new Error(match.error);
      const parts = match.slots.map((slot, index) => {
        const text = (slotDrafts.value[index] || '').trim();
        const result = compare(slot.reference, text, checkCase.value);
        return {
          part: { label: `${index + 1}. ${slot.label}`, referenceSegments: makeSegments(slot.reference, result.left, result.leftMarks), writtenSegments: makeSegments(text, result.right, result.rightMarks) },
          details: result.details.map((detail) => ({ ...detail, text: `${slot.label}：${detail.text}` })),
        };
      });
      resultParts.value = parts.map((item) => item.part);
      details.value = parts.flatMap((item) => item.details);
      resultMode.value = 'slots';
    } else {
      const result = compare(reference, submitted, checkCase.value);
      resultParts.value = [{ label: '', referenceSegments: makeSegments(reference, result.left, result.leftMarks), writtenSegments: makeSegments(submitted, result.right, result.rightMarks) }];
      details.value = result.details;
      resultMode.value = 'full';
    }
  } catch (error) { alert(error instanceof Error ? error.message : '对比失败。'); return; }
  pauseTimer();
  durationSeconds.value = checkTimer.value ? Math.max(1, Math.ceil(timerAccumulated.value / 1000)) : 0;
  saveDuration.value = durationSeconds.value > 0;
  selectedLevel.value = familiarity.value[current.value.key]?.level || '生';
  selectedLinkedKey.value = familiarity.value[current.value.key]?.linkedKey || '';
  const savedTaskId = familiarity.value[current.value.key]?.taskId;
  selectedTaskId.value = matchingTodayTasks.value.some((task) => task.id === savedTaskId)
    ? savedTaskId! : matchingTodayTasks.value.length === 1 ? matchingTodayTasks.value[0].id : '';
  resultReady.value = true;
  sessionSaved.value = false;
  saveStatus.value = '选择熟练度后，可保存本次练习。';
  saveError.value = false;
  goTo('result');
}
function saveSession() {
  if (!current.value || sessionSaved.value) return;
  const savedAt = new Date().toISOString();
  const linked = linkOptions.value.find((item) => item.key === selectedLinkedKey.value);
  const seconds = saveDuration.value ? durationSeconds.value : 0;
  const level = selectedLevel.value;
  const selectedTask = matchingTodayTasks.value.find((task) => task.id === selectedTaskId.value);
  if (seconds > 0 && matchingTodayTasks.value.length > 0 && !selectedTask) {
    saveStatus.value = '请先选择本次用时归属的今日任务。';
    saveError.value = true;
    return;
  }
  try {
    let next: StudyData = props.data;
    if (seconds > 0 || linked) {
      if (linked) next = { ...next, tasks: next.tasks.map((task) => task.id === linked.taskId ? {
        ...task, subItems: task.subItems.map((item) => item.id === linked.subItemId ? { ...item, familiarity: level } : item),
      } : task) };
      if (seconds > 0) {
        const date = todayIso();
        const startAt = new Date(new Date(savedAt).getTime() - seconds * 1000).toISOString();
        const entry: StudyTimeEntry = {
          id: crypto.randomUUID(), date, taskId: selectedTask?.id || '', reviewPlanId: '',
          taskName: selectedTask ? taskOptionLabel(selectedTask) : `${current.value.examType} 默写检查`, examType: current.value.examType,
          durationSeconds: seconds, timeType: 'main', source: 'timer', note: `默写检查：${current.value.title}`,
          startAt, endAt: savedAt, createdAt: savedAt,
        };
        next = { ...next, studyTimeEntries: [...next.studyTimeEntries, entry] };
      }
    }
    const updated = { ...familiarity.value, [current.value.key]: { level, linkedKey: linked?.key || '', taskId: seconds > 0 ? selectedTask?.id || '' : familiarity.value[current.value.key]?.taskId || '', updatedAt: savedAt } };
    localStorage.setItem(FAMILIARITY_KEY, JSON.stringify(updated));
    familiarity.value = updated;
    if (seconds > 0 || linked) props.saveProgress(next);
    sessionSaved.value = true;
    saveStatus.value = seconds > 0
      ? selectedTask ? `用时已计入「${taskOptionLabel(selectedTask)}」今日学习时长，熟练度已保存。` : '用时已计入题型统计；今日任务无对应项。熟练度已保存。'
      : '本篇熟练度已保存。';
    saveError.value = false;
  } catch {
    saveStatus.value = '保存失败，请检查浏览器存储空间后重试。';
    saveError.value = true;
  }
}
function assignExistingTime(entry: StudyTimeEntry) {
  const task = todayTasksForType(entry.examType.toUpperCase()).find((item) => item.id === assignmentDraft[entry.id]);
  if (!task) { assignmentStatus.value = '请先选择对应的今日任务。'; return; }
  try {
    props.saveProgress({
      ...props.data,
      studyTimeEntries: props.data.studyTimeEntries.map((item) => item.id === entry.id
        ? { ...item, taskId: task.id, taskName: taskOptionLabel(task) } : item),
    });
    assignmentStatus.value = `已将用时归属到「${taskOptionLabel(task)}」。`;
  } catch { assignmentStatus.value = '归属失败，请检查浏览器存储空间后重试。'; }
}
</script>

<template>
  <section class="page recall-page">
    <div class="recall-header">
      <div><h2>WE / SST 默写检查</h2><p>从答案库选择一篇答案，遮住原文默写，提交后查看遗漏与错误。</p></div>
      <span class="recall-source">已读取现有答案库</span>
    </div>
    <div class="recall-steps" aria-label="默写流程">
      <button type="button" :class="{ active: view === 'choose', done: view !== 'choose' }" @click="goTo('choose')"><span>1</span>选择文章</button>
      <button type="button" :class="{ active: view === 'write', done: view === 'result' }" :disabled="!current" @click="goTo('write')"><span>2</span>开始默写</button>
      <button type="button" :class="{ active: view === 'result' }" :disabled="!resultReady" @click="goTo('result')"><span>3</span>查看对比</button>
    </div>

    <div v-if="view === 'choose'" class="recall-card recall-choose">
      <div class="recall-section-head">
        <div><h3>选择一篇答案</h3><p>答案内容统一在答案库维护；旧版本地答案仍可只读默写。</p></div>
        <div class="recall-head-actions"><div class="recall-segmented" aria-label="题型筛选"><button v-for="examType in (['WE', 'SST'] as const)" :key="examType" type="button" :class="{ active: type === examType }" :aria-pressed="type === examType" @click="type = examType">{{ examType }}</button></div></div>
      </div>
      <div class="recall-template-setup">
        <h4>{{ type }} 通用默写模板</h4>
        <p>保留完整的固定文字，把需要默写的内容写成 <code>【】</code>。例如 <code>Nowadays, the topic of 【】 has become a widely discussed issue.</code>。模板对所有 {{ type }} 文章通用；练习时关闭“仅对比非模板部分”即可校验全文。</p>
        <label :for="`recall-template-${type}`">{{ type }} 通用模板</label>
        <textarea :id="`recall-template-${type}`" v-model="templateDrafts[type]" :placeholder="`粘贴 ${type} 通用模板；不使用模板可留空`" spellcheck="false" @input="scheduleTemplateSave(type)" @blur="saveTemplate(type)"></textarea>
        <div class="recall-template-save-foot"><span :class="{ error: templateSaveError[type] }" role="status">{{ templateSaveStatus[type] || '输入后自动保存到学习进度，并随现有云端同步。' }}</span><button class="recall-secondary" type="button" :disabled="!templateDirty[type]" @click="saveTemplate(type)">保存模板</button></div>
      </div>
      <div class="recall-toolbar"><input v-model="search" type="search" placeholder="搜索标题、题目或答案内容" aria-label="搜索答案"><span>共 {{ visibleEntries.length }} 篇</span></div>
      <div v-if="visibleEntries.length" class="recall-list">
        <article v-for="entry in visibleEntries" :key="entry.key" class="recall-entry">
          <div class="recall-entry-main"><div class="recall-entry-title"><span class="recall-badge" :class="{ sst: entry.examType === 'SST' }">{{ entry.examType }}</span><strong>{{ entry.title }}</strong><span v-if="familiarity[entry.key]?.level" class="recall-familiarity-tag">{{ familiarity[entry.key].level }}</span></div><p>{{ entry.source === 'own' ? '旧版本地答案 · 只读' : `答案库${entry.platformRefs.find(item => item.questionNumber) ? ` · ${entry.platformRefs.find(item => item.questionNumber)?.platform} #${entry.platformRefs.find(item => item.questionNumber)?.questionNumber}` : ''}` }}</p><p v-if="entry.question" class="recall-preview">题目：{{ entry.question }}</p><p class="recall-preview">{{ entry.answer.replace(/\s+/g, ' ').slice(0, 125) }}</p></div>
          <div class="recall-entry-actions"><button class="recall-primary" type="button" @click="startPractice(entry)">开始默写</button></div>
        </article>
      </div>
      <div v-else class="recall-empty">还没有符合条件的答案。请先在答案库录入答案。</div>
      <section v-if="unassignedRecallEntries.length" class="recall-unassigned">
        <h3>待归属的默写用时</h3>
        <p>今天已保存的这些用时还没有对应任务。选择平台后，可补到“今日任务”的相应行。</p>
        <div v-for="entry in unassignedRecallEntries" :key="entry.id" class="recall-unassigned-row">
          <span>{{ entry.examType }} · {{ entry.note.slice('默写检查：'.length) }} · {{ formatDuration(entry.durationSeconds) }}</span>
          <template v-if="todayTasksForType(entry.examType.toUpperCase()).length">
            <select v-model="assignmentDraft[entry.id]" :aria-label="`为${entry.note}选择今日任务`">
              <option value="">请选择今日任务</option>
              <option v-for="task in todayTasksForType(entry.examType.toUpperCase())" :key="task.id" :value="task.id">{{ taskOptionLabel(task) }}</option>
            </select>
            <button class="recall-secondary" type="button" @click="assignExistingTime(entry)">确认归属</button>
          </template>
          <small v-else>今日暂无对应题型任务</small>
        </div>
        <p v-if="assignmentStatus" class="recall-assignment-status" role="status">{{ assignmentStatus }}</p>
      </section>
    </div>

    <div v-else-if="view === 'write' && current" class="recall-practice-grid">
      <div class="recall-card recall-practice"><div class="recall-practice-title"><span class="recall-badge" :class="{ sst: current.examType === 'SST' }">{{ current.examType }}</span><h3>{{ current.title }}</h3></div><p v-if="current.question" class="recall-prompt">题目：{{ current.question }}</p><p class="recall-muted">标准答案已隐藏</p>
        <div class="recall-options"><label class="recall-switch"><input v-model="compareNonTemplate" type="checkbox" role="switch" :disabled="!activeTemplate.trim()" @change="resultReady = false"><span class="track"></span><span><strong>仅对比非模板部分</strong><small>{{ activeTemplate.trim() ? '开启后只默写【】中的内容' : '可在第一步录入通用模板' }}</small></span></label><label class="recall-switch"><input v-model="checkCase" type="checkbox" role="switch" @change="resultReady = false"><span class="track"></span><span><strong>验证大小写</strong><small>关闭后忽略大小写，仍检查单词与标点</small></span></label><label class="recall-switch timer"><input v-model="checkTimer" type="checkbox" role="switch" @change="toggleTimer"><span class="track"></span><strong>默写计时</strong><b>{{ timerText }}</b></label></div>
        <template v-if="compareNonTemplate">
          <p class="recall-template-status" :class="{ error: templateMatch.error }" role="status">{{ templateMatch.error || `按第一步设置的模板，填写以下 ${templateMatch.slots.length} 处空位。` }}</p>
          <button v-if="templateMatch.error" class="recall-secondary" type="button" @click="goTo('choose')">返回第一步修改通用模板</button>
          <div v-else class="recall-template-preview"><strong>模板提示</strong><p>{{ templatePreview }}</p></div>
          <div v-if="!templateMatch.error" class="recall-slot-list">
            <label v-for="(slot, index) in templateMatch.slots" :key="index" class="recall-slot-field"><span>{{ index + 1 }}. {{ slot.label }}</span><textarea v-model="slotDrafts[index]" :aria-label="`默写${slot.label}`" placeholder="只填写这一处的非模板内容" spellcheck="false" @input="resultReady = false"></textarea></label>
          </div>
        </template>
        <template v-else><div class="recall-editor-head"><label for="recall-written">请默写完整答案</label><span>{{ wordCount }} 词</span></div><textarea id="recall-written" v-model="written" class="recall-editor" placeholder="从记忆中写出这篇文章。提交前不会显示标准答案。" spellcheck="false" @input="resultReady = false"></textarea></template>
        <div class="recall-bottom-actions"><button class="recall-text" type="button" @click="goTo('choose')">← 重新选题</button><button class="recall-primary" type="button" :disabled="compareNonTemplate && !!templateMatch.error" @click="submitPractice">提交并对比答案 →</button></div>
      </div>
      <aside class="recall-card recall-help"><h3>专注默写</h3><p>{{ compareNonTemplate ? '只填写模板占位符中的内容。提交后按每个空位显示遗漏、写错和多写的内容。' : '这里显示题目和标题，完成后提交，页面会按原文顺序标出遗漏、写错和多写的内容。' }}</p><div>🔒 提交前隐藏标准答案</div></aside>
    </div>

    <div v-else-if="view === 'result' && current" class="recall-result">
      <div class="recall-card recall-result-head"><div><h3>{{ current.title }} · 对比结果</h3><p>{{ resultMode === 'slots' ? '仅对比非模板部分；' : '对比完整答案；' }}忽略空白差异；{{ checkCase ? '验证大小写' : '忽略大小写' }}，标点按原文检查。</p></div><div class="recall-counts"><span class="missing">遗漏 {{ countByKind.missing }}</span><span class="wrong">错误 {{ countByKind.wrong }}</span><span class="extra">多写 {{ countByKind.extra }}</span><span v-if="!details.length" class="correct">{{ resultMode === 'slots' ? '检查部分完全一致' : '完全一致' }}</span></div></div>
      <div v-for="(part, partIndex) in resultParts" :key="partIndex" class="recall-result-part"><h3 v-if="part.label">{{ part.label }}</h3><div class="recall-compare"><div class="recall-card recall-compare-panel"><h3>{{ resultMode === 'slots' ? '标准内容' : '标准答案' }}</h3><p>橙色：遗漏　红色：写错</p><div class="recall-answer"><span v-for="(segment, index) in part.referenceSegments" :key="index" :class="segment.mark">{{ segment.text }}</span></div></div><div class="recall-card recall-compare-panel"><h3>我的默写</h3><p>红色：写错　紫色：多写</p><div class="recall-answer"><span v-for="(segment, index) in part.writtenSegments" :key="index" :class="segment.mark">{{ segment.text }}</span></div></div></div></div>
      <div class="recall-card recall-details"><h3>需要回看的地方</h3><div v-if="details.length"><span v-for="(detail, index) in details" :key="index" :class="detail.kind">{{ detail.kind === 'missing' ? '遗漏' : detail.kind === 'wrong' ? '错误' : '多写' }}：{{ detail.text }}</span></div><p v-else>没有发现遗漏或错误。</p></div>
      <div class="recall-card recall-save"><div class="recall-save-head"><div><h3>保存本次练习</h3><p>可选择将用时计入题型学习时长，并记录这篇答案的熟练度。</p></div><span>{{ durationSeconds ? `本次用时 ${formatDuration(durationSeconds)}` : '本次未计时' }}</span></div>
        <label v-if="durationSeconds" class="recall-switch recall-save-time"><input v-model="saveDuration" type="checkbox" role="switch" :disabled="sessionSaved"><span class="track"></span><span><strong>将本次用时计入题型学习时长</strong><small>开启后可选择归属的今日任务</small></span></label>
        <div v-if="durationSeconds && saveDuration" class="recall-task-choice">
          <label v-if="matchingTodayTasks.length" for="recall-today-task">用时归属的今日任务</label>
          <select v-if="matchingTodayTasks.length" id="recall-today-task" v-model="selectedTaskId" :disabled="sessionSaved" :required="matchingTodayTasks.length > 1">
            <option value="" disabled>请选择对应任务</option>
            <option v-for="task in matchingTodayTasks" :key="task.id" :value="task.id">{{ taskOptionLabel(task) }}</option>
          </select>
          <p v-if="matchingTodayTasks.length">保存后，用时会显示在所选任务的“今日已学”下方。</p>
          <p v-else>今日任务没有进行中的 {{ current.examType }} 项；用时将只计入题型统计。</p>
        </div>
        <div class="recall-save-grid"><div><span class="recall-field-label">选择熟练度</span><div class="recall-levels" role="radiogroup" aria-label="熟练度"><label v-for="level in levels" :key="level"><input v-model="selectedLevel" type="radio" name="recall-familiarity" :value="level" :disabled="sessionSaved"><span>{{ level }}</span></label></div></div><label v-if="linkOptions.length" class="recall-link"><span>同步到计划篇目（可选）</span><select v-model="selectedLinkedKey" :disabled="sessionSaved"><option value="">仅记录本篇熟练度</option><option v-for="option in linkOptions" :key="option.key" :value="option.key">{{ option.label }}</option></select></label></div>
        <div class="recall-save-foot"><span :class="{ error: saveError }" role="status">{{ saveStatus }}</span><button class="recall-primary" type="button" :disabled="sessionSaved" @click="saveSession">{{ sessionSaved ? '已保存' : '保存本次练习' }}</button></div>
      </div>
      <div class="recall-bottom-actions"><button class="recall-text" type="button" @click="goTo('choose')">← 选择其他文章</button><button class="recall-primary" type="button" @click="startPractice(current)">再默写一次</button></div>
    </div>
  </section>
</template>

<style scoped>
.recall-page{--ink:#221f2a;--muted:#746f7a;--line:#eee4e5;min-width:0;padding:36px clamp(22px,4vw,54px) 48px;color:var(--ink);background:#faf8f6}
.recall-page h2,.recall-page h3,.recall-page p{margin:0}.recall-page button{font-weight:500}.recall-page strong,.recall-page b,.recall-page h2,.recall-page h3{font-weight:500}.recall-page input,.recall-page textarea,.recall-page select{font:inherit;font-weight:400}.recall-page button:disabled{opacity:.55;cursor:not-allowed}
.recall-header,.recall-steps,.recall-choose,.recall-practice-grid,.recall-result{max-width:1180px;margin-left:auto;margin-right:auto}
.recall-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:23px}.recall-header h2{font-size:27px;letter-spacing:-.02em}.recall-header p,.recall-section-head p,.recall-result-head p,.recall-save-head p{margin-top:7px;color:var(--muted);font-size:13px;line-height:1.5}.recall-source{padding:8px 13px;border:1px solid #e6dcf0;border-radius:99px;background:#f1ecf7;color:#756491;font-size:12px;white-space:nowrap}
.recall-steps{display:flex;gap:9px;margin-bottom:18px}.recall-steps button{display:flex;flex:1;align-items:center;gap:10px;min-height:54px;padding:11px 16px;border:1px solid var(--line);border-radius:9px;background:#fff;color:#8a8490;text-align:left;box-shadow:0 7px 20px rgba(72,62,92,.04)}.recall-steps button.active{border-color:#f1c5d0;background:#fff4f6;color:#c85670}.recall-steps button.done{color:#6d7295}.recall-steps button span{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#f4f0f3;font-size:12px}.recall-steps button.active span{background:#ea7186;color:#fff}.recall-steps button.done span{background:#eeebf6}
.recall-card{min-width:0;border:1px solid rgba(122,119,185,.16);border-radius:12px;background:#fff;box-shadow:0 14px 34px rgba(72,62,92,.07)}.recall-choose{padding:27px 30px}.recall-section-head,.recall-head-actions,.recall-toolbar,.recall-entry,.recall-entry-actions,.recall-bottom-actions,.recall-result-head,.recall-save-head,.recall-save-foot{display:flex;align-items:center;justify-content:space-between;gap:16px}.recall-section-head{align-items:flex-start;margin-bottom:20px}.recall-section-head h3{font-size:19px}.recall-section-head p{font-size:12px}.recall-head-actions{gap:10px;flex-wrap:wrap}.recall-page button{border-radius:7px;padding:10px 15px;font-size:13px}.recall-primary{border:1px solid transparent;color:#fff;background:linear-gradient(135deg,#7a77b9,#6f58b9);box-shadow:0 8px 18px rgba(122,119,185,.18)}.recall-primary:hover:not(:disabled){background:linear-gradient(135deg,#6e6aab,#6350a8)}.recall-secondary{border:1px solid #d7c9e8;color:#71649c;background:#fff}.recall-ghost{border:1px solid #e7dee8;color:#605a6b;background:#fff}.recall-text{border:0;color:#7a70a6;background:transparent}.recall-text.danger{color:#c65b71}.recall-segmented{display:flex;gap:2px;padding:3px;border-radius:8px;background:#f4eff5}.recall-segmented button{border:0;padding:8px 16px;color:#817b87;background:transparent;font-size:12px}.recall-segmented button.active{color:#c4536d;background:#fff;box-shadow:0 2px 8px rgba(72,62,92,.1)}
.recall-form{margin-bottom:17px;padding:21px 22px;border:1px solid #e9e0ee;border-radius:9px;background:#fbf9fc}.recall-form h3{margin-bottom:16px;font-size:16px}.recall-form-grid{display:grid;grid-template-columns:130px minmax(0,1fr);gap:12px}.recall-form-grid label,.recall-link{display:grid;gap:7px;color:#514a59;font-size:12px;font-weight:500}.recall-form-grid .wide{grid-column:1/-1}.recall-form-grid input,.recall-form-grid select,.recall-form-grid textarea,.recall-toolbar input,.recall-link select,.recall-editor{width:100%;border:1px solid #ded7e2;border-radius:7px;padding:10px 12px;color:var(--ink);background:#fff}.recall-form-grid textarea{min-height:135px;resize:vertical;line-height:1.65}.recall-form p{margin-top:12px;color:var(--muted);font-size:12px}.recall-form-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:15px}.recall-feedback{min-height:16px;margin-bottom:13px!important;color:#54846c;font-size:12px}.recall-feedback.error,.recall-save-foot .error{color:#b8566d}.recall-toolbar{margin-bottom:15px}.recall-toolbar input{width:min(340px,100%);font-size:13px}.recall-toolbar span,.recall-entry p,.recall-muted{color:#817b86;font-size:12px}.recall-list{display:grid;gap:10px}.recall-entry{padding:16px 18px;border:1px solid #ece5e9;border-radius:9px}.recall-entry:hover{border-color:#d9c8df;background:#fffdfd}.recall-entry-main{min-width:0}.recall-entry-title,.recall-practice-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.recall-entry-title strong{font-size:14px}.recall-badge,.recall-familiarity-tag{padding:3px 7px;border-radius:5px;color:#7763a8;background:#f1ecf9;font-size:11px;font-weight:500}.recall-badge.sst{color:#be5e7a;background:#fff0f4}.recall-familiarity-tag{color:#7a648e;background:#f7f1f8}.recall-entry p{margin-top:7px}.recall-preview{overflow:hidden;max-width:690px;text-overflow:ellipsis;white-space:nowrap}.recall-entry-actions{flex-shrink:0;gap:8px}.recall-entry-actions .recall-primary{white-space:nowrap}.recall-empty{padding:32px 20px;border:1px dashed #e8dce5;border-radius:8px;background:#fcfafb;color:var(--muted);font-size:13px;text-align:center}
.recall-template-setup{display:grid;gap:9px;margin-bottom:18px;padding:16px 18px;border:1px solid #e9e0ee;border-radius:9px;background:#fbf9fc}.recall-template-setup h4{margin:0;color:#514a59;font-size:14px;font-weight:500}.recall-template-setup p{color:var(--muted);font-size:12px;line-height:1.6}.recall-template-setup code{padding:2px 4px;border-radius:4px;background:#f1ecfa;color:#665394;white-space:normal}.recall-template-setup label{color:#514a59;font-size:12px;font-weight:500}.recall-template-setup textarea{width:100%;min-height:100px;padding:11px 12px;border:1px solid #ded7e2;border-radius:7px;background:#fff;color:var(--ink);font-size:13px;line-height:1.6;resize:vertical}.recall-template-save-foot{display:flex;align-items:center;justify-content:space-between;gap:12px}.recall-template-save-foot span{color:#54846c;font-size:12px}.recall-template-save-foot span.error{color:#b8566d}
.recall-practice-grid{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:17px}.recall-practice{padding:28px 30px}.recall-practice-title h3{font-size:20px}.recall-muted{margin:8px 0 17px!important}.recall-options{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:19px}.recall-switch{display:flex;align-items:center;gap:10px;min-height:54px;padding:10px 12px;border:1px solid #e7dfea;border-radius:8px;background:#faf8fc;cursor:pointer}.recall-options .recall-switch:first-child{flex:1 1 290px}.recall-switch input{position:absolute;width:1px;height:1px;opacity:0}.recall-switch .track{position:relative;flex:0 0 39px;width:39px;height:23px;border-radius:99px;background:#bbc7d8}.recall-switch .track:after{position:absolute;top:3px;left:3px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,35,65,.25);content:'';transition:transform .15s}.recall-switch input:checked + .track{background:#7a77b9}.recall-switch input:checked + .track:after{transform:translateX(16px)}.recall-switch input:focus-visible + .track{outline:2px solid #b99ded;outline-offset:2px}.recall-switch>span:last-child{display:grid;gap:2px}.recall-switch strong{color:#4a4356;font-size:13px}.recall-switch small{color:var(--muted);font-size:11px;font-weight:400}.recall-switch.timer b{min-width:58px;color:#71639f;font-size:17px;font-variant-numeric:tabular-nums;text-align:right}.recall-editor-head{display:flex;justify-content:space-between;gap:12px;margin-bottom:9px;color:#453e50;font-size:13px;font-weight:500}.recall-editor-head span{color:var(--muted)}.recall-editor{display:block;min-height:300px;padding:17px;font-size:15px;line-height:1.8;resize:vertical}.recall-bottom-actions{margin-top:18px}.recall-help{align-self:start;padding:20px;background:#fdfbff}.recall-help h3{font-size:15px}.recall-help p{margin-top:10px;color:var(--muted);font-size:13px;line-height:1.7}.recall-help div{margin-top:17px;padding:12px;border-radius:8px;color:#75649e;background:#f4effa;font-size:12px}
.recall-template-status{margin:0 0 17px!important;color:#54846c;font-size:12px;line-height:1.5}.recall-template-status.error{color:#b8566d}.recall-slot-list{display:grid;gap:14px}.recall-slot-field{display:grid;gap:7px;color:#453e50;font-size:13px;font-weight:500}.recall-slot-field textarea{width:100%;min-height:82px;padding:12px;border:1px solid #ded7e2;border-radius:7px;background:#fff;color:var(--ink);font-size:14px;line-height:1.6;resize:vertical}
.recall-template-preview{margin:0 0 18px;padding:14px 16px;border:1px solid #e9e0ee;border-radius:8px;background:#fbf9fc}.recall-template-preview strong{color:#665394;font-size:12px}.recall-template-preview p{margin-top:7px;white-space:pre-wrap;overflow-wrap:anywhere;color:#514a59;font-size:13px;line-height:1.7}
.recall-result-head{padding:20px 23px;margin-bottom:15px}.recall-result-head h3{font-size:19px}.recall-result-head p{font-size:12px}.recall-counts,.recall-details>div{display:flex;flex-wrap:wrap;gap:7px}.recall-counts span,.recall-details>div span{padding:8px 10px;border-radius:7px;font-size:12px;font-weight:500}.recall-counts .missing,.recall-details .missing,.recall-answer .missing{color:#986126;background:#fff2dd}.recall-counts .wrong,.recall-details .wrong,.recall-answer .wrong{color:#aa4962;background:#ffe9ee}.recall-counts .extra,.recall-details .extra,.recall-answer .extra{color:#705caa;background:#f0ebfa}.recall-counts .correct{color:#518362;background:#eaf5ed}.recall-compare{display:grid;grid-template-columns:1fr 1fr;gap:15px}.recall-compare-panel{padding:22px}.recall-compare-panel h3{font-size:16px}.recall-compare-panel p{margin:5px 0 17px;color:var(--muted);font-size:12px}.recall-answer{min-height:85px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:2}.recall-answer .wrong{text-decoration:underline wavy;text-underline-offset:3px}.recall-details{margin-top:15px;padding:20px 22px}.recall-details h3{margin-bottom:12px;font-size:15px}.recall-details p{color:var(--muted);font-size:13px}.recall-save{margin-top:16px;padding:23px 25px}.recall-save-head{align-items:flex-start;margin-bottom:17px}.recall-save-head h3{font-size:16px}.recall-save-head p{font-size:12px}.recall-save-head>span{padding:8px 12px;border-radius:7px;color:#6f62a0;background:#f1ecfa;font-size:13px;font-weight:500;white-space:nowrap}.recall-save-time{width:100%;margin-bottom:17px}.recall-save-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:16px}.recall-field-label{display:block;margin-bottom:8px;color:#514a59;font-size:12px;font-weight:500}.recall-levels{display:flex;flex-wrap:wrap;gap:7px}.recall-levels label{cursor:pointer}.recall-levels input{position:absolute;width:1px;height:1px;opacity:0}.recall-levels span{display:inline-flex;align-items:center;min-height:40px;padding:0 14px;border:1px solid #ded7e2;border-radius:7px;color:#6d6671;font-size:13px;font-weight:500}.recall-levels input:checked + span{border-color:#bfb0dc;color:#6d5f9f;background:#f1ecfa}.recall-levels input:focus-visible + span{outline:2px solid #b99ded;outline-offset:2px}.recall-link select{min-height:40px;font-size:13px}.recall-save-foot{margin-top:17px}.recall-save-foot>span{color:var(--muted);font-size:12px;line-height:1.5}.recall-save-foot .recall-primary{white-space:nowrap}
.recall-result-part+.recall-result-part{margin-top:18px}.recall-result-part>h3{margin:0 0 9px;color:#665394;font-size:14px}
.recall-task-choice{display:grid;gap:8px;margin:0 0 18px}.recall-task-choice label{color:#514a59;font-size:12px;font-weight:500}.recall-task-choice select{width:100%;min-height:42px;padding:9px 11px;border:1px solid #ded7e2;border-radius:7px;color:var(--ink);background:#fff;font-size:13px}.recall-task-choice p{color:var(--muted);font-size:12px;line-height:1.5}
.recall-unassigned{display:grid;gap:10px;margin-top:22px;padding-top:20px;border-top:1px solid var(--line)}.recall-unassigned h3{font-size:15px}.recall-unassigned>p,.recall-unassigned small{color:var(--muted);font-size:12px;line-height:1.5}.recall-unassigned-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,260px) auto;align-items:center;gap:10px;padding:12px;border:1px solid var(--line);border-radius:8px}.recall-unassigned-row>span{overflow-wrap:anywhere;font-size:13px}.recall-unassigned-row select{min-width:0;min-height:39px;padding:8px 10px;border:1px solid #ded7e2;border-radius:7px;background:#fff;color:var(--ink);font-size:12px}.recall-unassigned .recall-assignment-status{color:#54846c}
.recall-page input:focus,.recall-page textarea:focus,.recall-page select:focus{outline:2px solid rgba(122,119,185,.42);outline-offset:1px}
@media(max-width:1050px){.recall-practice-grid{grid-template-columns:1fr}.recall-help{display:none}}
@media(max-width:850px){.recall-page{padding:25px 22px}.recall-compare,.recall-save-grid{grid-template-columns:1fr}.recall-entry{align-items:flex-start;flex-direction:column}.recall-entry-actions{width:100%}.recall-entry-actions .recall-primary{flex:1}}
@media(max-width:700px){.recall-page{padding:22px 15px}.recall-header{display:block}.recall-source{display:inline-block;margin-top:12px}.recall-steps button{justify-content:center;padding:9px 4px;font-size:11px}.recall-steps button span{width:20px;height:20px}.recall-choose,.recall-practice,.recall-compare-panel,.recall-save{padding:19px}.recall-section-head,.recall-result-head,.recall-toolbar,.recall-save-head,.recall-save-foot{align-items:stretch;flex-direction:column}.recall-head-actions{justify-content:flex-start}.recall-toolbar input{width:100%}.recall-preview{white-space:normal}.recall-unassigned-row{grid-template-columns:1fr}.recall-bottom-actions{align-items:stretch;flex-direction:column-reverse}.recall-bottom-actions button,.recall-save-foot button{width:100%}}
@media(max-width:440px){.recall-steps{gap:4px}.recall-steps button span{display:none}.recall-form-grid{grid-template-columns:1fr}.recall-form-grid .wide{grid-column:auto}.recall-options{display:grid}.recall-switch.timer{justify-content:space-between}}
</style>

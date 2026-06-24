import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildSchedule, currentPhase, defaultCarryover, defaultData, daysBetweenInclusive, normalizeData, progressPercent, taskSuggestion, todayIso } from './planner';
import { fetchGitHubData, saveGitHubData } from './github';
import type { CarryoverMode, Phase, Priority, StrategyType, StudyData, Task } from './types';
import './styles.css';

const DATA_KEY = 'pte-study-planner-data';
const GITHUB_CONFIG_KEY = 'pte-study-planner-github-config';
const strategyOptions: Array<{ value: StrategyType; label: string }> = [
  { value: 'phased_pool', label: '分阶段题库' },
  { value: 'fixed_pool', label: '固定范围题库' },
  { value: 'daily_fixed', label: '每日固定训练' },
  { value: 'memorization', label: '背诵熟悉型' },
];
const carryoverOptions: Array<{ value: CarryoverMode; label: string }> = [
  { value: 'adaptive_average', label: '动态均摊' },
  { value: 'none', label: '不累计' },
  { value: 'next_day', label: '全部累计到第二天' },
];
const priorityOptions: Array<{ value: Priority; label: string }> = [
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
];
const examTypes = ['RS', 'WFD', 'FIB', 'DI', 'WE', 'SST', 'RL'];

const loadData = (): StudyData => {
  const storedData = localStorage.getItem(DATA_KEY);
  const storedConfig = localStorage.getItem(GITHUB_CONFIG_KEY);
  const data = normalizeData(storedData ? JSON.parse(storedData) : defaultData());
  return { ...data, settings: { ...data.settings, ...(storedConfig ? JSON.parse(storedConfig) : {}) } };
};

function App() {
  const [data, setData] = useState<StudyData>(loadData);
  const [activeTab, setActiveTab] = useState('today');
  const schedule = useMemo(() => buildSchedule(data), [data]);
  const phase = currentPhase(schedule);
  const todayTasks = data.tasks.filter((task) => task.phaseId === phase?.id);
  const hasTasks = data.tasks.length > 0;
  const todayTarget = todayTasks.reduce((sum, task) => sum + taskSuggestion(task, phase), 0);
  const todayDone = (data.dailyLogs[todayIso()] || []).reduce((sum, log) => sum + log.amount, 0);
  const totalDone = data.tasks.reduce((sum, task) => sum + task.completedCount, 0);
  const totalTarget = data.tasks.reduce((sum, task) => sum + task.targetCount, 0);

  const saveLocal = (next: StudyData) => {
    const stamped = normalizeData({ ...next, updatedAt: new Date().toISOString() });
    setData(stamped);
    localStorage.setItem(DATA_KEY, JSON.stringify(stamped));
    const { githubOwner, githubRepo, githubBranch, githubPath } = stamped.settings;
    localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify({ githubOwner, githubRepo, githubBranch, githubPath }));
  };
  const updateTask = (id: string, patch: Partial<Task>) => saveLocal({ ...data, tasks: data.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) });
  const addAmount = (task: Task, amount: number) => {
    const safeAmount = Math.max(0, amount);
    if (!safeAmount) return;
    const today = todayIso();
    saveLocal({
      ...data,
      tasks: data.tasks.map((item) => item.id === task.id ? { ...item, completedCount: item.completedCount + safeAmount } : item),
      dailyLogs: { ...data.dailyLogs, [today]: [...(data.dailyLogs[today] || []), { taskId: task.id, amount: safeAmount }] },
    });
  };
  const githubConfig = { owner: data.settings.githubOwner, repo: data.settings.githubRepo, branch: data.settings.githubBranch, path: data.settings.githubPath };

  const askToken = () => new Promise<string>((resolve) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'modal';
    wrapper.innerHTML = '<form class="modal-box"><h3>输入 GitHub Token</h3><p>Token 只用于本次同步，不会保存。</p><input name="token" type="password" autocomplete="off" placeholder="fine-grained personal access token"/><div class="actions"><button type="submit">确认</button><button type="button" data-cancel="1">取消</button></div></form>';
    document.body.appendChild(wrapper);
    const input = wrapper.querySelector('input') as HTMLInputElement;
    input.focus();
    const done = (value: string) => { input.value = ''; wrapper.remove(); resolve(value); };
    wrapper.querySelector('form')?.addEventListener('submit', (event) => { event.preventDefault(); done(input.value); });
    wrapper.querySelector('[data-cancel]')?.addEventListener('click', () => done(''));
  });
  const pullFromGitHub = async () => {
    let token = await askToken();
    if (!token) return;
    try {
      const remote = normalizeData((await fetchGitHubData(githubConfig, token)).data);
      if (data.updatedAt > remote.updatedAt && !confirm('本地数据比 GitHub 数据更新。是否使用 GitHub 数据覆盖本地？')) return;
      saveLocal(remote);
      alert('已从 GitHub 拉取数据');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'GitHub 同步失败');
    } finally {
      token = '';
    }
  };
  const saveToGitHub = async () => {
    let token = await askToken();
    if (!token) return;
    try {
      const remote = normalizeData((await fetchGitHubData(githubConfig, token)).data);
      if (remote.updatedAt > data.updatedAt) {
        const choice = prompt('检测到 GitHub 数据更新。输入 1 使用 GitHub 覆盖本地；输入 2 使用本地覆盖 GitHub；其他取消同步。');
        if (choice === '1') { saveLocal(remote); return; }
        if (choice !== '2') return;
      }
      const stamped = normalizeData({ ...data, updatedAt: new Date().toISOString() });
      await saveGitHubData(githubConfig, token, stamped);
      saveLocal(stamped);
      alert('已保存到 GitHub');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'GitHub 同步失败');
    } finally {
      token = '';
    }
  };

  return <main>
    <header>
      <h1>PTE 备考进度调度器</h1>
      <p>专注回答“今天我要练什么”，只记录进度和计算任务，不上传题库。</p>
      <nav>{[['today', '今日任务'], ['progress', '整体进度'], ['settings', '计划设置'], ['sync', 'GitHub 同步']].map(([key, label]) => <button className={activeTab === key ? 'active' : ''} onClick={() => setActiveTab(key)} key={key}>{label}</button>)}</nav>
    </header>

    {activeTab === 'today' && <section className="card hero-card">
      <h2>今天我要练什么？</h2>
      <div className="metric-grid">
        <Metric label="今天日期" value={todayIso()} />
        <Metric label="当前阶段" value={phase?.name || '暂无阶段'} />
        <Metric label="距最终截止" value={`${daysBetweenInclusive(todayIso(), data.settings.deadline)} 天`} />
        <Metric label="今日总任务量" value={`${todayTarget} 题/篇/句`} />
      </div>
      {(!hasTasks || todayTasks.length === 0) ? <EmptyState /> : <>
        <h3>今日完成进度</h3>
        <Progress value={progressPercent(todayDone, todayTarget)} muted={todayTarget === 0} />
        <div className="task-list">{todayTasks.map((task) => <TodayTaskCard key={task.id} task={task} phase={phase} onAdd={addAmount} />)}</div>
      </>}
    </section>}

    {activeTab === 'progress' && <section className="card">
      <h2>整体进度</h2>
      {!hasTasks ? <EmptyState /> : <>
        <section className="summary-box"><b>总进度：{totalDone} / {totalTarget} / {progressPercent(totalDone, totalTarget)}%</b><Progress value={progressPercent(totalDone, totalTarget)} muted={totalTarget === 0} /></section>
        <h3>阶段进度</h3>
        {schedule.map((item) => {
          const phaseTasks = data.tasks.filter((task) => task.phaseId === item.id);
          const done = phaseTasks.reduce((sum, task) => sum + task.completedCount, 0);
          const target = phaseTasks.reduce((sum, task) => sum + task.targetCount, 0);
          return <section className="progress-item" key={item.id}><b>{item.name}</b><span>{item.startDate} ~ {item.endDate}</span><Progress value={progressPercent(done, target)} muted={target === 0} /><small>已完成 {done} / 总目标 {target} / {progressPercent(done, target)}%</small></section>;
        })}
        <h3>任务进度</h3>
        {data.tasks.map((task) => <TaskProgress key={task.id} task={task} />)}
      </>}
    </section>}

    {activeTab === 'settings' && <section className="card">
      <h2>计划设置</h2>
      <div className="form-grid three"><label>计划开始日期<input type="date" value={data.settings.startDate} onChange={(event) => saveLocal({ ...data, settings: { ...data.settings, startDate: event.target.value } })} /></label><label>最终截止日期<input type="date" value={data.settings.deadline} onChange={(event) => saveLocal({ ...data, settings: { ...data.settings, deadline: event.target.value } })} /></label><label>缓冲天数<input type="number" min="0" value={data.settings.bufferDays} onChange={(event) => saveLocal({ ...data, settings: { ...data.settings, bufferDays: Number(event.target.value) } })} /></label></div>
      <h3>阶段</h3>
      <p className="hint">阶段日期由开始日期、截止日期、缓冲天数和各阶段任务量自动计算。</p>
      {schedule.map((item) => <div className="phase-row" key={item.id}><input value={item.name} onChange={(event) => saveLocal({ ...data, phases: data.phases.map((phaseItem) => phaseItem.id === item.id ? { ...phaseItem, name: event.target.value } : phaseItem) })} /><span>{item.startDate} ~ {item.endDate}</span><span>任务量 {item.totalWork}</span><button onClick={() => saveLocal({ ...data, phases: data.phases.filter((phaseItem) => phaseItem.id !== item.id), tasks: data.tasks.filter((task) => task.phaseId !== item.id) })}>删除</button></div>)}
      <button onClick={() => saveLocal({ ...data, phases: [...data.phases, { id: crypto.randomUUID(), name: '新阶段', order: data.phases.length + 1 }] })}>新增阶段</button>
      <h3>任务</h3>
      <button onClick={() => saveLocal({ ...data, tasks: [...data.tasks, createTask(data.phases[0]?.id || '')] })}>新增任务</button>
      {data.tasks.length === 0 ? <EmptyState /> : data.tasks.map((task) => <TaskEditor key={task.id} task={task} phases={data.phases} onChange={(patch) => updateTask(task.id, patch)} onDelete={() => saveLocal({ ...data, tasks: data.tasks.filter((item) => item.id !== task.id) })} />)}
    </section>}

    {activeTab === 'sync' && <section className="card">
      <h2>GitHub 同步设置</h2>
      <div className="form-grid two">
        <label>GitHub 用户名 / Owner<input value={data.settings.githubOwner} onChange={(event) => saveLocal({ ...data, settings: { ...data.settings, githubOwner: event.target.value } })} /></label>
        <label>数据仓库名<input value={data.settings.githubRepo} onChange={(event) => saveLocal({ ...data, settings: { ...data.settings, githubRepo: event.target.value } })} /></label>
        <label>分支名<input value={data.settings.githubBranch} onChange={(event) => saveLocal({ ...data, settings: { ...data.settings, githubBranch: event.target.value } })} /></label>
        <label>数据文件路径<input value={data.settings.githubPath} onChange={(event) => saveLocal({ ...data, settings: { ...data.settings, githubPath: event.target.value } })} /></label>
      </div>
      <p className="warn">Token 每次同步时手动输入，只临时存在于输入框和函数局部变量中；不会保存到 localStorage、sessionStorage 或 data.json，也不会输出到 console。</p>
      <div className="actions"><button onClick={pullFromGitHub}>从 GitHub 拉取数据</button><button onClick={saveToGitHub}>保存到 GitHub</button></div>
    </section>}
  </main>;
}

function createTask(phaseId: string): Task {
  return { id: crypto.randomUUID(), taskName: 'RS 超高频', examType: 'RS', phaseId, strategyType: 'phased_pool', targetCount: 200, completedCount: 0, fixedDailyCount: 0, carryoverMode: 'adaptive_average', priority: 'high' };
}
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><b>{value}</b></div>; }
function EmptyState() { return <p className="empty">暂无任务，请先在计划设置中添加任务。</p>; }
function Progress({ value, muted = false }: { value: number; muted?: boolean }) { return <div className={`progress ${muted ? 'muted' : ''}`}><span style={{ width: `${value}%` }} /><em>{value}%</em></div>; }
function TaskProgress({ task }: { task: Task }) { const percent = progressPercent(task.completedCount, task.targetCount); return <section className="progress-item"><b>{task.taskName} · {task.examType}</b><Progress value={percent} muted={task.targetCount === 0} /><small>已完成 {task.completedCount} / 目标 {task.targetCount} / 剩余 {Math.max(0, task.targetCount - task.completedCount)} / {percent}%</small></section>; }
function TodayTaskCard({ task, phase, onAdd }: { task: Task; phase: ReturnType<typeof currentPhase>; onAdd: (task: Task, amount: number) => void }) { const suggestion = taskSuggestion(task, phase); const percent = progressPercent(task.completedCount, task.targetCount); return <article className="task-card"><div><h3>{task.taskName}</h3><p>今日建议 <b>{suggestion}</b>，已完成 {task.completedCount} / {task.targetCount}，剩余 {Math.max(0, task.targetCount - task.completedCount)}，进度 {percent}%</p><Progress value={percent} muted={task.targetCount === 0} /></div><div className="actions">{[1, 5, 10].map((amount) => <button onClick={() => onAdd(task, amount)} key={amount}>+{amount}</button>)}<button onClick={() => onAdd(task, Number(prompt('输入完成量') || 0))}>手动输入</button></div></article>; }
function TaskEditor({ task, phases, onChange, onDelete }: { task: Task; phases: Phase[]; onChange: (patch: Partial<Task>) => void; onDelete: () => void }) { return <article className="task-editor"><label>任务名称<input value={task.taskName} onChange={(event) => onChange({ taskName: event.target.value })} /></label><label>题型<select value={task.examType} onChange={(event) => onChange({ examType: event.target.value })}>{examTypes.map((type) => <option key={type}>{type}</option>)}</select></label><label>所属阶段<select value={task.phaseId} onChange={(event) => onChange({ phaseId: event.target.value })}>{phases.map((phase) => <option value={phase.id} key={phase.id}>{phase.name}</option>)}</select></label><label>策略类型<select value={task.strategyType} onChange={(event) => { const strategyType = event.target.value as StrategyType; onChange({ strategyType, carryoverMode: defaultCarryover(strategyType) }); }}>{strategyOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label>目标数量<input type="number" min="0" value={task.targetCount} onChange={(event) => onChange({ targetCount: Number(event.target.value) })} /></label><label>已完成数量<input type="number" min="0" value={task.completedCount} onChange={(event) => onChange({ completedCount: Number(event.target.value) })} /></label><label>每日固定数量<input type="number" min="0" value={task.fixedDailyCount} onChange={(event) => onChange({ fixedDailyCount: Number(event.target.value) })} /></label><label>累计模式<select value={task.carryoverMode} onChange={(event) => onChange({ carryoverMode: event.target.value as CarryoverMode })}>{carryoverOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label>优先级<select value={task.priority} onChange={(event) => onChange({ priority: event.target.value as Priority })}>{priorityOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><button className="danger" onClick={onDelete}>删除任务</button></article>; }

createRoot(document.getElementById('root')!).render(<App />);

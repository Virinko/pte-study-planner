import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildSchedule, currentPhase, defaultCarryover, defaultData, daysBetweenInclusive, normalizeData, progressPercent, taskSuggestion, todayIso } from './planner';
import { fetchGitHubData, saveGitHubData } from './github';
import type { CarryoverMode, Phase, Priority, StrategyType, StudyData, Task } from './types';
import './styles.css';

const DATA_KEY = 'pte-study-planner-data';
const GITHUB_CONFIG_KEY = 'pte-study-planner-github-config';
const strategyOptions: Array<{ value: StrategyType; label: string }> = [
  { value: 'phased_pool', label: 'phased_pool' },
  { value: 'fixed_pool', label: 'fixed_pool' },
  { value: 'daily_fixed', label: 'daily_fixed' },
  { value: 'memorization', label: 'memorization' },
];
const carryoverOptions: Array<{ value: CarryoverMode; label: string }> = [
  { value: 'adaptive_average', label: 'adaptive_average' },
  { value: 'none', label: 'none' },
  { value: 'next_day', label: 'next_day' },
];
const priorityOptions: Array<{ value: Priority; label: string }> = [
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
];
const examTypes = ['RS', 'WFD', 'FIB', 'DI', 'WE', 'SST', 'RL'];
const examColors: Record<string, string> = { RS: 'blue', WFD: 'green', WE: 'orange', DI: 'purple', FIB: 'cyan', SST: 'pink', RL: 'indigo' };

const loadData = (): StudyData => {
  try {
    const storedData = localStorage.getItem(DATA_KEY);
    const storedConfig = localStorage.getItem(GITHUB_CONFIG_KEY);
    const data = normalizeData(storedData ? JSON.parse(storedData) : defaultData());
    return { ...data, settings: { ...data.settings, ...(storedConfig ? JSON.parse(storedConfig) : {}) } };
  } catch {
    return defaultData();
  }
};

function App() {
  const [data, setData] = useState<StudyData>(loadData);
  const [activeTab, setActiveTab] = useState('today');
  const [syncToken, setSyncToken] = useState('');
  const [syncLog, setSyncLog] = useState('暂无同步记录');
  const schedule = useMemo(() => buildSchedule(data), [data]);
  const phase = currentPhase(schedule);
  const todayTasks = data.tasks.filter((task) => task.phaseId === phase?.id);
  const hasTasks = data.tasks.length > 0;
  const todayTarget = todayTasks.reduce((sum, task) => sum + taskSuggestion(task, phase), 0);
  const todayDone = (data.dailyLogs[todayIso()] || []).reduce((sum, log) => sum + log.amount, 0);
  const totalDone = data.tasks.reduce((sum, task) => sum + task.completedCount, 0);
  const totalTarget = data.tasks.reduce((sum, task) => sum + task.targetCount, 0);
  const remainingTotal = Math.max(0, totalTarget - totalDone);
  const totalDays = Math.max(0, daysBetweenInclusive(todayIso(), data.settings.deadline));
  const githubConfig = { owner: data.settings.githubOwner, repo: data.settings.githubRepo, branch: data.settings.githubBranch, path: data.settings.githubPath };

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
  const requireToken = () => {
    if (!syncToken) alert('请先输入本次同步 Token。Token 不会保存，同步结束后会清空。');
    return syncToken;
  };
  const pullFromGitHub = async () => {
    let token = requireToken();
    if (!token) return;
    try {
      const remote = normalizeData((await fetchGitHubData(githubConfig, token)).data);
      if (data.updatedAt > remote.updatedAt && !confirm('本地数据比 GitHub 数据更新。是否使用 GitHub 数据覆盖本地？')) return;
      saveLocal(remote);
      setSyncLog(`成功从 GitHub 拉取数据 · ${new Date().toLocaleString()}`);
      alert('已从 GitHub 拉取数据');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'GitHub 同步失败');
    } finally {
      token = '';
      setSyncToken('');
    }
  };
  const saveToGitHub = async () => {
    let token = requireToken();
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
      setSyncLog(`成功保存到 GitHub · ${new Date().toLocaleString()}`);
      alert('已保存到 GitHub');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'GitHub 同步失败');
    } finally {
      token = '';
      setSyncToken('');
    }
  };

  return <main>
    <TopBar activeTab={activeTab} onTabChange={setActiveTab} />

    {activeTab === 'today' && <section className="page-shell">
      <div className="metric-grid today-metrics">
        <Metric icon="📅" label="今天" value={todayIso()} tone="blue" />
        <Metric icon="⚑" label="当前阶段" value={phase?.name || '暂无阶段'} tone="green" />
        <Metric icon="⏳" label="距截止" value={`${totalDays} 天`} tone="orange" />
        <Metric icon="📋" label="今日总任务" value={`${todayTarget}`} tone="purple" />
      </div>
      <Panel title="今日任务清单">
        {(!hasTasks || todayTasks.length === 0) ? <EmptyState /> : <div className="task-list">{todayTasks.map((task) => <TodayTaskCard key={task.id} task={task} phase={phase} onAdd={addAmount} />)}</div>}
      </Panel>
      <Panel className="today-footer">
        <div className="footer-progress"><b>今日完成进度</b><Progress value={progressPercent(todayDone, todayTarget)} muted={todayTarget === 0} /></div>
        <span className="encourage">⭐ 继续加油，稳步前进！</span>
      </Panel>
    </section>}

    {activeTab === 'progress' && <section className="page-shell progress-layout">
      {!hasTasks ? <Panel><EmptyState /></Panel> : <>
        <Panel className="overall-card">
          <Donut value={progressPercent(totalDone, totalTarget)} />
          <div><span className="muted-label">总进度</span><h2>{totalDone} <small>/ {totalTarget} · {progressPercent(totalDone, totalTarget)}%</small></h2><p>已完成 {totalDone} 题/项，共 {totalTarget} 题/项</p></div>
          <TrendCard />
        </Panel>
        <Panel title="阶段进度">
          {schedule.map((item) => {
            const phaseTasks = data.tasks.filter((task) => task.phaseId === item.id);
            const done = phaseTasks.reduce((sum, task) => sum + task.completedCount, 0);
            const target = phaseTasks.reduce((sum, task) => sum + task.targetCount, 0);
            return <ProgressRow key={item.id} title={item.name} done={done} target={target} color="blue" meta={`${item.startDate} ~ ${item.endDate}`} />;
          })}
        </Panel>
        <Panel title="题型任务进度">
          {data.tasks.map((task) => <ProgressRow key={task.id} title={`${task.taskName}`} done={task.completedCount} target={task.targetCount} color={examColors[task.examType] || 'blue'} badge={task.examType} />)}
        </Panel>
        <div className="stat-strip">
          <Metric icon="☷" label="当前总任务" value={`${totalTarget}`} tone="blue" />
          <Metric icon="✓" label="已完成" value={`${totalDone}`} tone="green" />
          <Metric icon="◷" label="剩余" value={`${remainingTotal}`} tone="blue" />
          <Metric icon="🗓" label="计划总天数" value={`${daysBetweenInclusive(data.settings.startDate, data.settings.deadline)} 天`} tone="purple" />
        </div>
      </>}
    </section>}

    {activeTab === 'settings' && <section className="page-shell">
      <div className="setting-summary">
        <SettingCard icon="🗓" label="开始日期" value={data.settings.startDate} onChange={(value) => saveLocal({ ...data, settings: { ...data.settings, startDate: value } })} type="date" />
        <SettingCard icon="📅" label="最终截止日期" value={data.settings.deadline} onChange={(value) => saveLocal({ ...data, settings: { ...data.settings, deadline: value } })} type="date" />
        <SettingCard icon="🛡" label="缓冲天数" value={String(data.settings.bufferDays)} onChange={(value) => saveLocal({ ...data, settings: { ...data.settings, bufferDays: Number(value) } })} type="number" />
      </div>
      <Panel title="阶段" action={<button onClick={() => saveLocal({ ...data, phases: [...data.phases, { id: crypto.randomUUID(), name: '新阶段', order: data.phases.length + 1 }] })}>＋ 新增阶段</button>}>
        <div className="phase-grid">{schedule.map((item) => <article className={`phase-card ${item.totalWork === 0 ? 'empty-phase' : ''}`} key={item.id}><input value={item.name} onChange={(event) => saveLocal({ ...data, phases: data.phases.map((phaseItem) => phaseItem.id === item.id ? { ...phaseItem, name: event.target.value } : phaseItem) })} /><span>自动分配天数 <b>{item.days} 天</b></span><small>预计日期范围 {item.startDate} ~ {item.endDate}</small><button className="ghost danger-text" onClick={() => saveLocal({ ...data, phases: data.phases.filter((phaseItem) => phaseItem.id !== item.id), tasks: data.tasks.filter((task) => task.phaseId !== item.id) })}>删除阶段</button></article>)}</div>
        {!hasTasks && <p className="tip">💡 提示：请先添加任务，阶段天数会根据各阶段总任务量自动调整。</p>}
      </Panel>
      <Panel title="任务" action={<button onClick={() => saveLocal({ ...data, tasks: [...data.tasks, createTask(data.phases[0]?.id || '')] })}>＋ 新增任务</button>}>
        {data.tasks.length === 0 ? <EmptyState /> : <div className="table-wrap"><table><thead><tr><th>任务名称</th><th>题型</th><th>所属阶段</th><th>策略类型</th><th>目标数量</th><th>已完成</th><th>每日固定数量</th><th>累积方式</th><th>优先级</th><th>操作</th></tr></thead><tbody>{data.tasks.map((task) => <TaskRow key={task.id} task={task} phases={data.phases} onChange={(patch) => updateTask(task.id, patch)} onDelete={() => saveLocal({ ...data, tasks: data.tasks.filter((item) => item.id !== task.id) })} />)}</tbody></table></div>}
      </Panel>
    </section>}

    {activeTab === 'sync' && <section className="page-shell sync-layout">
      <Panel>
        <SyncField icon="👤" label="GitHub 用户名 / Owner" value={data.settings.githubOwner} onChange={(value) => saveLocal({ ...data, settings: { ...data.settings, githubOwner: value } })} />
        <SyncField icon="💻" label="数据仓库名" value={data.settings.githubRepo} onChange={(value) => saveLocal({ ...data, settings: { ...data.settings, githubRepo: value } })} />
        <SyncField icon="⑂" label="分支名" value={data.settings.githubBranch} onChange={(value) => saveLocal({ ...data, settings: { ...data.settings, githubBranch: value } })} />
        <SyncField icon="▣" label="数据文件路径" value={data.settings.githubPath} onChange={(value) => saveLocal({ ...data, settings: { ...data.settings, githubPath: value } })} />
        <p className="token-warning">🛡 Token 每次同步时手动输入，不保存到 localStorage、sessionStorage、data.json 或代码。</p>
      </Panel>
      <div className="sync-side">
        <Panel title="本次同步 Token">
          <div className="password-row"><input type="password" value={syncToken} onChange={(event) => setSyncToken(event.target.value)} autoComplete="off" placeholder="fine-grained personal access token" /><span>◉</span></div>
          <small>同步完成后立即清空</small>
        </Panel>
        <button className="sync-button pull" onClick={pullFromGitHub}>☁ 从 GitHub 拉取数据</button>
        <button className="sync-button push" onClick={saveToGitHub}>☁ 保存到 GitHub</button>
      </div>
      <Panel title="同步记录" className="sync-log"><p>✅ {syncLog}</p></Panel>
    </section>}
  </main>;
}

function TopBar({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) {
  const tabs = [['today', '今日任务'], ['progress', '整体进度'], ['settings', '计划设置'], ['sync', 'GitHub 同步']];
  return <header className="topbar"><div className="brand"><span className="logo">P</span><b>PTE 备考进度调度器</b></div><nav>{tabs.map(([key, label]) => <button className={activeTab === key ? 'active' : ''} onClick={() => onTabChange(key)} key={key}>{label}</button>)}</nav><span className="bell">♧</span></header>;
}
function createTask(phaseId: string): Task { return { id: crypto.randomUUID(), taskName: 'RS 超高频', examType: 'RS', phaseId, strategyType: 'phased_pool', targetCount: 200, completedCount: 0, fixedDailyCount: 0, carryoverMode: 'adaptive_average', priority: 'high' }; }
function Panel({ title, action, className = '', children }: { title?: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) { return <section className={`panel ${className}`}>{(title || action) && <div className="panel-head"><h2>{title}</h2>{action}</div>}{children}</section>; }
function Metric({ icon, label, value, tone }: { icon: string; label: string; value: string; tone: string }) { return <article className="metric"><span className={`metric-icon ${tone}`}>{icon}</span><div><small>{label}</small><b>{value}</b></div></article>; }
function EmptyState() { return <p className="empty">暂无任务，请先在计划设置中添加任务。</p>; }
function Progress({ value, muted = false, color = 'blue' }: { value: number; muted?: boolean; color?: string }) { return <div className={`progress ${muted ? 'muted' : ''}`}><span className={color} style={{ width: `${value}%` }} /></div>; }
function Donut({ value }: { value: number }) { return <div className="donut" style={{ background: `conic-gradient(#0b72f0 ${value * 3.6}deg,#edf1f7 0deg)` }}><span>{value}%</span></div>; }
function TrendCard() { return <div className="trend-card"><b>近7天完成趋势</b><svg viewBox="0 0 260 92"><polyline points="8,70 50,62 94,48 134,40 176,58 218,28 252,34" fill="none" stroke="#0b72f0" strokeWidth="4"/><g fill="#0b72f0">{[[8,70],[50,62],[94,48],[134,40],[176,58],[218,28],[252,34]].map(([cx,cy])=><circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4" />)}</g></svg></div>; }
function ProgressRow({ title, done, target, color, meta, badge }: { title: string; done: number; target: number; color: string; meta?: string; badge?: string }) { const percent = progressPercent(done, target); return <article className="progress-row">{badge && <span className={`badge ${color}`}>{badge}</span>}<div><b>{title}</b>{meta && <small>{meta}</small>}<Progress value={percent} muted={target === 0} color={color} /></div><span>{done} / {target}</span><em>{percent}%</em></article>; }
function TodayTaskCard({ task, phase, onAdd }: { task: Task; phase: ReturnType<typeof currentPhase>; onAdd: (task: Task, amount: number) => void }) { const suggestion = taskSuggestion(task, phase); const percent = progressPercent(task.completedCount, task.targetCount); const color = examColors[task.examType] || 'blue'; return <article className="today-task"><span className={`task-avatar ${color}`}>{task.examType}</span><div className="task-title"><b>{task.taskName}</b><small>今日建议 {suggestion} {task.strategyType === 'memorization' ? '篇' : '题'}</small></div><div><small>已完成</small><b>{task.completedCount} <small>/ {task.targetCount}</small></b><Progress value={percent} muted={task.targetCount === 0} color={color} /></div><div><small>剩余</small><b>{Math.max(0, task.targetCount - task.completedCount)}</b></div><div><small>进度</small><b>{percent}%</b></div><div className="quick"><small>快捷记录</small><div className="quick-buttons">{[1, 5, 10].map((amount) => <button onClick={() => onAdd(task, amount)} key={amount}>+{amount}</button>)}<button onClick={() => onAdd(task, Number(prompt('输入完成量') || 0))}>✎ 手动输入</button></div></div></article>; }
function SettingCard({ icon, label, value, type, onChange }: { icon: string; label: string; value: string; type: string; onChange: (value: string) => void }) { return <article className="setting-card"><span>{icon}</span><label>{label}<input type={type} value={value} min="0" onChange={(event) => onChange(event.target.value)} /></label><b>›</b></article>; }
function SyncField({ icon, label, value, onChange }: { icon: string; label: string; value: string; onChange: (value: string) => void }) { return <label className="sync-field"><span>{icon}</span><div>{label}<input value={value} onChange={(event) => onChange(event.target.value)} /></div></label>; }
function TaskRow({ task, phases, onChange, onDelete }: { task: Task; phases: Phase[]; onChange: (patch: Partial<Task>) => void; onDelete: () => void }) { return <tr><td><input value={task.taskName} onChange={(event) => onChange({ taskName: event.target.value })} /></td><td><select value={task.examType} onChange={(event) => onChange({ examType: event.target.value })}>{examTypes.map((type) => <option key={type}>{type}</option>)}</select></td><td><select value={task.phaseId} onChange={(event) => onChange({ phaseId: event.target.value })}>{phases.map((phase) => <option value={phase.id} key={phase.id}>{phase.name.replace(/^第.阶段：/, '')}</option>)}</select></td><td><select value={task.strategyType} onChange={(event) => { const strategyType = event.target.value as StrategyType; onChange({ strategyType, carryoverMode: defaultCarryover(strategyType) }); }}>{strategyOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></td><td><input type="number" min="0" value={task.targetCount} onChange={(event) => onChange({ targetCount: Number(event.target.value) })} /></td><td><input type="number" min="0" value={task.completedCount} onChange={(event) => onChange({ completedCount: Number(event.target.value) })} /></td><td><input type="number" min="0" value={task.fixedDailyCount} onChange={(event) => onChange({ fixedDailyCount: Number(event.target.value) })} /></td><td><select value={task.carryoverMode} onChange={(event) => onChange({ carryoverMode: event.target.value as CarryoverMode })}>{carryoverOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></td><td><select className={`priority ${task.priority}`} value={task.priority} onChange={(event) => onChange({ priority: event.target.value as Priority })}>{priorityOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></td><td><button className="ghost" onClick={onDelete}>🗑</button></td></tr>; }

createRoot(document.getElementById('root')!).render(<App />);

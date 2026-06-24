import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildSchedule, currentPhase, daysBetweenInclusive, defaultData, pct, taskSuggestion, todayIso } from './planner';
import { fetchGitHubData, saveGitHubData } from './github';
import type { CarryoverMode, Phase, StrategyType, StudyData, Task } from './types';
import './styles.css';

const KEY = 'pte-study-planner-data';
const GITHUB_KEY = 'pte-study-planner-github-config';
const strategies: StrategyType[] = ['phased_pool', 'fixed_pool', 'daily_fixed', 'memorization'];
const modes: CarryoverMode[] = ['adaptive_average', 'none', 'next_day'];
const load = (): StudyData => { const base = defaultData(); try { const raw = localStorage.getItem(KEY); const cfg = localStorage.getItem(GITHUB_KEY); return { ...(raw ? JSON.parse(raw) : base), settings: { ...base.settings, ...(raw ? JSON.parse(raw).settings : {}), ...(cfg ? JSON.parse(cfg) : {}) } }; } catch { return base; } };

function App() {
  const [data, setData] = useState<StudyData>(load);
  const [tab, setTab] = useState('today');
  const schedule = useMemo(() => buildSchedule(data), [data]);
  const phase = currentPhase(schedule);
  const todayTasks = data.tasks.filter((t) => t.phaseId === phase?.id);
  const saveLocal = (next: StudyData) => { const stamped = { ...next, updatedAt: new Date().toISOString() }; setData(stamped); localStorage.setItem(KEY, JSON.stringify(stamped)); const { githubOwner, githubRepo, githubBranch, githubPath } = stamped.settings; localStorage.setItem(GITHUB_KEY, JSON.stringify({ githubOwner, githubRepo, githubBranch, githubPath })); };
  const updateTask = (id: string, patch: Partial<Task>) => saveLocal({ ...data, tasks: data.tasks.map((t) => t.id === id ? { ...t, ...patch } : t) });
  const addAmount = (task: Task, amount: number) => { const n = Math.max(0, amount); const log = data.dailyLogs[todayIso()] || []; saveLocal({ ...data, tasks: data.tasks.map((t) => t.id === task.id ? { ...t, completed: t.completed + n } : t), dailyLogs: { ...data.dailyLogs, [todayIso()]: [...log, { taskId: task.id, amount: n }] } }); };
  const ghConfig = { owner: data.settings.githubOwner, repo: data.settings.githubRepo, branch: data.settings.githubBranch, path: data.settings.githubPath };

  const askToken = () => new Promise<string>((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = '<form class="modal-box"><h3>输入 GitHub Token</h3><p>Token 不会被保存，同步结束后会清空。</p><input name="token" type="password" autocomplete="off" placeholder="fine-grained personal access token"/><div class="actions"><button type="submit">确认</button><button type="button" data-cancel="1">取消</button></div></form>';
    document.body.appendChild(wrap);
    const input = wrap.querySelector('input') as HTMLInputElement;
    input.focus();
    const done = (value: string) => { input.value = ''; wrap.remove(); resolve(value); };
    wrap.querySelector('form')!.addEventListener('submit', (e) => { e.preventDefault(); done(input.value); });
    wrap.querySelector('[data-cancel]')!.addEventListener('click', () => done(''));
  });
  const pull = async () => { let token = await askToken(); if (!token) return; try { const remote = (await fetchGitHubData(ghConfig, token)).data; const localNewer = data.updatedAt && remote.updatedAt && data.updatedAt > remote.updatedAt; if (localNewer && !confirm('本地数据比 GitHub 更新。确定使用 GitHub 数据覆盖本地？取消则停止同步。')) return; saveLocal(remote); alert('已从 GitHub 拉取数据'); } catch (e) { alert(e instanceof Error ? e.message : '同步失败'); } finally { token = ''; } };
  const push = async () => { let token = await askToken(); if (!token) return; try { const remote = (await fetchGitHubData(ghConfig, token)).data; if (remote.updatedAt > data.updatedAt) { const choice = prompt('检测到 GitHub 数据更新。输入 1 使用 GitHub 覆盖本地；输入 2 使用本地覆盖 GitHub；其他取消'); if (choice === '1') { saveLocal(remote); return; } if (choice !== '2') return; } const stamped = { ...data, updatedAt: new Date().toISOString() }; await saveGitHubData(ghConfig, token, stamped); saveLocal(stamped); alert('已保存到 GitHub'); } catch (e) { alert(e instanceof Error ? e.message : '同步失败'); } finally { token = ''; } };
  const overallDone = data.tasks.reduce((s, t) => s + t.completed, 0), overallTarget = data.tasks.reduce((s, t) => s + t.target, 0);

  return <main><header><h1>PTE 备考进度调度器</h1><p>只记录进度、计算每日任务；数据默认保存在本机，可手动同步到私有 GitHub 仓库。</p><nav>{[['today','今日任务'],['progress','整体进度'],['settings','计划设置'],['sync','GitHub 同步']].map(([k,v])=><button className={tab===k?'active':''} onClick={()=>setTab(k)} key={k}>{v}</button>)}</nav></header>
  {tab==='today' && <section className="card"><h2>今日任务</h2><div className="grid"><b>今天：{todayIso()}</b><b>当前阶段：{phase?.name || '暂无'}</b><b>距截止：{daysBetweenInclusive(todayIso(), data.settings.deadline)} 天</b></div>{todayTasks.length===0?<p>请先在计划设置中添加任务。</p>:todayTasks.map(t=>{ const sug=taskSuggestion(t, phase); return <div className="task" key={t.id}><div><h3>{t.name}</h3><p>建议今日完成 {sug}；已完成 {t.completed}/{t.target}</p><Progress value={pct(t.completed,t.target)}/></div><div className="actions">{[1,5,10].map(n=><button onClick={()=>addAmount(t,n)} key={n}>+{n}</button>)}<button onClick={()=>addAmount(t, Number(prompt('输入完成量')||0))}>手动输入</button></div></div>})}<h3>今日完成进度</h3><Progress value={pct((data.dailyLogs[todayIso()]||[]).reduce((s,l)=>s+l.amount,0), todayTasks.reduce((s,t)=>s+taskSuggestion(t,phase),0))}/></section>}
  {tab==='progress' && <section className="card"><h2>整体进度</h2><Progress value={pct(overallDone,overallTarget)}/><p>{overallDone} / {overallTarget}，剩余 {Math.max(0,overallTarget-overallDone)}，{pct(overallDone,overallTarget)}%</p><h3>阶段进度</h3>{schedule.map(p=>{const ts=data.tasks.filter(t=>t.phaseId===p.id),d=ts.reduce((s,t)=>s+t.completed,0),tar=ts.reduce((s,t)=>s+t.target,0);return <div key={p.id}><b>{p.name}（{p.startDate} ~ {p.endDate}）</b><Progress value={pct(d,tar)}/><p>{d}/{tar}</p></div>})}<h3>题型任务进度</h3>{data.tasks.map(t=><div key={t.id}><b>{t.name}</b><Progress value={pct(t.completed,t.target)}/><p>已完成 {t.completed} / 目标 {t.target} / 剩余 {Math.max(0,t.target-t.completed)} / {pct(t.completed,t.target)}%</p></div>)}</section>}
  {tab==='settings' && <section className="card"><h2>计划设置</h2><label>开始日期<input type="date" value={data.settings.startDate} onChange={e=>saveLocal({...data,settings:{...data.settings,startDate:e.target.value}})}/></label><label>最终截止日期<input type="date" value={data.settings.deadline} onChange={e=>saveLocal({...data,settings:{...data.settings,deadline:e.target.value}})}/></label><label>缓冲天数<input type="number" value={data.settings.bufferDays} onChange={e=>saveLocal({...data,settings:{...data.settings,bufferDays:+e.target.value}})}/></label><h3>阶段</h3>{data.phases.map(p=><div className="row" key={p.id}><input value={p.name} onChange={e=>saveLocal({...data,phases:data.phases.map(x=>x.id===p.id?{...x,name:e.target.value}:x)})}/><button onClick={()=>saveLocal({...data,phases:data.phases.filter(x=>x.id!==p.id),tasks:data.tasks.filter(t=>t.phaseId!==p.id)})}>删除</button></div>)}<button onClick={()=>saveLocal({...data,phases:[...data.phases,{id:crypto.randomUUID(),name:'新阶段',order:data.phases.length+1}]})}>新增阶段</button><h3>任务</h3><button onClick={()=>saveLocal({...data,tasks:[...data.tasks,{id:crypto.randomUUID(),phaseId:data.phases[0]?.id||'',name:'RS',strategy:'phased_pool',target:100,completed:0,dailyFixed:10,carryoverMode:'adaptive_average'}]})}>新增任务</button>{data.tasks.map(t=><TaskEditor key={t.id} task={t} phases={data.phases} onChange={p=>updateTask(t.id,p)} onDelete={()=>saveLocal({...data,tasks:data.tasks.filter(x=>x.id!==t.id)})}/>)}</section>}
  {tab==='sync' && <section className="card"><h2>GitHub 同步设置</h2>{(['githubOwner','githubRepo','githubBranch','githubPath'] as const).map(k=><label key={k}>{k}<input value={data.settings[k]} onChange={e=>saveLocal({...data,settings:{...data.settings,[k]:e.target.value}})}/></label>)}<p className="warn">Token 每次同步手动输入，不保存到 localStorage、sessionStorage、data.json 或代码。</p><button onClick={pull}>从 GitHub 拉取数据</button><button onClick={push}>保存到 GitHub</button></section>}
  </main>;
}
function Progress({value}:{value:number}){return <div className="progress"><span style={{width:`${value}%`}}/><em>{value}%</em></div>}
function TaskEditor({task,phases,onChange,onDelete}:{task:Task;phases:Phase[];onChange:(p:Partial<Task>)=>void;onDelete:()=>void}){return <div className="editor"><input value={task.name} onChange={e=>onChange({name:e.target.value})}/><select value={task.phaseId} onChange={e=>onChange({phaseId:e.target.value})}>{phases.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select><select value={task.strategy} onChange={e=>{const strategy=e.target.value as StrategyType;onChange({strategy,carryoverMode: strategy==='daily_fixed'?'none':'adaptive_average'});}}>{strategies.map(s=><option key={s}>{s}</option>)}</select><select value={task.carryoverMode} onChange={e=>onChange({carryoverMode:e.target.value as CarryoverMode})}>{modes.map(m=><option key={m}>{m}</option>)}</select><label>目标<input type="number" value={task.target} onChange={e=>onChange({target:+e.target.value})}/></label><label>已完成<input type="number" value={task.completed} onChange={e=>onChange({completed:+e.target.value})}/></label><label>每日固定<input type="number" value={task.dailyFixed} onChange={e=>onChange({dailyFixed:+e.target.value})}/></label><button onClick={onDelete}>删除任务</button></div>}

createRoot(document.getElementById('root')!).render(<App />);

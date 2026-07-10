const PROGRESS_KEY = 'progress';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  },
});

const emptyProgress = () => ({
  version: 1,
  updatedAt: '',
  settings: {},
  phases: [],
  tasks: [],
  dailyLogs: {},
  dailyTargets: {},
  dailyNotes: {},
  reviewPlans: {},
  skippedReviewRegistrations: {},
  timeLogs: {},
  studyTimeEntries: [],
});

function isAuthorized(request, env) {
  const password = request.headers.get('x-app-password') || '';
  return Boolean(env.APP_PASSWORD) && password === env.APP_PASSWORD;
}

export async function onRequestGet({ request, env }) {
  if (!isAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);

  const stored = await env.PROGRESS_KV.get(PROGRESS_KEY, 'json');
  return json(stored || emptyProgress());
}

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) return json({ ok: false, error: 'Unauthorized' }, 401);

  let progress;
  try {
    progress = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const stored = await env.PROGRESS_KV.get(PROGRESS_KEY, 'json');
  const storedUpdatedAt = stored?.updatedAt || '';
  const baseUpdatedAt = request.headers.get('x-progress-base-updated-at') || '';
  if (storedUpdatedAt && (!baseUpdatedAt || storedUpdatedAt > baseUpdatedAt)) {
    return json({
      ok: false,
      error: 'Conflict',
      remoteUpdatedAt: storedUpdatedAt,
      remote: stored,
    }, 409);
  }

  const updatedAt = new Date().toISOString();
  const stamped = { ...progress, updatedAt };
  await env.PROGRESS_KV.put(PROGRESS_KEY, JSON.stringify(stamped));
  return json({ ok: true, updatedAt, progress: stamped });
}

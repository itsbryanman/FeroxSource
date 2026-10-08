const $ = (id) => document.getElementById(id);

let state = null;
let selected = null;
let token = sessionStorage.getItem('ferox-token') || '';

const COLORS = {
  drafting: '#85b8ed',
  ready: '#85b8ed',
  validating: '#d8bd7f',
  replaying: '#d8bd7f',
  accepted: '#8dd3a7',
  blocked: '#eb7d85',
  escalated: '#eb7d85',
  quarantined: '#f08365',
  deferred: '#9aa9b2',
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

async function api(route, method = 'GET', data) {
  const response = await fetch(route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'request failed');
  return value;
}

// ---- interaction map ----

function drawGraph() {
  const root = $('graph');
  root.replaceChildren();
  const changes = state.changes || [];
  // phones get a narrow canvas with 3 columns so nodes stay readable
  const narrow = root.clientWidth > 0 && root.clientWidth < 600;
  const width = narrow ? 380 : 900;
  const columns = narrow ? 3 : Math.max(4, Math.min(10, Math.ceil(Math.sqrt(changes.length * 1.6))));
  const rows = Math.ceil(changes.length / columns);
  const height = Math.max(narrow ? 200 : 360, rows * 85 + 90);
  root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const span = width - 130;

  const pos = new Map(
    changes.map((c, i) => [
      c.id,
      { x: 65 + (i % columns) * (span / Math.max(1, columns - 1)), y: 65 + Math.floor(i / columns) * 85 },
    ]),
  );

  for (const edge of state.graph || []) {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    if (!a || !b) continue;
    const semantic = edge.reasons.some((r) => r.kind !== 'write-write');
    root.append(
      svg('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: semantic ? '#85b8ed' : '#5d7184',
        'stroke-width': semantic ? 1.8 : 1.2,
        opacity: 0.6,
      }),
    );
  }

  // a capsule hub ties together a set that failed as a whole
  (state.capsules || []).forEach((capsule, i) => {
    const hub = { x: 75 + ((i * 85) % (width - 150)), y: height - 45 };
    for (const member of capsule.members) {
      const n = pos.get(member);
      if (n) root.append(svg('line', { x1: hub.x, y1: hub.y, x2: n.x, y2: n.y, stroke: '#eb7d85', opacity: 0.4, 'stroke-dasharray': '3 5' }));
    }
    const g = svg('g', { tabindex: 0, role: 'button', 'aria-label': `failing set ${capsule.id}` });
    g.append(svg('rect', { x: hub.x - 6, y: hub.y - 6, width: 12, height: 12, fill: '#eb7d85', transform: `rotate(45 ${hub.x} ${hub.y})` }));
    const label = svg('text', { x: hub.x, y: hub.y + 22, 'text-anchor': 'middle' });
    label.textContent = `${capsule.members.length} fail together`;
    g.append(label);
    g.onclick = () => select('capsule', capsule.id);
    root.append(g);
  });

  for (const c of changes) {
    const p = pos.get(c.id);
    const color = COLORS[c.state] || '#aaa';
    const llm = c.attempts.some((a) => a.agent?.startsWith('llm'));
    const g = svg('g', { tabindex: 0, role: 'button', 'aria-label': `${c.intent.title}, ${c.state}` });
    g.append(svg('circle', { cx: p.x, cy: p.y, r: 17, fill: '#17232b', stroke: color, 'stroke-width': llm ? 3.5 : 2 }));
    g.append(svg('circle', { cx: p.x, cy: p.y, r: c.state === 'accepted' ? 6 : 3, fill: color }));
    if (c.replayCount) {
      const badge = svg('text', { x: p.x + 15, y: p.y - 12, class: 'replay-badge' });
      badge.textContent = `↻${c.replayCount}`;
      g.append(badge);
    }
    const label = svg('text', { x: p.x, y: p.y + 34, 'text-anchor': 'middle' });
    label.textContent = c.id.length > 19 ? `${c.id.slice(0, 17)}…` : c.id;
    g.append(label);
    g.onclick = () => select('change', c.id);
    g.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') select('change', c.id);
    };
    root.append(g);
  }

  const edges = (state.graph || []).length;
  $('graph-count').textContent = `${changes.length} changes · ${edges} predicted interactions`;
}

// ---- detail panel ----

function section(title, content, code = false) {
  const frag = document.createDocumentFragment();
  frag.append(el('h3', title), el(code ? 'pre' : 'p', content));
  return frag;
}

function select(kind, id) {
  selected = { kind, id };
  drawDetail();
}

function drawDetail() {
  if (!selected || !state) return;
  const out = $('detail');
  out.replaceChildren();

  if (selected.kind === 'change') {
    const c = state.changes.find((x) => x.id === selected.id);
    if (!c) return;
    $('detail-title').textContent = c.intent.title;
    out.append(section('Intent', c.intent.task));
    out.append(section('State', `${c.state}${c.replayCount ? ` · replayed ${c.replayCount}x` : ''}`));
    if (c.reason) out.append(section('Why', c.reason));
    for (const a of c.attempts) {
      const who = a.agent?.startsWith('llm') ? `${a.agent} (real coding agent)` : a.agent;
      out.append(section(`Attempt ${a.n} · ${who}`, `base   ${a.base}\ncommit ${a.head}`, true));
      out.append(section('Writes', a.footprint.writes.join('\n') || 'none', true));
      out.append(section('Reads', a.footprint.reads.join('\n') || 'none', true));
      if (a.replayContext) {
        const moved = a.replayContext.interactingIntents.map((w) => `${w.id}: ${w.intent.task}`).join('\n');
        out.append(section('Replayed because', `${a.replayContext.reason}\n\n${moved || 'failed integration'}`, true));
      }
      if (a.transcript) out.append(section('Agent transcript', a.transcript, true));
    }
    return;
  }

  if (selected.kind === 'candidate') {
    const c = state.candidates.find((x) => x.id === selected.id);
    if (!c) return;
    $('detail-title').textContent = `Candidate · ${c.outcome}`;
    out.append(section('Run', `${c.purpose} · ${(c.durationMs / 1000).toFixed(2)}s`));
    out.append(section('Members', c.members.join(', ')));
    out.append(
      section('Identity', `candidate ${c.id}\nparent    ${c.base}\ntree      ${c.tree || 'assembly failed'}\ncommit    ${c.commit || 'none'}\npolicy    ${c.policyHash}`, true),
    );
    out.append(section('Reproduce', c.reproduction, true));
    out.append(section('Oracle output', c.output.replace(/\u001b\[[0-9;]*m/g, ''), true));
    return;
  }

  const capsule = state.capsules.find((x) => x.id === selected.id);
  if (!capsule) return;
  $('detail-title').textContent = 'Failing set';
  out.append(section('These fail together', capsule.members.join(', ')));
  out.append(
    section(
      'How it was found',
      `${capsule.reductionChecks} reduction runs${capsule.exhausted ? ', budget ran out, so the set may not be minimal' : ''}.`,
    ),
  );
  out.append(section('Record', JSON.stringify(capsule, null, 2), true));
}

// ---- page ----

function summaryLine(s) {
  const m = s.metrics;
  if (s.generating) return `drafting · ${s.changes.length}/${s.planned ?? '?'} changes`;
  if (s.running) return `integrating · ${s.events.at(-1)?.type ?? ''}`;
  const finished = s.events.some((e) => e.type === 'run.completed');
  const error = s.events.findLast((e) => e.type === 'run.error');
  if (error) return `stopped: ${error.message}`;
  if (finished) return `done · landed ${m.accepted} · replays ${m.replays} · ${m.validations} oracle runs · ${s.mode}`;
  return `${s.changes.length} changes drafted (${s.workload ?? 'workload'}). press Integrate.`;
}

function render(next) {
  state = next;
  if (next.empty) return;
  const m = next.metrics;
  $('accepted').textContent = m.accepted;
  $('validations').textContent = m.validations;
  $('replays').textContent = m.replays;
  $('capsules').textContent = next.capsules.length;
  $('agents').textContent = m.agentRuns ?? 0;
  $('duration').textContent = `${(m.validationMs / 1000).toFixed(1)}s`;
  $('head').textContent = next.head;
  $('backend').textContent = next.capabilities.backend === 'artifacts' ? 'CLOUDFLARE ARTIFACTS' : 'LOCAL GIT';
  $('backend').classList.toggle('cloud', next.capabilities.backend === 'artifacts');
  $('prepare').disabled = next.running || next.generating;
  $('integrate').disabled = next.running || next.generating;
  drawGraph();
  drawDetail();

  const candidates = $('candidates');
  candidates.replaceChildren();
  for (const c of [...next.candidates].reverse()) {
    const row = el('button', undefined, 'candidate');
    const left = el('div');
    left.append(el('b', c.members.join(' + ')), el('small', `${c.purpose} · ${c.id}`));
    row.append(left, el('span', c.outcome, `outcome ${c.outcome}`));
    row.onclick = () => select('candidate', c.id);
    candidates.append(row);
  }

  const events = $('events');
  events.replaceChildren();
  for (const e of next.events.slice(-40).reverse()) {
    const row = el('div', undefined, 'event');
    row.append(el('time', new Date(e.time).toLocaleTimeString([], { hour12: false })));
    const text = el('span');
    const who = e.changeId || e.members?.join(', ') || e.capsule?.members.join(', ') || '';
    text.append(el('strong', e.type), document.createTextNode(` ${who}`));
    row.append(text);
    events.append(row);
  }

  const steps = $('trunk-steps');
  steps.replaceChildren();
  for (const entry of next.ledger.slice(-12)) {
    steps.append(el('span', `+${entry.members.length} · ${entry.commit.slice(0, 7)}`, 'landing'));
  }

  status(summaryLine(next), next.events.some((e) => e.type === 'run.error'));
}

function renderRuns(runs) {
  const body = $('runs');
  body.replaceChildren();
  for (const r of runs) {
    const tr = el('tr');
    for (const v of [r.workload, r.mode, r.backend, r.changes, r.accepted, r.replays, r.validations, r.capsules, r.escalated, r.integrationSec ?? '…']) {
      tr.append(el('td', String(v)));
    }
    body.append(tr);
  }
  $('runs-empty').hidden = runs.length > 0;
}

$('prepare').onclick = async () => {
  $('prepare').disabled = true;
  status('forking workspaces and drafting changes…');
  try {
    selected = null;
    $('detail-title').textContent = 'Click a change';
    $('detail').replaceChildren(el('p', 'Click a node for its intent, footprint and replay history.', 'muted'));
    render(await api('/api/runs', 'POST', { workload: $('workload').value, count: Number($('count').value), mode: $('mode').value }));
  } catch (e) {
    status(e.message, true);
  } finally {
    $('prepare').disabled = false;
  }
};

$('integrate').onclick = async () => {
  try {
    await api('/api/run', 'POST', {});
  } catch (e) {
    status(e.message, true);
  }
};

$('auth').onclick = () => {
  token = prompt('API token (blank for local mode)', token) || '';
  sessionStorage.setItem('ferox-token', token);
  refresh();
};

async function refresh() {
  try {
    render(await api('/api/state'));
    renderRuns(await api('/api/runs/summary'));
  } catch (e) {
    status(e.message, true);
  }
}

await refresh();
setInterval(refresh, 1000);

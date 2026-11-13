// Dispatch Board demo. Plain JS, no build step. Data comes from ../shared/data.js (window.SUMMIT).
// All times are the visitor's local time.
(function () {
  'use strict';
  const S = window.SUMMIT;
  const STORE = 'summit-dispatch-board-v1';
  const DAY_START = 7, DAY_END = 18, HOURS = DAY_END - DAY_START, SLOTS = HOURS * 2, CAPACITY = 9;
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const DATE_FIELDS = ['createdAt', 'firstCallAt', 'scheduledStart', 'completedAt'];
  const TRADE_COLOR = { HVAC: '#2563eb', Plumbing: '#0f7a5c', Appliance: '#c2410c' };
  const STATUS_COLOR = {
    new: '#64748b', scheduled: '#2563eb', en_route: '#0891b2', in_progress: '#d97706',
    waiting_parts: '#9333ea', completed: '#0f7a5c', invoiced: '#475569',
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const tech = id => S.byId(S.techs, id);
  const vendor = id => S.byId(S.vendors, id);
  const customer = id => S.byId(S.customers, id);

  // ---------- State ----------
  let jobs = load();
  let viewDay = startOfDay(new Date());
  let filter = null;           // active alert key
  let colorBy = 'tech';
  let openId = null;           // job in drawer
  let placingId = null;        // tap-to-place mode
  let drag = null;             // { id, grab, kind }
  let undoSnap = null;
  let lastFocus = null;
  let toastTimer = null;
  let didAutoScroll = false;
  const find = id => jobs.find(j => j.id === id);

  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.jobs) && s.jobs.length) {
          // Saved on an earlier day: slide every date forward so the board stays "current".
          const days = Math.round((new Date(S.today) - new Date(s.today)) / DAY);
          if (days) s.jobs.forEach(j => DATE_FIELDS.forEach(f => {
            if (j[f]) { const t = new Date(j[f]); t.setDate(t.getDate() + days); j[f] = t.toISOString(); }
          }));
          return s.jobs;
        }
      }
    } catch (e) { /* storage unavailable: fall through */ }
    return clone(S.jobs);
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ today: S.today, jobs })); } catch (e) { /* ignore */ }
  }
  function snapshot() { undoSnap = clone(jobs); }

  // ---------- Time helpers ----------
  function startOfDay(d) { const t = new Date(d); t.setHours(0, 0, 0, 0); return t; }
  function sameDay(a, b) { return startOfDay(a).getTime() === startOfDay(b).getTime(); }
  function addDays(d, n) { const t = new Date(d); t.setDate(t.getDate() + n); return t; }
  function hourOf(d) { d = new Date(d); return d.getHours() + d.getMinutes() / 60; }
  function slotDate(day, slot) { const t = startOfDay(day); t.setHours(DAY_START + Math.floor(slot / 2), (slot % 2) * 30, 0, 0); return t; }
  function fmtTime(d) {
    d = new Date(d);
    const h = d.getHours(), m = d.getMinutes();
    return ((h % 12) || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM');
  }
  function fmtTimeShort(d) { return fmtTime(d).replace(' AM', 'a').replace(' PM', 'p'); }
  function fmtDur(ms) {
    ms = Math.abs(ms);
    const m = Math.floor(ms / MIN), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return d + 'd ' + (h % 24) + 'h';
    if (h >= 1) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    return Math.max(1, m) + 'm';
  }
  function dayWord(d, now) {
    const diff = Math.round((startOfDay(d) - startOfDay(now)) / DAY);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtWhen(d, now) { return dayWord(d, now) + ' ' + fmtTime(d); }
  function toDateInput(d) { d = new Date(d); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function fromDateInput(v) { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); }

  // ---------- Business rules ----------
  const isActive = j => j.status !== 'completed' && j.status !== 'invoiced';
  const isUnassigned = j => isActive(j) && (j.status === 'new' || !j.techId || !j.scheduledStart);
  const deadline = j => new Date(new Date(j.createdAt).getTime() + vendor(j.vendorId).firstCallHours * HOUR);
  const firstCallOverdue = (j, now) => (j.status === 'new' || j.status === 'scheduled') && !j.firstCallAt && now > deadline(j);
  const jobEnd = j => new Date(new Date(j.scheduledStart).getTime() + j.durationHrs * HOUR);
  const durSlots = j => Math.max(1, Math.ceil(j.durationHrs * 2));

  function urgency(j, now) {
    let r = j.firstCallAt ? 1e11 - (now - new Date(j.createdAt)) : deadline(j) - now;
    if (j.priority === 'high') r -= 12 * HOUR;
    return r;
  }

  // Non-blocking warnings for putting job j on techId at start.
  function warningsFor(j, techId, start) {
    const out = [];
    const t = tech(techId);
    if (!t) return out;
    if (t.trade !== j.trade) out.push({ tone: 'warn', short: 'Trade mismatch', text: `${t.name.split(' ')[0]} is ${t.trade}; this is a ${j.trade} job` });
    const s = start.getTime(), e = s + j.durationHrs * HOUR;
    const clash = jobs.filter(o => o.id !== j.id && o.techId === techId && o.scheduledStart && isActive(o) && o.status !== 'new' &&
      new Date(o.scheduledStart).getTime() < e && jobEnd(o).getTime() > s);
    clash.forEach(o => out.push({ tone: 'bad', short: 'Overlap ' + o.id, text: `Overlaps ${o.id} (${fmtTime(o.scheduledStart)}–${fmtTime(jobEnd(o))})` }));
    const booked = jobs.filter(o => o.id !== j.id && o.techId === techId && o.scheduledStart && sameDay(o.scheduledStart, start) && o.status !== 'new')
      .reduce((a, o) => a + o.durationHrs, 0);
    if (booked + j.durationHrs > CAPACITY) out.push({ tone: 'warn', short: 'Over 9h', text: `${t.name.split(' ')[0]} would be at ${booked + j.durationHrs}h of ${CAPACITY}h` });
    return out;
  }
  const flagHTML = w => `<span class="flag${w.tone === 'bad' ? ' bad' : ''}" title="${esc(w.text)}">⚠ ${esc(w.short)}</span>`;

  const ALERTS = [
    { key: 'overdue', tone: 'bad', label: 'Overdue first calls', sub: 'Window passed, no call logged', test: (j, now) => firstCallOverdue(j, now) },
    { key: 'unassigned', tone: 'warn', label: 'Unassigned', sub: 'Waiting in the queue', test: j => isUnassigned(j) },
    { key: 'parts', tone: 'info', label: 'Waiting on parts', sub: 'Need a return visit', test: j => j.status === 'waiting_parts' },
    { key: 'high', tone: 'accent', label: 'High priority today', sub: 'Booked today or unassigned', test: (j, now) => j.priority === 'high' && isActive(j) && (isUnassigned(j) || (j.scheduledStart && sameDay(j.scheduledStart, now))) },
  ];
  const matchFn = now => { const a = ALERTS.find(x => x.key === filter); return a ? j => a.test(j, now) : null; };

  // ---------- Render ----------
  function render() {
    const now = new Date();
    const active = document.activeElement;
    const focusId = active && active.dataset ? active.dataset.focus : null;
    renderHeader(now);
    renderAlerts(now);
    renderMatches(now);
    renderQueue(now);
    renderBoard(now);
    if (focusId) { const el = document.querySelector(`[data-focus="${CSS.escape(focusId)}"]`); if (el) el.focus({ preventScroll: true }); }
  }

  function renderHeader(now) {
    $('#dayName').textContent = viewDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const w = dayWord(viewDay, now);
    $('#dayRel').textContent = ['Today', 'Tomorrow', 'Yesterday'].includes(w) ? w : (viewDay < startOfDay(now) ? 'Past day' : 'Upcoming');
    $('#todayBtn').disabled = sameDay(viewDay, now);
    $$('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === colorBy)));
  }

  function renderAlerts(now) {
    $('#alerts').innerHTML = ALERTS.map(a => {
      const n = jobs.filter(j => a.test(j, now)).length;
      return `<button type="button" class="alert ${a.tone}${n ? '' : ' zero'}" data-alert="${a.key}" data-focus="alert-${a.key}" aria-pressed="${filter === a.key}">
        <span class="n">${n}</span><span class="l"><b>${a.label}</b><span>${a.sub}</span></span></button>`;
    }).join('');
  }

  function renderMatches(now) {
    const el = $('#matches');
    const fn = matchFn(now);
    if (!fn) { el.hidden = true; el.innerHTML = ''; return; }
    const a = ALERTS.find(x => x.key === filter);
    const list = jobs.filter(fn).sort((x, y) => (x.scheduledStart || x.createdAt).localeCompare(y.scheduledStart || y.createdAt));
    el.hidden = false;
    el.innerHTML = `<span class="mt">${esc(a.label)}:</span>` + (list.length ? list.map(j => {
      const where = isUnassigned(j) ? 'In queue' : `${dayWord(j.scheduledStart, now)} ${fmtTimeShort(j.scheduledStart)} · ${tech(j.techId).name.split(' ')[0]}`;
      return `<button type="button" class="mbtn" data-open="${j.id}" data-goto="1" data-focus="m-${j.id}"><span class="mono">${j.id}</span>${esc(customer(j.customerId).name)} · ${esc(where)}</button>`;
    }).join('') : '<span class="muted">Nothing here. Nice.</span>') +
      `<button type="button" class="linkbtn" data-clear="1">Clear filter</button>`;
  }

  function deadlineHTML(j, now) {
    if (j.firstCallAt) return `<span class="deadline done"><span class="dl-t"><span>✓ First call made</span><span>${fmtWhen(j.firstCallAt, now)}</span></span></span>`;
    const dl = deadline(j), left = dl - now, win = vendor(j.vendorId).firstCallHours * HOUR;
    const used = Math.min(100, Math.max(0, 100 * (1 - left / win)));
    const tone = left < 0 ? 'bad' : (left < win * 0.25 || left < 4 * HOUR) ? 'warn' : 'ok';
    const txt = left < 0 ? `First call overdue ${fmtDur(left)}` : `First call due in ${fmtDur(left)}`;
    return `<span class="deadline ${tone}"><span class="dl-t"><span>${left < 0 ? '⚠ ' : ''}${txt}</span><span>${vendor(j.vendorId).firstCallHours}h window</span></span><span class="dbar"><i style="width:${used.toFixed(0)}%"></i></span></span>`;
  }

  function renderQueue(now) {
    const fn = matchFn(now);
    const q = jobs.filter(isUnassigned).sort((a, b) => urgency(a, now) - urgency(b, now));
    $('#queueCount').textContent = q.length;
    $('#qlist').innerHTML = q.length ? q.map(j => {
      const c = customer(j.customerId), v = vendor(j.vendorId);
      const overdue = firstCallOverdue(j, now);
      const cls = ['qcard', overdue && 'overdue', fn && (fn(j) ? 'hit' : 'dim'), placingId === j.id && 'selected'].filter(Boolean).join(' ');
      const label = `${j.id}, ${c.name}, ${j.trade}: ${j.issue}. ${v.short}${j.claim ? ' claim ' + j.claim : ''}. ${overdue ? 'First call overdue.' : ''} Press Enter to open and assign.`;
      return `<li><div class="${cls}" role="button" tabindex="0" draggable="true" data-id="${j.id}" data-focus="q-${j.id}" style="--tradec:${TRADE_COLOR[j.trade]}" aria-label="${esc(label)}">
        <span class="qtop"><span class="id">${j.id}</span>${j.priority === 'high' ? '<span class="prio">High</span>' : ''}<span class="age">${now - new Date(j.createdAt) < MIN ? 'Just in' : 'In queue ' + fmtDur(now - new Date(j.createdAt))}</span></span>
        <span class="qcust">${esc(c.name)}</span>
        <span class="qissue">${esc(j.issue)}</span>
        <span class="qmeta"><span class="chip">${esc(v.short)}</span>${j.claim ? `<span class="chip">${esc(j.claim)}</span>` : ''}<span class="chip">${esc(j.trade)}</span><span class="chip">${j.durationHrs}h est.</span></span>
        ${deadlineHTML(j, now)}
      </div></li>`;
    }).join('') : '<li class="qempty">Queue is clear. Every job has a tech.</li>';
  }

  function blockColor(j) { return colorBy === 'status' ? STATUS_COLOR[j.status] : tech(j.techId).color; }

  function renderBoard(now) {
    const fn = matchFn(now);
    const isToday = sameDay(viewDay, now);
    const nowH = hourOf(now);
    const nowPct = (nowH - DAY_START) / HOURS * 100;
    const showNow = isToday && nowH >= DAY_START && nowH <= DAY_END;
    const pct = h => Math.min(100, Math.max(0, (h - DAY_START) / HOURS * 100));

    const dayJobs = jobs.filter(j => j.techId && j.scheduledStart && j.status !== 'new' && sameDay(j.scheduledStart, viewDay));
    let totalBooked = 0;
    const laneH = parseInt(getLane(), 10) || 82;

    let html = `<div class="bhead"><div class="corner">Tech</div><div class="hours">`;
    for (let h = DAY_START; h < DAY_END; h++) html += `<span style="left:${pct(h)}%">${(h % 12) || 12} ${h < 12 ? 'AM' : 'PM'}</span>`;
    if (showNow) html += `<div class="nowline" style="left:${nowPct}%"></div><span class="nowtag" style="left:${nowPct}%">${fmtTimeShort(now)}</span>`;
    html += `</div></div>`;

    S.techs.forEach(t => {
      const tj = dayJobs.filter(j => j.techId === t.id).sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
      const laneEnds = [];
      const lanes = tj.map(j => {
        const s = new Date(j.scheduledStart).getTime();
        let l = laneEnds.findIndex(e => e <= s);
        if (l < 0) { l = laneEnds.length; laneEnds.push(0); }
        laneEnds[l] = jobEnd(j).getTime();
        return l;
      });
      const nLanes = Math.max(1, laneEnds.length);
      const booked = tj.reduce((a, j) => a + j.durationHrs, 0);
      totalBooked += booked;
      const over = booked > CAPACITY;

      html += `<div class="brow" data-tech="${t.id}">
        <div class="tcell" style="--c:${t.color}">
          <div class="tid"><span class="avatar" aria-hidden="true">${t.initials}</span><span class="tname"><b>${esc(t.name)}</b><span>${t.trade}</span></span></div>
          <div class="cap${over ? ' over' : ''}" title="${booked}h booked of ${CAPACITY}h capacity">
            <div class="ct"><span>${tj.length} job${tj.length === 1 ? '' : 's'}</span><b>${booked}/${CAPACITY}h</b></div>
            <div class="capbar" role="meter" aria-label="${esc(t.name)} booked hours" aria-valuemin="0" aria-valuemax="${CAPACITY}" aria-valuenow="${booked}"><i style="width:${Math.min(100, booked / CAPACITY * 100)}%"></i></div>
          </div>
        </div>
        <div class="track" data-tech="${t.id}" style="height:calc(${nLanes} * var(--lane) + 10px)">`;
      if (isToday && nowH > DAY_START) html += `<div class="past" style="width:${pct(nowH)}%"></div>`;
      if (showNow) html += `<div class="nowline" style="left:${nowPct}%"></div>`;

      tj.forEach((j, i) => {
        const c = customer(j.customerId);
        const sh = hourOf(j.scheduledStart);
        const left = pct(sh), width = Math.max(2, pct(sh + j.durationHrs) - left);
        const warns = warningsFor(j, t.id, new Date(j.scheduledStart)).filter(w => w.short !== 'Over 9h');
        const late = firstCallOverdue(j, now);
        const conflict = warns.some(w => w.tone === 'bad');
        const cls = ['block', conflict && 'conflict', !isActive(j) && 'done', fn && (fn(j) ? 'hit' : 'dim')].filter(Boolean).join(' ');
        const label = `${j.id}, ${c.name}, ${j.issue}. ${fmtTime(j.scheduledStart)} to ${fmtTime(jobEnd(j))} with ${t.name}. Status ${S.statusLabels[j.status]}.${late ? ' First call overdue.' : ''}${warns.map(w => ' Warning: ' + w.text + '.').join('')}`;
        html += `<div class="${cls}" role="button" tabindex="0" draggable="true" data-id="${j.id}" data-focus="b-${j.id}" aria-label="${esc(label)}"
          style="--c:${blockColor(j)};left:${left}%;width:calc(${width}% - 3px);top:${5 + lanes[i] * laneH}px;height:calc(var(--lane) - 5px)">
          <span class="b-top"><span class="mono">${j.id}</span><span class="b-time">${fmtTimeShort(j.scheduledStart)}–${fmtTimeShort(jobEnd(j))}</span></span>
          <span class="b-cust">${esc(c.name)}</span>
          <span class="b-issue">${esc(j.issue)}</span>
          <span class="b-foot"><span class="sc" style="--sc:${STATUS_COLOR[j.status]}">${S.statusLabels[j.status]}</span>${late ? '<span class="flag bad">⚠ No first call</span>' : ''}${warns.map(flagHTML).join('')}</span>
        </div>`;
      });
      html += `</div></div>`;
    });
    $('#board').innerHTML = html;

    const cap = S.techs.length * CAPACITY;
    $('#daySummary').textContent = `${dayJobs.length} job${dayJobs.length === 1 ? '' : 's'} · ${totalBooked}h booked of ${cap}h (${Math.round(totalBooked / cap * 100)}%)`;
    $('#legend').innerHTML = colorBy === 'tech'
      ? S.techs.map(t => `<span><i style="--c:${t.color}"></i>${esc(t.name.split(' ')[0])}</span>`).join('')
      : ['scheduled', 'en_route', 'in_progress', 'waiting_parts', 'completed'].map(s => `<span><i style="--c:${STATUS_COLOR[s]}"></i>${S.statusLabels[s]}</span>`).join('');

    if (!didAutoScroll) {
      didAutoScroll = true;
      const sc = $('#boardScroll');
      if (sc.scrollWidth > sc.clientWidth + 4 && showNow) {
        const track = $('.track');
        const x = track.offsetLeft + track.clientWidth * nowPct / 100;
        sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.45);
      }
    }
  }
  function getLane() { return getComputedStyle(document.documentElement).getPropertyValue('--lane') || '82px'; }

  // ---------- Drawer ----------
  function openDrawer(id) {
    const j = find(id);
    if (!j) return;
    if (!openId) lastFocus = document.activeElement;
    openId = id;
    renderDrawer();
    $('#drawer').hidden = false;
    $('#backdrop').hidden = false;
    $('#drawer .dr-close').focus();
  }
  function closeDrawer() {
    openId = null;
    $('#drawer').hidden = true;
    $('#backdrop').hidden = true;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    else if (lastFocus && lastFocus.dataset && lastFocus.dataset.focus) { const el = document.querySelector(`[data-focus="${lastFocus.dataset.focus}"]`); if (el) el.focus(); }
  }

  function renderDrawer() {
    const j = find(openId);
    if (!j) { closeDrawer(); return; }
    const now = new Date();
    const c = customer(j.customerId), v = vendor(j.vendorId), t = tech(j.techId);
    const assigned = !isUnassigned(j);
    const overdue = firstCallOverdue(j, now);
    const dl = deadline(j);
    const si = S.statuses.indexOf(j.status);
    const next = S.statuses[si + 1];

    // Default schedule form values
    const fDay = j.scheduledStart ? new Date(j.scheduledStart) : viewDay;
    let fSlot = 2; // 8:00
    if (j.scheduledStart) fSlot = Math.min(SLOTS - 1, Math.max(0, Math.round((hourOf(j.scheduledStart) - DAY_START) * 2)));
    const techOpts = [...S.techs].sort((a, b) => (b.trade === j.trade) - (a.trade === j.trade))
      .map(x => `<option value="${x.id}"${x.id === j.techId ? ' selected' : ''}>${esc(x.name)} · ${x.trade}${x.trade === j.trade ? '' : ' (other trade)'}</option>`).join('');
    let slotOpts = '';
    for (let s = 0; s < SLOTS; s++) slotOpts += `<option value="${s}"${s === fSlot ? ' selected' : ''}>${fmtTime(slotDate(viewDay, s))}</option>`;

    let callout = '';
    if (overdue) callout = `<div class="callout bad"><span><b>First call overdue by ${fmtDur(now - dl)}.</b> ${esc(v.short)} expects contact within ${v.firstCallHours}h. Call the customer, then log it.</span><button class="btn small" type="button" data-act="call">Log first call</button></div>`;
    else if (!j.firstCallAt && isActive(j)) callout = `<div class="callout warn"><span>First call due by <b>${fmtWhen(dl, now)}</b> (${fmtDur(dl - now)} left).</span><button class="btn small" type="button" data-act="call">Log first call</button></div>`;

    const step = (cls, title, sub) => `<li class="${cls}"><b>${title}</b><span>${sub}</span></li>`;
    const steps = [
      step('done', 'Work order created', `${fmtWhen(j.createdAt, now)} · ${esc(v.name)}`),
      j.firstCallAt ? step('done', 'First call to customer', fmtWhen(j.firstCallAt, now))
        : step(overdue ? 'late' : '', 'First call to customer', overdue ? `Not logged · was due ${fmtWhen(dl, now)}` : `Due by ${fmtWhen(dl, now)}`),
      assigned ? step(si >= 1 ? 'done' : '', 'Scheduled', `${fmtWhen(j.scheduledStart, now)}–${fmtTime(jobEnd(j))} · ${esc(t.name)}`)
        : step('', 'Scheduled', 'Not yet assigned'),
      j.completedAt ? step('done', 'Completed', fmtWhen(j.completedAt, now)) : step('', 'Completed', 'Not yet · currently ' + S.statusLabels[j.status].toLowerCase()),
    ].join('');

    $('#drawer').innerHTML = `
      <div class="dr-head">
        <div class="mono">${j.id}${j.claim ? ' · Claim ' + esc(j.claim) : ''}</div>
        <h2 id="drTitle">${esc(c.name)}</h2>
        <div class="row" style="gap:6px">
          <span class="sc" style="--sc:${STATUS_COLOR[j.status]}">${S.statusLabels[j.status]}</span>
          ${j.priority === 'high' ? '<span class="prio">High priority</span>' : ''}
          <span class="chip">${esc(j.trade)}</span><span class="chip">${j.durationHrs}h est.</span>
        </div>
        <button class="icon-btn dr-close" type="button" data-act="close" aria-label="Close details">×</button>
      </div>
      <div class="dr-body">
        <div class="dr-sec"><h3>Issue</h3><p class="issue">${esc(j.issue)}</p>${callout}</div>
        <div class="dr-sec"><h3>Customer</h3><dl class="kv">
          <dt>Name</dt><dd>${esc(c.name)}</dd>
          <dt>Phone</dt><dd><a href="tel:${c.phone.replace(/\D/g, '')}">${esc(c.phone)}</a></dd>
          <dt>Address</dt><dd>${esc(c.address)}, ${esc(c.zip)}</dd>
        </dl></div>
        <div class="dr-sec"><h3>Work order</h3><dl class="kv">
          <dt>Vendor</dt><dd>${esc(v.name)}</dd>
          <dt>Claim #</dt><dd class="mono">${j.claim ? esc(j.claim) : '—'}</dd>
          <dt>First-call rule</dt><dd>Within ${v.firstCallHours}h of dispatch</dd>
          <dt>Pay terms</dt><dd>${esc(v.payTerms)}</dd>
        </dl></div>
        <div class="dr-sec"><h3>Timeline</h3><ol class="steps">${steps}</ol></div>
        <div class="dr-sec"><h3>Status</h3>
          <div class="statusflow" aria-hidden="true">${S.statuses.map((s, i) => `<span class="${i < si ? 'past' : i === si ? 'cur' : ''}">${S.statusLabels[s]}</span>`).join('')}</div>
          <div class="form">
            <div class="full"><label for="drStatus">Change status</label><select id="drStatus"${!j.techId || !j.scheduledStart ? ' aria-describedby="drStatusHint"' : ''}>${S.statuses.map(s => `<option value="${s}"${s === j.status ? ' selected' : ''}${s !== 'new' && (!j.techId || !j.scheduledStart) ? ' disabled' : ''}>${S.statusLabels[s]}</option>`).join('')}</select>${!j.techId || !j.scheduledStart ? '<p class="muted small" id="drStatusHint">Assign a tech and a time to move this job past New.</p>' : ''}</div>
          </div>
          <div class="actions">
            ${next && assigned ? `<button class="btn small" type="button" data-act="next">Mark ${S.statusLabels[next].toLowerCase()} →</button>` : ''}
            ${!j.firstCallAt && isActive(j) && !callout ? '<button class="btn ghost small" type="button" data-act="call">Log first call</button>' : ''}
          </div>
        </div>
        <div class="dr-sec"><h3>${assigned ? 'Reschedule or reassign' : 'Assign'}</h3>
          <div class="form">
            <div class="full"><label for="drTech">Tech</label><select id="drTech">${assigned ? '' : '<option value="">Choose a tech…</option>'}${techOpts}</select></div>
            <div><label for="drDay">Day</label><input id="drDay" type="date" value="${toDateInput(fDay)}"></div>
            <div><label for="drSlot">Start time</label><select id="drSlot">${slotOpts}</select></div>
            <div class="full warns" id="drWarns" aria-live="polite"></div>
          </div>
          <div class="actions">
            <button class="btn small" type="button" data-act="assign">${assigned ? 'Save changes' : 'Assign'}</button>
            <button class="btn ghost small" type="button" data-act="pick">Pick slot on board</button>
            ${assigned ? '<button class="btn danger small" type="button" data-act="unassign">Unassign</button>' : ''}
          </div>
        </div>
      </div>`;
    updateFormWarnings();
  }

  function formValues() {
    const techId = $('#drTech').value;
    const dayV = $('#drDay').value;
    const slot = Number($('#drSlot').value);
    if (!techId || !dayV) return null;
    return { techId, start: slotDate(fromDateInput(dayV), slot) };
  }
  function updateFormWarnings() {
    const el = $('#drWarns');
    if (!el) return;
    const j = find(openId), f = formValues();
    if (!f) { el.innerHTML = ''; return; }
    const w = warningsFor(j, f.techId, f.start);
    const end = new Date(f.start.getTime() + j.durationHrs * HOUR);
    el.innerHTML = (w.length ? w.map(x => `<span class="flag${x.tone === 'bad' ? ' bad' : ''}">⚠ ${esc(x.text)}</span>`).join('') : '<span class="chip good">✓ Fits: no conflicts</span>')
      + (hourOf(end) > DAY_END || !sameDay(end, f.start) ? '<span class="flag">⚠ Runs past 6 PM</span>' : '');
  }

  // ---------- Mutations ----------
  function place(id, techId, start, how) {
    const j = find(id);
    if (!j) return;
    snapshot();
    const warns = warningsFor(j, techId, start);
    const moved = !isUnassigned(j);
    j.techId = techId;
    j.scheduledStart = start.toISOString();
    if (j.status === 'new') j.status = 'scheduled';
    save();
    if (!sameDay(start, viewDay)) viewDay = startOfDay(start);
    render();
    if (openId === id) renderDrawer();
    const t = tech(techId);
    toast(`<b>${j.id}</b> ${moved ? 'moved to' : 'assigned to'} ${esc(t.name)} · ${fmtWhen(start, new Date())}`, warns, true);
  }
  function unassign(id) {
    const j = find(id);
    if (!j) return;
    snapshot();
    j.techId = null; j.scheduledStart = null; j.status = 'new';
    save(); render();
    if (openId === id) renderDrawer();
    toast(`<b>${j.id}</b> moved back to the queue`, [], true);
  }
  function setStatus(id, status) {
    const j = find(id);
    if (!j || j.status === status) return;
    if (status !== 'new' && (!j.techId || !j.scheduledStart)) {
      // A job nobody is booked on can't be scheduled, worked or completed: it would vanish from both the queue and the board.
      renderDrawer();
      toast(`Assign <b>${j.id}</b> to a tech and a time first`, [], false);
      return;
    }
    snapshot();
    if (status === 'new') { j.techId = null; j.scheduledStart = null; }
    j.status = status;
    if ((status === 'completed' || status === 'invoiced') && !j.completedAt) j.completedAt = new Date().toISOString();
    if (status !== 'completed' && status !== 'invoiced') j.completedAt = null;
    save(); render(); renderDrawer();
    toast(`<b>${j.id}</b> is now ${esc(S.statusLabels[status])}`, [], true);
  }
  function logCall(id) {
    const j = find(id);
    if (!j) return;
    snapshot();
    j.firstCallAt = new Date().toISOString();
    save(); render(); renderDrawer();
    toast(`First call logged for <b>${j.id}</b> at ${fmtTime(j.firstCallAt)}`, [], true);
  }

  function toast(html, warns, undo) {
    const el = $('#toast');
    el.innerHTML = `<span>${html}</span>${(warns || []).map(flagHTML).join('')}${undo ? '<button type="button" data-undo="1">Undo</button>' : ''}`;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), warns && warns.length ? 8000 : 5000);
  }

  // ---------- Placement mode (tap / click to place) ----------
  function startPlacing(id) {
    placingId = id;
    closeDrawer();
    document.body.classList.add('placing-mode');
    $('#placing').hidden = false;
    $('#placingText').textContent = `Placing ${id}: tap a time on any tech's row.`;
    render();
    $('.board-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function stopPlacing() {
    placingId = null;
    document.body.classList.remove('placing-mode');
    $('#placing').hidden = true;
    removeGhost();
    render();
  }

  // ---------- Drag & drop ----------
  function slotFromEvent(track, e, j, grab) {
    const r = track.getBoundingClientRect();
    const per = r.width / SLOTS;
    let s = Math.floor((e.clientX - r.left) / per) - (grab || 0);
    return Math.max(0, Math.min(Math.max(0, SLOTS - durSlots(j)), s));
  }
  let ghostKey = '';
  function showGhost(track, j, slot) {
    const key = track.dataset.tech + ':' + slot;
    if (key === ghostKey) return;
    ghostKey = key;
    removeGhost(true);
    $$('.track.over').forEach(t => t.classList.remove('over'));
    track.classList.add('over');
    const start = slotDate(viewDay, slot);
    const warns = warningsFor(j, track.dataset.tech, start);
    const g = document.createElement('div');
    g.className = 'drop-ghost' + (warns.length ? ' warned' : '');
    g.style.left = (slot / SLOTS * 100) + '%';
    g.style.width = `calc(${durSlots(j) / SLOTS * 100}% - 3px)`;
    g.style.top = '5px';
    g.style.height = 'calc(var(--lane) - 5px)';
    g.innerHTML = `<span class="gt">${fmtTimeShort(start)}–${fmtTimeShort(new Date(start.getTime() + j.durationHrs * HOUR))}</span>${warns.map(flagHTML).join('')}`;
    track.appendChild(g);
  }
  function removeGhost(keepKey) {
    $$('.drop-ghost').forEach(g => g.remove());
    if (!keepKey) { ghostKey = ''; $$('.track.over').forEach(t => t.classList.remove('over')); }
  }

  document.addEventListener('dragstart', e => {
    const el = e.target.closest && e.target.closest('[data-id][draggable]');
    if (!el) return;
    const j = find(el.dataset.id);
    const isBlock = el.classList.contains('block');
    let grab = 0;
    if (isBlock) {
      const track = el.closest('.track');
      const per = track.getBoundingClientRect().width / SLOTS;
      grab = Math.floor((e.clientX - el.getBoundingClientRect().left) / per);
    }
    drag = { id: j.id, grab, isBlock };
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', j.id); } catch (err) { /* ignore */ }
    if (placingId) stopPlacing();
    requestAnimationFrame(() => { el.classList.add('dragging'); document.body.classList.toggle('drag-block', isBlock); });
  });
  document.addEventListener('dragover', e => {
    if (!drag) return;
    const track = e.target.closest && e.target.closest('.track');
    const queue = e.target.closest && e.target.closest('#queue');
    if (track) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showGhost(track, find(drag.id), slotFromEvent(track, e, find(drag.id), drag.grab));
      $('#queue').classList.remove('over');
    } else if (queue && drag.isBlock) {
      e.preventDefault();
      removeGhost();
      queue.classList.add('over');
    } else {
      removeGhost();
      $('#queue').classList.remove('over');
    }
  });
  document.addEventListener('drop', e => {
    if (!drag) return;
    const track = e.target.closest && e.target.closest('.track');
    const queue = e.target.closest && e.target.closest('#queue');
    const d = drag;
    if (track) {
      e.preventDefault();
      const j = find(d.id);
      const slot = slotFromEvent(track, e, j, d.grab);
      endDrag();
      place(d.id, track.dataset.tech, slotDate(viewDay, slot));
    } else if (queue && d.isBlock) {
      e.preventDefault();
      endDrag();
      unassign(d.id);
    }
  });
  document.addEventListener('dragend', () => { if (drag) { endDrag(); render(); } });
  function endDrag() {
    drag = null;
    removeGhost();
    $('#queue').classList.remove('over');
    document.body.classList.remove('drag-block');
    $$('.dragging').forEach(x => x.classList.remove('dragging'));
  }

  // Hover preview + click to place while in placing mode
  $('#board').addEventListener('pointermove', e => {
    if (!placingId || e.pointerType === 'touch') return;
    const track = e.target.closest('.track');
    if (track) showGhost(track, find(placingId), slotFromEvent(track, e, find(placingId), 0));
    else removeGhost();
  });
  $('#board').addEventListener('pointerleave', () => { if (placingId) removeGhost(); });

  // ---------- Clicks & keys ----------
  document.addEventListener('click', e => {
    const t = e.target;
    if (placingId) {
      const track = t.closest('.track');
      if (track) {
        const id = placingId, j = find(id);
        const slot = slotFromEvent(track, e, j, 0);
        placingId = null;
        document.body.classList.remove('placing-mode');
        $('#placing').hidden = true;
        removeGhost();
        place(id, track.dataset.tech, slotDate(viewDay, slot));
        return;
      }
    }
    const alert = t.closest('[data-alert]');
    if (alert) { filter = filter === alert.dataset.alert ? null : alert.dataset.alert; render(); return; }
    if (t.closest('[data-clear]')) { filter = null; render(); return; }
    const open = t.closest('[data-open]');
    if (open) {
      const j = find(open.dataset.open);
      if (j && j.scheduledStart && !isUnassigned(j)) viewDay = startOfDay(j.scheduledStart);
      render();
      openDrawer(open.dataset.open);
      return;
    }
    if (t.closest('[data-undo]')) {
      if (undoSnap) { jobs = undoSnap; undoSnap = null; save(); render(); if (openId) renderDrawer(); }
      $('#toast').classList.remove('show');
      return;
    }
    const card = t.closest('.qcard, .block');
    if (card) { openDrawer(card.dataset.id); return; }
    const act = t.closest('[data-act]');
    if (act && openId) {
      const a = act.dataset.act, j = find(openId);
      if (a === 'close') closeDrawer();
      else if (a === 'call') logCall(j.id);
      else if (a === 'next') setStatus(j.id, S.statuses[S.statuses.indexOf(j.status) + 1]);
      else if (a === 'unassign') unassign(j.id);
      else if (a === 'pick') startPlacing(j.id);
      else if (a === 'assign') {
        const f = formValues();
        if (!f) {
          const noTech = !$('#drTech').value;
          $(noTech ? '#drTech' : '#drDay').focus();
          $('#drWarns').innerHTML = `<span class="flag bad">${noTech ? 'Choose a tech first' : 'Choose a day first'}</span>`;
          return;
        }
        place(j.id, f.techId, f.start);
      }
    }
  });
  document.addEventListener('change', e => {
    if (!openId) return;
    if (e.target.id === 'drStatus') setStatus(openId, e.target.value);
    else if (['drTech', 'drDay', 'drSlot'].includes(e.target.id)) updateFormWarnings();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (openId) { closeDrawer(); return; }
      if (placingId) { stopPlacing(); return; }
      if (filter) { filter = null; render(); return; }
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.qcard, .block')) {
      e.preventDefault();
      openDrawer(e.target.dataset.id);
    }
    if (e.key === 'Tab' && openId) { // keep focus inside the drawer
      const f = $$('#drawer button, #drawer select, #drawer input, #drawer a[href]').filter(x => !x.disabled);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  $('#backdrop').addEventListener('click', closeDrawer);
  $('#cancelPlace').addEventListener('click', e => { e.stopPropagation(); stopPlacing(); });
  $('#prevDay').addEventListener('click', () => { viewDay = addDays(viewDay, -1); render(); });
  $('#nextDay').addEventListener('click', () => { viewDay = addDays(viewDay, 1); render(); });
  $('#todayBtn').addEventListener('click', () => { viewDay = startOfDay(new Date()); render(); });
  $$('.seg button').forEach(b => b.addEventListener('click', () => { colorBy = b.dataset.color; render(); }));
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Reset the demo? This puts every job back the way it started.')) return;
    try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
    jobs = clone(S.jobs);
    undoSnap = null; filter = null; viewDay = startOfDay(new Date());
    if (openId) closeDrawer();
    if (placingId) stopPlacing();
    render();
    toast('Demo reset to the original schedule', [], false);
  });

  // Live countdowns
  setInterval(() => { if (!drag) { render(); } }, 30000);
  render();
})();

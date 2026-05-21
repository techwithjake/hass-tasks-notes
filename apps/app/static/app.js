'use strict';

// ── State ──────────────────────────────────────────────────
const state = {
  // Navigation
  activeTab:       'tasks',   // 'tasks' | 'notes'
  activeView:      'inbox',   // 'inbox' | 'today' | 'upcoming' | 'all' | 'project'
  activeProjectId: null,

  // Data
  projects:  [],
  sections:  [],   // sections for current project
  tasks:     [],
  subtasks:  {},   // { taskId: Task[] }

  // Detail panel
  activeTaskId:   null,
  detailDirty:    false,

  // Filters
  statusFilter:   'active',
  priorityFilter: '',
  searchFilter:   '',

  // Inline form tracking
  openFormSectionId: null,  // null = "no section" (top of project)

  // Drag & drop
  dragTaskId: null,
  dragOrder:  [],

  // Notes
  notes:        [],
  activeNoteId: null,
  noteSearch:   '',
  noteDirty:    false,

  // Modal state
  editingProjectId: null,
  editingSectionId: null,
  editingSectionProjectId: null,

  // Project color chosen in modal
  chosenProjectColor: '#db4035',
};

// Project palette
const PROJECT_COLORS = [
  '#db4035','#ff9a14','#ffd01a','#afb83b','#7ecc49',
  '#299438','#6accbc','#158fad','#14aaf5','#96c3eb',
  '#4073ff','#884dff','#af38eb','#eb96eb','#e05194',
  '#ff8d85','#808080','#b8b8b8',
];

// ── API helper ─────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

// ── Natural language date parser ───────────────────────────
function parseNaturalDate(input) {
  if (!input || !input.trim()) return null;
  const s = input.trim().toLowerCase();
  const today = new Date(); today.setHours(0, 0, 0, 0);

  if (s === 'today')     return isoDate(today);
  if (s === 'tomorrow')  { const d = new Date(today); d.setDate(d.getDate() + 1); return isoDate(d); }
  if (s === 'yesterday') { const d = new Date(today); d.setDate(d.getDate() - 1); return isoDate(d); }

  const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

  const nextMatch = s.match(/^next\s+(\w+)$/);
  if (nextMatch) {
    const di = DAYS.indexOf(nextMatch[1]);
    if (di !== -1) {
      const d = new Date(today);
      let diff = di - d.getDay();
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      return isoDate(d);
    }
  }

  const thisMatch = s.match(/^this\s+(\w+)$/);
  if (thisMatch) {
    const di = DAYS.indexOf(thisMatch[1]);
    if (di !== -1) {
      const d = new Date(today);
      let diff = di - d.getDay();
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      return isoDate(d);
    }
  }

  // "in X days/weeks"
  const inMatch = s.match(/^in\s+(\d+)\s+(day|days|week|weeks)$/);
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const d = new Date(today);
    d.setDate(d.getDate() + (inMatch[2].startsWith('week') ? n * 7 : n));
    return isoDate(d);
  }

  // "X days from now"
  const fromNow = s.match(/^(\d+)\s+(day|days|week|weeks)\s+from\s+now$/);
  if (fromNow) {
    const n = parseInt(fromNow[1]);
    const d = new Date(today);
    d.setDate(d.getDate() + (fromNow[2].startsWith('week') ? n * 7 : n));
    return isoDate(d);
  }

  // ── Named month: "Jun 15", "June 15", "Jun 15 2026", "June 15, 2026" ──
  // Native Date.parse() assigns an unpredictable year for "Mon DD" strings,
  // so handle these explicitly before falling through to the native parser.
  const MONTHS_LIST = ['january','february','march','april','may','june',
                       'july','august','september','october','november','december'];
  const namedMonth = s.match(/^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  if (namedMonth && namedMonth[1].length >= 3) {
    const mi = MONTHS_LIST.findIndex(m => m.startsWith(namedMonth[1]));
    if (mi !== -1) {
      const day = parseInt(namedMonth[2]);
      if (day >= 1 && day <= 31) {
        if (namedMonth[3]) {
          return isoDate(new Date(parseInt(namedMonth[3]), mi, day));
        }
        const candidate = new Date(today.getFullYear(), mi, day);
        if (candidate < today) candidate.setFullYear(today.getFullYear() + 1);
        return isoDate(candidate);
      }
    }
  }

  // ── American date formats ─────────────────────────────────
  // MM/DD or M/D  (no year → next occurrence of that month/day)
  const mdOnly = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (mdOnly) {
    const [, m, d] = mdOnly.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const candidate = new Date(today.getFullYear(), m - 1, d);
      // If the date has already passed this year, roll to next year
      if (candidate < today) candidate.setFullYear(today.getFullYear() + 1);
      return isoDate(candidate);
    }
  }

  // MM/DD/YY or M/D/YY  (2-digit year — native parser sometimes misreads these)
  const mdyShort = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mdyShort) {
    const [, m, d, y] = mdyShort.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return isoDate(new Date(2000 + y, m - 1, d));
    }
  }

  // Try native date parse as the final fallback.
  // Handles: "Jan 15", "May 28 2026", "2026-06-01",
  //          "05/28/2026", "05-28-2026", "5-28-26", etc.
  const parsed = new Date(input);
  if (!isNaN(parsed)) return isoDate(parsed);
  return null;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

// ── Date Picker ────────────────────────────────────────────
class DatePicker {
  constructor({ input, trigger, onChange } = {}) {
    this.input    = input;
    this.trigger  = trigger;
    this.onChange = onChange || null;
    this.popup    = null;
    this.viewDate = null;

    trigger.addEventListener('click', e => {
      e.stopPropagation();
      this.popup ? this.close() : this.open();
    });
  }

  /** Parse the current input value → Date or null */
  _selectedDate() {
    const val = this.input.value.trim();
    if (!val) return null;
    const iso = parseNaturalDate(val) || val;
    const d   = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
    return isNaN(d) ? null : d;
  }

  open() {
    const sel = this._selectedDate();
    const ref = sel || new Date();
    this.viewDate = new Date(ref.getFullYear(), ref.getMonth(), 1);

    this.popup = document.createElement('div');
    this.popup.className = 'dp-popup';
    document.body.appendChild(this.popup);
    this._render();
    this._position();

    this._outsideClick = e => {
      if (this.popup && !this.popup.contains(e.target) && e.target !== this.trigger) {
        this.close();
      }
    };
    // Defer so this click doesn't immediately close it
    setTimeout(() => document.addEventListener('click', this._outsideClick), 0);
  }

  close() {
    if (this.popup) { this.popup.remove(); this.popup = null; }
    document.removeEventListener('click', this._outsideClick);
  }

  _position() {
    const rect = this.trigger.getBoundingClientRect();
    const W = 256;
    let left = rect.left;
    let top  = rect.bottom + 6;
    if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
    if (left < 8) left = 8;
    if (top + 320 > window.innerHeight - 8) top = rect.top - 320 - 4;
    this.popup.style.left = `${Math.round(left)}px`;
    this.popup.style.top  = `${Math.round(top)}px`;
  }

  _render() {
    const year     = this.viewDate.getFullYear();
    const month    = this.viewDate.getMonth();
    const selDate  = this._selectedDate();
    const today    = new Date(); today.setHours(0, 0, 0, 0);
    const monthLbl = new Date(year, month, 1)
                       .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    // Build grid: start on the Sunday before the 1st
    const firstDay = new Date(year, month, 1);
    const start    = new Date(firstDay);
    start.setDate(start.getDate() - start.getDay());

    const cells = [];
    const cur = new Date(start);
    for (let i = 0; i < 42; i++) { cells.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }

    // Use 5-row grid when last row is fully in next month
    const rows = cells[35].getMonth() !== month ? 5 : 6;

    const dayHtml = cells.slice(0, rows * 7).map(d => {
      const iso        = isoDate(d);
      const isToday    = d.getTime() === today.getTime();
      const isSelected = selDate && d.getTime() === selDate.getTime();
      const isOther    = d.getMonth() !== month;
      const cls = ['dp-day',
                   isToday    ? 'today'       : '',
                   isSelected ? 'selected'    : '',
                   isOther    ? 'other-month' : '']
                  .filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-date="${iso}">${d.getDate()}</button>`;
    }).join('');

    this.popup.innerHTML = `
      <div class="dp-header">
        <button type="button" class="dp-nav dp-prev">&#x2039;</button>
        <span class="dp-month-label">${monthLbl}</span>
        <button type="button" class="dp-nav dp-next">&#x203A;</button>
      </div>
      <div class="dp-weekdays">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span>
        <span>Th</span><span>Fr</span><span>Sa</span>
      </div>
      <div class="dp-days">${dayHtml}</div>
      <div class="dp-footer">
        <button type="button" class="dp-btn-clear">Clear</button>
        <button type="button" class="dp-btn-today">Today</button>
      </div>`;

    this.popup.querySelector('.dp-prev').addEventListener('click', e => {
      e.stopPropagation();
      this.viewDate = new Date(year, month - 1, 1);
      this._render();
    });
    this.popup.querySelector('.dp-next').addEventListener('click', e => {
      e.stopPropagation();
      this.viewDate = new Date(year, month + 1, 1);
      this._render();
    });
    this.popup.querySelectorAll('.dp-day').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this._pick(btn.dataset.date);
      });
    });
    this.popup.querySelector('.dp-btn-clear').addEventListener('click', e => {
      e.stopPropagation();
      this._pick('');
    });
    this.popup.querySelector('.dp-btn-today').addEventListener('click', e => {
      e.stopPropagation();
      this._pick(isoDate(new Date()));
    });
  }

  _pick(iso) {
    this.input.value = iso;
    // Fire 'input' so dirty-tracking picks up the change
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    if (this.onChange) this.onChange(iso);
    this.close();
  }
}

// ── Load functions ─────────────────────────────────────────
async function loadProjects() {
  state.projects = await api('GET', 'api/projects');
  renderSidebar();
  updateBadges();
}

async function loadSections(projectId) {
  if (!projectId) { state.sections = []; return; }
  state.sections = await api('GET', `api/projects/${projectId}/sections`);
}

async function loadTasks() {
  const p = new URLSearchParams();
  p.set('status', state.statusFilter);
  if (state.priorityFilter) p.set('priority', state.priorityFilter);
  if (state.searchFilter)   p.set('search', state.searchFilter);

  if (state.activeView === 'inbox') {
    const inbox = state.projects.find(pr => pr.is_inbox);
    if (inbox) p.set('project_id', inbox.id);
  } else if (state.activeView === 'project') {
    if (state.activeProjectId) p.set('project_id', state.activeProjectId);
  } else {
    p.set('view', state.activeView); // 'today' | 'upcoming' | 'all'
  }

  state.tasks = await api('GET', `api/tasks?${p}`);
  renderView();
}

async function loadSubtasks(taskId) {
  state.subtasks[taskId] = await api('GET', `api/tasks/${taskId}/subtasks`);
}

// ── Projects ───────────────────────────────────────────────
async function createProject(name, color) {
  await api('POST', 'api/projects', { name, color });
  await loadProjects();
}

async function updateProject(id, data) {
  await api('PUT', `api/projects/${id}`, data);
  await loadProjects();
}

async function deleteProject(id) {
  await api('DELETE', `api/projects/${id}`);
  // If we were viewing this project, go to inbox
  if (state.activeView === 'project' && state.activeProjectId === id) {
    const inbox = state.projects.find(pr => pr.is_inbox);
    await switchView('inbox', inbox ? inbox.id : null);
  }
  await loadProjects();
}

// ── Sections ───────────────────────────────────────────────
async function createSection(projectId, name) {
  await api('POST', `api/projects/${projectId}/sections`, { name });
  await loadSections(projectId);
  await loadTasks();
}

async function updateSection(projectId, sectionId, data) {
  await api('PUT', `api/projects/${projectId}/sections/${sectionId}`, data);
  await loadSections(projectId);
  renderView();
}

async function deleteSection(projectId, sectionId) {
  await api('DELETE', `api/projects/${projectId}/sections/${sectionId}`);
  await loadSections(projectId);
  await loadTasks();
}

// ── Tasks ──────────────────────────────────────────────────
async function createTask(data) {
  const task = await api('POST', 'api/tasks', data);
  await loadTasks();
  return task;
}

async function updateTask(id, data) {
  const task = await api('PUT', `api/tasks/${id}`, data);
  await loadTasks();
  return task;
}

async function deleteTask(id) {
  await api('DELETE', `api/tasks/${id}`);
  if (state.activeTaskId === id) closeDetail();
  await loadTasks();
}

async function toggleTask(id) {
  await api('POST', `api/tasks/${id}/toggle`);
  // Reload subtasks if this was a subtask being toggled
  const task = state.tasks.find(t => t.id === id);
  if (task && task.parent_id && state.subtasks[task.parent_id]) {
    await loadSubtasks(task.parent_id);
  }
  await loadTasks();
  if (state.activeTaskId === id) {
    const updated = state.tasks.find(t => t.id === id);
    if (updated) syncDetailPanel(updated);
  }
}

async function reorderTasks(items) {
  await api('POST', 'api/tasks/reorder', items);
}

// ── Subtasks ───────────────────────────────────────────────
async function createSubtask(parentId, title) {
  const parent = state.tasks.find(t => t.id === parentId);
  await api('POST', 'api/tasks', {
    title,
    parent_id:  parentId,
    project_id: parent ? parent.project_id : null,
    section_id: parent ? parent.section_id : null,
  });
  await loadSubtasks(parentId);
  renderDetailSubtasks();
  await loadTasks(); // refresh subtask counts
}

async function toggleSubtask(subtaskId, parentId) {
  await api('POST', `api/tasks/${subtaskId}/toggle`);
  await loadSubtasks(parentId);
  renderDetailSubtasks();
  await loadTasks();
}

async function deleteSubtask(subtaskId, parentId) {
  await api('DELETE', `api/tasks/${subtaskId}`);
  await loadSubtasks(parentId);
  renderDetailSubtasks();
  await loadTasks();
}

// ── Navigation ─────────────────────────────────────────────
async function switchView(view, projectId) {
  state.activeView      = view;
  state.activeProjectId = projectId || null;
  state.activeTaskId    = null;
  state.detailDirty     = false;
  state.openFormSectionId = null;

  document.getElementById('task-detail').classList.add('hidden');
  document.querySelectorAll('.nav-item, .project-nav-item').forEach(el => el.classList.remove('active'));

  if (view === 'inbox') {
    document.querySelector('[data-view="inbox"]').classList.add('active');
  } else if (view === 'today') {
    document.querySelector('[data-view="today"]').classList.add('active');
  } else if (view === 'upcoming') {
    document.querySelector('[data-view="upcoming"]').classList.add('active');
  } else if (view === 'all') {
    document.querySelector('[data-view="all"]').classList.add('active');
  } else if (view === 'project') {
    document.querySelector(`[data-project-id="${projectId}"]`)?.classList.add('active');
  }

  const projectId2 = view === 'project' ? projectId
    : (view === 'inbox' ? state.projects.find(p => p.is_inbox)?.id : null);
  await loadSections(projectId2);
  await loadTasks();
  updateViewHeader();
}

function updateViewHeader() {
  const dot   = document.getElementById('view-color-dot');
  const title = document.getElementById('view-title');
  const acts  = document.getElementById('view-header-actions');

  dot.style.display = 'none';
  acts.innerHTML = '';

  if (state.activeView === 'inbox') {
    title.textContent = 'Inbox';
    dot.style.backgroundColor = '#3b82f6';
    dot.style.display = 'block';
  } else if (state.activeView === 'today') {
    title.textContent = 'Today';
  } else if (state.activeView === 'upcoming') {
    title.textContent = 'Upcoming';
  } else if (state.activeView === 'all') {
    title.textContent = 'All Tasks';
  } else if (state.activeView === 'project') {
    const proj = state.projects.find(p => p.id === state.activeProjectId);
    if (proj) {
      title.textContent = proj.name;
      dot.style.backgroundColor = proj.color;
      dot.style.display = 'block';
      const addSecBtn = mkEl('button', 'add-section-trigger');
      addSecBtn.innerHTML = '<span>+ Add section</span>';
      addSecBtn.addEventListener('click', () => openSectionModal(null, state.activeProjectId));
      acts.appendChild(addSecBtn);
    }
  }
}

// ── Render: Sidebar ────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('project-nav-list');
  const nonInbox = state.projects.filter(p => !p.is_inbox);
  if (!nonInbox.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = nonInbox.map(p => `
    <div class="project-nav-item${state.activeView === 'project' && state.activeProjectId === p.id ? ' active' : ''}"
         data-project-id="${p.id}">
      <span class="project-dot" style="background:${esc(p.color)}"></span>
      <span class="project-nav-label">${esc(p.name)}</span>
      <button class="project-nav-edit js-edit-project" data-id="${p.id}" title="Edit project">&#x22EF;</button>
    </div>
  `).join('');

  list.querySelectorAll('.project-nav-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.js-edit-project')) return;
      switchView('project', +el.dataset.projectId);
    });
  });
  list.querySelectorAll('.js-edit-project').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openProjectModal(+btn.dataset.id);
    });
  });
}

// ── Render: Main view ──────────────────────────────────────
function renderView() {
  const container = document.getElementById('sections-container');

  const isProjectView = state.activeView === 'inbox' || state.activeView === 'project';

  if (isProjectView) {
    renderProjectView(container);
  } else {
    renderFlatView(container);
  }
}

function renderProjectView(container) {
  const sections = state.sections;
  const allTasks = state.tasks;

  let html = '';

  // Unsectioned tasks (section_id IS NULL)
  const unsectioned = allTasks.filter(t => !t.section_id);
  html += renderSectionBlock(null, unsectioned);

  // Each section
  sections.forEach(sec => {
    const secTasks = allTasks.filter(t => t.section_id === sec.id);
    html += renderSectionBlock(sec, secTasks);
  });

  // "Add section" at the bottom
  const projId = state.activeView === 'project' ? state.activeProjectId
    : state.projects.find(p => p.is_inbox)?.id;
  if (projId) {
    html += `<button class="add-section-trigger js-add-section" data-project-id="${projId}">
      <span class="plus">+</span> Add section
    </button>`;
  }

  container.innerHTML = html;
  bindSectionEvents(container);
  bindTaskEvents(container);
}

function renderSectionBlock(sec, tasks) {
  const secId = sec ? sec.id : 'null';
  const secKey = sec ? sec.id : 'nosec';
  return `
    <div class="section-block" data-section-key="${secKey}">
      ${sec ? `
        <div class="section-header" data-section-id="${sec.id}">
          <button class="section-collapse-btn js-collapse-section" data-key="${secKey}" title="Collapse">&#x25BC;</button>
          <span class="section-name">${esc(sec.name)}</span>
          <div class="section-actions">
            <button class="section-action-btn js-edit-section" data-id="${sec.id}" data-project-id="${sec.project_id}" title="Rename">&#x270E;</button>
            <button class="section-action-btn js-add-task-section" data-section-id="${sec.id}" title="Add task">+</button>
          </div>
        </div>
      ` : ''}
      <div class="section-tasks" data-section-id="${secId}">
        ${tasks.map(t => renderTaskItem(t)).join('')}
        ${renderInlineForm(sec ? sec.id : null)}
        <button class="add-task-trigger js-add-task-trigger" data-section-id="${secId}">
          <span class="plus">+</span> Add task
        </button>
      </div>
    </div>
  `;
}

function renderInlineForm(sectionId) {
  const key = sectionId === null ? 'null' : sectionId;
  if (state.openFormSectionId !== key) return '';
  return `
    <div class="inline-task-form" data-form-section="${key}">
      <input type="text" class="inline-title" placeholder="Task name" autocomplete="off">
      <div class="inline-task-extras">
        <div class="dp-field">
          <input type="text" class="inline-due" placeholder="Due date" autocomplete="off">
          <button type="button" class="dp-trigger" title="Pick a date">&#128197;</button>
        </div>
        <select class="inline-priority">
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="low">Low</option>
        </select>
        <input type="text" class="inline-tags" placeholder="Tags">
      </div>
      <div class="inline-task-actions">
        <button class="btn-ghost js-cancel-inline">Cancel</button>
        <button class="btn-primary js-save-inline" data-section-id="${key}">Add task</button>
      </div>
    </div>
  `;
}

function renderTaskItem(t) {
  const isActive = t.id === state.activeTaskId;
  const pClass   = t.priority !== 'normal' ? `priority-${t.priority}` : '';
  const subtaskHtml = t.subtask_count > 0
    ? `<span class="subtask-pill${t.subtask_done === t.subtask_count ? ' all-done' : ''}">
        &#x2B73; ${t.subtask_done}/${t.subtask_count}
       </span>` : '';
  const recHtml = t.recurrence
    ? `<span class="recurrence-indicator" title="Repeats ${t.recurrence}">&#x21BB;</span>` : '';

  return `
    <div class="task-item${t.completed ? ' completed' : ''} ${pClass}${isActive ? ' active-detail' : ''}"
         data-id="${t.id}" draggable="true">
      <span class="drag-handle" title="Drag to reorder">&#x2807;</span>
      <button class="task-check js-toggle" data-id="${t.id}" title="${t.completed ? 'Mark incomplete' : 'Complete'}">
        ${t.completed ? '&#x2713;' : ''}
      </button>
      <div class="task-body js-open-detail" data-id="${t.id}">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">
          ${priorityFlag(t.priority)}
          ${dueBadge(t.due_date)}
          ${recHtml}
          ${subtaskHtml}
          ${t.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}
        </div>
        ${t.notes ? `<div class="task-notes-preview">${esc(t.notes.slice(0, 100))}${t.notes.length > 100 ? '…' : ''}</div>` : ''}
      </div>
    </div>
  `;
}

function renderFlatView(container) {
  if (!state.tasks.length) {
    container.innerHTML = '<div class="empty-state">No tasks here</div>';
    return;
  }

  if (state.activeView === 'upcoming') {
    // Group by date
    const groups = {};
    state.tasks.forEach(t => {
      const key = t.due_date || 'No date';
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    });
    let html = '';
    Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).forEach(([date, tasks]) => {
      html += `<div class="section-block">
        <div class="section-header">
          <span class="section-name">${fmtDateLabel(date)}</span>
        </div>
        <div class="section-tasks">
          ${tasks.map(t => renderTaskItem(t)).join('')}
        </div>
      </div>`;
    });
    container.innerHTML = html;
  } else {
    container.innerHTML = `
      <div class="section-block">
        <div class="section-tasks">
          ${state.tasks.map(t => renderTaskItem(t)).join('')}
        </div>
      </div>`;
  }

  bindTaskEvents(container);
}

// ── Section events ─────────────────────────────────────────
function bindSectionEvents(container) {
  container.querySelectorAll('.js-collapse-section').forEach(btn => {
    btn.addEventListener('click', () => {
      const block  = btn.closest('.section-block');
      const tasks  = block.querySelector('.section-tasks');
      const collapsed = tasks.classList.toggle('collapsed');
      btn.innerHTML = collapsed ? '&#x25BA;' : '&#x25BC;';
    });
  });

  container.querySelectorAll('.js-edit-section').forEach(btn => {
    btn.addEventListener('click', () => openSectionModal(+btn.dataset.id, +btn.dataset.projectId));
  });

  container.querySelectorAll('.js-add-task-section').forEach(btn => {
    const secId = btn.dataset.sectionId;
    btn.addEventListener('click', () => openInlineForm(secId));
  });

  container.querySelectorAll('.js-add-task-trigger').forEach(btn => {
    const secId = btn.dataset.sectionId;
    btn.addEventListener('click', () => openInlineForm(secId));
  });

  container.querySelectorAll('.js-add-section').forEach(btn => {
    btn.addEventListener('click', () => openSectionModal(null, +btn.dataset.projectId));
  });

  bindInlineFormEvents(container);
}

function openInlineForm(sectionIdKey) {
  state.openFormSectionId = sectionIdKey === 'null' ? 'null' : String(sectionIdKey);
  renderView();
  // Focus the title input
  setTimeout(() => {
    const input = document.querySelector('.inline-title');
    if (input) input.focus();
  }, 0);
}

function bindInlineFormEvents(container) {
  container.querySelectorAll('.js-cancel-inline').forEach(btn => {
    btn.addEventListener('click', () => { state.openFormSectionId = null; renderView(); });
  });

  container.querySelectorAll('.js-save-inline').forEach(btn => {
    btn.addEventListener('click', () => saveInlineTask(btn));
  });

  container.querySelectorAll('.inline-title').forEach(input => {
    input.addEventListener('keydown', async e => {
      if (e.key === 'Enter') {
        const btn = input.closest('.inline-task-form').querySelector('.js-save-inline');
        await saveInlineTask(btn);
      }
      if (e.key === 'Escape') { state.openFormSectionId = null; renderView(); }
    });
  });

  // Date picker for inline form due-date fields
  container.querySelectorAll('.inline-task-form').forEach(form => {
    const inp  = form.querySelector('.inline-due');
    const trig = form.querySelector('.dp-trigger');
    if (inp && trig) new DatePicker({ input: inp, trigger: trig });
  });
}

async function saveInlineTask(btn) {
  const form     = btn.closest('.inline-task-form');
  const title    = form.querySelector('.inline-title').value.trim();
  if (!title) { form.querySelector('.inline-title').focus(); return; }

  const dueRaw   = form.querySelector('.inline-due').value;
  const due      = parseNaturalDate(dueRaw) || (dueRaw || null);
  const priority = form.querySelector('.inline-priority').value;
  const tagsRaw  = form.querySelector('.inline-tags').value;
  const tags     = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);

  const secIdKey = btn.dataset.sectionId;
  const sectionId = (secIdKey === 'null' || secIdKey === undefined) ? null : +secIdKey;

  let projectId = null;
  if (state.activeView === 'inbox') {
    projectId = state.projects.find(p => p.is_inbox)?.id || null;
  } else if (state.activeView === 'project') {
    projectId = state.activeProjectId;
  }

  // Clear BEFORE the await so renderView() (called inside createTask) sees it already null
  state.openFormSectionId = null;
  await createTask({ title, due_date: due, priority, tags, project_id: projectId, section_id: sectionId });
  toast('Task added');
}

// ── Task events ────────────────────────────────────────────
function bindTaskEvents(container) {
  container.querySelectorAll('.js-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleTask(+btn.dataset.id);
    });
  });

  container.querySelectorAll('.js-open-detail').forEach(el => {
    el.addEventListener('click', () => openDetail(+el.dataset.id));
  });

  // Drag-to-reorder
  container.querySelectorAll('.task-item[draggable]').forEach(el => {
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragover',  onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop',      onDrop);
    el.addEventListener('dragend',   onDragEnd);
  });
}

// ── Drag & Drop ────────────────────────────────────────────
function onDragStart(e) {
  state.dragTaskId = +this.dataset.id;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (+this.dataset.id !== state.dragTaskId) {
    document.querySelectorAll('.task-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    this.classList.add('drag-over');
  }
}
function onDragLeave() { this.classList.remove('drag-over'); }
function onDragEnd()   {
  this.classList.remove('dragging');
  document.querySelectorAll('.task-item.drag-over').forEach(el => el.classList.remove('drag-over'));
}
async function onDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  const targetId = +this.dataset.id;
  if (!state.dragTaskId || state.dragTaskId === targetId) return;

  // Re-order within the same section list
  const sectionEl = this.closest('.section-tasks');
  const items = [...sectionEl.querySelectorAll('.task-item[data-id]')];
  const ids   = items.map(el => +el.dataset.id);

  const fromIdx = ids.indexOf(state.dragTaskId);
  const toIdx   = ids.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return;

  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, state.dragTaskId);

  const reorderItems = ids.map((id, idx) => ({ id, sort_order: idx }));
  await reorderTasks(reorderItems);
  await loadTasks();
}

// ── Detail panel ───────────────────────────────────────────
async function openDetail(taskId) {
  if (state.activeTaskId === taskId) return;
  if (state.detailDirty) { if (!confirm('Discard unsaved changes?')) return; }

  state.activeTaskId = taskId;
  state.detailDirty  = false;

  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  syncDetailPanel(task);
  document.getElementById('task-detail').classList.remove('hidden');

  // Highlight in list
  document.querySelectorAll('.task-item').forEach(el =>
    el.classList.toggle('active-detail', +el.dataset.id === taskId)
  );

  // Load subtasks
  await loadSubtasks(taskId);
  renderDetailSubtasks();
}

function syncDetailPanel(task) {
  qs('#detail-title').value      = task.title;
  qs('#detail-priority').value   = task.priority;
  qs('#detail-recurrence').value = task.recurrence || '';
  qs('#detail-due').value        = task.due_date || '';
  qs('#detail-tags').value       = task.tags.join(', ');
  qs('#detail-notes').value      = task.notes;
}

function renderDetailSubtasks() {
  const taskId   = state.activeTaskId;
  const subtasks = state.subtasks[taskId] || [];
  const container = qs('#detail-subtasks');
  const countEl   = qs('#detail-subtask-count');

  const done = subtasks.filter(s => s.completed).length;
  countEl.textContent = subtasks.length ? `${done}/${subtasks.length}` : '';

  container.innerHTML = subtasks.map(s => `
    <div class="detail-subtask-item${s.completed ? ' completed' : ''}" data-id="${s.id}">
      <button class="task-check js-toggle-subtask" data-id="${s.id}" data-parent="${taskId}">
        ${s.completed ? '&#x2713;' : ''}
      </button>
      <input class="detail-subtask-title js-subtask-title" data-id="${s.id}"
             value="${esc(s.title)}" type="text">
      <button class="detail-subtask-delete js-delete-subtask" data-id="${s.id}" data-parent="${taskId}" title="Delete">&times;</button>
    </div>
  `).join('');

  container.querySelectorAll('.js-toggle-subtask').forEach(btn => {
    btn.addEventListener('click', () => toggleSubtask(+btn.dataset.id, +btn.dataset.parent));
  });
  container.querySelectorAll('.js-delete-subtask').forEach(btn => {
    btn.addEventListener('click', () => deleteSubtask(+btn.dataset.id, +btn.dataset.parent));
  });
  container.querySelectorAll('.js-subtask-title').forEach(input => {
    input.addEventListener('change', async () => {
      await api('PUT', `api/tasks/${input.dataset.id}`, { title: input.value.trim() || 'Untitled' });
    });
  });
}

function closeDetail() {
  state.activeTaskId = null;
  state.detailDirty  = false;
  qs('#task-detail').classList.add('hidden');
  document.querySelectorAll('.task-item').forEach(el => el.classList.remove('active-detail'));
}

async function saveDetail() {
  if (!state.activeTaskId) return;
  const dueRaw = qs('#detail-due').value.trim();
  const due    = parseNaturalDate(dueRaw) || (dueRaw || null);

  await updateTask(state.activeTaskId, {
    title:      qs('#detail-title').value.trim() || 'Untitled',
    priority:   qs('#detail-priority').value,
    recurrence: qs('#detail-recurrence').value || null,
    due_date:   due,
    tags:       qs('#detail-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    notes:      qs('#detail-notes').value,
  });
  state.detailDirty = false;
  toast('Saved');
}

// ── Project modal ──────────────────────────────────────────
function openProjectModal(projectId) {
  state.editingProjectId = projectId || null;
  const modal    = qs('#project-modal');
  const title    = qs('#project-modal-title');
  const nameInp  = qs('#project-name-input');
  const saveBtn  = qs('#save-project-btn');
  const delBtn   = qs('#delete-project-btn');

  if (projectId) {
    const proj = state.projects.find(p => p.id === projectId);
    title.textContent    = 'Edit Project';
    nameInp.value        = proj ? proj.name : '';
    state.chosenProjectColor = proj ? proj.color : '#db4035';
    saveBtn.textContent  = 'Save';
    delBtn.classList.remove('hidden');
  } else {
    title.textContent    = 'New Project';
    nameInp.value        = '';
    state.chosenProjectColor = '#db4035';
    saveBtn.textContent  = 'Create';
    delBtn.classList.add('hidden');
  }

  renderColorPicker();
  modal.classList.remove('hidden');
  nameInp.focus();
}

function renderColorPicker() {
  const picker = qs('#project-color-picker');
  picker.innerHTML = PROJECT_COLORS.map(c =>
    `<span class="color-swatch${c === state.chosenProjectColor ? ' selected' : ''}"
           style="background:${c}" data-color="${c}"></span>`
  ).join('');
  picker.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      state.chosenProjectColor = sw.dataset.color;
      picker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
  });
}

function closeProjectModal() {
  qs('#project-modal').classList.add('hidden');
  state.editingProjectId = null;
}

// ── Section modal ──────────────────────────────────────────
function openSectionModal(sectionId, projectId) {
  state.editingSectionId        = sectionId || null;
  state.editingSectionProjectId = projectId;
  const modal   = qs('#section-modal');
  const nameInp = qs('#section-name-input');
  const delBtn  = qs('#delete-section-btn');

  if (sectionId) {
    const sec = state.sections.find(s => s.id === sectionId);
    nameInp.value = sec ? sec.name : '';
    delBtn.classList.remove('hidden');
  } else {
    nameInp.value = '';
    delBtn.classList.add('hidden');
  }
  modal.classList.remove('hidden');
  nameInp.focus();
}

function closeSectionModal() {
  qs('#section-modal').classList.add('hidden');
  state.editingSectionId = null;
}

// ── Badge counts ───────────────────────────────────────────
async function updateBadges() {
  try {
    const inbox = state.projects.find(p => p.is_inbox);
    if (inbox) {
      const tasks = await api('GET', `api/tasks?project_id=${inbox.id}&status=active`);
      const badge = qs('#inbox-badge');
      badge.textContent = tasks.length || '';
      badge.classList.toggle('visible', tasks.length > 0);
    }
    const today  = await api('GET', 'api/tasks?view=today&status=active');
    const badge2 = qs('#today-badge');
    badge2.textContent = today.length || '';
    badge2.classList.toggle('visible', today.length > 0);
  } catch (_) {}
}

// ── Notes ──────────────────────────────────────────────────
async function loadNotes() {
  const p = new URLSearchParams();
  if (state.noteSearch) p.set('search', state.noteSearch);
  state.notes = await api('GET', `api/notes${p.toString() ? '?' + p : ''}`);
  renderNoteList();
}

async function createNote() {
  const note = await api('POST', 'api/notes', { title: 'New Note', content: '', tags: [] });
  await loadNotes();
  await openNote(note.id);
}

async function saveNote() {
  if (!state.activeNoteId) return;
  const title   = qs('#note-title').value.trim() || 'Untitled';
  const content = qs('#note-content').value;
  const tags    = qs('#note-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  await api('PUT', `api/notes/${state.activeNoteId}`, { title, content, tags });
  state.noteDirty = false;
  await loadNotes();
  toast('Note saved');
}

async function deleteNote() {
  if (!state.activeNoteId) return;
  if (!confirm('Delete this note?')) return;
  await api('DELETE', `api/notes/${state.activeNoteId}`);
  state.activeNoteId = null;
  state.noteDirty    = false;
  await loadNotes();
  showNoteEditor(false);
}

async function openNote(id) {
  if (state.noteDirty && !confirm('Discard unsaved changes?')) return;
  const note = await api('GET', `api/notes/${id}`);
  state.activeNoteId = id;
  state.noteDirty    = false;
  qs('#note-title').value   = note.title;
  qs('#note-content').value = note.content;
  qs('#note-tags').value    = note.tags.join(', ');
  showNoteEditor(true);
  renderNoteList();
}

function renderNoteList() {
  const list = qs('#note-list');
  if (!state.notes.length) {
    list.innerHTML = '<div class="empty-state">No notes</div>';
    return;
  }
  list.innerHTML = state.notes.map(n => `
    <div class="note-item${n.id === state.activeNoteId ? ' active' : ''}" data-id="${n.id}">
      <div class="note-item-title">${esc(n.title)}</div>
      <div class="note-item-meta">
        ${fmtDate(n.updated_at)}
        ${n.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
      </div>
    </div>
  `).join('');
  list.querySelectorAll('.note-item').forEach(el =>
    el.addEventListener('click', () => openNote(+el.dataset.id))
  );
}

function showNoteEditor(show) {
  qs('#note-placeholder').classList.toggle('hidden', show);
  qs('#note-editor-content').classList.toggle('hidden', !show);
}

// ── Helpers ────────────────────────────────────────────────
function qs(sel) { return document.querySelector(sel); }

function mkEl(tag, cls) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = String(str || '');
  return d.innerHTML;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function priorityFlag(p) {
  if (p === 'high')   return '<span class="priority-flag high" title="High priority">&#x2691;</span>';
  if (p === 'low')    return '<span class="priority-flag low" title="Low priority">&#x2691;</span>';
  return '';
}

function dueBadge(dateStr) {
  if (!dateStr) return '';
  const due   = new Date(dateStr + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff  = Math.round((due - today) / 86400000);
  const label = diff < 0  ? dateStr
              : diff === 0 ? 'Today'
              : diff === 1 ? 'Tomorrow'
              : dateStr;
  const cls   = diff < 0  ? 'overdue'
              : diff === 0 ? 'today'
              : diff <= 3  ? 'soon'
              : '';
  return `<span class="due-date${cls ? ' ' + cls : ''}">${esc(label)}</span>`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDateLabel(dateStr) {
  if (!dateStr || dateStr === 'No date') return 'No date';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {

  // ── Sidebar: view navigation ───────────────────────────
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'inbox') {
        const inbox = state.projects.find(p => p.is_inbox);
        switchView('inbox', inbox?.id);
      } else {
        switchView(view, null);
      }
    });
  });

  // ── Add project button ─────────────────────────────────
  qs('#add-project-btn').addEventListener('click', () => openProjectModal(null));

  // ── Notes nav button ───────────────────────────────────
  qs('#notes-nav-btn').addEventListener('click', () => {
    state.activeTab = 'notes';
    qs('#tasks-workspace').classList.remove('active');
    qs('#notes-workspace').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    qs('#notes-nav-btn').classList.add('active');
    loadNotes();
  });

  // ── Filters ────────────────────────────────────────────
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.statusFilter = btn.dataset.filter;
      loadTasks();
    });
  });

  qs('#priority-filter').addEventListener('change', e => {
    state.priorityFilter = e.target.value;
    loadTasks();
  });

  qs('#task-search').addEventListener('input', debounce(e => {
    state.searchFilter = e.target.value;
    loadTasks();
  }, 300));

  qs('#global-search').addEventListener('input', debounce(e => {
    state.searchFilter = e.target.value;
    if (state.activeTab === 'tasks') {
      qs('#task-search').value = e.target.value;
      loadTasks();
    }
  }, 300));

  // ── Detail panel ───────────────────────────────────────
  qs('#close-detail-btn').addEventListener('click', () => {
    if (state.detailDirty && !confirm('Discard unsaved changes?')) return;
    closeDetail();
  });

  qs('#detail-save-btn').addEventListener('click', saveDetail);

  qs('#detail-delete-btn').addEventListener('click', async () => {
    if (!state.activeTaskId) return;
    if (!confirm('Delete this task?')) return;
    await deleteTask(state.activeTaskId);
    toast('Task deleted');
  });

  ['#detail-title','#detail-priority','#detail-recurrence','#detail-due','#detail-tags','#detail-notes'].forEach(sel => {
    qs(sel).addEventListener('input', () => { state.detailDirty = true; });
    qs(sel).addEventListener('change', () => { state.detailDirty = true; });
  });

  // ── Date picker for detail panel ───────────────────────
  new DatePicker({
    input:    qs('#detail-due'),
    trigger:  qs('#detail-due-trigger'),
    onChange: () => { state.detailDirty = true; },
  });

  // Add subtask via Enter key
  qs('#new-subtask-input').addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const title = qs('#new-subtask-input').value.trim();
    if (!title || !state.activeTaskId) return;
    qs('#new-subtask-input').value = '';
    await createSubtask(state.activeTaskId, title);
  });

  // ── Project modal ──────────────────────────────────────
  qs('#close-project-modal-btn').addEventListener('click', closeProjectModal);
  qs('#project-modal').addEventListener('click', e => {
    if (e.target === qs('#project-modal')) closeProjectModal();
  });

  qs('#save-project-btn').addEventListener('click', async () => {
    const name  = qs('#project-name-input').value.trim();
    if (!name) { qs('#project-name-input').focus(); return; }
    const color = state.chosenProjectColor;
    if (state.editingProjectId) {
      await updateProject(state.editingProjectId, { name, color });
      toast('Project updated');
    } else {
      const proj = await api('POST', 'api/projects', { name, color });
      await loadProjects();
      switchView('project', proj.id);
      toast('Project created');
    }
    closeProjectModal();
  });

  qs('#project-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') qs('#save-project-btn').click();
    if (e.key === 'Escape') closeProjectModal();
  });

  qs('#delete-project-btn').addEventListener('click', async () => {
    if (!state.editingProjectId) return;
    if (!confirm('Delete this project and all its tasks?')) return;
    await deleteProject(state.editingProjectId);
    closeProjectModal();
    toast('Project deleted');
  });

  // ── Section modal ──────────────────────────────────────
  qs('#close-section-modal-btn').addEventListener('click', closeSectionModal);
  qs('#section-modal').addEventListener('click', e => {
    if (e.target === qs('#section-modal')) closeSectionModal();
  });

  qs('#save-section-btn').addEventListener('click', async () => {
    const name = qs('#section-name-input').value.trim();
    if (!name) { qs('#section-name-input').focus(); return; }
    if (state.editingSectionId) {
      await updateSection(state.editingSectionProjectId, state.editingSectionId, { name });
      toast('Section renamed');
    } else {
      await createSection(state.editingSectionProjectId, name);
      toast('Section added');
    }
    closeSectionModal();
  });

  qs('#section-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') qs('#save-section-btn').click();
    if (e.key === 'Escape') closeSectionModal();
  });

  qs('#delete-section-btn').addEventListener('click', async () => {
    if (!state.editingSectionId) return;
    if (!confirm('Delete this section? Tasks will be moved to unsectioned.')) return;
    await deleteSection(state.editingSectionProjectId, state.editingSectionId);
    closeSectionModal();
    toast('Section deleted');
  });

  // ── Notes ──────────────────────────────────────────────
  qs('#new-note-btn').addEventListener('click', createNote);
  qs('#save-note-btn').addEventListener('click', saveNote);
  qs('#delete-note-btn').addEventListener('click', deleteNote);

  qs('#note-search').addEventListener('input', debounce(e => {
    state.noteSearch = e.target.value;
    loadNotes();
  }, 300));

  ['#note-title','#note-content','#note-tags'].forEach(sel =>
    qs(sel).addEventListener('input', () => { state.noteDirty = true; })
  );

  // ── Keyboard shortcuts ─────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!qs('#project-modal').classList.contains('hidden')) { closeProjectModal(); return; }
      if (!qs('#section-modal').classList.contains('hidden')) { closeSectionModal(); return; }
      if (state.openFormSectionId !== null) { state.openFormSectionId = null; renderView(); return; }
      if (state.activeTaskId) { closeDetail(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (state.activeTab === 'notes') saveNote();
      else if (state.activeTaskId) saveDetail();
    }
  });

  // ── Bootstrap ──────────────────────────────────────────
  await loadProjects();
  const inbox = state.projects.find(p => p.is_inbox);
  await switchView('inbox', inbox?.id);
  document.querySelector('[data-view="inbox"]').classList.add('active');
});

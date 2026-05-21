'use strict';

// ── State ─────────────────────────────────────────────────
const state = {
  tab: 'tasks',
  tasks: [],
  taskFilter: { status: 'all', priority: '', search: '' },
  notes: [],
  activeNoteId: null,
  noteSearch: '',
  editingTaskId: null,
  noteDirty: false,
};

// ── API ───────────────────────────────────────────────────
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

// ── Tasks API ─────────────────────────────────────────────
async function loadTasks() {
  const p = new URLSearchParams();
  if (state.taskFilter.status !== 'all') p.set('status', state.taskFilter.status);
  if (state.taskFilter.priority)         p.set('priority', state.taskFilter.priority);
  if (state.taskFilter.search)           p.set('search', state.taskFilter.search);
  const qs = p.toString();
  state.tasks = await api('GET', `api/tasks${qs ? '?' + qs : ''}`);
  renderTasks();
}

async function createTask(data)        { await api('POST', 'api/tasks', data); await loadTasks(); }
async function updateTask(id, data)    { await api('PUT',  `api/tasks/${id}`, data); await loadTasks(); }
async function deleteTask(id)          { await api('DELETE', `api/tasks/${id}`); await loadTasks(); }
async function toggleTask(id)          { await api('POST', `api/tasks/${id}/toggle`); await loadTasks(); }

// ── Notes API ─────────────────────────────────────────────
async function loadNotes() {
  const p = new URLSearchParams();
  if (state.noteSearch) p.set('search', state.noteSearch);
  const qs = p.toString();
  state.notes = await api('GET', `api/notes${qs ? '?' + qs : ''}`);
  renderNoteList();
}

async function createNote() {
  const note = await api('POST', 'api/notes', { title: 'New Note', content: '', tags: [] });
  await loadNotes();
  await openNote(note.id);
}

async function saveNote() {
  if (!state.activeNoteId) return;
  const title = qs1('#note-title').value.trim() || 'Untitled';
  const content = qs1('#note-content').value;
  const tags = qs1('#note-tags').value.split(',').map(t => t.trim()).filter(Boolean);
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
  state.noteDirty = false;
  await loadNotes();
  showEditor(false);
}

async function openNote(id) {
  if (state.noteDirty && !confirm('Discard unsaved changes?')) return;
  const note = await api('GET', `api/notes/${id}`);
  state.activeNoteId = id;
  state.noteDirty = false;
  qs1('#note-title').value   = note.title;
  qs1('#note-content').value = note.content;
  qs1('#note-tags').value    = note.tags.join(', ');
  showEditor(true);
  renderNoteList();
}

// ── Render: Tasks ─────────────────────────────────────────
function renderTasks() {
  const list = qs1('#task-list');
  if (!state.tasks.length) {
    list.innerHTML = '<div class="empty-state">No tasks found</div>';
    return;
  }
  list.innerHTML = state.tasks.map(t => `
    <div class="task-item${t.completed ? ' completed' : ''}" data-id="${t.id}">
      <button class="task-check js-toggle" data-id="${t.id}" title="${t.completed ? 'Mark incomplete' : 'Mark complete'}">
        ${t.completed ? '✓' : ''}
      </button>
      <div class="task-body js-edit" data-id="${t.id}">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">
          ${priorityBadge(t.priority)}
          ${dueBadge(t.due_date)}
          ${t.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}
        </div>
        ${t.notes ? `<div class="task-notes-preview">${esc(t.notes.slice(0, 120))}${t.notes.length > 120 ? '…' : ''}</div>` : ''}
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.js-toggle').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); toggleTask(+btn.dataset.id); })
  );
  list.querySelectorAll('.js-edit').forEach(el =>
    el.addEventListener('click', () => openTaskModal(+el.dataset.id))
  );
}

// ── Render: Notes ─────────────────────────────────────────
function renderNoteList() {
  const list = qs1('#note-list');
  if (!state.notes.length) {
    list.innerHTML = '<div class="empty-state">No notes found</div>';
    return;
  }
  list.innerHTML = state.notes.map(n => `
    <div class="note-item${n.id === state.activeNoteId ? ' active' : ''}" data-id="${n.id}">
      <div class="note-item-title">${esc(n.title)}</div>
      <div class="note-item-meta">
        ${fmtDate(n.updated_at)}
        ${n.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.note-item').forEach(el =>
    el.addEventListener('click', () => openNote(+el.dataset.id))
  );
}

// ── Task Modal ────────────────────────────────────────────
function openTaskModal(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  state.editingTaskId = id;
  qs1('#edit-task-title').value    = t.title;
  qs1('#edit-task-notes').value    = t.notes;
  qs1('#edit-task-due').value      = t.due_date || '';
  qs1('#edit-task-priority').value = t.priority;
  qs1('#edit-task-tags').value     = t.tags.join(', ');
  qs1('#task-modal').classList.remove('hidden');
  qs1('#edit-task-title').focus();
}

function closeTaskModal() {
  qs1('#task-modal').classList.add('hidden');
  state.editingTaskId = null;
}

// ── Helpers ───────────────────────────────────────────────
function qs1(sel) { return document.querySelector(sel); }

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function showEditor(show) {
  qs1('#note-placeholder').classList.toggle('hidden', show);
  qs1('#note-editor-content').classList.toggle('hidden', !show);
}

function priorityBadge(p) {
  if (p === 'high') return '<span class="priority-badge high">HIGH</span>';
  if (p === 'low')  return '<span class="priority-badge low">LOW</span>';
  return '';
}

function dueBadge(dateStr) {
  if (!dateStr) return '';
  const due   = new Date(dateStr + 'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  const diff  = Math.round((due - today) / 86400000);
  const label = diff < 0  ? dateStr
              : diff === 0 ? 'Today'
              : diff === 1 ? 'Tomorrow'
              : dateStr;
  const cls   = diff < 0  ? 'overdue'
              : diff === 0 ? 'today'
              : diff <= 3  ? 'soon'
              : '';
  return `<span class="due-date${cls ? ' ' + cls : ''}">${label}</span>`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function parseTags(str) {
  return str.split(',').map(t => t.trim()).filter(Boolean);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `${state.tab}-panel`));
      if (state.tab === 'notes') loadNotes();
    })
  );

  // ── Tasks ──────────────────────────────────────────────
  qs1('#add-task-btn').addEventListener('click', () => {
    const form = qs1('#task-form');
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) qs1('#new-task-title').focus();
  });

  qs1('#cancel-task-btn').addEventListener('click', () => qs1('#task-form').classList.add('hidden'));

  qs1('#save-task-btn').addEventListener('click', async () => {
    const title = qs1('#new-task-title').value.trim();
    if (!title) { qs1('#new-task-title').focus(); return; }
    await createTask({
      title,
      notes:    qs1('#new-task-notes').value,
      due_date: qs1('#new-task-due').value   || null,
      priority: qs1('#new-task-priority').value,
      tags:     parseTags(qs1('#new-task-tags').value),
    });
    // reset form
    ['#new-task-title','#new-task-notes','#new-task-due','#new-task-tags'].forEach(s => qs1(s).value = '');
    qs1('#new-task-priority').value = 'normal';
    qs1('#task-form').classList.add('hidden');
    toast('Task added');
  });

  // Status filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.taskFilter.status = btn.dataset.filter;
      loadTasks();
    })
  );

  qs1('#priority-filter').addEventListener('change', e => {
    state.taskFilter.priority = e.target.value;
    loadTasks();
  });

  qs1('#task-search').addEventListener('input', debounce(e => {
    state.taskFilter.search = e.target.value;
    loadTasks();
  }, 300));

  // Task modal
  qs1('.modal-close').addEventListener('click', closeTaskModal);
  qs1('#task-modal').addEventListener('click', e => { if (e.target === qs1('#task-modal')) closeTaskModal(); });

  qs1('#update-task-btn').addEventListener('click', async () => {
    if (!state.editingTaskId) return;
    await updateTask(state.editingTaskId, {
      title:    qs1('#edit-task-title').value.trim(),
      notes:    qs1('#edit-task-notes').value,
      due_date: qs1('#edit-task-due').value   || null,
      priority: qs1('#edit-task-priority').value,
      tags:     parseTags(qs1('#edit-task-tags').value),
    });
    closeTaskModal();
    toast('Task updated');
  });

  qs1('#delete-task-btn').addEventListener('click', async () => {
    if (!state.editingTaskId) return;
    if (!confirm('Delete this task?')) return;
    await deleteTask(state.editingTaskId);
    closeTaskModal();
    toast('Task deleted');
  });

  // ── Notes ──────────────────────────────────────────────
  qs1('#new-note-btn').addEventListener('click', createNote);
  qs1('#save-note-btn').addEventListener('click', saveNote);
  qs1('#delete-note-btn').addEventListener('click', deleteNote);

  qs1('#note-search').addEventListener('input', debounce(e => {
    state.noteSearch = e.target.value;
    loadNotes();
  }, 300));

  ['#note-title', '#note-content', '#note-tags'].forEach(sel =>
    qs1(sel).addEventListener('input', () => { state.noteDirty = true; })
  );

  // ── Keyboard shortcuts ─────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeTaskModal();
    if ((e.ctrlKey || e.metaKey) && e.key === 's' && state.tab === 'notes') {
      e.preventDefault();
      saveNote();
    }
  });

  // Initial load
  loadTasks();
});

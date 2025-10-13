const chatWindow = document.getElementById('chat-window');
const modelSelect = document.getElementById('model-select');
const modeSelect = document.getElementById('mode-select');
const modelSearchInput = document.getElementById('model-search');
const messageInput = document.getElementById('message-input');
const chatForm = document.getElementById('chat-form');
const clearButton = document.getElementById('clear-history');
const messageTemplate = document.getElementById('message-template');
const commentatorsLabel = document.getElementById('commentators-label');
const commentatorsInput = document.getElementById('commentators-input');
const alertsDate = document.getElementById('alerts-date');
const alertsDiaspora = document.getElementById('alerts-diaspora');
const alertsList = document.getElementById('alerts-list');

const state = {
  history: [],
  config: { models: [] },
  modelInfo: new Map()
};
let searchDebounce;

function updateModelOptions(models, { preserveSelection = true } = {}) {
  const previous = preserveSelection ? modelSelect.value : '';
  state.modelInfo.clear();
  modelSelect.innerHTML = '';

  models.forEach((model) => {
    state.modelInfo.set(model.id, model);
    const opt = document.createElement('option');
    opt.value = model.id;
    const provider = model.provider ? ` (${model.provider})` : '';
    opt.textContent = `${model.label || model.id}${provider}`;
    if (model.description) opt.title = model.description;
    modelSelect.appendChild(opt);
  });

  if (previous && state.modelInfo.has(previous)) {
    modelSelect.value = previous;
  } else if (models.length > 0) {
    modelSelect.value = models[0].id;
  }
}

async function loadConfig() {
  try {
    const resp = await fetch('/config');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const config = await resp.json();
    state.config = config;
    if (config.models?.length) {
      updateModelOptions(config.models, { preserveSelection: false });
    }
  } catch (err) {
    console.error('Failed to load config', err);
    addMessage('system', 'Could not load configuration. Please refresh.', { severity: 'error' });
  }
}

async function fetchModels(term = '') {
  try {
    const params = new URLSearchParams();
    if (term) params.set('search', term);
    params.set('limit', '100');
    const resp = await fetch(`/models?${params.toString()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (Array.isArray(data.models)) {
      updateModelOptions(data.models);
    }
  } catch (err) {
    console.error('Model search failed', err);
  }
}

function addMessage(role, content, meta = {}) {
  const clone = messageTemplate.content.cloneNode(true);
  const wrapper = clone.querySelector('.message');
  wrapper.classList.add(role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system');
  const metaEl = clone.querySelector('.meta');
  const contentEl = clone.querySelector('.content');

  const metaParts = [];
  if (meta.severity === 'error') {
    metaParts.push('Error');
  }
  if (meta.model) {
    const info = state.modelInfo.get(meta.model);
    const label = info?.label || meta.model;
    const provider = info?.provider ? ` (${info.provider})` : '';
    metaParts.push(`Model: ${label}${provider}`);
  }
  if (meta.timestamp) metaParts.push(new Date(meta.timestamp).toLocaleTimeString());
  metaEl.textContent = metaParts.join(' • ');

  contentEl.textContent = content;
  chatWindow.appendChild(clone);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  state.history.push({ role, content, meta });
  return wrapper;
}

function removeMessage(element) {
  if (!element || !element.parentNode) return;
  element.parentNode.removeChild(element);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

async function sendMessage(message) {
  const selectedModel = modelSelect.value || undefined;
  const selectedMode = modeSelect.value || undefined;
  const payload = {
    message,
    model: selectedModel,
    mode: selectedMode
  };
  if (selectedMode === 'insight_layers') {
    const txt = (commentatorsInput?.value || '').trim();
    if (txt) payload.commentators = txt.split(',').map((s) => s.trim()).filter(Boolean);
  }

  addMessage('user', message, { timestamp: Date.now() });
  messageInput.value = '';

  const planningElement = addMessage('system', 'Planning answer…', { timestamp: Date.now() });

  try {
    const resp = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const errorBody = await resp.json().catch(() => ({}));
      throw new Error(errorBody.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    removeMessage(planningElement);
    addMessage('assistant', data.response || '(No response)', {
      model: selectedModel,
      timestamp: Date.now()
    });
  } catch (err) {
    removeMessage(planningElement);
    addMessage('system', err.message || 'Unexpected error', { severity: 'error', timestamp: Date.now() });
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;
  sendMessage(message);
});

clearButton.addEventListener('click', () => {
  state.history = [];
  chatWindow.innerHTML = '';
});

window.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  messageInput.focus();
  modelSearchInput.addEventListener('input', (event) => {
    const term = event.target.value.trim();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      fetchModels(term);
    }, 300);
  });
  fetchModels('');

  // Mode visibility
  function updateModeVisibility() {
    if (!commentatorsLabel) return;
    commentatorsLabel.style.display = modeSelect.value === 'insight_layers' ? '' : 'none';
  }
  if (modeSelect) {
    modeSelect.addEventListener('change', updateModeVisibility);
    updateModeVisibility();
  }

  // Alerts sidebar
  if (alertsDate && alertsDiaspora && alertsList) {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    alertsDate.value = `${y}-${m}-${d}`;

    alertsDate.addEventListener('change', loadAlerts);
    alertsDiaspora.addEventListener('change', loadAlerts);
    loadAlerts();
  }
});

async function loadAlerts() {
  try {
    const params = new URLSearchParams();
    if (alertsDate?.value) params.set('startDate', alertsDate.value);
    if (alertsDiaspora) params.set('diaspora', alertsDiaspora.checked ? '1' : '0');
    const resp = await fetch(`/alerts?${params.toString()}`);
    if (!resp.ok) return;
    const data = await resp.json();
    renderAlerts(data);
  } catch (err) {
    // noop
  }
}

function renderAlerts(data) {
  if (!alertsList) return;
  alertsList.innerHTML = '';
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  if (!alerts.length) {
    alertsList.textContent = 'No alerts.';
    return;
  }
  for (const day of alerts) {
    const dayEl = document.createElement('div');
    dayEl.className = 'alert-day';
    const title = document.createElement('div');
    title.className = 'alert-date';
    title.textContent = day.date;
    dayEl.appendChild(title);
    const list = document.createElement('ul');
    list.className = 'alert-items';
    for (const item of day.items || []) {
      const li = document.createElement('li');
      li.className = `alert-item type-${(item.type || 'other').toLowerCase()}`;
      const label = document.createElement('span');
      label.className = 'alert-label';
      label.textContent = `[${item.type || 'other'}] `;
      const text = document.createElement('span');
      const main = item.url ? `${item.title} → ${item.url}` : item.title;
      text.textContent = main;
      li.appendChild(label);
      li.appendChild(text);
      list.appendChild(li);
    }
    dayEl.appendChild(list);
    alertsList.appendChild(dayEl);
  }
}

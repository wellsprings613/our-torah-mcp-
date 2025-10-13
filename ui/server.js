import express from 'express';
import fetch from 'node-fetch';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.CHAT_UI_PORT ? Number(process.env.CHAT_UI_PORT) : 4000;
const MCP_ENDPOINT = process.env.MCP_ENDPOINT || 'http://localhost:3000/mcp';
const PROJECT_ROOT = path.join(__dirname, '..');
const MODEL_CATALOG_PATH = path.join(__dirname, 'modelCatalog.json');

let MODEL_CATALOG = [];
try {
  MODEL_CATALOG = JSON.parse(fs.readFileSync(MODEL_CATALOG_PATH, 'utf-8'));
} catch (err) {
  console.warn('Model catalog not found or invalid, defaulting to empty list.', err);
  MODEL_CATALOG = [];
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getDefaultModels(limit = 12) {
  return MODEL_CATALOG.slice(0, limit);
}

function filterModels({ search = '', provider = '', limit }) {
  const query = search.trim().toLowerCase();
  const providerQuery = provider.trim().toLowerCase();
  let results = MODEL_CATALOG;

  if (providerQuery) {
    results = results.filter((model) => (model.provider || '').toLowerCase().includes(providerQuery));
  }

  if (query) {
    results = results.filter((model) => {
      const haystack = [model.id, model.label, model.provider, ...(model.tags || []), model.description]
        .filter(Boolean)
        .join(' ') 
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  if (limit) {
    const numericLimit = Number(limit);
    if (!Number.isNaN(numericLimit) && numericLimit > 0) {
      return results.slice(0, numericLimit);
    }
  }

  return results;
}

let cachedTools = null;
let cachedToolsTimestamp = 0;

async function listMcpTools() {
  const REFRESH_MS = 60_000;
  const now = Date.now();
  if (cachedTools && now - cachedToolsTimestamp < REFRESH_MS) {
    return cachedTools;
  }
  try {
    const payload = {
      jsonrpc: '2.0',
      id: 'list-tools',
      method: 'tools/list'
    };
    const result = await callMcp(payload);
    const tools = result?.tools || [];
    cachedTools = tools.map((tool) => ({
      name: tool.name,
      title: tool.title || tool.name,
      description: tool.description || ''
    }));
    cachedToolsTimestamp = now;
  } catch (err) {
    console.error('Failed to list MCP tools', err);
    cachedTools = [];
  }
  return cachedTools;
}

async function callMcp(payload) {
  const resp = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`MCP HTTP ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  if (json.error) {
    throw new Error(json.error?.message || 'MCP error');
  }
  return json.result;
}

async function callMcpTool(name, args = {}) {
  const payload = {
    jsonrpc: '2.0',
    id: `call-${name}-${Date.now()}`,
    method: 'tools/call',
    params: { name, arguments: args }
  };
  return callMcp(payload);
}

function formatStructured(structured) {
  if (!structured || typeof structured !== 'object') {
    return typeof structured === 'string' ? structured : JSON.stringify(structured, null, 2);
  }
  if (Array.isArray(structured)) {
    return structured.map((item, idx) => `${idx + 1}. ${formatStructured(item)}`).join('\n');
  }
  if (structured.matches) {
    return structured.matches
      .map((row, idx) => `${idx + 1}. ${row.ref || row.title || 'Unknown'} - ${row.url || ''}`)
      .join('\n');
  }
  if (structured.results) {
    return structured.results
      .map((row, idx) => `${idx + 1}. ${row.title || row.ref || row.id || 'Result'} → ${row.url || ''}`)
      .join('\n');
  }
  if (structured.parsha) {
    const parts = [`Parsha: ${structured.parsha.nameEn}`];
    if (structured.parsha.summaryEn) parts.push(structured.parsha.summaryEn);
    if (structured.haftarot?.length) {
      parts.push('Haftarot:');
      structured.haftarot.forEach((h) => parts.push(`- ${h.title} (${h.ref})`));
    }
    if (structured.learningTracks?.length) {
      parts.push('Learning Tracks:');
      structured.learningTracks.forEach((t) => parts.push(`- ${t.title}: ${t.display || t.ref}`));
    }
    return parts.join('\n');
  }
  if (structured.text && structured.url) {
    return `${structured.title || 'Result'}\n${structured.url}\n\n${structured.text}`;
  }
  return JSON.stringify(structured, null, 2);
}

function runChain({ module, args = [] }, { model, requiresKey = true } = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      OPENROUTER_MODEL: model || process.env.OPENROUTER_MODEL || 'x-ai/grok-4-fast'
    };
    if (requiresKey && !env.OPENROUTER_API_KEY) {
      return reject(new Error('OPENROUTER_API_KEY is not set.'));
    }
    if (!env.OPENROUTER_REFERER && process.env.HTTP_REFERER) {
      env.OPENROUTER_REFERER = process.env.HTTP_REFERER;
    }
    if (!env.OPENROUTER_TITLE && process.env.X_TITLE) {
      env.OPENROUTER_TITLE = process.env.X_TITLE;
    }
    const pythonPaths = [PROJECT_ROOT];
    if (env.PYTHONPATH) pythonPaths.push(env.PYTHONPATH);
    env.PYTHONPATH = pythonPaths.join(path.delimiter);

    const child = spawn('python3', ['-m', module, ...args], {
      env,
      cwd: PROJECT_ROOT
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || `Chain exited with code ${code}`));
      }
      resolve(stdout.trim());
    });
    child.on('error', (err) => reject(err));
  });
}

app.get('/config', async (req, res) => {
  const tools = await listMcpTools();
  res.json({
    tools,
    models: getDefaultModels(),
    modes: ['auto_explain', 'guided_chavruta', 'insight_layers']
  });
});

app.get('/models', (req, res) => {
  const { search = '', provider = '', limit } = req.query || {};
  const models = filterModels({ search, provider, limit: limit || 50 });
  res.json({ models });
});

app.post('/chat', async (req, res) => {
  const { message, model, mode: rawMode, commentators } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  try {
    // Heuristic defaulting to guided chavruta for multi-part or educational prompts
    let mode = rawMode;
    const lower = message.toLowerCase();
    const educational = /(help me learn|learn|study|chavruta|teach me)/.test(lower);
    const multipart = (message.match(/\?/g) || []).length > 1 || message.includes(',') || message.includes(' and ');
    if (!mode) mode = educational || multipart ? 'guided_chavruta' : 'auto_explain';

    if (mode === 'guided_chavruta') {
      const output = await runChain({ module: 'chains.guided_chavruta', args: [message] }, { model, requiresKey: false });
      return res.json({ response: output, metadata: { mode, model } });
    }

    if (mode === 'insight_layers') {
      const argsObj = { ref: message };
      if (Array.isArray(commentators) && commentators.length) argsObj.commentators = commentators;
      const result = await callMcpTool('insight_layers', argsObj);
      const structured = result?.structuredContent || result || {};
      const text = formatStructured(structured);
      return res.json({ response: text, metadata: { mode } });
    }

    // default: auto_explain
    const args = [message];
    if (model) args.push('--model', model);
    const output = await runChain({ module: 'chains.auto_explain', args }, { model, requiresKey: true });
    return res.json({ response: output, metadata: { mode: 'auto_explain', model } });
  } catch (err) {
    console.error('Chat error', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.get('/alerts', async (req, res) => {
  try {
    const { startDate, diaspora, includeLearningTracks, interests, timezone } = req.query || {};
    const args = {};
    if (startDate) args.startDate = String(startDate);
    if (typeof diaspora !== 'undefined') args.diaspora = String(diaspora) === 'true' || String(diaspora) === '1';
    if (typeof includeLearningTracks !== 'undefined') args.includeLearningTracks = String(includeLearningTracks) === 'true' || String(includeLearningTracks) === '1';
    if (timezone) args.timezone = String(timezone);
    if (interests) {
      const arr = Array.isArray(interests) ? interests : String(interests).split(',');
      args.interests = arr.map((s) => String(s).trim()).filter(Boolean);
    }
    const result = await callMcpTool('calendar_insights', args);
    const structured = result?.structuredContent || result || {};
    res.json(structured);
  } catch (err) {
    console.error('alerts error', err);
    res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

app.listen(PORT, () => {
  console.log(`MCP chat UI listening on http://localhost:${PORT}`);
  console.log(`Proxying MCP requests to ${MCP_ENDPOINT}`);
});

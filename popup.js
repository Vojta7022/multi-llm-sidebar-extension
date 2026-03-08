let attachedFiles = [];
const LIMITS = { gpt: 10, claude: 5, gemini: 10, ds: 5 };
const ALL_BOT_IDS = ['gpt', 'claude', 'gemini', 'ds', 'perp'];

const bots = [
  { key: 'gpt', id: 'check-gpt', outId: 'out-gpt', statusId: 'status-gpt', pattern: 'chatgpt.com', limit: LIMITS.gpt, needsWake: true },
  { key: 'claude', id: 'check-claude', outId: 'out-claude', statusId: 'status-claude', pattern: 'claude.ai', limit: LIMITS.claude, needsWake: true },
  { key: 'gemini', id: 'check-gemini', outId: 'out-gemini', statusId: 'status-gemini', pattern: 'gemini.google.com', limit: LIMITS.gemini, needsWake: true },
  { key: 'ds', id: 'check-ds', outId: 'out-ds', statusId: 'status-ds', pattern: 'deepseek.com', limit: LIMITS.ds },
  { key: 'perp', id: 'check-perp', outId: 'out-perp', statusId: 'status-perp', pattern: 'perplexity.ai' }
];

const RESPONSE_STATE_LABELS = {
  idle: 'Idle',
  queued: 'Queued',
  sending: 'Sending',
  responding: 'Responding',
  done: 'Done',
  error: 'Error',
  offline: 'Offline',
  skipped: 'Skipped'
};

function selectedBots() {
  return bots.filter((bot) => document.getElementById(bot.id)?.checked);
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function updateFileUI() {
  const label = attachedFiles.length > 0 ? `📎 ${attachedFiles.length} file${attachedFiles.length === 1 ? '' : 's'}` : 'No files';
  for (const id of ['fileIndicator', 'followupFileIndicator']) {
    const indicator = document.getElementById(id);
    if (indicator) indicator.textContent = label;
  }

  const shouldShowClear = attachedFiles.length > 0 ? 'inline' : 'none';
  for (const id of ['clearFilesBtn', 'followupClearFilesBtn']) {
    const clearButton = document.getElementById(id);
    if (clearButton) clearButton.style.display = shouldShowClear;
  }

  const selected = selectedBots();
  const hasWarning = attachedFiles.length > 0 && selected.some((bot) => attachedFiles.length > (bot.limit || 10));
  for (const id of ['fileWarning', 'followupFileWarning']) {
    const warning = document.getElementById(id);
    if (warning) warning.style.display = hasWarning ? 'block' : 'none';
  }
}

function clearPromptInputs() {
  const setupPrompt = document.getElementById('promptText');
  const followupPrompt = document.getElementById('followupPromptText');
  if (setupPrompt) setupPrompt.value = '';
  if (followupPrompt) followupPrompt.value = '';
}

function clearAttachments() {
  attachedFiles = [];
  updateFileUI();
}

function switchToComparisonView() {
  document.getElementById('setupView').style.display = 'none';
  document.getElementById('comparisonView').style.display = 'flex';
}

function setResponseState(botKey, stateKey) {
  const badge = document.getElementById(`respstatus-${botKey}`);
  if (!badge) return;

  const normalized = RESPONSE_STATE_LABELS[stateKey] ? stateKey : 'idle';
  badge.textContent = RESPONSE_STATE_LABELS[normalized];
  badge.className = `response-state ${normalized}`;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch (error) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
}

async function ensureWakeScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['page_wake.js'],
      world: 'MAIN'
    });
  } catch (error) {
    // Ignore wake injection failures.
  }
}

async function updateStatuses() {
  const tabs = await chrome.tabs.query({});
  for (const bot of bots) {
    const el = document.getElementById(bot.statusId);
    if (!el) continue;

    const tab = tabs.find((candidate) => (candidate.url || '').includes(bot.pattern));
    if (!tab) {
      el.textContent = 'Offline';
      el.className = 'status';
      continue;
    }

    try {
      await ensureContentScript(tab.id);
      el.textContent = 'Ready';
      el.className = 'status ready';
    } catch (error) {
      el.textContent = 'Wake up';
      el.className = 'status busy';
    }
  }

  updateFileUI();
}

function attachPasteHandler(textareaId) {
  const textarea = document.getElementById(textareaId);
  if (!textarea) return;

  textarea.addEventListener('paste', async (event) => {
    const items = event.clipboardData?.items || [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        attachedFiles.push({ name: file.name, type: file.type, data: loadEvent.target.result });
        updateFileUI();
      };
      reader.readAsDataURL(file);
    }
  });
}

function resetSelectedBotOutputs(selectedBotKeys) {
  for (const bot of bots) {
    if (selectedBotKeys.includes(bot.key)) {
      const out = document.getElementById(bot.outId);
      if (out) out.innerText = 'Connecting...';
      setResponseState(bot.key, attachedFiles.length > 0 ? 'queued' : 'sending');
    } else {
      setResponseState(bot.key, 'skipped');
    }
  }
}

async function brieflyActivateGeminiTab(geminiTabId, returnTabId, pulseMs = 2200) {
  if (!geminiTabId || !returnTabId || geminiTabId === returnTabId) return;

  try {
    const geminiTab = await chrome.tabs.get(geminiTabId);
    const returnTab = await chrome.tabs.get(returnTabId);

    await chrome.windows.update(geminiTab.windowId, { focused: true });
    await chrome.tabs.update(geminiTabId, { active: true });

    await wait(pulseMs);

    await chrome.windows.update(returnTab.windowId, { focused: true });
    await chrome.tabs.update(returnTabId, { active: true });
  } catch (error) {
    // Ignore tab focus errors.
  }
}

async function sendPrompt(promptText, isNewChat) {
  const text = (promptText || '').trim();
  if (!text && attachedFiles.length === 0) return;

  const selected = selectedBots();
  if (!selected.length) return;

  const tabs = await chrome.tabs.query({});
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const originalActiveTabId = activeTabs[0]?.id || null;

  switchToComparisonView();
  resetSelectedBotOutputs(selected.map((bot) => bot.key));

  let geminiTabIdToPulse = null;

  for (const bot of selected) {
    const tab = tabs.find((candidate) => (candidate.url || '').includes(bot.pattern));
    if (!tab) {
      const out = document.getElementById(bot.outId);
      if (out) out.innerText = 'Tab not found.';
      setResponseState(bot.key, 'offline');
      continue;
    }

    try {
      await ensureContentScript(tab.id);
      if (bot.needsWake) await ensureWakeScript(tab.id);

      await chrome.tabs.sendMessage(tab.id, {
        action: 'fillPrompt',
        text,
        isNewChat,
        files: attachedFiles.slice(0, bot.limit || 10)
      });

      if (bot.key === 'gemini') {
        geminiTabIdToPulse = tab.id;
      }
    } catch (error) {
      const out = document.getElementById(bot.outId);
      if (out) out.innerText = `Extension error: ${error?.message || 'failed to send'}`;
      setResponseState(bot.key, 'error');
    }
  }

  if (geminiTabIdToPulse && originalActiveTabId) {
    await brieflyActivateGeminiTab(geminiTabIdToPulse, originalActiveTabId, 2200);
  }

  clearPromptInputs();
  clearAttachments();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'updateResponse') {
    const out = document.getElementById(`out-${msg.bot}`);
    if (out) out.innerText = msg.text;
    return;
  }

  if (msg.action === 'updateResponseState') {
    setResponseState(msg.bot, msg.state);
  }
});

document.getElementById('sendBtn').addEventListener('click', async () => {
  const text = document.getElementById('promptText').value;
  const isNew = document.getElementById('newChat').checked;
  await sendPrompt(text, isNew);
});

document.getElementById('followupSendBtn').addEventListener('click', async () => {
  const text = document.getElementById('followupPromptText').value;
  const isNew = document.getElementById('followupNewChat').checked;
  await sendPrompt(text, isNew);
});

document.getElementById('clearFilesBtn')?.addEventListener('click', clearAttachments);
document.getElementById('followupClearFilesBtn')?.addEventListener('click', clearAttachments);

attachPasteHandler('promptText');
attachPasteHandler('followupPromptText');
setInterval(updateStatuses, 2500);
updateStatuses();
updateFileUI();

ALL_BOT_IDS.forEach((id) => setResponseState(id, 'idle'));
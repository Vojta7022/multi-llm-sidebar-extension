(() => {
  if (window.__multiBotCommandCenterLoaded) return;
  window.__multiBotCommandCenterLoaded = true;

  const host = window.location.hostname;
  const botName = host.includes('chatgpt')
    ? 'gpt'
    : host.includes('claude')
      ? 'claude'
      : host.includes('gemini')
        ? 'gemini'
        : host.includes('perplexity')
          ? 'perp'
          : 'ds';

  const state = {
    observerStarted: false,
    pollIntervalId: null,
    awaitingResponse: false,
    baselineText: '',
    lastPublishedText: '',
    responseState: 'idle',
    completionTimerId: null
  };

  function safeSendMessage(message) {
    try {
      if (chrome.runtime?.id) chrome.runtime.sendMessage(message);
    } catch (error) {
      // Ignore extension context errors.
    }
  }

  function publishResponseState(nextState) {
    if (!nextState || state.responseState === nextState) return;
    state.responseState = nextState;
    safeSendMessage({ action: 'updateResponseState', bot: botName, state: nextState });
  }

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isVisible(node) {
    if (!node) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function getTextFromNode(node) {
    if (!node) return '';
    return normalizeText(node.innerText || node.textContent || '');
  }

  function visibleElements(selectors, root = document) {
    const out = [];
    for (const selector of selectors) {
      try {
        const nodes = Array.from(root.querySelectorAll(selector));
        for (const node of nodes) {
          if (isVisible(node)) out.push(node);
        }
      } catch (error) {
        // Ignore invalid selectors.
      }
    }
    return out;
  }

  function hasVisibleElement(selectors, root = document) {
    return visibleElements(selectors, root).length > 0;
  }

  function countVisibleElements(selectors, root = document) {
    return visibleElements(selectors, root).length;
  }

  async function waitForElement(selectors, timeoutMs = 12000, root = document) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      for (const selector of selectors) {
        try {
          const element = root.querySelector(selector);
          if (element) return element;
        } catch (error) {
          // Ignore invalid selectors.
        }
      }
      await wait(150);
    }
    return null;
  }

  function responseSelectorsForBot() {
    switch (botName) {
      case 'gpt':
        return [
          '[data-message-author-role="assistant"] .markdown',
          '[data-message-author-role="assistant"] [data-testid="conversation-turn-content"]',
          'article .markdown',
          '.markdown'
        ];
      case 'claude':
        return [
          '[data-is-streaming] .font-claude-response',
          '[data-is-streaming] .standard-markdown',
          '.font-claude-response',
          '.standard-markdown',
          'p.font-claude-response-body'
        ];
      case 'gemini':
        return ['.message-content', '.model-response-text'];
      case 'perp':
        return ['[data-testid="answer"]', '[data-testid="message-content"]', '.prose'];
      default:
        return ['.ds-markdown'];
    }
  }

  function getLatestResponseText() {
    const selectors = responseSelectorsForBot();
    const seen = new Set();
    const candidates = [];

    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (error) {
        nodes = [];
      }

      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        const text = getTextFromNode(node);
        if (!text) continue;
        candidates.push({ node, text });
      }
    }

    if (!candidates.length) return '';

    if (botName === 'claude') {
      const exactResponseNode = candidates
        .map((item) => item.node.closest('.font-claude-response, [data-is-streaming]'))
        .filter(Boolean)
        .at(-1);
      if (exactResponseNode) {
        const text = getTextFromNode(exactResponseNode);
        if (text) return text;
      }
    }

    if (botName === 'gpt') {
      const assistantTurn = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).at(-1);
      if (assistantTurn) {
        const text = getTextFromNode(assistantTurn);
        if (text) return text;
      }
    }

    return candidates.at(-1)?.text || '';
  }

  function getComposerSelectors() {
    switch (botName) {
      case 'gpt':
        return [
          '#prompt-textarea',
          'textarea[data-testid="prompt-textarea"]',
          'textarea[placeholder*="Message"]'
        ];
      case 'claude':
        return [
          '.ProseMirror[contenteditable="true"]',
          '[contenteditable="true"][role="textbox"]',
          '[contenteditable="true"]'
        ];
      case 'gemini':
        return [
          'rich-textarea [contenteditable="true"]',
          'rich-textarea textarea',
          '[contenteditable="true"][role="textbox"]',
          'textarea[aria-label*="Message"]',
          'textarea'
        ];
      case 'perp':
        return [
          'textarea[placeholder*="Ask"]',
          'textarea',
          '[contenteditable="true"][role="textbox"]'
        ];
      default:
        return [
          'textarea',
          '[contenteditable="true"][role="textbox"]',
          '.ProseMirror[contenteditable="true"]'
        ];
    }
  }

  async function findComposer() {
    return waitForElement(getComposerSelectors(), 12000);
  }

  function getComposerRoot(composer) {
    if (!composer) return document.body;

    const direct =
      composer.closest('form') ||
      composer.closest('[role="main"]') ||
      composer.closest('main') ||
      composer.parentElement;

    let root = direct || document.body;

    for (let i = 0; i < 4; i += 1) {
      if (!root?.parentElement) break;
      const parent = root.parentElement;
      const hasButtons = parent.querySelector('button');
      const hasFileInput = parent.querySelector('input[type="file"]');
      if (hasButtons || hasFileInput) {
        root = parent;
      } else {
        break;
      }
    }

    return root || document.body;
  }

  function nativeSetValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    const setter = descriptor?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  function clearContentEditable(element) {
    element.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    try {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    } catch (error) {
      // Ignore execCommand failures.
    }

    element.innerHTML = '';
    element.textContent = '';
  }

  function setComposerText(element, text) {
    element.focus();

    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      nativeSetValue(element, text);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (botName === 'claude') {
      clearContentEditable(element);
      const paragraphs = text.split(/\n/);
      element.innerHTML = paragraphs.map((part) => `<p>${part || '<br>'}</p>`).join('');
      element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertParagraph', data: text }));
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return;
    }

    clearContentEditable(element);
    element.textContent = text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  function getSendButtonSelectors() {
    switch (botName) {
      case 'gpt':
        return [
          'button[data-testid="send-button"]',
          'button[aria-label*="Send"]',
          'form button[type="submit"]'
        ];
      case 'claude':
        return [
          'button[aria-label*="Send"]',
          'button[data-testid*="send"]',
          'form button[type="submit"]',
          'div[role="group"] button'
        ];
      case 'gemini':
        return [
          'button[aria-label*="Send"]',
          'button[aria-label*="submit"]',
          'button[data-testid*="send"]',
          'form button[type="submit"]',
          'rich-textarea ~ button',
          'rich-textarea button'
        ];
      case 'perp':
        return [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[data-testid*="submit"]',
          'form button[type="submit"]'
        ];
      default:
        return [
          'button[aria-label*="Send"]',
          'button[data-testid*="send"]',
          'button[title*="Send"]',
          'form button[type="submit"]',
          'button'
        ];
    }
  }

  function getButtonLabel(button) {
    return normalizeText(
      [
        button?.getAttribute?.('aria-label') || '',
        button?.getAttribute?.('title') || '',
        button?.getAttribute?.('mattooltip') || '',
        button?.innerText || '',
        button?.textContent || ''
      ].join(' ')
    ).toLowerCase();
  }

  function looksLikeSendButton(button) {
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    const label = getButtonLabel(button);
    const html = (button.innerHTML || '').toLowerCase();

    if (/attach|upload|file|image|photo|plus|add|insert/.test(label)) return false;
    if (/send|submit|ask|go/.test(label)) return true;
    if (html.includes('send') || html.includes('arrow_upward') || html.includes('arrow-up') || html.includes('paper-plane')) return true;

    return false;
  }

  function findEnabledSendButton(composer = null) {
    for (const selector of getSendButtonSelectors()) {
      let buttons = [];
      try {
        buttons = Array.from(document.querySelectorAll(selector));
      } catch (error) {
        buttons = [];
      }

      const button = buttons.find((candidate) =>
        isVisible(candidate) &&
        !candidate.disabled &&
        candidate.getAttribute('aria-disabled') !== 'true' &&
        (selector === 'button' ? looksLikeSendButton(candidate) : true)
      );

      if (button) return button;
    }

    if (composer) {
      const root = getComposerRoot(composer);
      const buttons = Array.from(root.querySelectorAll('button')).filter((button) =>
        isVisible(button) &&
        !button.disabled &&
        button.getAttribute('aria-disabled') !== 'true'
      );

      const explicit = buttons.find((button) => looksLikeSendButton(button));
      if (explicit) return explicit;

      const fallback = buttons.at(-1);
      if (fallback) return fallback;
    }

    return null;
  }

  function getSendWaitMs(hasFiles) {
    if (botName === 'ds') return hasFiles ? 12000 : 7000;
    if (botName === 'gemini') return hasFiles ? 7000 : 4000;
    if (botName === 'claude') return hasFiles ? 6000 : 3500;
    if (botName === 'perp') return hasFiles ? 6000 : 3500;
    return hasFiles ? 5000 : 2500;
  }

  async function waitForEnabledSendButton(composer, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const button = findEnabledSendButton(composer);
      if (button) return button;
      await wait(120);
    }
    return null;
  }

  function getAttachmentButtonSelectors() {
    switch (botName) {
      case 'gpt':
        return [
          'button[aria-label*="Attach"]',
          'button[aria-label*="Upload"]',
          '[data-testid*="attach"] button',
          '[data-testid*="upload"] button'
        ];
      case 'claude':
        return [
          'button[aria-label*="Attach"]',
          'button[aria-label*="Upload"]',
          'button[aria-label*="Plus"]',
          'button[aria-label*="plus"]',
          'button:has(svg)',
          'button:has(i)'
        ];
      case 'gemini':
        return [
          'button[aria-label*="Add"]',
          'button[aria-label*="add"]',
          'button[aria-label*="Upload"]',
          'button[aria-label*="upload"]',
          'button[aria-label*="Insert"]',
          'button[aria-label*="insert"]',
          'button[aria-label*="files"]',
          'button[aria-label*="Files"]',
          'button[mattooltip*="Add"]',
          'button[mattooltip*="Upload"]',
          'button[mattooltip*="files"]',
          'button:has(svg)',
          'button:has(mat-icon)'
        ];
      case 'perp':
        return [
          'button[aria-label*="Attach"]',
          'button[aria-label*="Upload"]',
          'button[aria-label*="Plus"]',
          'button[aria-label*="plus"]',
          'button:has(svg)'
        ];
      default:
        return [
          'button[aria-label*="Attach"]',
          'button[aria-label*="Upload"]',
          'button[aria-label*="Plus"]',
          'button[aria-label*="plus"]',
          'button:has(svg)'
        ];
    }
  }

  function looksLikeAttachButton(button) {
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    const label = getButtonLabel(button);
    const html = (button.innerHTML || '').toLowerCase();

    if (/send|submit|stop|cancel|voice|microphone|mic/.test(label)) return false;
    if (/attach|upload|file|image|photo|picture|add|plus|insert/.test(label)) return true;
    if (html.includes('attach') || html.includes('upload') || html.includes('image') || html.includes('photo')) return true;
    if (html.includes('add') || html.includes('plus')) return true;

    const rect = button.getBoundingClientRect();
    return rect.width <= 56 && rect.height <= 56 && !label;
  }

  function getAttachmentChipSelectors() {
    switch (botName) {
      case 'gpt':
        return [
          '[data-testid*="attachment"]',
          '[data-testid*="file"]',
          '[data-testid*="upload"]',
          'button[aria-label*="Remove"]',
          'img[alt*="upload"]'
        ];
      case 'claude':
        return [
          '[data-testid*="attachment"]',
          '[data-testid*="file"]',
          'button[aria-label*="Remove attachment"]',
          '.attachment',
          'img'
        ];
      case 'gemini':
        return [
          '.attachment-chip',
          '.uploaded-file',
          '[data-test-id*="attachment"]',
          'button[aria-label*="Remove"]',
          'img'
        ];
      case 'perp':
        return [
          '[data-testid*="attachment"]',
          '[data-testid*="file"]',
          '.attachment',
          'img'
        ];
      default:
        return [
          '[data-testid*="attachment"]',
          '[data-testid*="file"]',
          '.attachment',
          'img'
        ];
    }
  }

  function getAttachmentBusySelectors() {
    return [
      '[role="progressbar"]',
      'progress',
      'mat-progress-bar',
      'ms-circular-progress-bar',
      '[aria-busy="true"]',
      '.upload-progress',
      '.uploading',
      '.attachment-progress',
      '.file-upload-progress'
    ];
  }

  function getUploadSettleDelayMs(fileCount) {
    const n = Math.max(1, Math.min(fileCount || 1, 4));

    switch (botName) {
      case 'ds':
        return 6000 + (n - 1) * 2500;
      case 'claude':
        return 3500 + (n - 1) * 1800;
      case 'gemini':
        return 3500 + (n - 1) * 1600;
      case 'perp':
        return 3500 + (n - 1) * 1800;
      default:
        return 2200 + (n - 1) * 1200;
    }
  }

  function getAllFileInputs(root = document) {
    return Array.from(root.querySelectorAll('input[type="file"]')).filter((input) => !input.disabled);
  }

  function getLastFileInput(root = document) {
    return getAllFileInputs(root).at(-1) || null;
  }

  async function tryClickButtonsForFileInput(buttons, root) {
    const clicked = new Set();

    for (const button of buttons) {
      if (!button || clicked.has(button)) continue;
      clicked.add(button);

      try {
        button.click();
      } catch (error) {
        // Ignore click failures.
      }

      await wait(350);

      const fileInput = getLastFileInput(root) || getLastFileInput(document);
      if (fileInput) return fileInput;
    }

    return null;
  }

  async function revealFileInput(composer) {
    const root = getComposerRoot(composer);

    let fileInput = getLastFileInput(root) || getLastFileInput(document);
    if (fileInput) return fileInput;

    const selectorButtons = visibleElements(getAttachmentButtonSelectors(), root);
    fileInput = await tryClickButtonsForFileInput(selectorButtons, root);
    if (fileInput) return fileInput;

    const globalSelectorButtons = visibleElements(getAttachmentButtonSelectors(), document);
    fileInput = await tryClickButtonsForFileInput(globalSelectorButtons, document);
    if (fileInput) return fileInput;

    const rootButtons = Array.from(root.querySelectorAll('button')).filter((button) => isVisible(button) && looksLikeAttachButton(button));
    fileInput = await tryClickButtonsForFileInput(rootButtons, root);
    if (fileInput) return fileInput;

    const allVisibleButtons = Array.from(document.querySelectorAll('button')).filter((button) => isVisible(button) && looksLikeAttachButton(button));
    fileInput = await tryClickButtonsForFileInput(allVisibleButtons, document);
    if (fileInput) return fileInput;

    return waitForElement(['input[type="file"]'], 2500);
  }

  async function buildDataTransferFiles(files) {
    const dt = new DataTransfer();

    for (const item of files) {
      const response = await fetch(item.data);
      const blob = await response.blob();
      dt.items.add(new File([blob], item.name, { type: item.type || blob.type }));
    }

    return dt;
  }

  function dispatchFileDrop(target, dataTransfer) {
    if (!target) return false;

    try {
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      return true;
    } catch (error) {
      return false;
    }
  }

  async function waitForUploadsToSettle(fileCount, root = document) {
    const minDelay = getUploadSettleDelayMs(fileCount);
    const started = Date.now();
    const deadline = started + minDelay + 12000;
    let sawAttachmentChip = countVisibleElements(getAttachmentChipSelectors(), root) > 0 || countVisibleElements(getAttachmentChipSelectors(), document) > 0;

    while (Date.now() < deadline) {
      const chipCount =
        countVisibleElements(getAttachmentChipSelectors(), root) +
        countVisibleElements(getAttachmentChipSelectors(), document);

      if (chipCount > 0) sawAttachmentChip = true;

      const busy = hasVisibleElement(getAttachmentBusySelectors(), root) || hasVisibleElement(getAttachmentBusySelectors(), document);
      const elapsed = Date.now() - started;

      if (elapsed >= minDelay && (!busy || sawAttachmentChip)) {
        await wait(700);
        const stillBusy = hasVisibleElement(getAttachmentBusySelectors(), root) || hasVisibleElement(getAttachmentBusySelectors(), document);
        if (!stillBusy) return true;
      }

      await wait(300);
    }

    return sawAttachmentChip;
  }

  async function attachFiles(files, composer) {
    if (!files || files.length === 0) return true;

    const root = getComposerRoot(composer);
    const dataTransfer = await buildDataTransferFiles(files);

    const input = await revealFileInput(composer);
    if (input) {
      try {
        input.files = dataTransfer.files;
      } catch (error) {
        try {
          Object.defineProperty(input, 'files', {
            configurable: true,
            value: dataTransfer.files
          });
        } catch (defineError) {
          // Ignore and continue to drop fallback.
        }
      }

      try {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (error) {
        // Ignore event dispatch failures.
      }

      const settled = await waitForUploadsToSettle(files.length, root);
      if (settled) return true;
    }

    const dropTargets = [composer, root, composer.parentElement, composer.closest('form'), document.body].filter(Boolean);
    for (const target of dropTargets) {
      const dropped = dispatchFileDrop(target, dataTransfer);
      if (!dropped) continue;

      const settled = await waitForUploadsToSettle(files.length, root);
      if (settled) return true;
    }

    return false;
  }

  function isComposerInteractive() {
    let composer = null;
    try {
      composer = document.querySelector(getComposerSelectors().join(','));
    } catch (error) {
      composer = null;
    }

    if (!composer) return false;
    if (composer.disabled) return false;
    if (composer.getAttribute('aria-disabled') === 'true') return false;
    if (composer.closest('[aria-disabled="true"]')) return false;
    return true;
  }

  function isGeminiReadyForNextPrompt() {
    if (!isComposerInteractive()) return false;

    const busySelectors = [
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      'button[mattooltip*="Stop"]',
      'button[mattooltip*="stop"]',
      'button[aria-label*="Cancel"]',
      '[data-test-id*="stop"]',
      'mat-progress-bar',
      'ms-circular-progress-bar'
    ];

    if (hasVisibleElement(busySelectors)) return false;
    return true;
  }

  function isReadyForDoneState() {
    if (botName === 'gemini') return isGeminiReadyForNextPrompt();
    return true;
  }

  function getCompletionDelayMs() {
    if (botName === 'gemini') return 4200;
    return 2200;
  }

  function scheduleCompletionCheck() {
    if (state.completionTimerId) window.clearTimeout(state.completionTimerId);

    state.completionTimerId = window.setTimeout(() => {
      if (state.responseState !== 'responding' && state.responseState !== 'sending') return;

      if (isReadyForDoneState()) {
        publishResponseState('done');
        state.awaitingResponse = false;
        return;
      }

      scheduleCompletionCheck();
    }, getCompletionDelayMs());
  }

  function publishLatestResponse(force = false) {
    const latestText = getLatestResponseText();
    if (!latestText) return;

    if (!force && state.awaitingResponse && state.baselineText && normalizeText(latestText) === normalizeText(state.baselineText)) {
      return;
    }

    if (latestText === state.lastPublishedText) return;

    state.lastPublishedText = latestText;
    state.awaitingResponse = false;
    publishResponseState('responding');
    scheduleCompletionCheck();
    safeSendMessage({ action: 'updateResponse', bot: botName, text: latestText });
  }

  function startObserver() {
    if (state.observerStarted) return;
    state.observerStarted = true;

    const scrape = () => publishLatestResponse(false);

    try {
      const observer = new MutationObserver(scrape);
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (error) {
      // Ignore observer setup failure.
    }

    state.pollIntervalId = window.setInterval(scrape, 1200);
    window.setTimeout(() => publishLatestResponse(true), 1200);
  }

  async function clickSendOrPressEnter(composer, hasFiles) {
    const initialDelay =
      botName === 'claude' ? 700 :
      botName === 'gemini' ? 1000 :
      botName === 'ds' ? 1800 :
      300;

    await wait(initialDelay);

    const sendButton = await waitForEnabledSendButton(composer, getSendWaitMs(hasFiles));
    if (sendButton) {
      try {
        sendButton.click();
        return true;
      } catch (error) {
        // Continue to keyboard fallbacks.
      }
    }

    composer.focus();

    const keyboardVariants = [
      { key: 'Enter', code: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false },
      { key: 'Enter', code: 'Enter', ctrlKey: true, metaKey: false, shiftKey: false },
      { key: 'Enter', code: 'Enter', ctrlKey: false, metaKey: true, shiftKey: false }
    ];

    for (const variant of keyboardVariants) {
      try {
        composer.dispatchEvent(new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: variant.key,
          code: variant.code,
          keyCode: 13,
          which: 13,
          ctrlKey: variant.ctrlKey,
          metaKey: variant.metaKey,
          shiftKey: variant.shiftKey
        }));

        composer.dispatchEvent(new KeyboardEvent('keypress', {
          bubbles: true,
          cancelable: true,
          key: variant.key,
          code: variant.code,
          keyCode: 13,
          which: 13,
          ctrlKey: variant.ctrlKey,
          metaKey: variant.metaKey,
          shiftKey: variant.shiftKey
        }));

        composer.dispatchEvent(new KeyboardEvent('keyup', {
          bubbles: true,
          cancelable: true,
          key: variant.key,
          code: variant.code,
          keyCode: 13,
          which: 13,
          ctrlKey: variant.ctrlKey,
          metaKey: variant.metaKey,
          shiftKey: variant.shiftKey
        }));
      } catch (error) {
        // Ignore keyboard dispatch failures.
      }

      await wait(500);

      const retryButton = findEnabledSendButton(composer);
      if (!retryButton) return true;
    }

    const form = composer.closest('form');
    if (form) {
      try {
        form.requestSubmit();
        return true;
      } catch (error) {
        // Ignore requestSubmit failures.
      }
    }

    return false;
  }

  async function maybeStartNewChat() {
    if (botName === 'gpt') {
      const newChatButton = document.querySelector('a[href="/"], button[aria-label*="New chat"], a[aria-label*="New chat"]');
      if (newChatButton) {
        newChatButton.click();
        await wait(1200);
      }
    } else if (botName === 'claude') {
      const newChatButton = document.querySelector('a[href="/new"], button[aria-label*="New chat"], a[aria-label*="New chat"]');
      if (newChatButton) {
        newChatButton.click();
        await wait(1200);
      }
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      sendResponse({ status: 'ok' });
      return true;
    }

    if (request.action === 'fillPrompt') {
      (async () => {
        try {
          startObserver();
          state.awaitingResponse = true;
          state.baselineText = getLatestResponseText();
          state.lastPublishedText = '';
          publishResponseState(request.files?.length ? 'queued' : 'sending');

          if (state.completionTimerId) window.clearTimeout(state.completionTimerId);

          if (request.isNewChat) await maybeStartNewChat();

          const composer = await findComposer();
          if (!composer) {
            publishResponseState('error');
            safeSendMessage({ action: 'updateResponse', bot: botName, text: 'Composer not found.' });
            return;
          }

          if (request.files?.length) {
            const attached = await attachFiles(request.files, composer);
            if (!attached) {
              publishResponseState('error');
              safeSendMessage({ action: 'updateResponse', bot: botName, text: 'Attachment upload could not be started.' });
              return;
            }

            if (botName === 'ds') {
              await wait(2500);
            }

            if (botName === 'gemini') {
              await wait(1200);
            }
          }

          publishResponseState('sending');
          setComposerText(composer, request.text || '');

          if (botName === 'ds' && request.files?.length) {
            await wait(1200);
          }

          const sent = await clickSendOrPressEnter(composer, Boolean(request.files?.length));
          if (!sent) {
            publishResponseState('error');
            safeSendMessage({ action: 'updateResponse', bot: botName, text: 'Prompt could not be sent after upload.' });
            return;
          }

          window.setTimeout(() => publishLatestResponse(false), 1500);
          window.setTimeout(() => publishLatestResponse(false), 3000);
          window.setTimeout(() => {
            if (state.responseState === 'sending') publishResponseState('responding');
          }, 1200);
        } catch (error) {
          publishResponseState('error');
          safeSendMessage({ action: 'updateResponse', bot: botName, text: `Extension error: ${error?.message || 'unknown error'}` });
        }
      })();

      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  startObserver();
})();
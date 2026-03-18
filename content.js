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

    let root =
      composer.closest('form') ||
      composer.closest('footer') ||
      composer.closest('[role="main"]') ||
      composer.closest('main') ||
      composer.parentElement ||
      document.body;

    for (let i = 0; i < 3; i += 1) {
      if (!root?.parentElement) break;
      const parent = root.parentElement;
      if (parent.querySelector('button') || parent.querySelector('input[type="file"]')) {
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

  function looksLikeSendButton(button) {
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;

    const label = getButtonLabel(button);
    const html = (button.innerHTML || '').toLowerCase();

    if (/attach|upload|file|image|photo|plus|add|insert|temporary|model|canvas|deep research/.test(label)) return false;
    if (/send|submit|ask|go/.test(label)) return true;
    if (html.includes('send') || html.includes('arrow_upward') || html.includes('paper-plane')) return true;

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

    if (!composer) return null;

    const root = getComposerRoot(composer);
    const buttons = Array.from(root.querySelectorAll('button')).filter((button) =>
      isVisible(button) &&
      !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true'
    );

    const explicit = buttons.find((button) => looksLikeSendButton(button));
    return explicit || null;
  }

  function getSendWaitMs(hasFiles) {
    if (botName === 'ds') return hasFiles ? 18000 : 9000;
    if (botName === 'gemini') return hasFiles ? 9000 : 4500;
    if (botName === 'claude') return hasFiles ? 7000 : 3500;
    if (botName === 'perp') return hasFiles ? 7000 : 3500;
    return hasFiles ? 5000 : 2500;
  }

  async function waitForEnabledSendButton(composer, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const button = findEnabledSendButton(composer);
      if (button) return button;
      await wait(150);
    }
    return null;
  }

  function getAttachmentChipSelectors() {
    switch (botName) {
      case 'gpt':
        return [
          '[data-testid*="attachment"]',
          '[data-testid*="file"]',
          '[data-testid*="upload"]',
          'button[aria-label*="Remove"]'
        ];
      case 'claude':
        return [
          '[data-testid*="attachment"]',
          '[data-testid*="file"]',
          'button[aria-label*="Remove attachment"]',
          '.attachment'
        ];
      case 'gemini':
        return [
          '.attachment-chip',
          '.uploaded-file',
          '[data-test-id*="attachment"]',
          'button[aria-label*="Remove"]',
          'button[aria-label*="Delete attachment"]'
        ];
      case 'perp':
        return [
          '[data-testid*="attachment"]',
          '[data-testid*="file"]',
          '.attachment'
        ];
      default:
        return [
          '[data-testid*="attachment"]',
          '[data-testid*="file"]',
          '.attachment'
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
        return 7000 + (n - 1) * 3000;
      case 'claude':
        return 3500 + (n - 1) * 1800;
      case 'gemini':
        return 3500 + (n - 1) * 1800;
      case 'perp':
        return 3500 + (n - 1) * 1800;
      default:
        return 2200 + (n - 1) * 1200;
    }
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
    const deadline = started + minDelay + 14000;
    let sawAttachmentChip =
      countVisibleElements(getAttachmentChipSelectors(), root) > 0 ||
      countVisibleElements(getAttachmentChipSelectors(), document) > 0;

    while (Date.now() < deadline) {
      const chipCount =
        countVisibleElements(getAttachmentChipSelectors(), root) +
        countVisibleElements(getAttachmentChipSelectors(), document);

      if (chipCount > 0) sawAttachmentChip = true;

      const busy =
        hasVisibleElement(getAttachmentBusySelectors(), root) ||
        hasVisibleElement(getAttachmentBusySelectors(), document);

      const elapsed = Date.now() - started;

      if (elapsed >= minDelay && (!busy || sawAttachmentChip)) {
        await wait(800);
        const stillBusy =
          hasVisibleElement(getAttachmentBusySelectors(), root) ||
          hasVisibleElement(getAttachmentBusySelectors(), document);

        if (!stillBusy) return true;
      }

      await wait(350);
    }

    return sawAttachmentChip;
  }

  function allFilesAreImages(files) {
    return Array.isArray(files) && files.length > 0 && files.every((file) => (file.type || '').startsWith('image/'));
  }

  async function pasteFilesIntoComposer(files, composer) {
    const root = getComposerRoot(composer);
    const dataTransfer = await buildDataTransferFiles(files);

    composer.focus();

    let pasteWorked = false;

    try {
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true
      });

      Object.defineProperty(pasteEvent, 'clipboardData', {
        configurable: true,
        value: dataTransfer
      });

      pasteWorked = composer.dispatchEvent(pasteEvent);
    } catch (error) {
      pasteWorked = false;
    }

    await wait(600);

    const settledAfterPaste = await waitForUploadsToSettle(files.length, root);
    if (settledAfterPaste) return true;

    const dropTargets = [composer, root, composer.parentElement].filter(Boolean);
    for (const target of dropTargets) {
      const dropped = dispatchFileDrop(target, dataTransfer);
      if (!dropped) continue;

      const settledAfterDrop = await waitForUploadsToSettle(files.length, root);
      if (settledAfterDrop) return true;
    }

    return pasteWorked;
  }

  function getAllFileInputs(root = document) {
    return Array.from(root.querySelectorAll('input[type="file"]')).filter((input) => !input.disabled);
  }

  function getLastFileInput(root = document) {
    return getAllFileInputs(root).at(-1) || null;
  }

  function findGeminiUploadMenuOption() {
    const nodes = Array.from(document.querySelectorAll('button, [role="menuitem"], li, div[role="button"]')).filter(isVisible);
    return nodes.find((node) => {
      const label = getButtonLabel(node);
      return /upload|files|from device|local files/.test(label);
    }) || null;
  }

  function findGeminiExactAddFilesButton(root) {
    const candidates = visibleElements([
      'button[aria-label*="Add files"]',
      'button[aria-label*="add files"]',
      'button[aria-label*="Upload"]',
      'button[aria-label*="upload"]',
      'button[aria-label*="Files"]',
      'button[aria-label*="files"]',
      'button[mattooltip*="Add files"]',
      'button[mattooltip*="Upload"]',
      'button[mattooltip*="Files"]'
    ], root);

    return candidates[0] || null;
  }

  async function revealGeminiFileInputMinimal(composer) {
    const root = getComposerRoot(composer);

    let input = getLastFileInput(root) || getLastFileInput(document);
    if (input) return input;

    const addFilesButton = findGeminiExactAddFilesButton(root);
    if (!addFilesButton) return null;

    try {
      addFilesButton.click();
    } catch (error) {
      return null;
    }

    await wait(350);

    const uploadOption = findGeminiUploadMenuOption();
    if (uploadOption) {
      try {
        uploadOption.click();
      } catch (error) {
        // Ignore click failures.
      }
      await wait(350);
    }

    input = getLastFileInput(root) || getLastFileInput(document);
    if (input) return input;

    return waitForElement(['input[type="file"]'], 2500);
  }

  async function attachFilesGemini(files, composer) {
    const root = getComposerRoot(composer);

    if (allFilesAreImages(files)) {
      const pasted = await pasteFilesIntoComposer(files, composer);
      if (pasted) {
        const settled = await waitForUploadsToSettle(files.length, root);
        if (settled) return true;
      }
    }

    const input = await revealGeminiFileInputMinimal(composer);
    if (!input) return false;

    const dataTransfer = await buildDataTransferFiles(files);

    try {
      input.files = dataTransfer.files;
    } catch (error) {
      try {
        Object.defineProperty(input, 'files', {
          configurable: true,
          value: dataTransfer.files
        });
      } catch (defineError) {
        return false;
      }
    }

    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) {
      // Ignore dispatch failures.
    }

    return waitForUploadsToSettle(files.length, root);
  }

  async function attachFilesGeneric(files, composer) {
    if (!files || files.length === 0) return true;

    const root = getComposerRoot(composer);
    const dataTransfer = await buildDataTransferFiles(files);

    let input = getLastFileInput(root) || getLastFileInput(document);

    if (!input) {
      const exactButtons = visibleElements([
        'button[aria-label*="Attach"]',
        'button[aria-label*="Upload"]',
        'button[aria-label*="Plus"]',
        'button[aria-label*="plus"]'
      ], root);

      for (const button of exactButtons) {
        try {
          button.click();
        } catch (error) {
          // Ignore click failures.
        }

        await wait(300);
        input = getLastFileInput(root) || getLastFileInput(document);
        if (input) break;
      }
    }

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
        // Ignore dispatch failures.
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

  async function attachFiles(files, composer) {
    if (!files || files.length === 0) return true;
    if (botName === 'gemini') return attachFilesGemini(files, composer);
    return attachFilesGeneric(files, composer);
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
      botName === 'ds' ? 2200 :
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

      await wait(600);

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
              safeSendMessage({ action: 'updateResponse', bot: botName, text: botName === 'gemini'
                ? 'Gemini attachment failed. Image paste/input path did not attach the file.'
                : 'Attachment upload could not be started.' });
              return;
            }

            if (botName === 'ds') await wait(3500);
            if (botName === 'gemini') await wait(1200);
          }

          publishResponseState('sending');
          setComposerText(composer, request.text || '');

          if (botName === 'ds' && request.files?.length) {
            await wait(1800);
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
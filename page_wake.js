(() => {
  if (window.__mbccWakePatched) return;
  window.__mbccWakePatched = true;

  const dispatchWake = () => {
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('readystatechange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focusin'));
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('mousemove'));
      window.dispatchEvent(new Event('resize'));
    } catch (error) {
      // Ignore dispatch errors.
    }
  };

  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  } catch (error) {
    // Ignore non-configurable properties.
  }

  try {
    Object.defineProperty(document, 'webkitHidden', { configurable: true, get: () => false });
  } catch (error) {
    // Ignore non-configurable properties.
  }

  try {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  } catch (error) {
    // Ignore non-configurable properties.
  }

  try {
    document.hasFocus = () => true;
  } catch (error) {
    // Ignore hasFocus override failures.
  }

  try {
    const originalRAF = window.requestAnimationFrame?.bind(window);
    if (originalRAF) {
      window.requestAnimationFrame = (callback) => {
        return originalRAF((timestamp) => {
          dispatchWake();
          callback(timestamp);
        });
      };
    }
  } catch (error) {
    // Ignore RAF patch failures.
  }

  dispatchWake();
  window.setInterval(dispatchWake, 1000);
})();
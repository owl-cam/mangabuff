(function () {
  "use strict";

  const SETTINGS_KEY = "mangabuff_settings";
  const CACHE_KEYS = [
    "mangabuff_card_stats_cache",
    "mangabuff_card_lots_cache",
    "mangabuff_user_trades_cache",
  ];
  const DEFAULT_SETTINGS = {
    showStats: true,
    showLots: true,
    showTrades: true,
    compactMode: false,
  };

  const inputs = Array.from(document.querySelectorAll("[data-setting]"));
  const clearCacheButton = document.getElementById("clear-cache");
  const statusElement = document.getElementById("status");

  function storageGet(keys) {
    const browserStorage = globalThis.browser?.storage?.local;
    if (browserStorage?.get) return browserStorage.get(keys);

    return new Promise((resolve, reject) => {
      globalThis.chrome.storage.local.get(keys, (result) => {
        const error = globalThis.chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(result);
      });
    });
  }

  function storageSet(items) {
    const browserStorage = globalThis.browser?.storage?.local;
    if (browserStorage?.set) return browserStorage.set(items);

    return new Promise((resolve, reject) => {
      globalThis.chrome.storage.local.set(items, () => {
        const error = globalThis.chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  function storageRemove(keys) {
    const browserStorage = globalThis.browser?.storage?.local;
    if (browserStorage?.remove) return browserStorage.remove(keys);

    return new Promise((resolve, reject) => {
      globalThis.chrome.storage.local.remove(keys, () => {
        const error = globalThis.chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    return Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS).map(([key, defaultValue]) => [
        key,
        typeof source[key] === "boolean" ? source[key] : defaultValue,
      ]),
    );
  }

  function readForm() {
    return Object.fromEntries(
      inputs.map((input) => [input.dataset.setting, input.checked]),
    );
  }

  function showStatus(message, isError = false) {
    statusElement.textContent = message;
    statusElement.classList.toggle("error", isError);
  }

  async function saveSettings() {
    try {
      await storageSet({ [SETTINGS_KEY]: readForm() });
      showStatus("Настройки сохранены");
    } catch (error) {
      showStatus(`Ошибка: ${error.message}`, true);
    }
  }

  async function bootstrap() {
    try {
      const result = await storageGet([SETTINGS_KEY]);
      const settings = normalizeSettings(result[SETTINGS_KEY]);
      inputs.forEach((input) => {
        input.checked = settings[input.dataset.setting];
        input.addEventListener("change", saveSettings);
      });
    } catch (error) {
      showStatus(`Ошибка: ${error.message}`, true);
    }

    clearCacheButton.addEventListener("click", async () => {
      if (!confirm("Очистить весь кэш MangaBuff Stats?")) return;

      try {
        await storageRemove(CACHE_KEYS);
        showStatus("Кэш очищен");
      } catch (error) {
        showStatus(`Ошибка: ${error.message}`, true);
      }
    });
  }

  void bootstrap();
})();

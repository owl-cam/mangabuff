(function () {
  "use strict";

  const API_URL = "https://mbstat.space";
  const HOUR_MS = 60 * 60 * 1000;
  const CACHE_TTLS = {
    cardStats: 24,
    lots: 1,
    trades: 24,
  };
  const STALE_AFTER_MS = 4 * 24 * HOUR_MS;
  const CACHE_KEY = "mangabuff_card_stats_cache";
  const LOTS_CACHE_KEY = "mangabuff_card_lots_cache";
  const TRADES_CACHE_KEY = "mangabuff_user_trades_cache";
  const SETTINGS_KEY = "mangabuff_settings";
  const DEFAULT_SETTINGS = {
    showStats: true,
    showLots: true,
    showTrades: true,
    compactMode: false,
  };
  const REQUEST_DELAY = 500;
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000;

  const PAGE_CONFIGS = {
    cards: {
      cardSelector:
        ".manga-cards__item[data-card-id], .lootbox__card[data-id]",
      wrapperSelector: ".manga-cards__item-wrapper",
      idAttribute: "data-card-id,data-id",
      idLocation: "card",
      showStats: true,
      showLots: false,
    },
    deck: {
      cardSelector: ".deck__item[data-card-id]",
      wrapperSelector: null,
      idAttribute: "data-card-id",
      idLocation: "card",
      showStats: true,
      showLots: false,
    },
    market: {
      cardSelector: ".market-list__cards--all .manga-cards__item",
      wrapperSelector: ".manga-cards__item-wrapper",
      idAttribute: "data-id",
      idLocation: "wrapper",
      showStats: false,
      showLots: true,
    },
    "club-boost": {
      cardSelector: ".club-boost__inner",
      wrapperSelector: null,
      statsContainerSelector: ".club-boost__image",
      idAttribute: null,
      idLocation: "link",
      linkSelector: 'a[href*="/cards/"]',
      showStats: true,
      showLots: false,
    },
    manga: {
      cardSelector: ".manga-cards__item[data-card-id], .lootbox__card[data-id]",
      wrapperSelector: ".manga-cards__item-wrapper",
      idAttribute: "data-card-id,data-id",
      idLocation: "card",
      showStats: true,
      showLots: false,
    },
    "trade-history": {
      cardSelector: ".history__body-item",
      wrapperSelector: null,
      idAttribute: null,
      idLocation: "link",
      linkSelector: 'a[href*="/cards/"]',
      showStats: true,
      showLots: false,
    },
    trade: {
      cardSelector: ".trade__main-item",
      wrapperSelector: null,
      idAttribute: null,
      idLocation: "link",
      linkSelector: 'a[href*="/cards/"]',
      showStats: true,
      showLots: false,
    },
  };

  let cardStatsCache = {};
  let cardLotsCache = {};
  let userTradesCache = {};
  let settings = { ...DEFAULT_SETTINGS };
  let cachedCurrentUserId = null;

  const requestQueue = [];
  let isProcessingQueue = false;
  let lastRequestTime = 0;

  const scrapeQueue = [];
  let isProcessingScrapeQueue = false;
  let scrapeQueueOrder = 0;
  let scrapeQueueScheduled = false;

  const SCRAPE_PRIORITY = {
    missing: 0,
    stale: 1,
  };

  const marketCardsQueue = [];
  let isProcessingMarketCards = false;
  let lotsObserver = null;
  let processCardsTimer = null;

  function log(...args) {
    console.log("[MangaBuff Stats]", ...args);
  }

  function errorLog(...args) {
    console.error("[MangaBuff Stats]", ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isFreshTimestamp(timestamp, ttlHours) {
    return (
      typeof timestamp === "number" &&
      Date.now() - timestamp < ttlHours * HOUR_MS
    );
  }

  function storageGet(keys) {
    const browserStorage = globalThis.browser?.storage?.local;
    if (browserStorage?.get) {
      return browserStorage.get(keys);
    }

    const chromeStorage = globalThis.chrome?.storage?.local;
    if (!chromeStorage?.get) {
      return Promise.reject(new Error("storage.local is unavailable"));
    }

    return new Promise((resolve, reject) => {
      chromeStorage.get(keys, (result) => {
        const err = globalThis.chrome?.runtime?.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(result);
      });
    });
  }

  function storageSet(items) {
    const browserStorage = globalThis.browser?.storage?.local;
    if (browserStorage?.set) {
      return browserStorage.set(items);
    }

    const chromeStorage = globalThis.chrome?.storage?.local;
    if (!chromeStorage?.set) {
      return Promise.reject(new Error("storage.local is unavailable"));
    }

    return new Promise((resolve, reject) => {
      chromeStorage.set(items, () => {
        const err = globalThis.chrome?.runtime?.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve();
      });
    });
  }

  function sendMessage(message) {
    const browserRuntime = globalThis.browser?.runtime;
    if (browserRuntime?.sendMessage) {
      return browserRuntime.sendMessage(message);
    }

    const chromeRuntime = globalThis.chrome?.runtime;
    if (!chromeRuntime?.sendMessage) {
      return Promise.reject(new Error("runtime.sendMessage is unavailable"));
    }

    return new Promise((resolve, reject) => {
      chromeRuntime.sendMessage(message, (response) => {
        const err = chromeRuntime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(response);
      });
    });
  }

  async function requestFetch(options) {
    const response = await sendMessage({
      type: "MB_FETCH",
      ...options,
    });

    if (!response || response.ok !== true) {
      throw new Error(response?.error || "Request failed");
    }

    return response;
  }

  async function loadCache(key, expiryHours) {
    try {
      const result = await storageGet([key]);
      const cached = result?.[key];
      if (!cached || typeof cached !== "object") {
        return {};
      }

      const now = Date.now();
      Object.keys(cached).forEach((entryKey) => {
        const entry = cached[entryKey];
        if (entry?.timestamp && now - entry.timestamp > expiryHours * HOUR_MS) {
          delete cached[entryKey];
        }
      });

      return cached;
    } catch (error) {
      errorLog("Ошибка загрузки кеша:", error);
      return {};
    }
  }

  function saveCache(key, cache) {
    void storageSet({ [key]: cache }).catch((error) => {
      errorLog("Ошибка сохранения кеша:", error);
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

  async function loadSettings() {
    try {
      const result = await storageGet([SETTINGS_KEY]);
      return normalizeSettings(result?.[SETTINGS_KEY]);
    } catch (error) {
      errorLog("Ошибка загрузки настроек:", error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function removeStatsOverlays() {
    document
      .querySelectorAll(".card-stats-overlay")
      .forEach((element) => element.remove());
  }

  function removeLotsOverlays() {
    document
      .querySelectorAll(".card-lots-overlay")
      .forEach((element) => element.remove());
  }

  function removeTradesIndicators() {
    document
      .querySelectorAll(".profile__trades-count, .profile__trades-blocked")
      .forEach((element) => element.remove());
  }

  function applyCompactMode() {
    document.documentElement.classList.toggle(
      "mangabuff-stats-compact",
      settings.compactMode,
    );
  }

  function applySettings(nextSettings) {
    const previousSettings = settings;
    settings = normalizeSettings(nextSettings);
    applyCompactMode();

    if (!settings.showStats) {
      removeStatsOverlays();
    }

    if (!settings.showLots) {
      removeLotsOverlays();
      marketCardsQueue.length = 0;
      lotsObserver?.disconnect();
    }

    if (!settings.showTrades) {
      removeTradesIndicators();
    }

    if (
      (!previousSettings.showStats && settings.showStats) ||
      (!previousSettings.showLots && settings.showLots)
    ) {
      scheduleProcessCards(0);
    }

    if (!previousSettings.showTrades && settings.showTrades) {
      void displayUserTradesCount();
    }
  }

  function handleStorageChanges(changes, areaName) {
    if (areaName !== "local") return;

    if (changes[SETTINGS_KEY]) {
      applySettings(changes[SETTINGS_KEY].newValue);
    }
    if (changes[CACHE_KEY] && changes[CACHE_KEY].newValue === undefined) {
      cardStatsCache = {};
    }
    if (
      changes[LOTS_CACHE_KEY] &&
      changes[LOTS_CACHE_KEY].newValue === undefined
    ) {
      cardLotsCache = {};
    }
    if (
      changes[TRADES_CACHE_KEY] &&
      changes[TRADES_CACHE_KEY].newValue === undefined
    ) {
      userTradesCache = {};
    }
  }

  function registerStorageChangeListener() {
    const storageEvents =
      globalThis.browser?.storage?.onChanged ||
      globalThis.chrome?.storage?.onChanged;
    storageEvents?.addListener(handleStorageChanges);
  }

  function setCachedCardStats(cardId, owners, wanters, timestamp = Date.now()) {
    cardStatsCache[cardId] = {
      owners,
      wanters,
      timestamp,
    };
    saveCache(CACHE_KEY, cardStatsCache);
  }

  function getFreshCachedCardStats(cardId) {
    const cached = cardStatsCache[cardId];
    if (
      cached &&
      isFreshTimestamp(cached.timestamp, CACHE_TTLS.cardStats) &&
      cached.owners !== null &&
      cached.wanters !== null
    ) {
      return cached;
    }
    return null;
  }

  function getPageType() {
    const pathname = window.location.pathname;

    if (pathname.startsWith("/market") && !pathname.includes("requests")) {
      return "market";
    }
    if (pathname.startsWith("/decks/")) return "deck";
    if (pathname.match(/\/clubs\/[^/]+\/boost/)) return "club-boost";
    if (pathname.startsWith("/cards")) return "cards";
    if (pathname.match(/^\/users\/\d+\/cards/)) return "cards";
    if (pathname.match(/^\/users\/\d+/)) return "trade-history";
    if (pathname.startsWith("/manga/")) return "manga";
    if (pathname.startsWith("/users/")) return "profile";
    if (pathname.startsWith("/trades/history")) return "trade-history";
    if (pathname.match(/^\/trades\/\d+/)) return "trade";

    return "unknown";
  }

  function getPageConfig(pageType) {
    return PAGE_CONFIGS[pageType] || null;
  }

  function makeRequestWithDelay() {
    if (lastRequestTime === 0) {
      lastRequestTime = Date.now();
      return Promise.resolve();
    }

    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;

    if (timeSinceLastRequest >= REQUEST_DELAY) {
      lastRequestTime = now;
      return Promise.resolve();
    }

    return sleep(REQUEST_DELAY - timeSinceLastRequest).then(() => {
      lastRequestTime = Date.now();
    });
  }

  function addToQueue(requestFn) {
    return new Promise((resolve, reject) => {
      requestQueue.push({ requestFn, resolve, reject });
      processQueue();
    });
  }

  function scheduleScrapeQueueProcessing() {
    if (scrapeQueueScheduled) return;

    scrapeQueueScheduled = true;
    Promise.resolve().then(() => {
      scrapeQueueScheduled = false;
      processScrapeQueue();
    });
  }

  function addScrapeToQueue(requestFn, priority = SCRAPE_PRIORITY.stale) {
    return new Promise((resolve, reject) => {
      scrapeQueue.push({
        requestFn,
        resolve,
        reject,
        priority,
        order: scrapeQueueOrder++,
      });
      scheduleScrapeQueueProcessing();
    });
  }

  async function processScrapeQueue() {
    if (isProcessingScrapeQueue || scrapeQueue.length === 0) {
      return;
    }

    isProcessingScrapeQueue = true;

    while (scrapeQueue.length > 0) {
      scrapeQueue.sort((a, b) => a.priority - b.priority || a.order - b.order);

      const { requestFn, resolve, reject } = scrapeQueue.shift();

      try {
        const result = await requestFn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }

    isProcessingScrapeQueue = false;
  }

  async function processQueue() {
    if (isProcessingQueue || requestQueue.length === 0) {
      return;
    }

    isProcessingQueue = true;

    while (requestQueue.length > 0) {
      const { requestFn, resolve, reject } = requestQueue.shift();

      try {
        const result = await requestFn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }

    isProcessingQueue = false;
  }

  async function fetchWithRetry(url, retryCount = 0) {
    await makeRequestWithDelay();

    const response = await requestFetch({
      method: "GET",
      url,
      timeout: 5000,
    });

    if (response.status === 429) {
      if (retryCount < MAX_RETRIES) {
        log(
          `429 ошибка для ${url}, повторная попытка ${retryCount + 1}/${MAX_RETRIES}`,
        );
        await sleep(RETRY_DELAY * (retryCount + 1));
        return fetchWithRetry(url, retryCount + 1);
      }

      errorLog(`Превышено количество попыток для ${url}`);
      throw new Error("Too many retries");
    }

    if (response.status >= 200 && response.status < 300) {
      return response.responseText;
    }

    throw new Error(`HTTP ${response.status}`);
  }

  function parseHtml(html) {
    const parser = new DOMParser();
    return parser.parseFromString(html, "text/html");
  }

  function getLastPageNumber(html) {
    const doc = parseHtml(html);
    const paginationButtons = doc.querySelectorAll(".pagination__button a");

    let maxPage = 1;
    paginationButtons.forEach((button) => {
      const href = button.getAttribute("href");
      if (!href || !href.includes("page=")) return;

      const match = href.match(/page=(\d+)/);
      if (!match) return;

      const pageNum = parseInt(match[1], 10);
      if (pageNum > maxPage) {
        maxPage = pageNum;
      }
    });

    return maxPage;
  }

  function parseCardLots(html) {
    const doc = parseHtml(html);
    const lotElements = doc.querySelectorAll(
      ".market-show__lots .market-show__item",
    );
    const lots = [];
    const seenPrices = new Set();

    for (const lotElement of lotElements) {
      const href = lotElement.getAttribute("href");
      const lotId = href ? href.split("/market/")[1] : null;
      if (!lotId) continue;

      const priceElement = lotElement.querySelector(
        ".market-show__user-cards-rank",
      );
      const price = priceElement ? priceElement.textContent.trim() : null;
      if (!price || seenPrices.has(price)) continue;

      seenPrices.add(price);
      lots.push({ lotId, price });

      if (lots.length >= 5) {
        break;
      }
    }

    return lots;
  }

  function parseTradesCount(html) {
    const doc = parseHtml(html);
    const tradeHeader = doc.querySelector(".trade__header-name span");
    const count = tradeHeader ? tradeHeader.textContent.trim() : null;
    const isBlocked = doc.querySelector(".trade__block") !== null;

    return { count, isBlocked };
  }

  async function fetchCardStatsBatch(cardIds) {
    const CHUNK = 200;
    const result = {};

    for (let index = 0; index < cardIds.length; index += CHUNK) {
      if (!settings.showStats) break;

      const chunk = cardIds.slice(index, index + CHUNK);
      const url = `${API_URL}/cards?ids=${chunk.join(",")}`;

      await new Promise((resolve) => {
        requestFetch({
          method: "GET",
          url,
          timeout: 5000,
        })
          .then((response) => {
            if (response.status >= 200 && response.status < 300) {
              try {
                JSON.parse(response.responseText).forEach((card) => {
                  result[card.id] = card;
                });
              } catch (error) {
                errorLog("Ошибка разбора ответа batch API:", error);
              }
            }
            resolve();
          })
          .catch(() => resolve());
      });
    }

    return result;
  }

  function extractNumericId(value) {
    if (value === null || value === undefined) return null;
    const numericId = Number(value);
    return Number.isFinite(numericId) && numericId > 0 ? numericId : null;
  }

  function extractUserIdFromText(text) {
    if (!text) return null;

    const patterns = [
      /(?:^|[^\w])user_id\s*[:=]\s*["']?(\d+)["']?/i,
      /"user_id"\s*:\s*(\d+)/i,
      /'user_id'\s*:\s*(\d+)/i,
      /data-user-id=["'](\d+)["']/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return extractNumericId(match[1]);
      }
    }

    return null;
  }

  function getCurrentUserId() {
    try {
      if (cachedCurrentUserId) {
        return cachedCurrentUserId;
      }

      const profile = document.querySelector(".profile[data-user-id]");
      const profileId = profile?.getAttribute("data-user-id");
      const directProfileId = extractNumericId(profileId);
      if (directProfileId) {
        cachedCurrentUserId = directProfileId;
        return directProfileId;
      }

      const htmlUserId = document.documentElement.getAttribute("data-user-id");
      const htmlId = extractNumericId(htmlUserId);
      if (htmlId) {
        cachedCurrentUserId = htmlId;
        return htmlId;
      }

      const bodyUserId = document.body?.getAttribute("data-user-id");
      const bodyId = extractNumericId(bodyUserId);
      if (bodyId) {
        cachedCurrentUserId = bodyId;
        return bodyId;
      }

      for (const script of document.scripts) {
        const id = extractUserIdFromText(script.textContent || "");
        if (id) {
          cachedCurrentUserId = id;
          return id;
        }
      }

      const outerId = extractUserIdFromText(document.documentElement.outerHTML);
      if (outerId) {
        cachedCurrentUserId = outerId;
      }
      return outerId;
    } catch {
      return null;
    }
  }

  async function submitCardObservation(cardId, owners, wanted) {
    if (!settings.showStats) return;

    const userId = getCurrentUserId();
    if (!userId) return;
    if (owners === null || wanted === null) return;

    try {
      await requestFetch({
        method: "POST",
        url: `${API_URL}/cards/${cardId}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owners: Number(owners),
          wanted: Number(wanted),
          user_id: userId,
        }),
        timeout: 5000,
      });
    } catch {
      // Fire-and-forget path.
    }
  }

  async function parseCardStatsFromSite(
    cardId,
    priority = SCRAPE_PRIORITY.stale,
  ) {
    return addScrapeToQueue(async () => {
      if (!settings.showStats) return null;

      let wanted = null;
      let owners = null;

      try {
        if (!settings.showStats) return null;
        await makeRequestWithDelay();
        const html = await fetchWithRetry(
          `https://mangabuff.ru/cards/${cardId}/offers/want`,
        );
        wanted = getLastPageNumber(html);
      } catch {
        wanted = null;
      }

      try {
        if (!settings.showStats) return null;
        await makeRequestWithDelay();
        const html = await fetchWithRetry(
          `https://mangabuff.ru/cards/${cardId}/users`,
        );
        owners = getLastPageNumber(html);
      } catch {
        owners = null;
      }

      if (owners === null || wanted === null) {
        return null;
      }

      return { owners, wanted };
    }, priority);
  }

  function updateCardStats(cardId, stats, options = {}) {
    if (!settings.showStats) return;

    const { stale = false } = options;

    if (Object.prototype.hasOwnProperty.call(stats, "owners")) {
      const ownersElements = document.querySelectorAll(
        `[data-card-id="${cardId}"][data-type="owners"]`,
      );

      ownersElements.forEach((element) => {
        element.textContent = stats.owners !== null ? stats.owners : 1;
        element.classList.remove("card-stats-loading");
        element.classList.toggle("card-stats-stale", stale);
      });
    }

    if (Object.prototype.hasOwnProperty.call(stats, "wanters")) {
      const wantersElements = document.querySelectorAll(
        `[data-card-id="${cardId}"][data-type="wanters"]`,
      );

      wantersElements.forEach((element) => {
        element.textContent = stats.wanters !== null ? stats.wanters : 1;
        element.classList.remove("card-stats-loading");
        element.classList.toggle("card-stats-stale", stale);
      });
    }
  }

  function createStatsOverlay(cardId) {
    const overlay = document.createElement("div");
    overlay.className = "card-stats-overlay";
    overlay.innerHTML = `
      <div class="card-stats-row">
        <span class="card-stats-label">Владельцев:</span>
        <span class="card-stats-value owners card-stats-loading" data-card-id="${cardId}" data-type="owners">...</span>
      </div>
      <div class="card-stats-row">
        <span class="card-stats-label">Желают:</span>
        <span class="card-stats-value wanters card-stats-loading" data-card-id="${cardId}" data-type="wanters">...</span>
      </div>
    `;
    return overlay;
  }

  function createLotsOverlay(lots) {
    if (!lots || lots.length === 0) {
      return null;
    }

    const overlay = document.createElement("div");
    overlay.className = "card-lots-overlay";
    overlay.innerHTML = `
      <div class="card-lots-label">Цены:</div>
      <div class="card-lots-prices">${lots.map((lot) => lot.price).join(", ")}</div>
    `;
    return overlay;
  }

  function getStatsContainer(cardElement, config) {
    if (config.statsContainerSelector) {
      const container = cardElement.querySelector(config.statsContainerSelector);
      if (container) {
        if (getComputedStyle(container).position === "static") {
          container.style.position = "relative";
        }
        return container;
      }
    }

    if (cardElement.matches(".manga-cards__item")) {
      if (getComputedStyle(cardElement).position === "static") {
        cardElement.style.position = "relative";
      }
      return cardElement;
    }

    if (config.wrapperSelector) {
      const wrapper = cardElement.closest(config.wrapperSelector);
      if (wrapper) {
        if (getComputedStyle(wrapper).position === "static") {
          wrapper.style.position = "relative";
        }
        return wrapper;
      }
    }

    if (getComputedStyle(cardElement).position === "static") {
      cardElement.style.position = "relative";
    }
    return cardElement;
  }

  function extractCardId(element, config) {
    if (config.idLocation === "card") {
      const attributes = config.idAttribute.split(",");
      for (const attribute of attributes) {
        const id = element.getAttribute(attribute.trim());
        if (id) return id;
      }
      return null;
    }

    if (config.idLocation === "wrapper") {
      const wrapper = element.closest(config.wrapperSelector);
      return wrapper ? wrapper.getAttribute(config.idAttribute) : null;
    }

    if (config.idLocation === "link") {
      let link = element.querySelector(config.linkSelector);
      if (!link && element.matches && element.matches(config.linkSelector)) {
        link = element;
      }
      if (!link) return null;

      const href = link.getAttribute("href");
      const match = href ? href.match(/\/cards\/(\d+)/) : null;
      return match ? match[1] : null;
    }

    return null;
  }

  async function scrapeAndSubmit(cardId, priority = SCRAPE_PRIORITY.missing) {
    if (!settings.showStats) return;

    const stats = await parseCardStatsFromSite(cardId, priority);
    if (!settings.showStats || !stats) return;

    updateCardStats(cardId, { owners: stats.owners, wanters: stats.wanted });
    setCachedCardStats(cardId, stats.owners, stats.wanted);
    await submitCardObservation(cardId, stats.owners, stats.wanted);
  }

  async function scrapeAndCompare(cardId, apiOwners, apiWanted) {
    if (!settings.showStats) return;

    const stats = await parseCardStatsFromSite(cardId, SCRAPE_PRIORITY.stale);
    if (!settings.showStats || !stats) return;

    setCachedCardStats(cardId, stats.owners, stats.wanted);
    updateCardStats(cardId, { owners: stats.owners, wanters: stats.wanted });
    if (stats.owners === apiOwners && stats.wanted === apiWanted) {
      return;
    }

    await submitCardObservation(cardId, stats.owners, stats.wanted);
  }

  async function fetchCardStatsScrape(cardId) {
    return scrapeAndSubmit(cardId, SCRAPE_PRIORITY.missing);
  }

  async function fetchCardLots(cardId) {
    if (!settings.showLots) return [];

    const cached = cardLotsCache[cardId];
    if (cached && isFreshTimestamp(cached.timestamp, CACHE_TTLS.lots)) {
      if (cached.lots && cached.lots.length > 0) {
        return cached.lots;
      }
    }

    return addToQueue(async () => {
      if (!settings.showLots) return [];

      try {
        const html = await fetchWithRetry(
          `https://mangabuff.ru/market/card/${cardId}`,
        );
        const lots = parseCardLots(html);

        if (lots.length > 0) {
          cardLotsCache[cardId] = {
            lots,
            timestamp: Date.now(),
          };
          saveCache(LOTS_CACHE_KEY, cardLotsCache);
        }

        return lots;
      } catch (error) {
        errorLog(`Ошибка загрузки лотов для карты ${cardId}:`, error);
        return [];
      }
    });
  }

  async function fetchUserTradesCount(userId) {
    if (!settings.showTrades) {
      return { count: null, isBlocked: false };
    }

    const cached = userTradesCache[userId];
    if (
      cached &&
      isFreshTimestamp(cached.timestamp, CACHE_TTLS.trades) &&
      cached.count !== null
    ) {
      return { count: cached.count, isBlocked: cached.isBlocked || false };
    }

    return addToQueue(async () => {
      if (!settings.showTrades) {
        return { count: null, isBlocked: false };
      }

      try {
        const html = await fetchWithRetry(
          `https://mangabuff.ru/trades/offers/${userId}`,
        );
        const result = parseTradesCount(html);

        if (result.count !== null) {
          userTradesCache[userId] = {
            count: result.count,
            isBlocked: result.isBlocked,
            timestamp: Date.now(),
          };
          saveCache(TRADES_CACHE_KEY, userTradesCache);
        }

        return result;
      } catch {
        return { count: null, isBlocked: false };
      }
    });
  }

  async function displayUserTradesCount() {
    if (!settings.showTrades) return;

    const profileElement = document.querySelector(".profile[data-user-id]");
    if (!profileElement) return;

    const userId = profileElement.getAttribute("data-user-id");
    if (!userId) return;

    const nameElement =
      document.querySelector(".profile__name") ||
      document.querySelector(".mobile-profile__name");
    if (!nameElement) return;

    if (nameElement.querySelector(".profile__trades-count")) return;

    const result = await fetchUserTradesCount(userId);
    if (settings.showTrades && result && result.count !== null) {
      const tradesSpan = document.createElement("span");
      tradesSpan.className = "profile__trades-count";
      tradesSpan.textContent = result.count;
      tradesSpan.title = "Количество обменов";
      nameElement.appendChild(tradesSpan);

      const ignoreButton = document.querySelector(".profile__info--ignore-btn");
      const isBlockedFromProfile =
        ignoreButton &&
        ignoreButton.textContent.includes("Удалить из черного списка");
      const isBlocked = result.isBlocked || isBlockedFromProfile;

      if (isBlocked) {
        const blockedSpan = document.createElement("span");
        blockedSpan.className = "profile__trades-blocked";
        blockedSpan.textContent = "✖";
        nameElement.appendChild(blockedSpan);
      }
    }
  }

  async function displayCardLots(cardId, wrapper) {
    if (!settings.showLots) return;

    if (wrapper.querySelector(".card-lots-overlay")) {
      return;
    }

    const lots = await fetchCardLots(cardId);
    if (settings.showLots && lots && lots.length > 0) {
      const overlay = createLotsOverlay(lots);
      if (overlay) {
        wrapper.appendChild(overlay);
      }
    }
  }

  function addMarketCardToQueue(cardId, wrapper) {
    if (!settings.showLots) return;

    marketCardsQueue.push({ cardId, wrapper });
    processMarketCardsQueue();
  }

  async function processMarketCardsQueue() {
    if (isProcessingMarketCards || marketCardsQueue.length === 0) {
      return;
    }

    isProcessingMarketCards = true;

    while (marketCardsQueue.length > 0) {
      if (!settings.showLots) {
        marketCardsQueue.length = 0;
        break;
      }

      const { cardId, wrapper } = marketCardsQueue.shift();

      if (
        document.contains(wrapper) &&
        !wrapper.querySelector(".card-lots-overlay")
      ) {
        await displayCardLots(cardId, wrapper);
      }
    }

    isProcessingMarketCards = false;
  }

  function initLotsObserver() {
    if (!settings.showLots) return;
    if (lotsObserver) {
      lotsObserver.disconnect();
    }

    lotsObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;

          const wrapper = entry.target;
          const cardId = wrapper.getAttribute("data-id");
          if (cardId) {
            addMarketCardToQueue(cardId, wrapper);
            lotsObserver.unobserve(wrapper);
          }
        });
      },
      {
        rootMargin: "50px",
      },
    );
  }

  function hydrateCardStats(cardId, stats, now) {
    if (!settings.showStats) return;

    const updatedAtMs = stats.updated_at ? Date.parse(stats.updated_at) : 0;
    const isStale = !updatedAtMs || now - updatedAtMs > STALE_AFTER_MS;

    updateCardStats(
      cardId,
      {
        owners: stats.owners,
        wanters: stats.wanted,
      },
      { stale: isStale },
    );

    setCachedCardStats(cardId, stats.owners, stats.wanted, now);

    if (isStale) {
      scrapeAndCompare(cardId, stats.owners, stats.wanted);
    }
  }

  function handleMissingBackendCard(cardId) {
    if (!settings.showStats) return;

    scrapeAndSubmit(cardId, SCRAPE_PRIORITY.missing);
  }

  function processMarketPage(cards, config) {
    if (!settings.showLots || !config.showLots) return;

    const marketContainer = document.querySelector(".market-list__cards--all");
    if (!marketContainer) return;

    initLotsObserver();

    cards.forEach((card) => {
      const wrapper = card.closest(config.wrapperSelector);
      if (wrapper && lotsObserver) {
        lotsObserver.observe(wrapper);
      }
    });
  }

  function processNonMarketPage(cards, config) {
    const pendingIds = [];

    cards.forEach((card) => {
      if (settings.showStats && config.showStats) {
        const container = getStatsContainer(card, config);
        if (!container) return;

        if (container.querySelector(".card-stats-overlay")) return;

        const cardId = extractCardId(card, config);
        if (!cardId) return;

        const overlay = createStatsOverlay(cardId);
        container.appendChild(overlay);

        const cached = getFreshCachedCardStats(cardId);
        if (cached) {
          updateCardStats(cardId, {
            owners: cached.owners,
            wanters: cached.wanters,
          });
        } else {
          pendingIds.push(cardId);
        }
      }

      if (settings.showLots && config.showLots) {
        const container = getStatsContainer(card, config);
        if (!container) return;

        const cardId = extractCardId(card, config);
        if (!cardId) return;

        displayCardLots(cardId, container);
      }
    });

    if (settings.showStats && pendingIds.length > 0) {
      fetchCardStatsBatch(pendingIds)
        .then((results) => {
          if (!settings.showStats) return;

          const now = Date.now();
          pendingIds.forEach((id) => {
            const stats = results[id];
            if (stats !== undefined) {
              hydrateCardStats(id, stats, now);
            } else {
              handleMissingBackendCard(id);
            }
          });
        })
        .catch((err) => {
          errorLog("Backend API error:", err);
          pendingIds.forEach((id) => handleMissingBackendCard(id));
        });
    }
  }

  function processCards() {
    const startTime = Date.now();
    const pageType = getPageType();

    log(`Начало processCards, тип страницы: ${pageType}`);

    if (pageType === "profile" || pageType === "unknown") {
      log(`Пропуск обработки для типа: ${pageType}`);
      return;
    }

    const config = getPageConfig(pageType);
    if (!config) {
      log(`Конфигурация не найдена для типа: ${pageType}`);
      return;
    }

    if (
      (!settings.showStats || !config.showStats) &&
      (!settings.showLots || !config.showLots)
    ) {
      return;
    }

    const cards = document.querySelectorAll(config.cardSelector);
    log(`Найдено ${cards.length} карточек на странице ${pageType}`);

    if (cards.length === 0) {
      return;
    }

    if (pageType === "market") {
      processMarketPage(cards, config);
      log(`processCards завершен за ${Date.now() - startTime}мс`);
      return;
    }

    processNonMarketPage(cards, config);
    log(`processCards завершен за ${Date.now() - startTime}мс`);
  }

  function scheduleProcessCards(delay = 100) {
    if (processCardsTimer) {
      clearTimeout(processCardsTimer);
    }

    processCardsTimer = setTimeout(() => {
      processCardsTimer = null;
      processCards();
    }, delay);
  }

  function isElementNode(node) {
    return node && node.nodeType === 1;
  }

  function nodeContainsCardLikeContent(node) {
    return (
      node.classList?.contains("tabs__page") ||
      node.querySelector?.(".manga-cards__item") ||
      node.classList?.contains("lootbox__card") ||
      node.querySelector?.(".lootbox__card") ||
      node.classList?.contains("lootbox__list") ||
      node.classList?.contains("history__item") ||
      node.querySelector?.(".history__item") ||
      node.querySelector?.(".trade__main-item")
    );
  }

  function nodeContainsMarketCards(node) {
    return (
      node.classList?.contains("market-list__cards--all") ||
      node.querySelector?.(".market-list__cards--all")
    );
  }

  function nodeContainsLootboxCard(node) {
    return (
      node.classList?.contains("lootbox__card") ||
      node.querySelector?.(".lootbox__card")
    );
  }

  function handleLootboxAttributeMutation(card) {
    if (!settings.showStats) {
      card.querySelector(".card-stats-overlay")?.remove();
      return;
    }

    const oldOverlay = card.querySelector(".card-stats-overlay");
    if (oldOverlay) {
      oldOverlay.remove();
    }

    const cardId = card.getAttribute("data-id");
    if (!cardId) return;

    if (getComputedStyle(card).position === "static") {
      card.style.position = "relative";
    }

    const overlay = createStatsOverlay(cardId);
    card.appendChild(overlay);

    fetchCardStatsBatch([cardId]).then((results) => {
      if (!settings.showStats) return;

      const stats = results[cardId];
      if (stats !== undefined) {
        const now = Date.now();
        hydrateCardStats(cardId, stats, now);
      } else {
        handleMissingBackendCard(cardId);
      }
    });
  }

  const observer = new MutationObserver((mutations) => {
    let shouldProcessCards = false;
    let handledAttributeChange = false;

    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        const addedNodes = Array.from(mutation.addedNodes).filter(
          isElementNode,
        );
        const tabLoaded = addedNodes.some(nodeContainsCardLikeContent);
        const marketCardsAdded = addedNodes.some(nodeContainsMarketCards);

        if (tabLoaded || marketCardsAdded) {
          shouldProcessCards = true;
        }
      }

      if (mutation.removedNodes.length > 0) {
        const removedNodes = Array.from(mutation.removedNodes).filter(
          isElementNode,
        );
        const lootboxRemoved = removedNodes.some(nodeContainsLootboxCard);
        if (lootboxRemoved) {
          shouldProcessCards = true;
        }
      }

      if (
        mutation.type === "attributes" &&
        mutation.attributeName === "data-id"
      ) {
        const card = mutation.target;
        if (card.classList.contains("lootbox__card")) {
          handledAttributeChange = true;
          handleLootboxAttributeMutation(card);
        }
      }
    }

    if (shouldProcessCards) {
      scheduleProcessCards(100);
    } else if (!handledAttributeChange) {
      processCards();
    }
  });

  async function bootstrap() {
    const caches = await Promise.all([
      loadCache(CACHE_KEY, CACHE_TTLS.cardStats),
      loadCache(LOTS_CACHE_KEY, CACHE_TTLS.lots),
      loadCache(TRADES_CACHE_KEY, CACHE_TTLS.trades),
      loadSettings(),
    ]);

    [cardStatsCache, cardLotsCache, userTradesCache, settings] = caches;

    applyCompactMode();
    registerStorageChangeListener();
    processCards();
    void displayUserTradesCount();
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-id"],
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      bootstrap().catch((error) => errorLog("Bootstrap error:", error));
    });
  } else {
    bootstrap().catch((error) => errorLog("Bootstrap error:", error));
  }
})();

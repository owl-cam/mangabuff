// ==UserScript==
// @name         MangaBuff Card Statistics
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  Показывает статистику владельцев/желающих, цены на лоты и число обменов пользователей
// @author       zamoroz
// @match        https://mangabuff.ru/cards*
// @match        https://mangabuff.ru/users/*
// @match        https://mangabuff.ru/market*
// @match        https://mangabuff.ru/decks/*
// @match        https://mangabuff.ru/clubs/*/boost
// @match        https://mangabuff.ru/manga/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      mangabuff.ru
// @connect      mbstat.space
// @license MIT
// @downloadURL https://update.greasyfork.org/scripts/563924/MangaBuff%20Card%20Statistics.user.js
// @updateURL https://update.greasyfork.org/scripts/563924/MangaBuff%20Card%20Statistics.meta.js
// ==/UserScript==

(function () {
  "use strict";

  const API_URL = "https://mbstat.space";
  const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

  // Кэш для хранения данных о карточках
  const CACHE_KEY = "mangabuff_card_stats_cache";
  const CACHE_EXPIRY_HOURS = 24;
  const LOTS_CACHE_KEY = "mangabuff_card_lots_cache";
  const LOTS_CACHE_EXPIRY_HOURS = 1; // Кеш действителен 1 час
  const TRADES_CACHE_KEY = "mangabuff_user_trades_cache";
  const TRADES_CACHE_EXPIRY_HOURS = 24; // Кеш действителен 24 часа

  /**
   * Загружает кеш из localStorage
   */
  function loadCache(key, expiry) {
    try {
      const cached = localStorage.getItem(key);
      if (!cached) return {};

      const data = JSON.parse(cached);
      const now = Date.now();

      // Удаляем устаревшие записи
      Object.keys(data).forEach((key) => {
        if (
          data[key].timestamp &&
          now - data[key].timestamp > expiry * 60 * 60 * 1000
        ) {
          delete data[key];
        }
      });

      return data;
    } catch (error) {
      console.error("[MangaBuff Stats] Ошибка загрузки кеша:", error);
      return {};
    }
  }

  /**
   * Сохраняет кеш в localStorage
   */
  function saveCache(key, cache) {
    try {
      localStorage.setItem(key, JSON.stringify(cache));
    } catch (error) {
      console.error("[MangaBuff Stats] Ошибка сохранения кеша:", error);
    }
  }

  const cardStatsCache = loadCache(CACHE_KEY, CACHE_EXPIRY_HOURS);
  const cardLotsCache = loadCache(LOTS_CACHE_KEY, LOTS_CACHE_EXPIRY_HOURS);
  const userTradesCache = loadCache(
    TRADES_CACHE_KEY,
    TRADES_CACHE_EXPIRY_HOURS,
  );

  // Настройки защиты от DDOS
  const REQUEST_DELAY = 500; // Задержка между запросами в мс
  const MAX_RETRIES = 3; // Максимальное количество повторных попыток
  const RETRY_DELAY = 2000; // Задержка перед повторной попыткой в мс
  let lastRequestTime = 0;

  // Очередь запросов
  const requestQueue = [];
  let isProcessingQueue = false;

  // Очередь для обработки карточек маркета
  const marketCardsQueue = [];
  let isProcessingMarketCards = false;

  // Intersection Observer для ленивой загрузки лотов
  let lotsObserver = null;

  /**
   * Определяет тип страницы по URL
   * Этот подход более надежен, чем определение по CSS-селекторам,
   * так как URL не зависит от изменений в верстке сайта
   */
  function getPageType() {
    const pathname = window.location.pathname;

    if (pathname.startsWith("/market")) {
      return "market";
    }
    if (pathname.startsWith("/decks/")) {
      return "deck";
    }
    if (pathname.match(/\/clubs\/[^/]+\/boost/)) {
      return "club-boost";
    }
    if (pathname.startsWith("/cards")) {
      return "cards";
    }
    if (pathname.match(/\/users\/\d+\/cards/)) {
      return "cards";
    }
    if (pathname.startsWith("/manga/")) {
      return "manga";
    }
    if (pathname.startsWith("/users/")) {
      return "profile";
    }
    return "unknown";
  }

  /**
   * Возвращает конфигурацию обработки карточек для текущего типа страницы
   */
  function getPageConfig(pageType) {
    const configs = {
      cards: {
        cardSelector: ".manga-cards__item[data-card-id]",
        wrapperSelector: ".manga-cards__item-wrapper",
        idAttribute: "data-card-id",
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
        idAttribute: null,
        idLocation: "link",
        linkSelector: 'a[href*="/cards/"]',
        showStats: true,
        showLots: false,
      },
      manga: {
        cardSelector:
          ".manga-cards__item[data-card-id], .lootbox__card[data-id]",
        wrapperSelector: ".manga-cards__item-wrapper",
        idAttribute: "data-card-id,data-id",
        idLocation: "card",
        showStats: true,
        showLots: false,
      },
    };

    return configs[pageType] || null;
  }

  // CSS стили для отображения статистики
  const styles = `
        .card-stats-overlay {
            background: rgba(0, 0, 0, 0.85);
            color: white;
            padding: 4px 6px;
            border-radius: 3px;
            font-size: 9px;
            z-index: 10;
            backdrop-filter: blur(5px);
            line-height: 1.3;
        }
        .card-stats-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin: 1px 0;
            white-space: nowrap;
        }
        .card-stats-label {
            color: #aaa;
            margin-right: 4px;
            font-size: 8px;
        }
        .card-stats-value {
            font-weight: bold;
            font-size: 9px;
        }
        .card-stats-value.owners {
            color: #4ade80;
        }
        .card-stats-value.wanters {
            color: #fb923c;
        }
        .card-stats-loading {
            color: #888;
            font-style: italic;
        }
        .manga-cards__item-wrapper {
            position: relative;
        }
        .deck__item {
            position: relative;
        }
        .club-boost__inner {
            position: relative;
        }
        .lootbox__list {
            padding-bottom: 40px;
        }
        .lootbox__card {
            position: relative;
        }
        .card-lots-overlay {
            position: absolute;
            top: 8px;
            right: 5px;
            background: rgba(0, 0, 0, 0.85);
            color: white;
            padding: 4px 6px;
            border-radius: 3px;
            font-size: 8px;
            z-index: 10;
            backdrop-filter: blur(5px);
            max-width: 110px;
            line-height: 1.4;
        }
        .card-lots-label {
            color: #aaa;
            font-weight: 500;
            margin-bottom: 2px;
        }
        .card-lots-prices {
            color: #fbbf24;
            font-weight: bold;
        }
        .profile__trades-count {
            display: inline-block;
            margin-left: 8px;
            padding: 2px 8px;
            background: rgba(139, 0, 255, 0.5);
            border: 1px solid rgba(139, 0, 255, 0.8);
            border-radius: 12px;
            font-size: 12px;
            color: #a78bfa;
            font-weight: 500;
            vertical-align: middle;
        }
        .profile__trades-blocked {
            display: inline-block;
            margin-left: 4px;
            color: #ef4444;
            font-size: 16px;
            font-weight: bold;
            vertical-align: middle;
            cursor: help;
        }
    `;

  // Добавляем стили на страницу
  const styleSheet = document.createElement("style");
  styleSheet.textContent = styles;
  document.head.appendChild(styleSheet);

  /**
   * Ждет указанное время
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Выполняет запрос с задержкой между запросами
   */
  async function makeRequestWithDelay() {
    // Если это первый запрос, не ждем
    if (lastRequestTime === 0) {
      lastRequestTime = Date.now();
      return;
    }

    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;

    if (timeSinceLastRequest < REQUEST_DELAY) {
      await sleep(REQUEST_DELAY - timeSinceLastRequest);
    }

    lastRequestTime = Date.now();
  }

  /**
   * Добавляет запрос в очередь
   */
  function addToQueue(requestFn) {
    return new Promise((resolve, reject) => {
      requestQueue.push({ requestFn, resolve, reject });
      processQueue();
    });
  }

  /**
   * Обрабатывает очередь запросов последовательно
   */
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

  /**
   * Выполняет запрос с повторными попытками при ошибке 429
   */
  async function fetchWithRetry(url, retryCount = 0) {
    await makeRequestWithDelay();

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        onload: async function (response) {
          if (response.status === 429) {
            // Слишком много запросов - ждем и повторяем
            if (retryCount < MAX_RETRIES) {
              console.log(
                `[MangaBuff Stats] 429 ошибка для ${url}, повторная попытка ${retryCount + 1}/${MAX_RETRIES}`,
              );
              await sleep(RETRY_DELAY * (retryCount + 1)); // Экспоненциальная задержка
              try {
                const result = await fetchWithRetry(url, retryCount + 1);
                resolve(result);
              } catch (err) {
                reject(err);
              }
            } else {
              console.error(
                `[MangaBuff Stats] Превышено количество попыток для ${url}`,
              );
              reject(new Error("Too many retries"));
            }
          } else if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText);
          } else {
            reject(new Error(`HTTP ${response.status}`));
          }
        },
        onerror: function (error) {
          reject(error);
        },
      });
    });
  }

  /**
   * Извлекает номер последней страницы из пагинации
   */
  function getLastPageNumber(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const paginationButtons = doc.querySelectorAll(".pagination__button a");

    let maxPage = 1;
    paginationButtons.forEach((button) => {
      const href = button.getAttribute("href");
      if (href && href.includes("page=")) {
        const match = href.match(/page=(\d+)/);
        if (match) {
          const pageNum = parseInt(match[1]);
          if (pageNum > maxPage) {
            maxPage = pageNum;
          }
        }
      }
    });

    return maxPage;
  }

  /**
   * Парсит HTML страницы лотов и извлекает первые 5 уникальных цен
   */
  function parseCardLots(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const lotElements = doc.querySelectorAll(
      ".market-show__lots .market-show__item",
    );

    const lots = [];
    const seenPrices = new Set();

    for (const lotElement of lotElements) {
      // Извлечение ID лота из href
      const href = lotElement.getAttribute("href");
      const lotId = href ? href.split("/market/")[1] : null;

      if (!lotId) continue;

      // Извлечение цены
      const priceElement = lotElement.querySelector(
        ".market-show__user-cards-rank",
      );
      const price = priceElement ? priceElement.textContent.trim() : null;

      // Проверка уникальности цены
      if (!price || seenPrices.has(price)) continue;
      seenPrices.add(price);

      lots.push({ lotId, price });

      // Ограничение: максимум 5 уникальных цен
      if (lots.length >= 5) break;
    }

    return lots;
  }

  /**
   * Загружает статистику для списка карточек через локальный бекенд
   * Возвращает map: id → {owners, wanted}
   */
  async function fetchCardStatsBatch(cardIds) {
    const CHUNK = 200;
    const result = {};
    for (let i = 0; i < cardIds.length; i += CHUNK) {
      const chunk = cardIds.slice(i, i + CHUNK);
      const url = `${API_URL}/cards?ids=${chunk.join(",")}`;
      await new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          timeout: 5000,
          onload: (r) => {
            if (r.status >= 200 && r.status < 300) {
              try {
                JSON.parse(r.responseText).forEach((c) => {
                  result[c.id] = c;
                });
              } catch {}
            }
            resolve();
          },
          onerror: resolve,
          ontimeout: resolve,
        });
      });
    }
    return result;
  }

  /**
   * Возвращает текущий user_id из window (выставляется самим mangabuff.ru в хедере)
   */
  function getCurrentUserId() {
    try {
      const w = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
      const id = w.user_id;
      if (id === undefined || id === null || id === "") return null;
      const n = Number(id);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Отправляет наблюдение по карте на бекенд (best-effort, без ретраев)
   */
  function submitCardObservation(cardId, owners, wanted) {
    const userId = getCurrentUserId();
    if (!userId) return;
    if (owners === null || wanted === null) return;
    GM_xmlhttpRequest({
      method: "POST",
      url: `${API_URL}/cards/${cardId}`,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({
        owners: Number(owners),
        wanted: Number(wanted),
        user_id: userId,
      }),
      timeout: 5000,
      onload: () => {},
      onerror: () => {},
      ontimeout: () => {},
    });
  }

  /**
   * Парсит счётчики owners/wanted с mangabuff.ru через 2 запроса с пагинацией.
   * Возвращает {owners, wanted} либо null если хоть один запрос не удался.
   */
  async function parseCardStatsFromSite(cardId) {
    return addToQueue(async () => {
      let wanted = null;
      let owners = null;
      try {
        await makeRequestWithDelay();
        const html = await fetchWithRetry(
          `https://mangabuff.ru/cards/${cardId}/offers/want`,
        );
        wanted = getLastPageNumber(html);
      } catch {
        wanted = null;
      }
      try {
        await makeRequestWithDelay();
        const html = await fetchWithRetry(
          `https://mangabuff.ru/cards/${cardId}/users`,
        );
        owners = getLastPageNumber(html);
      } catch {
        owners = null;
      }
      if (owners === null || wanted === null) return null;
      return { owners, wanted };
    });
  }

  /**
   * Скрейпит карточку, апдейтит DOM/кеш и шлёт наблюдение на бекенд.
   * Используется когда у бекенда нет данных по карте.
   */
  async function scrapeAndSubmit(cardId) {
    const stats = await parseCardStatsFromSite(cardId);
    if (!stats) return;
    updateCardStats(cardId, { owners: stats.owners, wanters: stats.wanted });
    cardStatsCache[cardId] = {
      owners: stats.owners,
      wanters: stats.wanted,
      timestamp: Date.now(),
    };
    saveCache(CACHE_KEY, cardStatsCache);
    submitCardObservation(cardId, stats.owners, stats.wanted);
  }

  /**
   * Перепарсивает карточку и шлёт апдейт только если данные разошлись с бекендом.
   * Используется когда updated_at на бекенде старше STALE_AFTER_MS.
   */
  async function scrapeAndCompare(cardId, apiOwners, apiWanted) {
    const stats = await parseCardStatsFromSite(cardId);
    if (!stats) return;
    cardStatsCache[cardId] = {
      owners: stats.owners,
      wanters: stats.wanted,
      timestamp: Date.now(),
    };
    saveCache(CACHE_KEY, cardStatsCache);
    if (stats.owners === apiOwners && stats.wanted === apiWanted) return;
    updateCardStats(cardId, { owners: stats.owners, wanters: stats.wanted });
    submitCardObservation(cardId, stats.owners, stats.wanted);
  }

  /**
   * Обратная совместимость: старое имя, теперь делегирует scrapeAndSubmit.
   */
  async function fetchCardStatsScrape(cardId) {
    return scrapeAndSubmit(cardId);
  }

  /**
   * Загружает информацию о лотах для карточки
   */
  async function fetchCardLots(cardId) {
    // Проверяем кеш
    if (cardLotsCache[cardId]) {
      const cached = cardLotsCache[cardId];
      const isNotExpired =
        cached.timestamp &&
        Date.now() - cached.timestamp <
          LOTS_CACHE_EXPIRY_HOURS * 60 * 60 * 1000;

      if (isNotExpired && cached.lots && cached.lots.length > 0) {
        return cached.lots;
      }
    }

    // Запрашиваем данные
    return addToQueue(async () => {
      try {
        const html = await fetchWithRetry(
          `https://mangabuff.ru/market/card/${cardId}`,
        );
        const lots = parseCardLots(html);

        // Сохраняем в кеш
        if (lots.length > 0) {
          cardLotsCache[cardId] = {
            lots: lots,
            timestamp: Date.now(),
          };
          saveCache(LOTS_CACHE_KEY, cardLotsCache);
        }

        return lots;
      } catch (error) {
        console.error(
          `[MangaBuff Stats] Ошибка загрузки лотов для карты ${cardId}:`,
          error,
        );
        return [];
      }
    });
  }

  /**
   * Парсит HTML страницы обмена и извлекает число обменов и статус блокировки
   */
  function parseTradesCount(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const tradeHeader = doc.querySelector(".trade__header-name span");

    let count = null;
    if (tradeHeader) {
      count = tradeHeader.textContent.trim();
    }

    // Проверяем наличие блока trade__block (пользователь заблокирован)
    const isBlocked = doc.querySelector(".trade__block") !== null;

    return { count, isBlocked };
  }

  /**
   * Загружает информацию о числе обменов пользователя и статусе блокировки
   */
  async function fetchUserTradesCount(userId) {
    // Проверяем кеш
    if (userTradesCache[userId]) {
      const cached = userTradesCache[userId];
      const isNotExpired =
        cached.timestamp &&
        Date.now() - cached.timestamp <
          TRADES_CACHE_EXPIRY_HOURS * 60 * 60 * 1000;

      if (isNotExpired && cached.count !== null) {
        return { count: cached.count, isBlocked: cached.isBlocked || false };
      }
    }

    // Запрашиваем данные
    return addToQueue(async () => {
      try {
        const html = await fetchWithRetry(
          `https://mangabuff.ru/trades/offers/${userId}`,
        );
        const result = parseTradesCount(html);

        // Сохраняем в кеш
        if (result.count !== null) {
          userTradesCache[userId] = {
            count: result.count,
            isBlocked: result.isBlocked,
            timestamp: Date.now(),
          };
          saveCache(TRADES_CACHE_KEY, userTradesCache);
        }

        return result;
      } catch (error) {
        return { count: null, isBlocked: false };
      }
    });
  }

  /**
   * Отображает число обменов на странице профиля
   */
  async function displayUserTradesCount() {
    // Проверяем, что мы на странице профиля
    const profileElement = document.querySelector(".profile[data-user-id]");
    if (!profileElement) return;

    const userId = profileElement.getAttribute("data-user-id");
    if (!userId) return;

    // Ищем элемент с именем пользователя (десктоп или мобильная версия)
    const nameElement =
      document.querySelector(".profile__name") ||
      document.querySelector(".mobile-profile__name");
    if (!nameElement) return;

    // Проверяем, не добавлен ли уже счетчик
    if (nameElement.querySelector(".profile__trades-count")) return;

    // Получаем число обменов и статус блокировки
    const result = await fetchUserTradesCount(userId);

    // Если число получено - добавляем его
    if (result && result.count !== null) {
      const tradesSpan = document.createElement("span");
      tradesSpan.className = "profile__trades-count";
      tradesSpan.textContent = result.count;
      tradesSpan.title = "Количество обменов";
      nameElement.appendChild(tradesSpan);

      // Проверяем блокировку: либо из кеша страницы обмена, либо из кнопки на странице профиля
      const ignoreButton = document.querySelector(".profile__info--ignore-btn");
      const isBlockedFromProfile =
        ignoreButton &&
        ignoreButton.textContent.includes("Удалить из черного списка");
      const isBlocked = result.isBlocked || isBlockedFromProfile;

      // Добавляем индикатор черного списка, если пользователь заблокирован
      if (isBlocked) {
        const blockedSpan = document.createElement("span");
        blockedSpan.className = "profile__trades-blocked";
        blockedSpan.textContent = "✖";
        nameElement.appendChild(blockedSpan);
      }
    }
  }

  /**
   * Извлекает ID карты из элемента согласно конфигурации
   */
  function extractCardId(element, config) {
    if (config.idLocation === "card") {
      // Поддержка множественных атрибутов через запятую
      const attributes = config.idAttribute.split(",");
      for (const attr of attributes) {
        const id = element.getAttribute(attr.trim());
        if (id) return id;
      }
      return null;
    } else if (config.idLocation === "wrapper") {
      const wrapper = element.closest(config.wrapperSelector);
      return wrapper ? wrapper.getAttribute(config.idAttribute) : null;
    } else if (config.idLocation === "link") {
      const link = element.querySelector(config.linkSelector);
      if (link) {
        const href = link.getAttribute("href");
        const match = href.match(/\/cards\/(\d+)/);
        return match ? match[1] : null;
      }
    }
    return null;
  }

  /**
   * Находит контейнер для размещения статистики
   */
  function getStatsContainer(cardElement, config) {
    if (config.wrapperSelector) {
      const wrapper = cardElement.closest(config.wrapperSelector);
      if (wrapper) {
        wrapper.style.position = "relative";
        return wrapper;
      }
    }
    // No wrapper - card is the container
    cardElement.style.position = "relative";
    return cardElement;
  }

  /**
   * Создает HTML элемент со статистикой
   */
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

  /**
   * Создает HTML элемент с информацией о лотах (только цены)
   */
  function createLotsOverlay(lots) {
    if (!lots || lots.length === 0) return null;

    const overlay = document.createElement("div");
    overlay.className = "card-lots-overlay";

    // Формируем строку с ценами через запятую
    const prices = lots.map((lot) => lot.price).join(", ");

    overlay.innerHTML = `
            <div class="card-lots-label">Цены:</div>
            <div class="card-lots-prices">${prices}</div>
        `;

    return overlay;
  }

  /**
   * Обновляет статистику на карточке
   */
  function updateCardStats(cardId, stats) {
    const ownersElements = document.querySelectorAll(
      `[data-card-id="${cardId}"][data-type="owners"]`,
    );
    const wantersElements = document.querySelectorAll(
      `[data-card-id="${cardId}"][data-type="wanters"]`,
    );

    // Обновляем владельцев только если значение передано (не undefined)
    if (stats.owners !== undefined) {
      ownersElements.forEach((el) => {
        el.textContent = stats.owners !== null ? stats.owners : 1;
        el.classList.remove("card-stats-loading");
      });
    }

    // Обновляем желающих только если значение передано (не undefined)
    if (stats.wanters !== undefined) {
      wantersElements.forEach((el) => {
        el.textContent = stats.wanters !== null ? stats.wanters : 1;
        el.classList.remove("card-stats-loading");
      });
    }
  }

  /**
   * Отображает информацию о лотах на карточке
   */
  async function displayCardLots(cardId, wrapper) {
    // Проверяем, не добавлен ли уже overlay
    if (wrapper.querySelector(".card-lots-overlay")) return;

    // Получаем лоты
    const lots = await fetchCardLots(cardId);

    // Если лоты есть - создаем и добавляем overlay
    if (lots && lots.length > 0) {
      const overlay = createLotsOverlay(lots);
      if (overlay) {
        wrapper.appendChild(overlay);
      }
    }
  }

  /**
   * Добавляет карточку маркета в очередь для обработки
   */
  function addMarketCardToQueue(cardId, wrapper) {
    marketCardsQueue.push({ cardId, wrapper });
    processMarketCardsQueue();
  }

  /**
   * Обрабатывает очередь карточек маркета последовательно
   */
  async function processMarketCardsQueue() {
    if (isProcessingMarketCards || marketCardsQueue.length === 0) {
      return;
    }

    isProcessingMarketCards = true;

    while (marketCardsQueue.length > 0) {
      const { cardId, wrapper } = marketCardsQueue.shift();

      // Проверяем, что карточка все еще в DOM и не обработана
      if (
        document.contains(wrapper) &&
        !wrapper.querySelector(".card-lots-overlay")
      ) {
        await displayCardLots(cardId, wrapper);
      }
    }
    isProcessingMarketCards = false;
  }

  /**
   * Инициализирует Intersection Observer для ленивой загрузки лотов
   */
  function initLotsObserver() {
    if (lotsObserver) return; // Уже инициализирован

    lotsObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const wrapper = entry.target;
            const cardId = wrapper.getAttribute("data-id");

            if (cardId) {
              // Добавляем в очередь вместо немедленной обработки
              addMarketCardToQueue(cardId, wrapper);
              // Отключаем наблюдение после добавления в очередь
              lotsObserver.unobserve(wrapper);
            }
          }
        });
      },
      {
        rootMargin: "50px", // Предзагрузка за 50px до появления
      },
    );
  }

  /**
   * Обрабатывает карточки на странице
   */
  function processCards() {
    const startTime = Date.now();
    const pageType = getPageType();

    console.log(
      `[MangaBuff Stats] Начало processCards, тип страницы: ${pageType}`,
    );

    // Пропускаем обработку для страниц профиля и неизвестных страниц
    if (pageType === "profile" || pageType === "unknown") {
      console.log(`[MangaBuff Stats] Пропуск обработки для типа: ${pageType}`);
      return;
    }

    // Получаем конфигурацию для текущего типа страницы
    const config = getPageConfig(pageType);
    if (!config) {
      console.log(
        `[MangaBuff Stats] Конфигурация не найдена для типа: ${pageType}`,
      );
      return;
    }

    const cards = document.querySelectorAll(config.cardSelector);
    console.log(
      `[MangaBuff Stats] Найдено ${cards.length} карточек на странице ${pageType}`,
    );

    if (cards.length === 0) return;

    // Специальная обработка для маркета - только лоты, без статистики
    if (pageType === "market") {
      const marketContainer = document.querySelector(
        ".market-list__cards--all",
      );
      if (marketContainer) {
        initLotsObserver();

        cards.forEach((card) => {
          const wrapper = card.closest(config.wrapperSelector);
          if (wrapper && lotsObserver) {
            lotsObserver.observe(wrapper);
          }
        });
      }
      console.log(
        `[MangaBuff Stats] processCards завершен за ${Date.now() - startTime}мс`,
      );
      return;
    }

    // Обработка карточек для остальных типов страниц
    const pendingIds = [];

    cards.forEach((card) => {
      // Показываем статистику владельцев/желающих, если включено
      if (config.showStats) {
        const container = getStatsContainer(card, config);
        if (!container) return;

        // Проверяем, не добавлена ли уже статистика
        if (container.querySelector(".card-stats-overlay")) return;

        const cardId = extractCardId(card, config);
        if (!cardId) return;

        // Добавляем оверлей со статистикой
        const overlay = createStatsOverlay(cardId);
        container.appendChild(overlay);

        // Проверяем кеш
        const cached = cardStatsCache[cardId];
        const isValid =
          cached &&
          cached.timestamp &&
          Date.now() - cached.timestamp < CACHE_EXPIRY_HOURS * 60 * 60 * 1000 &&
          cached.owners !== null &&
          cached.wanters !== null;

        if (isValid) {
          updateCardStats(cardId, {
            owners: cached.owners,
            wanters: cached.wanters,
          });
        } else {
          pendingIds.push(cardId);
        }
      }

      // Показываем лоты, если включено
      if (config.showLots) {
        const container = getStatsContainer(card, config);
        if (!container) return;

        const cardId = extractCardId(card, config);
        if (!cardId) return;

        displayCardLots(cardId, container);
      }
    });

    // Батч-запрос к бекенду для всех некешированных карточек
    if (pendingIds.length > 0) {
      fetchCardStatsBatch(pendingIds)
        .then((results) => {
          const now = Date.now();
          pendingIds.forEach((id) => {
            const stats = results[id];
            if (stats !== undefined) {
              updateCardStats(id, {
                owners: stats.owners,
                wanters: stats.wanted,
              });
              cardStatsCache[id] = {
                owners: stats.owners,
                wanters: stats.wanted,
                timestamp: now,
              };
              // Если данные на бекенде устарели — переcчитываем в фоне и при расхождении шлём апдейт
              const updatedAtMs = stats.updated_at
                ? Date.parse(stats.updated_at)
                : 0;
              if (!updatedAtMs || now - updatedAtMs > STALE_AFTER_MS) {
                scrapeAndCompare(id, stats.owners, stats.wanted);
              }
            } else {
              // Бекенд ничего не знает о карте — парсим и шлём наблюдение
              scrapeAndSubmit(id);
            }
          });
          saveCache(CACHE_KEY, cardStatsCache);
        })
        .catch((err) => {
          console.error("[MangaBuff Stats] Backend API error:", err);
          pendingIds.forEach((id) => scrapeAndSubmit(id));
        });
    }

    console.log(
      `[MangaBuff Stats] processCards завершен за ${Date.now() - startTime}мс`,
    );
  }

  /**
   * Наблюдатель за изменениями DOM
   */
  const observer = new MutationObserver((mutations) => {
    let shouldProcessCards = false;
    let hasAttributeChange = false;

    for (const mutation of mutations) {
      // Обрабатываем добавление новых элементов
      if (mutation.addedNodes.length > 0) {
        // Проверяем, не была ли загружена вкладка с карточками или lootbox карточки
        const tabLoaded = Array.from(mutation.addedNodes).some((node) => {
          return (
            node.nodeType === 1 &&
            (node.classList?.contains("tabs__page") ||
              node.querySelector?.(".manga-cards__item") ||
              node.classList?.contains("lootbox__card") ||
              node.querySelector?.(".lootbox__card") ||
              node.classList?.contains("lootbox__list"))
          );
        });

        // Проверка на добавление карточек маркета
        const marketCardsAdded = Array.from(mutation.addedNodes).some(
          (node) => {
            return (
              node.nodeType === 1 &&
              (node.classList?.contains("market-list__cards--all") ||
                node.querySelector?.(".market-list__cards--all"))
            );
          },
        );

        if (tabLoaded || marketCardsAdded) {
          shouldProcessCards = true;
        }
      }

      // Обрабатываем удаление элементов (когда карточки заменяются)
      if (mutation.removedNodes.length > 0) {
        const lootboxRemoved = Array.from(mutation.removedNodes).some(
          (node) => {
            return (
              node.nodeType === 1 &&
              (node.classList?.contains("lootbox__card") ||
                node.querySelector?.(".lootbox__card"))
            );
          },
        );

        if (lootboxRemoved) {
          shouldProcessCards = true;
        }
      }

      // Обрабатываем изменение атрибутов карточек lootbox
      if (
        mutation.type === "attributes" &&
        mutation.attributeName === "data-id"
      ) {
        const card = mutation.target;
        if (card.classList.contains("lootbox__card")) {
          hasAttributeChange = true;

          // Удаляем старую статистику
          const oldOverlay = card.querySelector(".card-stats-overlay");
          if (oldOverlay) {
            oldOverlay.remove();
          }

          // Добавляем новую статистику
          const cardId = card.getAttribute("data-id");
          if (cardId) {
            card.style.position = "relative";
            const overlay = createStatsOverlay(cardId);
            card.appendChild(overlay);

            fetchCardStatsBatch([cardId]).then((results) => {
              const stats = results[cardId];
              if (stats !== undefined) {
                updateCardStats(cardId, {
                  owners: stats.owners,
                  wanters: stats.wanted,
                });
                const now = Date.now();
                cardStatsCache[cardId] = {
                  owners: stats.owners,
                  wanters: stats.wanted,
                  timestamp: now,
                };
                saveCache(CACHE_KEY, cardStatsCache);
                const updatedAtMs = stats.updated_at
                  ? Date.parse(stats.updated_at)
                  : 0;
                if (!updatedAtMs || now - updatedAtMs > STALE_AFTER_MS) {
                  scrapeAndCompare(cardId, stats.owners, stats.wanted);
                }
              } else {
                scrapeAndSubmit(cardId);
              }
            });
          }
        }
      }
    }

    // Обрабатываем карточки с задержкой, если были добавлены новые элементы
    if (shouldProcessCards) {
      setTimeout(processCards, 100);
    } else if (!hasAttributeChange) {
      // Если не было изменений атрибутов, обрабатываем сразу
      processCards();
    }
  });

  // Запускаем обработку после загрузки страницы
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      processCards();
      displayUserTradesCount();
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-id"],
      });
    });
  } else {
    processCards();
    displayUserTradesCount();
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-id"],
    });
  }
})();

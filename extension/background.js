function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object") {
    return {};
  }

  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      result[key] = String(value);
    }
  }
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "MB_FETCH") {
    return;
  }

  const {
    url,
    method = "GET",
    headers,
    body,
    timeout = 5000,
  } = message;

  (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: normalizeHeaders(headers),
        body,
        credentials: "include",
        signal: controller.signal,
      });

      const responseText = await response.text();
      sendResponse({
        ok: true,
        status: response.status,
        responseText,
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  })();

  return true;
});

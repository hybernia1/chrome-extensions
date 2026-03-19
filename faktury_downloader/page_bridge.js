(() => {
  function matchesDownloadUrl(url, mode) {
    if (typeof url !== "string" || !url) return false;
    const lower = url.toLowerCase();
    if (mode === "pdf") return lower.includes("pdf.alza.cz") || lower.includes(".pdf");
    return lower.includes("/attachment/") || lower.includes(".isdoc");
  }

  function findDownloadUrlInValue(value, mode) {
    if (!value) return null;
    if (typeof value === "string") return matchesDownloadUrl(value, mode) ? value : null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findDownloadUrlInValue(item, mode);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === "object") {
      for (const nested of Object.values(value)) {
        const found = findDownloadUrlInValue(nested, mode);
        if (found) return found;
      }
    }
    return null;
  }

  function emit(detail) {
    window.dispatchEvent(new CustomEvent("ALZA_PAGE_DOWNLOAD_URL_RESULT", { detail }));
  }

  window.addEventListener("ALZA_PAGE_CAPTURE_DOWNLOAD_URL", (event) => {
    const { requestId, mode, timeoutMs } = event.detail || {};
    const originalFetch = window.fetch;
    const originalOpen = window.open;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    let settled = false;

    const finish = (url) => {
      if (settled) return;
      settled = true;
      window.fetch = originalFetch;
      window.open = originalOpen;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
      XMLHttpRequest.prototype.open = originalXhrOpen;
      XMLHttpRequest.prototype.send = originalXhrSend;
      emit({ requestId, url: url || null });
    };

    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      try {
        const clone = response.clone();
        const text = await clone.text();
        finish(matchesDownloadUrl(response.url, mode) ? response.url : findDownloadUrlInValue(text, mode));
      } catch {}
      return response;
    };

    window.open = function(url, ...rest) {
      if (matchesDownloadUrl(url, mode)) finish(url);
      return originalOpen.call(this, url, ...rest);
    };

    HTMLAnchorElement.prototype.click = function(...args) {
      try {
        if (matchesDownloadUrl(this.href, mode)) finish(this.href);
      } catch {}
      return originalAnchorClick.apply(this, args);
    };

    XMLHttpRequest.prototype.open = function(...args) {
      return originalXhrOpen.apply(this, args);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener("load", function() {
        try {
          finish(findDownloadUrlInValue(this.responseText, mode));
        } catch {}
      }, { once: true });
      return originalXhrSend.apply(this, args);
    };

    setTimeout(() => finish(null), timeoutMs || 4000);
  });
})();

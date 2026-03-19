(() => {
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function matchesDownloadUrl(url, mode) {
    if (typeof url !== "string" || !url) return false;
    const lower = url.toLowerCase();
    if (mode === "pdf") return lower.includes("pdf.alza.cz") || lower.includes(".pdf");
    return lower.includes("/attachment/") || lower.includes(".isdoc") || lower.startsWith("blob:");
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

  function inferFilename(response, mode) {
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename\\*?=(?:UTF-8''|\"?)([^\";]+)/i);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1].replace(/\"/g, ""));
      } catch {
        return match[1].replace(/\"/g, "");
      }
    }
    return mode === "isdoc" ? "download.isdoc" : "download.pdf";
  }

  function looksLikeIsdocResponse(response) {
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const disposition = (response.headers.get("content-disposition") || "").toLowerCase();
    return disposition.includes(".isdoc") || disposition.includes(".isdocx") || contentType.includes("xml") || contentType.includes("octet-stream");
  }

  async function resolveBlobUrl(url, mode) {
    const response = await fetch(url);
    const blob = await response.blob();
    return {
      url,
      dataUrl: blob.size > 0 ? await blobToDataUrl(blob) : null,
      filename: mode === "isdoc" ? "download.isdoc" : "download.pdf"
    };
  }

  window.addEventListener("ALZA_PAGE_CAPTURE_DOWNLOAD_URL", (event) => {
    const { requestId, mode, timeoutMs } = event.detail || {};
    const originalFetch = window.fetch;
    const originalOpen = window.open;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      window.fetch = originalFetch;
      window.open = originalOpen;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
      XMLHttpRequest.prototype.open = originalXhrOpen;
      XMLHttpRequest.prototype.send = originalXhrSend;
      emit({ requestId, ...(payload || {}) });
    };

    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      try {
        const clone = response.clone();
        if (mode === "isdoc" && looksLikeIsdocResponse(response)) {
          const blob = await clone.blob();
          const dataUrl = blob.size > 0 ? await blobToDataUrl(blob) : null;
          finish({
            url: matchesDownloadUrl(response.url, mode) ? response.url : null,
            dataUrl,
            filename: inferFilename(response, mode)
          });
        } else {
          const text = await clone.text();
          finish({ url: matchesDownloadUrl(response.url, mode) ? response.url : findDownloadUrlInValue(text, mode) });
        }
      } catch {}
      return response;
    };

    window.open = function(url, ...rest) {
      if (matchesDownloadUrl(url, mode)) {
        if (mode === "isdoc" && typeof url === "string" && url.startsWith("blob:")) {
          resolveBlobUrl(url, mode).then(finish).catch(() => finish({ url }));
        } else {
          finish({ url });
        }
      }
      return originalOpen.call(this, url, ...rest);
    };

    HTMLAnchorElement.prototype.click = function(...args) {
      try {
        if (matchesDownloadUrl(this.href, mode)) {
          if (mode === "isdoc" && this.href.startsWith("blob:")) {
            resolveBlobUrl(this.href, mode).then(finish).catch(() => finish({ url: this.href }));
          } else {
            finish({ url: this.href });
          }
        }
      } catch {}
      return originalAnchorClick.apply(this, args);
    };

    XMLHttpRequest.prototype.open = function(...args) {
      return originalXhrOpen.apply(this, args);
    };

    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener("load", function() {
        try {
          finish({ url: findDownloadUrlInValue(this.responseText, mode) });
        } catch {}
      }, { once: true });
      return originalXhrSend.apply(this, args);
    };

    setTimeout(() => finish({ url: null }), timeoutMs || 4000);
  });
})();

// 스마트스토어센터(sell.smartstore.naver.com) MAIN world — 비즈어드바이저 API 응답 passive 캡처
// 페이지를 조작하지 않고, 페이지가 스스로 호출하는 fetch/XHR 응답만 관찰해서 content 로 전달.
(function () {
  if (window.__gpago_biz_inject__) return;
  window.__gpago_biz_inject__ = true;

  // 통계/판매성과/키워드 관련 응답만 후보로 (광고/리소스 제외)
  function looksLikeData(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return false;
    // 정적 리소스 제외
    if (/\.(js|css|png|jpe?g|gif|webp|svg|woff2?|ttf|ico|mp4)(\?|$)/.test(u)) return false;
    // 비즈어드바이저 / 통계 / 판매성과 / 키워드 / 유입 / 결제 관련
    return /bizadvisor|stat|sales|marketing|keyword|inflow|payment|performance|channel|report|trend|product/i.test(u);
  }

  function send(url, data) {
    try {
      window.postMessage({ source: 'gpago-biz-inject', type: 'BIZ_CAPTURED', url: String(url), data: data }, window.location.origin);
    } catch (_) {}
  }
  // 요청 메타(메서드/헤더/바디) 전송 — 직접 API 호출용 인증 방식 파악
  function sendReq(url, method, headers, body) {
    try {
      let abs = String(url || '');
      try { abs = new URL(abs, location.href).href; } catch (_) {} // 상대경로 → 절대 URL (background 재요청용)
      window.postMessage({ source: 'gpago-biz-inject', type: 'BIZ_REQ', url: abs, method: method || 'GET', headers: headers || {}, body: (typeof body === 'string' ? body.slice(0, 2000) : null) }, window.location.origin);
    } catch (_) {}
  }
  function _hdrToObj(h) {
    const o = {};
    try {
      if (!h) return o;
      if (typeof h.forEach === 'function') h.forEach((v, k) => { o[k] = v; });
      else if (Array.isArray(h)) h.forEach(([k, v]) => { o[k] = v; });
      else if (typeof h === 'object') Object.keys(h).forEach(k => { o[k] = h[k]; });
    } catch (_) {}
    return o;
  }

  // fetch 래핑 (관찰만)
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const init = args[1] || {};
    const p = origFetch.apply(this, args);
    if (looksLikeData(url)) {
      try { sendReq(url, init.method || (args[0] && args[0].method) || 'GET', _hdrToObj(init.headers || (args[0] && args[0].headers)), init.body); } catch (_) {}
      p.then(res => {
        try {
          res.clone().text().then(text => {
            if (!text || text.length > 4000000) return;
            const c0 = text.trimStart()[0];
            if (c0 !== '{' && c0 !== '[') return;
            try { send(url, JSON.parse(text)); } catch (_) {}
          }).catch(() => {});
        } catch (_) {}
      }).catch(() => {});
    }
    return p;
  };
  try { window.fetch.toString = () => 'function fetch() { [native code] }'; } catch (_) {}

  // XHR 래핑 (관찰만)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gpago_biz_url__ = url;
    this.__gpago_biz_method__ = method;
    this.__gpago_biz_hdrs__ = {};
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__gpago_biz_hdrs__) this.__gpago_biz_hdrs__[k] = v; } catch (_) {}
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    if (looksLikeData(xhr.__gpago_biz_url__)) {
      try { sendReq(xhr.__gpago_biz_url__, xhr.__gpago_biz_method__ || 'GET', xhr.__gpago_biz_hdrs__ || {}, body); } catch (_) {}
      xhr.addEventListener('load', function () {
        try {
          const text = xhr.responseText;
          if (!text || text.length > 4000000) return;
          const c0 = text.trimStart()[0];
          if (c0 !== '{' && c0 !== '[') return;
          send(xhr.__gpago_biz_url__, JSON.parse(text));
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log('[GPAGO biz] inject ready — passive 캡처 (비즈어드바이저 응답 관찰)');
})();

// JS Auth Trace — wrapper 복원 스크립트.
// inject.js에서 백업한 원본을 다시 prototype/슬롯에 할당.
// 누적된 __authTrace는 보존 (Stop 후에도 panel이 끝까지 splice 가능하도록).

(function () {
  if (!window.__authTraceInstalled) return 'not-installed';
  var originals = window.__authTraceOriginals || {};

  if (originals.MathRandom) Math.random = originals.MathRandom;
  if (originals.getRandomValues && window.crypto) {
    crypto.getRandomValues = originals.getRandomValues;
  }
  if (originals.subtle && window.crypto && crypto.subtle) {
    Object.keys(originals.subtle).forEach(function (m) {
      crypto.subtle[m] = originals.subtle[m];
    });
  }
  if (originals.fetch) window.fetch = originals.fetch;
  if (originals.xhrOpen && window.XMLHttpRequest) {
    XMLHttpRequest.prototype.open = originals.xhrOpen;
  }
  if (originals.xhrSend && window.XMLHttpRequest) {
    XMLHttpRequest.prototype.send = originals.xhrSend;
  }
  if (originals.btoa) window.btoa = originals.btoa;
  if (originals.atob) window.atob = originals.atob;
  if (originals.TextEncoder_encode && window.TextEncoder) {
    TextEncoder.prototype.encode = originals.TextEncoder_encode;
  }
  if (originals.TextDecoder_decode && window.TextDecoder) {
    TextDecoder.prototype.decode = originals.TextDecoder_decode;
  }
  if (originals.inputValueDesc && window.HTMLInputElement) {
    Object.defineProperty(HTMLInputElement.prototype, 'value', originals.inputValueDesc);
  }
  if (originals.formSubmit && window.HTMLFormElement) {
    HTMLFormElement.prototype.submit = originals.formSubmit;
  }
  if (originals.formSubmitListener) {
    document.removeEventListener('submit', originals.formSubmitListener, true);
  }
  if (originals.Storage_setItem && window.Storage) {
    Storage.prototype.setItem = originals.Storage_setItem;
  }
  if (originals.Storage_removeItem && window.Storage) {
    Storage.prototype.removeItem = originals.Storage_removeItem;
  }
  if (originals.Storage_clear && window.Storage) {
    Storage.prototype.clear = originals.Storage_clear;
  }
  if (originals.cookieDesc && window.Document) {
    Object.defineProperty(Document.prototype, 'cookie', originals.cookieDesc);
  }
  if (originals.pageHideHandler) {
    window.removeEventListener('pagehide', originals.pageHideHandler);
  }
  try { sessionStorage.removeItem('__authTracePending'); } catch (e) {}
  window.__authTraceCallsiteCounts = undefined;
  window.__authTraceFilterStats = undefined;

  window.__authTraceInstalled = false;
  return 'restored';
})();

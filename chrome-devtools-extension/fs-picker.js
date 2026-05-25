// DevTools++ — FS Picker / Grant Popup (top-level context)
// 패널 iframe에선 showDirectoryPicker / requestPermission 호출 불가 → 이 popup에서 호출 후 IDB 공유

const FS_DB_NAME = 'devtools-pp-fs';
const FS_DB_VERSION = 1;
const FS_DIR_STORE = 'dir-handles';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FS_DB_NAME, FS_DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(FS_DIR_STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(record) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_DIR_STORE, 'readwrite');
    tx.objectStore(FS_DIR_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(id) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_DIR_STORE, 'readonly');
    const req = tx.objectStore(FS_DIR_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const params = new URLSearchParams(window.location.search);
const action = params.get('action') || 'pick';
const dirId = params.get('dirId');
const mode = params.get('mode') || 'readwrite';

const title = document.getElementById('title');
const desc = document.getElementById('desc');
const btn = document.getElementById('action-btn');
const msg = document.getElementById('msg');

function showError(text) {
  msg.className = 'err';
  msg.textContent = text;
  btn.disabled = false;
}

function showOk(text) {
  msg.className = 'ok';
  msg.textContent = text;
}

if (action === 'grant' && dirId) {
  // ===== 권한 부여 모드 =====
  (async () => {
    const r = await idbGet(dirId);
    if (!r || !r.handle) {
      title.textContent = 'Error';
      desc.textContent = '디렉토리 핸들을 찾을 수 없습니다 (IndexedDB).';
      btn.style.display = 'none';
      return;
    }
    title.textContent = 'Grant Permission';
    desc.textContent = `"${r.name}" 디렉토리에 접근 권한을 부여하시겠어요?`;
    btn.textContent = '✓ Grant Permission';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const p = await r.handle.requestPermission({ mode });
        if (p === 'granted') {
          showOk(`✓ 권한 부여됨 (${mode}) — 잠시 후 자동 닫힘`);
          setTimeout(() => window.close(), 800);
        } else {
          showError(`권한 거부 또는 미부여: ${p}`);
        }
      } catch (e) {
        showError('실패: ' + e.message);
      }
    });
  })();
} else {
  // ===== picker 모드 (기본) =====
  btn.addEventListener('click', async () => {
    msg.className = '';
    msg.textContent = '';
    btn.disabled = true;
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const id = 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await idbPut({ id, name: handle.name, handle, addedAt: Date.now() });
      showOk(`✓ Connected: ${handle.name} — 잠시 후 자동 닫힘`);
      setTimeout(() => window.close(), 1000);
    } catch (e) {
      if (e.name === 'AbortError') {
        window.close();
      } else {
        showError('실패: ' + e.message);
      }
    }
  });
}

// ==UserScript==
// @name         NovelAI Local Panel (N-Local)
// @namespace    http://tampermonkey.net/
// @version      1.1.5
// @description  スマホ単独動作版のNovelAI設定同期ツール。サーバー不要で履歴保存・タグサジェストが可能です。
// @author       Antigravity
// @match        https://novelai.net/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/NovelAI_Local.user.js
// @downloadURL  https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/NovelAI_Local.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // === 設定 ===
    // 配信先URL（タグデータ）
    // ============================================================
    const TAGS_JSON_DANBOORU = 'https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/danbooru_tags.json';
    const TAGS_JSON_E621 = 'https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/e621_tags.json';

    // ============================================================
    // === グローバル状態 ===
    // ============================================================
    let panelOpen = false;
    let activeTab = 'history'; // 'history' or 'favorites'
    let currentPage = 1;
    let currentSearch = '';
    let LIMIT = 80;
    let historyData = [];
    
    // バッチ生成
    let batchRunning = false;
    let batchTarget = 0;
    let batchCount = 0;
    let batchOnGenerated = null; // 生成完了コールバック

    // 生成ボタンが押された回数をカウントし、手動インポートと区別する
    let _nsyncPendingGenerations = 0;

    // ブラウザセッションID (ページロード時に一意に生成)
    const CURRENT_SESSION_ID = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // サムネイル生成時にフックを迂回するためのオリジナル参照
    let _origCreateObjectURL = null;

    // ============================================================
    // === ユーティリティ ===
    const pad = n => String(n).padStart(2, '0');
    const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const showToast = (msg, type) => {
        const t = document.getElementById('nsync-toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        if (type === 'error') { t.classList.add('error'); } else { t.classList.remove('error'); }
        clearTimeout(window._nsyncToastTimer);
        window._nsyncToastTimer = setTimeout(() => t.classList.remove('show', 'error'), 3000);
    };


    // ============================================================
    // === ローカルデータベース (IndexedDB) ===
    // ============================================================
    class LocalDB {
        static db = null;
        static tagsCache = { danbooru: null, e621: null };

        static init() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open('NovelAILocalDB', 1);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains('history')) {
                        const store = db.createObjectStore('history', { keyPath: 'id' });
                        store.createIndex('session_id', 'session_id');
                        store.createIndex('created_at', 'created_at');
                    }
                    if (!db.objectStoreNames.contains('favorites')) {
                        const store = db.createObjectStore('favorites', { keyPath: 'fav_id' });
                        store.createIndex('history_id', 'history_id');
                    }
                    if (!db.objectStoreNames.contains('tags')) {
                        db.createObjectStore('tags');
                    }
                };
                req.onsuccess = (e) => {
                    this.db = e.target.result;
                    resolve();
                };
                req.onerror = () => reject(req.error);
            });
        }

        static generateId() {
            return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        }

        static addHistory(item) {
            return new Promise((resolve) => {
                const tx = this.db.transaction('history', 'readwrite');
                const store = tx.objectStore('history');
                const id = this.generateId();
                item.id = id;
                if (!item.created_at) {
                    item.created_at = new Date().toISOString();
                }
                store.add(item);
                tx.oncomplete = () => resolve(id);
            });
        }

        static getSessions(page, limit) {
            return new Promise((resolve) => {
                const tx = this.db.transaction('history', 'readonly');
                const store = tx.objectStore('history');
                const index = store.index('created_at');
                const req = index.openCursor(null, 'prev'); // 降順
                
                const sessionsMap = new Map();
                
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        const item = cursor.value;
                        const sid = item.session_id || 'unknown';
                        if (!sessionsMap.has(sid)) {
                            sessionsMap.set(sid, { session_id: sid, count: 0, latest_date: item.created_at, items: [] });
                        }
                        const s = sessionsMap.get(sid);
                        s.count++;
                        if (s.items.length < 4) s.items.push(item);
                        cursor.continue();
                    } else {
                        // pagination
                        const arr = Array.from(sessionsMap.values());
                        const total_pages = Math.ceil(arr.length / limit) || 1;
                        const start = (page - 1) * limit;
                        const data = arr.slice(start, start + limit);
                        data.forEach(s => {
                            if (s.items.length > 0) s.prompt = s.items[0].prompt;
                            s.thumbnails = s.items.map(i => i.thumbnail);
                            s.last_updated = s.latest_date;
                        });
                        
                        resolve({ data, page, limit, total_pages });
                    }
                };
            });
        }

        static searchHistory(query, page, limit) {
            return new Promise((resolve) => {
                const tx = this.db.transaction('history', 'readonly');
                const store = tx.objectStore('history');
                const index = store.index('created_at');
                const req = index.openCursor(null, 'prev');
                
                const results = [];
                const q = query.toLowerCase();
                
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        const item = cursor.value;
                        if ((item.prompt && item.prompt.toLowerCase().includes(q)) || (item.char_prompts_json && item.char_prompts_json.toLowerCase().includes(q))) {
                            results.push(item);
                        }
                        cursor.continue();
                    } else {
                        const total_pages = Math.ceil(results.length / limit) || 1;
                        const start = (page - 1) * limit;
                        resolve({ data: results.slice(start, start + limit), page, limit, total_pages });
                    }
                };
            });
        }

        static getSessionDetail(sessionId) {
            return new Promise((resolve) => {
                const tx = this.db.transaction('history', 'readonly');
                const index = tx.objectStore('history').index('session_id');
                const req = index.getAll(sessionId);
                req.onsuccess = () => {
                    const sorted = req.result.sort((a,b) => b.created_at.localeCompare(a.created_at));
                    resolve(sorted);
                };
            });
        }

        static getHistoryItem(id) {
            return new Promise((resolve) => {
                const tx = this.db.transaction('history', 'readonly');
                const req = tx.objectStore('history').get(id);
                req.onsuccess = () => resolve(req.result);
            });
        }

        static addFavorite(historyId) {
            return new Promise(async (resolve) => {
                const item = await this.getHistoryItem(historyId);
                if (!item) return resolve(null);
                
                const tx = this.db.transaction('favorites', 'readwrite');
                const id = this.generateId();
                tx.objectStore('favorites').add({
                    fav_id: id,
                    history_id: historyId,
                    label: '',
                    added_at: new Date().toISOString(),
                    ...item
                });
                tx.oncomplete = () => resolve({ fav_id: id });
            });
        }

        static removeFavorite(favId) {
            return new Promise((resolve) => {
                const tx = this.db.transaction('favorites', 'readwrite');
                tx.objectStore('favorites').delete(favId);
                tx.oncomplete = () => resolve();
            });
        }

        static clearAll() {
            return new Promise((resolve) => {
                const tx = this.db.transaction(['history', 'favorites'], 'readwrite');
                tx.objectStore('history').clear();
                tx.objectStore('favorites').clear();
                tx.oncomplete = () => resolve();
            });
        }

        static getFavorites(page, limit) {
            return new Promise((resolve) => {
                const tx = this.db.transaction('favorites', 'readonly');
                const req = tx.objectStore('favorites').openCursor(null, 'prev');
                const results = [];
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        results.push(cursor.value);
                        cursor.continue();
                    } else {
                        const total_pages = Math.ceil(results.length / limit) || 1;
                        const start = (page - 1) * limit;
                        resolve({ data: results.slice(start, start + limit), page, limit, total_pages });
                    }
                };
            });
        }

        static checkFavorite(historyId) {
            return new Promise((resolve) => {
                const tx = this.db.transaction('favorites', 'readonly');
                const index = tx.objectStore('favorites').index('history_id');
                const req = index.get(historyId);
                req.onsuccess = () => {
                    if (req.result) resolve({ is_favorite: true, fav_id: req.result.fav_id });
                    else resolve({ is_favorite: false });
                };
            });
        }

        static async loadTags(source) {
            if (this.tagsCache[source]) return this.tagsCache[source];
            
            // Check IndexedDB cache first
            const tx = this.db.transaction('tags', 'readonly');
            const req = tx.objectStore('tags').get(source);
            const cached = await new Promise(r => { req.onsuccess = () => r(req.result); });
            
            if (cached) {
                this.tagsCache[source] = cached;
                return cached;
            }
            
            // Download from URL
            showToast(`${source} のタグデータをダウンロード中...`, 'ok');
            const url = source === 'danbooru' ? TAGS_JSON_DANBOORU : TAGS_JSON_E621;
            try {
                const res = await fetch(url);
                const data = await res.json();
                
                const wTx = this.db.transaction('tags', 'readwrite');
                wTx.objectStore('tags').put(data, source);
                
                this.tagsCache[source] = data;
                showToast('タグデータをキャッシュしました', 'ok');
                return data;
            } catch (err) {
                console.error(err);
                showToast('タグのダウンロードに失敗しました', 'error');
                return [];
            }
        }

        static async searchTags(query, source) {
            const tags = await this.loadTags(source);
            const q = query.toLowerCase().replace(/ /g, '_');
            
            // tags is array of [name, post_count, category]
            const results = [];
            for (let i = 0; i < tags.length; i++) {
                if (tags[i][0].includes(q)) {
                    results.push(tags[i]);
                }
                // もしstartsWith優先などしたければここでソート条件を考える
            }
            
            // ソート: 1. 前方一致優先, 2. 投稿数降順
            results.sort((a, b) => {
                const aStarts = a[0].startsWith(q);
                const bStarts = b[0].startsWith(q);
                if (aStarts && !bStarts) return -1;
                if (!aStarts && bStarts) return 1;
                return b[1] - a[1];
            });
            
            return results.slice(0, 50).map(t => ({ name: t[0], post_count: t[1], category: t[2] }));
        }
        
        static async exportData() {
            const exportObj = { history: [], favorites: [] };
            
            await new Promise(r => {
                const req = this.db.transaction('history').objectStore('history').getAll();
                req.onsuccess = () => { exportObj.history = req.result; r(); };
            });
            await new Promise(r => {
                const req = this.db.transaction('favorites').objectStore('favorites').getAll();
                req.onsuccess = () => { exportObj.favorites = req.result; r(); };
            });
            
            const blob = new Blob([JSON.stringify(exportObj)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `nsync_local_backup_${new Date().getTime()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('バックアップをダウンロードしました', 'ok');
        }
        
        static async importData(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const data = JSON.parse(e.target.result);
                        if (!data.history || !data.favorites) throw new Error("無効なバックアップファイルです");
                        
                        const tx = this.db.transaction(['history', 'favorites'], 'readwrite');
                        const hStore = tx.objectStore('history');
                        const fStore = tx.objectStore('favorites');
                        
                        // Clear existing
                        hStore.clear();
                        fStore.clear();
                        
                        data.history.forEach(item => hStore.add(item));
                        data.favorites.forEach(item => fStore.add(item));
                        
                        tx.oncomplete = () => {
                            showToast('データを復元しました！リロードしてください。', 'ok');
                            resolve();
                        };
                    } catch (err) {
                        showToast('復元に失敗: ' + err.message, 'error');
                        reject(err);
                    }
                };
                reader.readAsText(file);
            });
        }
    }

    // === スタイル注入 ===
    // ============================================================
    function injectStyles() {
        if (document.getElementById('nsync-styles')) return;
        const style = document.createElement('style');
        style.id = 'nsync-styles';
        style.textContent = `
        /* ─── タブボタン ─── */
        #nsync-tab {
            position: fixed; right: 0; top: 50%; transform: translateY(-50%);
            z-index: 99998; background: #1a1025;
            color:#9d7fd4; writing-mode:vertical-rl; padding:14px 7px;
            font-size:12px; font-weight:600; letter-spacing:0.06em;
            border-radius:6px 0 0 6px; cursor:pointer; user-select:none;
            touch-action: none; /* スマホのスクロールを無効化してドラッグを維持 */
            box-shadow:-2px 0 12px rgba(0,0,0,0.5);
            border:1px solid #2d2040; border-right:none;
            transition:background 0.2s,color 0.2s; font-family:'Segoe UI',sans-serif;
        }
        #nsync-tab:hover { background:#231535; color:#c4a8e8; }

        /* ─── メインパネル ─── */
        #nsync-panel {
            position:fixed; top:0; right:-55vw;
            width:min(340px,50vw);
            height:100vh; height:100dvh; z-index:99999;
            background:#12101a;
            border-left:1px solid #2d2040;
            display:flex; flex-direction:column;
            transition:right 0.3s cubic-bezier(0.4,0,0.2,1);
            box-shadow:-6px 0 24px rgba(0,0,0,0.7);
            font-family:'Segoe UI','Hiragino Sans',sans-serif;
        }
        #nsync-panel.open { right:0; }

        /* スマホ: 画面幋50%の右半分に和える */
        @media (max-width:768px) {
            #nsync-panel { width:50vw; right:-50vw; }
            #nsync-panel.open { right:0; }
            #nsync-tab { font-size:11px; padding:12px 6px; }
        }

        /* ─── ヘッダー ─── */
        #nsync-header {
            display:flex; align-items:center; justify-content:space-between;
            padding:8px 12px; background:#1a1025;
            border-bottom:1px solid #2d2040; flex-shrink:0;
        }
        #nsync-header-title { font-size:13px; font-weight:600; color:#9d7fd4; }
        #nsync-status { font-size:10px; color:#4a4060; margin-right:6px; }
        #nsync-status.ok { color:#5a9e7a; }
        #nsync-close {
            background:none; border:none; color:#5a5070; font-size:18px;
            cursor:pointer; padding:2px 5px; line-height:1; border-radius:4px;
        }
        #nsync-close:hover { background:#2d2040; color:#c4a8e8; }

        /* ─── タブ ─── */
        #nsync-tabs {
            display:flex; border-bottom:1px solid #2d2040; flex-shrink:0;
            background:#0e0c16;
        }
        .nsync-tab-btn {
            flex:1; padding:7px; font-size:11px; font-weight:600;
            cursor:pointer; color:#5a5070; border:none; background:none;
            border-bottom:2px solid transparent; transition:all 0.2s;
            font-family:'Segoe UI',sans-serif;
        }
        .nsync-tab-btn.active { color:#9d7fd4; border-bottom-color:#6e40c9; }
        .nsync-tab-btn:hover { background:#1a1025; }

        /* ─── 検索バー ─── */
        #nsync-search-bar {
            padding:7px 10px; background:#0e0c16;
            border-bottom:1px solid #2d2040; flex-shrink:0;
        }
        #nsync-search-input {
            width:100%; box-sizing:border-box; background:#0a0910;
            border:1px solid #2d2040; border-radius:5px;
            color:#c4a8e8; padding:5px 8px; font-size:11px;
            font-family:'Segoe UI',sans-serif; outline:none;
            transition:border-color 0.2s;
        }
        #nsync-search-input:focus { border-color:#6e40c9; }
        #nsync-search-hint { font-size:9px; color:#2d2040; margin-top:2px; padding:0 2px; }

        /* ─── リスト ─── */
        #nsync-list-container { flex:1; overflow-y:auto; overflow-x:hidden; }
        #nsync-list-container::-webkit-scrollbar { width:3px; }
        #nsync-list-container::-webkit-scrollbar-thumb { background:#2d2040; border-radius:2px; }

        /* リストアイテム: タイムスタンプ + サムネ + 星のみ */
        .nsync-item {
            display:flex; align-items:center; padding:6px 10px;
            border-bottom:1px solid #1a1025; cursor:pointer;
            transition:background 0.15s; gap:8px; position:relative;
        }
        .nsync-item:hover { background:#1a1025; }
        .nsync-item-new { background:#160e28; border-left:2px solid #6e40c9; }
        .nsync-item-datetime {
            font-size:10px; color:#7a5fa8; font-family:'Consolas',monospace;
            white-space:nowrap; flex-shrink:0; line-height:1.5;
        }
        .nsync-item-date { display:block; font-size:9px; color:#4a3a6a; }
        .nsync-item-time { display:block; font-size:11px; font-weight:600; }
        .nsync-thumbnail {
            display:block; width:48px; height:48px; object-fit:cover;
            border-radius:4px; border:1px solid #2d2040; flex-shrink:0;
            cursor:pointer; transition:border-color 0.2s,transform 0.15s;
            background:#0a0910;
        }
        .nsync-thumbnail:hover { border-color:#9d7fd4; transform:scale(1.05); }
        .nsync-item-spacer { flex:1; }
        .nsync-fav-star {
            flex-shrink:0; font-size:15px; background:none; border:none; cursor:pointer;
            color:#5a5070; padding:0 2px; transition:color 0.2s; line-height:1;
        }
        .nsync-fav-star.on { color:#c9a227; }

        /* ─── フッター ─── */
        #nsync-footer {
            padding:6px 10px;
            padding-bottom: calc(6px + env(safe-area-inset-bottom));
            background:#0e0c16;
            border-top:1px solid #2d2040;
            display:flex; align-items:center; justify-content:space-between; flex-shrink:0;
        }
        .nsync-page-btn {
            background:#1a1025; border:1px solid #2d2040; color:#7a5fa8;
            padding:3px 8px; font-size:10px; border-radius:4px; cursor:pointer;
        }
        .nsync-page-btn:hover { background:#231535; }
        .nsync-page-btn:disabled { opacity:0.3; cursor:not-allowed; }
        #nsync-page-info { font-size:10px; color:#4a3a6a; }

        /* ─── バッチ生成バー ─── */
        #nsync-batch-bar {
            padding:8px 10px; background:#0e0c16;
            border-top:1px solid #2d2040; flex-shrink:0;
        }
        #nsync-batch-row {
            display:flex; align-items:center; gap:6px;
        }
        #nsync-batch-label {
            font-size:10px; color:#7a5fa8; white-space:nowrap; font-weight:600;
        }
        #nsync-batch-input {
            width:48px; background:#0a0910; border:1px solid #2d2040;
            border-radius:4px; color:#c4a8e8; padding:4px 6px;
            font-size:12px; text-align:center; font-family:'Consolas',monospace;
            outline:none;
        }
        #nsync-batch-input:focus { border-color:#6e40c9; }
        #nsync-batch-btn {
            flex:1; padding:5px 10px; font-size:11px; font-weight:600;
            border-radius:4px; cursor:pointer; border:1px solid #2d2040;
            transition:all 0.2s; font-family:'Segoe UI',sans-serif;
        }
        #nsync-batch-btn.start {
            background:linear-gradient(135deg,#1a6e40,#0e4a2a); color:#7aefa8;
            border-color:#2d6040;
        }
        #nsync-batch-btn.start:hover { filter:brightness(1.2); }
        #nsync-batch-btn.stop {
            background:linear-gradient(135deg,#6e1a25,#4a0e15); color:#ef7a8a;
            border-color:#602d35;
        }
        #nsync-batch-btn.stop:hover { filter:brightness(1.2); }
        #nsync-batch-progress {
            font-size:10px; color:#4a3a6a; white-space:nowrap;
            font-family:'Consolas',monospace;
        }
        #nsync-batch-progress.active { color:#7aefa8; }

        /* ─── デバッグバー ─── */
        #nsync-debug-bar {
            padding:4px 8px; border-top:1px solid #1a1025;
        }
        #nsync-diagnose-btn {
            width:100%; background:#0e0c16; border:1px solid #2d2040;
            color:#3a3050; padding:4px 6px; font-size:10px;
            border-radius:4px; cursor:pointer;
        }
        #nsync-diagnose-btn:hover { color:#7a5fa8; border-color:#3d2960; }

        /* ─── 詳細ポップアップ ─── */
        #nsync-overlay {
            position:fixed; inset:0; background:rgba(0,0,0,0.82); z-index:100000;
            display:flex; align-items:center; justify-content:center;
            backdrop-filter:blur(4px);
        }
        #nsync-detail-box {
            background:#12101a; border:1px solid #2d2040; border-radius:10px;
            width:90%; max-width:640px; max-height:88vh; overflow-y:auto;
            box-shadow:0 20px 60px rgba(0,0,0,0.9);
            font-family:'Segoe UI',sans-serif;
        }
        #nsync-detail-box::-webkit-scrollbar { width:3px; }
        #nsync-detail-box::-webkit-scrollbar-thumb { background:#2d2040; border-radius:2px; }
        .nsync-dh {
            display:flex; align-items:center; justify-content:space-between;
            padding:12px 16px; border-bottom:1px solid #2d2040;
            position:sticky; top:0; background:#12101a; z-index:1;
        }
        .nsync-dh h3 { margin:0; font-size:12px; color:#9d7fd4; font-weight:600; }
        .nsync-dh button { background:none; border:none; color:#5a5070; font-size:18px; cursor:pointer; }
        .nsync-db { padding:14px 16px; }
        .nsync-ds { margin-bottom:12px; }
        .nsync-dl { font-size:9px; font-weight:600; letter-spacing:0.1em; color:#6e40c9; text-transform:uppercase; margin-bottom:3px; }
        .nsync-dv {
            background:#0a0910; border:1px solid #2d2040; border-radius:5px;
            padding:8px 10px; font-size:11px; color:#c4a8e8;
            line-height:1.6; white-space:pre-wrap; word-break:break-all; min-height:28px;
        }
        .nsync-dv.char { border-color:#3d1f6e; background:#0e0820; }
        .nsync-params { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
        .nsync-param { background:#0a0910; border:1px solid #2d2040; border-radius:5px; padding:6px 8px; }
        .nsync-param-n { font-size:9px; color:#4a3a6a; text-transform:uppercase; letter-spacing:0.08em; }
        .nsync-param-v { font-size:12px; font-weight:600; color:#c4a8e8; margin-top:2px; font-family:'Consolas',monospace; }
        .nsync-df {
            padding:12px 16px; border-top:1px solid #2d2040; display:flex; gap:8px;
            justify-content:flex-end; position:sticky; bottom:0; background:#12101a;
        }
        .nsync-btn-apply {
            background:linear-gradient(135deg,#6e40c9,#4a1d8a); color:#fff; border:none;
            padding:8px 18px; font-size:12px; font-weight:600; border-radius:5px; cursor:pointer;
        }
        .nsync-btn-apply:hover { filter:brightness(1.2); }
        .nsync-btn-fav {
            background:#1a1025; border:1px solid #2d2040; color:#c9a227;
            padding:8px 12px; font-size:12px; border-radius:5px; cursor:pointer;
        }
        .nsync-btn-cancel {
            background:#1a1025; color:#5a5070; border:1px solid #2d2040;
            padding:8px 14px; font-size:12px; border-radius:5px; cursor:pointer;
        }
        .nsync-btn-cancel:hover { background:#231535; }

        /* ─── セッション画像グリッド ─── */
        #nsync-grid-overlay {
            position:fixed; inset:0; background:rgba(6,4,12,0.96); z-index:200000;
            display:flex; flex-direction:column; font-family:'Segoe UI','Hiragino Sans',sans-serif;
        }
        #nsync-grid-header {
            display:flex; align-items:center; justify-content:space-between;
            padding:12px 16px; background:#0e0c16; border-bottom:1px solid #2d2040;
            flex-shrink:0;
        }
        #nsync-grid-title { font-size:14px; font-weight:700; color:#9d7fd4; }
        #nsync-grid-count { font-size:11px; color:#4a3a6a; margin-left:8px; }
        #nsync-grid-close {
            background:none; border:1px solid #2d2040; color:#7a5fa8;
            padding:6px 14px; font-size:12px; border-radius:5px; cursor:pointer;
        }
        #nsync-grid-close:hover { background:#1a1025; color:#c4a8e8; }
        #nsync-grid-body {
            flex:1; overflow-y:auto; padding:8px;
            display:flex; flex-wrap:wrap; align-content:flex-start;
        }
        #nsync-grid-body::-webkit-scrollbar { width:4px; }
        #nsync-grid-body::-webkit-scrollbar-thumb { background:#2d2040; border-radius:2px; }
        .nsync-grid-item {
            position:relative; overflow:hidden;
            border-radius:6px; border:1px solid #1a1025; cursor:pointer;
            transition:border-color 0.2s, transform 0.15s;
            background:#0a0910;
            display:block;
            width: calc(20% - 4.8px); /* 5 columns on PC */
            margin-right: 6px;
            margin-bottom: 6px;
        }
        .nsync-grid-item:nth-child(5n) { margin-right:0; }
        .nsync-grid-item::before {
            content:""; display:block; padding-top:133.33%; /* 3:4 aspect ratio */
        }
        .nsync-grid-item:hover { border-color:#6e40c9; transform:scale(1.03); z-index:1; }
        .nsync-grid-item img {
            position:absolute; top:0; left:0;
            width:100%; height:100%; object-fit:contain; display:block;
        }
        .nsync-grid-item-idx {
            position:absolute; top:4px; left:4px; background:rgba(0,0,0,0.7);
            color:#9d7fd4; font-size:9px; padding:1px 5px; border-radius:3px;
            font-family:'Consolas',monospace;
        }
        /* グリッド ライトボックス */
        #nsync-grid-lightbox {
            position:fixed; inset:0; background:rgba(0,0,0,0.92); z-index:200001;
            display:flex; align-items:center; justify-content:center; cursor:zoom-out;
        }
        #nsync-grid-lightbox img {
            max-width:95vw; max-height:95vh; object-fit:contain;
            border-radius:8px; border:1px solid #2d2040;
        }
        @media (max-width:768px) {
            #nsync-grid-body {
                padding:4px;
            }
            .nsync-grid-item {
                width: calc(25% - 3px); /* 4 columns on mobile */
                margin-right: 4px;
                margin-bottom: 4px;
            }
            .nsync-grid-item:nth-child(5n) { margin-right: 4px; } /* リセット */
            .nsync-grid-item:nth-child(4n) { margin-right: 0; }
        }

        /* ─── トースト ─── */
        #nsync-toast {
            position:fixed; bottom:20px; left:50%;
            transform:translateX(-50%) translateY(20px);
            background:#1a1025; border:1px solid #6e40c9; color:#c4a8e8;
            padding:8px 18px; border-radius:7px; font-size:12px; font-weight:500;
            z-index:100001; opacity:0; transition:opacity 0.3s,transform 0.3s;
            pointer-events:none; font-family:'Segoe UI',sans-serif; white-space:nowrap;
        }
        #nsync-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }

        /* セッションフォルダグリッド */
        .nsync-session-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; padding: 14px; }
        .nsync-folder { background: #1a1025; border: 1px solid #2d2040; border-radius: 8px; cursor: pointer; overflow: hidden; transition: all 0.2s; display: flex; flex-direction: column; }
        .nsync-folder:hover { border-color: #7a5fa8; background: #231535; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
        .nsync-folder-thumbs { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; aspect-ratio: 1; background: #0e0c16; gap: 1px; }
        .nsync-folder-thumbs img { width: 100%; height: 100%; object-fit: cover; }
        .nsync-folder-thumbs .empty-thumb { background: #151020; width: 100%; height: 100%; }
        .nsync-folder-info { padding: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #a58ebb; background: #1f142e; border-top: 1px solid #2d2040; border-bottom: 1px solid #2d2040; }
        .nsync-folder-count { font-weight: bold; color: #fff; background: #6e40c9; padding: 2px 6px; border-radius: 10px; font-size: 10px; }
        .nsync-folder-time { opacity: 0.8; }
        .nsync-folder-prompt { padding: 8px; font-size: 10px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        
        /* セッション内画像グリッド */
        .nsync-detail-grid-header { padding: 10px 14px; background: #1a1025; border-bottom: 1px solid #2d2040; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 10; }
        .nsync-back-btn { background: #2d2040; border: none; color: #c4a8e8; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; transition: background 0.2s; font-family:'Segoe UI',sans-serif; }
        .nsync-back-btn:hover { background: #3d2960; color: #fff; }
        .nsync-detail-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; padding: 10px; }
        @media (min-width: 600px) { .nsync-detail-grid { grid-template-columns: repeat(4, 1fr); } }
        .nsync-detail-item { position: relative; aspect-ratio: 1; border-radius: 6px; overflow: hidden; cursor: pointer; background: #0e0c16; border: 1px solid #2d2040; transition: border-color 0.2s; }
        .nsync-detail-item:hover { border-color: #6e40c9; }
        .nsync-detail-item img { width: 100%; height: 100%; object-fit: contain; display: block; }
        .nsync-detail-fav { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,0.7); border: 1px solid #2d2040; color: #777; width: 26px; height: 26px; border-radius: 50%; font-size: 14px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s; }
        .nsync-detail-fav:hover { background: rgba(0,0,0,0.9); color: #fff; border-color: #555; }
        .nsync-detail-fav.on { color: #fbbf24; border-color: #fbbf24; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    // ============================================================
    // === UI 構築 ===
    // ============================================================
    function buildUI() {
        if (document.getElementById('nsync-panel')) return;

        // タブボタン（絵文字なし）
        const tab = document.createElement('div');
        tab.id = 'nsync-tab';
        tab.textContent = '履歴';
        document.body.appendChild(tab);

        // --- タブのドラッグ＆クリック判定 ---
        const savedTop = localStorage.getItem('nsync-tab-pos');
        if (savedTop) tab.style.top = savedTop;

        let dragStartY = 0;
        let dragStartTop = 0;
        let isDragging = false;

        tab.addEventListener('pointerdown', (e) => {
            isDragging = false;
            dragStartY = e.clientY;
            const rect = tab.getBoundingClientRect();
            // transform: translateY(-50%) がかかっているため、中央位置を計算する
            dragStartTop = rect.top + rect.height / 2;
            tab.setPointerCapture(e.pointerId);
            e.preventDefault(); // テキスト選択などを防止
        });

        tab.addEventListener('pointermove', (e) => {
            if (!tab.hasPointerCapture(e.pointerId)) return;
            const deltaY = e.clientY - dragStartY;
            if (Math.abs(deltaY) > 5) { // 5px 以上動かしたらドラッグと判定
                isDragging = true;
                let newTop = dragStartTop + deltaY;
                // 画面外にはみ出ないように制御
                newTop = Math.max(tab.offsetHeight / 2, Math.min(newTop, window.innerHeight - tab.offsetHeight / 2));
                tab.style.top = `${newTop}px`;
            }
        });

        tab.addEventListener('pointerup', (e) => {
            tab.releasePointerCapture(e.pointerId);
            if (isDragging) {
                localStorage.setItem('nsync-tab-pos', tab.style.top); // 最後にドロップした位置を記憶
            } else {
                togglePanel(); // ドラッグしていなければクリック（開閉）
            }
        });

        // --- パネル外クリックで閉じる ---
        document.addEventListener('pointerdown', (e) => {
            if (panelOpen) {
                const panelEl = document.getElementById('nsync-panel');
                const overlayEl = document.getElementById('nsync-overlay');
                const diagEl = document.getElementById('nsync-diag-overlay');
                
                // パネル自体、タブ、または詳細・診断ポップアップが押された場合は閉じない
                if (panelEl && !panelEl.contains(e.target) && 
                    tab && !tab.contains(e.target) &&
                    (!overlayEl || !overlayEl.contains(e.target)) &&
                    (!diagEl || !diagEl.contains(e.target))) {
                    togglePanel();
                }
            }
        });

        // パネル本体
        const panel = document.createElement('div');
        panel.id = 'nsync-panel';
        panel.innerHTML = `
            <div id="nsync-header">
                <div id="nsync-header-title">N-Sync</div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span id="nsync-status">● 切断</span>
                    <button id="nsync-close">✕</button>
                </div>
            </div>
            <div id="nsync-tabs">
                <button class="nsync-tab-btn active" data-tab="history">📜 履歴</button>
                <button class="nsync-tab-btn" data-tab="favorites">⭐ お気に入り</button>
            </div>
            <div id="nsync-search-bar">
                <input id="nsync-search-input" type="text" placeholder="プロンプト検索... (* はワイルドカード)" />
                <div id="nsync-search-hint">例: 1girl * solo　で「1girl」〜「solo」の間に何でも入るプロンプト</div>
            </div>
            <div id="nsync-list-container"></div>
            <div id="nsync-footer">
                <button class="nsync-page-btn" id="nsync-prev">◀ 前へ</button>
                <span id="nsync-page-info">-</span>
                <button class="nsync-page-btn" id="nsync-next">次へ ▶</button>
            </div>
            <div id="nsync-batch-bar">
                <div id="nsync-batch-row">
                    <span id="nsync-batch-label">🔄 連続生成</span>
                    <input id="nsync-batch-input" type="number" min="1" max="999" value="10" />
                    <button id="nsync-batch-btn" class="start">▶ 開始</button>
                    <span id="nsync-batch-progress"></span>
                </div>
            </div>
            <div id="nsync-debug-bar" style="padding:6px 10px;border-top:1px solid #2a2a3a;display:flex;gap:6px;">
                <button id="nsync-grid-btn" style="flex:1;background:#1a1025;border:1px solid #2d2040;color:#7a5fa8;padding:5px 8px;font-size:11px;border-radius:4px;cursor:pointer;font-weight:600;" title="セッション中に生成した画像をグリッドで一覧表示">🖼 グリッド表示</button>
                <button id="nsync-backup-btn" style="flex:1;background:#1a1025;border:1px solid #2d2040;color:#7a5fa8;padding:5px 8px;font-size:11px;border-radius:4px;cursor:pointer;font-weight:600;" title="履歴のバックアップ/復元">💾 データ管理</button>
                <!-- <button id="nsync-diagnose-btn" style="flex:1;background:#1e1e30;border:1px solid #3a3a5a;color:#888;padding:5px 8px;font-size:11px;border-radius:4px;cursor:pointer;" title="画面内のfile inputを全件調査してモバイル対応セレクタを特定します">🔍 診断</button> -->
            </div>
        `;
        document.body.appendChild(panel);

        // トースト
        const toast = document.createElement('div');
        toast.id = 'nsync-toast';
        document.body.appendChild(toast);

        // イベント設定
        panel.querySelector('#nsync-close').addEventListener('click', togglePanel);
        panel.querySelector('#nsync-prev').addEventListener('click', () => loadList(currentPage - 1));
        panel.querySelector('#nsync-next').addEventListener('click', () => loadList(currentPage + 1));

        // タブ切り替え
        panel.querySelectorAll('.nsync-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                panel.querySelectorAll('.nsync-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activeTab = btn.dataset.tab;
                currentPage = 1;
                currentSearch = '';
                panel.querySelector('#nsync-search-input').value = '';
                // お気に入りタブでは検索バーを隠す
                panel.querySelector('#nsync-search-bar').style.display = activeTab === 'history' ? '' : 'none';
                loadList(1);
            });
        });

        // 検索
        let searchTimer;
        panel.querySelector('#nsync-search-input').addEventListener('input', e => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                currentSearch = e.target.value;
                currentPage = 1;
                loadList(1);
            }, 400);
        });

        // 診断ボタン
        // panel.querySelector('#nsync-diagnose-btn').addEventListener('click', inspectFileInputs);

        // バッチ生成
        panel.querySelector('#nsync-batch-btn').addEventListener('click', toggleBatchGeneration);

        // グリッドビュー
        
        panel.querySelector('#nsync-grid-btn').addEventListener('click', showSessionGrid);
        
        panel.querySelector('#nsync-backup-btn').addEventListener('click', () => {
            document.getElementById('nsync-overlay')?.remove();
            const overlay = document.createElement('div');
            overlay.id = 'nsync-overlay';
            overlay.innerHTML = `
                <div id="nsync-detail-box" style="width:300px; padding:20px; text-align:center;">
                    <h3 style="color:#9d7fd4;margin-top:0;">💾 ローカルデータ管理</h3>
                    <p style="font-size:11px;color:#888;margin-bottom:20px;text-align:left;">
                        スマホ単独版では画像履歴はブラウザ内部に保存されます。キャッシュクリア等で消える前にZIP形式(JSON)でエクスポートして保護してください。
                    </p>
                    <button id="nsync-do-export" style="width:100%;padding:10px;margin-bottom:10px;background:#6e40c9;color:#fff;border:none;border-radius:5px;cursor:pointer;">📥 バックアップをダウンロード</button>
                    
                    <div style="border-top:1px solid #2d2040; margin:15px 0;"></div>
                    
                    <label style="display:block;width:100%;padding:10px;background:#1a1025;color:#8ccf6a;border:1px solid #2d2040;border-radius:5px;cursor:pointer;box-sizing:border-box;margin-bottom:10px;">
                        👁️ バックアップをプレビュー
                        <input type="file" id="nsync-do-preview" accept=".json" style="display:none;">
                    </label>
                    <div style="border-top:1px solid #2d2040; margin:15px 0;"></div>
                    <button id="nsync-do-clear" style="width:100%;padding:10px;background:#1a1025;color:#e55;border:1px solid #3a1515;border-radius:5px;cursor:pointer;">🗑 ブラウザが保持している履歴を消去</button>
                    
                    <button id="nsync-close-backup" style="margin-top:15px;background:none;border:none;color:#888;cursor:pointer;">閉じる</button>
                </div>
            `;
            document.body.appendChild(overlay);
            
            document.getElementById('nsync-close-backup').addEventListener('click', () => overlay.remove());
            document.getElementById('nsync-do-export').addEventListener('click', () => LocalDB.exportData());
            document.getElementById('nsync-do-preview').addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    previewBackup(e.target.files[0]);
                    overlay.remove();
                }
            });
            document.getElementById('nsync-do-clear').addEventListener('click', () => {
                if (confirm('ブラウザが保持している全履歴とお気に入りを消去します。本当によろしいですか？（ダウンロード済みのバックアップファイルは消えません）')) {
                    LocalDB.clearAll().then(() => {
                        showToast('すべての履歴を消去しました', 'ok');
                        if (activeTab !== 'backup_preview') loadList(1);
                        overlay.remove();
                    });
                }
            });
        });

        
        // オートコンプリート初期化
        initAutocomplete();
        // 十字キーUI初期化
        initDpad();
    }

    // ============================================================
    // === 共通ユーティリティ関数 ===
    // ============================================================
    function getAbsoluteOffset(container, node, offset) {
        try {
            const targetRange = document.createRange();
            targetRange.setStart(node, offset);
            targetRange.collapse(true);

            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
            let currentOffset = 0;

            while (walker.nextNode()) {
                const currentTextNode = walker.currentNode;
                if (currentTextNode === node) {
                    return currentOffset + offset;
                }
                const textRange = document.createRange();
                textRange.selectNodeContents(currentTextNode);
                
                if (targetRange.compareBoundaryPoints(Range.START_TO_START, textRange) <= 0) {
                    return currentOffset;
                }
                currentOffset += currentTextNode.textContent.length;
            }
            return currentOffset;
        } catch (e) {
            return 0;
        }
    }

    function getAbsoluteRange(container, startIdx, endIdx) {
        const range = document.createRange();
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
        
        let currentOffset = 0;
        let startNode = null, startNodeOffset = 0;
        let endNode = null, endNodeOffset = 0;
        
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const len = node.textContent.length;
            
            if (!startNode && startIdx <= currentOffset + len) {
                startNode = node;
                startNodeOffset = startIdx - currentOffset;
            }
            if (!endNode && endIdx <= currentOffset + len) {
                endNode = node;
                endNodeOffset = endIdx - currentOffset;
                break;
            }
            currentOffset += len;
        }
        
        if (startNode && endNode) {
            range.setStart(startNode, startNodeOffset);
            range.setEnd(endNode, endNodeOffset);
        } else if (startNode) {
            range.setStart(startNode, startNodeOffset);
            range.setEnd(startNode, startNode.textContent.length);
        }
        return range;
    }

    function getFullText(container) {
        let text = '';
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
        while (walker.nextNode()) text += walker.currentNode.textContent;
        return text;
    }

    function findEnclosingWeightBlock(fullText, offset) {
        const regex = /[\-－−‐]?[0-9.]+::.*?::/g;
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            if (offset >= start && offset <= end) {
                return { start, end };
            }
        }
        return null;
    }

    // ============================================================
    // === Danbooru/e621タグ オートコンプリート ===
    // ============================================================
    let acPopup = null;
    let acSuggestions = [];
    let acSelectedIndex = -1;
    let acCurrentQuery = '';
    let acPrefix = '';
    let acFullTypedWord = '';
    let acActivePm = null;
    let acAbsStart = 0;
    let acAbsEnd = 0;
    let acSource = localStorage.getItem('nsync-tag-source') || 'danbooru'; // 'danbooru' or 'e621'

    function initAutocomplete() {
        const style = document.createElement('style');
        style.textContent = `
            .nsync-ac-popup {
                position: absolute; z-index: 999999;
                background: #110d18; border: 1px solid #2d2040; border-radius: 6px;
                box-shadow: 0 4px 15px rgba(0,0,0,0.7); width: 320px;
                max-height: 280px; font-family: 'Inter', sans-serif;
                display: none; flex-direction: column;
            }
            .nsync-ac-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 6px 12px; background: #1a1025; border-bottom: 1px solid #2d2040;
                border-radius: 6px 6px 0 0;
            }
            .nsync-ac-toggle { display: flex; gap: 4px; }
            .nsync-ac-toggle button {
                background: #2d2040; border: none; color: #9d7fd4;
                padding: 4px 8px; font-size: 11px; border-radius: 4px; cursor: pointer;
            }
            .nsync-ac-toggle button.active {
                background: #6e40c9; color: #fff;
            }
            .nsync-ac-list {
                flex: 1; overflow-y: auto;
            }
            .nsync-ac-list::-webkit-scrollbar { width:4px; }
            .nsync-ac-list::-webkit-scrollbar-thumb { background:#2d2040; border-radius:2px; }
            .nsync-ac-item {
                padding: 6px 12px; cursor: pointer; display: flex; justify-content: space-between;
                align-items: center; font-size: 13px; border-bottom: 1px solid #1a1025; font-family: monospace;
            }
            .nsync-ac-item.selected, .nsync-ac-item:hover { background: #2d2040; }
            .nsync-ac-cat-0 { color: #d1c4e9; } /* General */
            .nsync-ac-cat-1 { color: #ff8a65; } /* Artist */
            .nsync-ac-cat-3 { color: #f06292; } /* Copyright */
            .nsync-ac-cat-4 { color: #81c784; } /* Character */
            .nsync-ac-cat-5 { color: #f48fb1; } /* Species (e621) / Meta */
            .nsync-ac-cat-8 { color: #81c784; } /* Lore (e621) */
            .nsync-ac-count { color: #7a5fa8; font-size: 11px; margin-left: auto; margin-right: 8px; }
            .nsync-ac-wiki {
                text-decoration: none; font-size: 14px; opacity: 0.6; transition: opacity 0.2s;
            }
            .nsync-ac-wiki:hover { opacity: 1; }
            .nsync-ac-empty {
                padding: 12px; text-align: center; color: #7a5fa8; font-size: 12px;
            }
        `;
        document.head.appendChild(style);

        acPopup = document.createElement('div');
        acPopup.className = 'nsync-ac-popup';
        
        // スマホやPCでポップアップ内をタップした際、プロンプト入力欄が閉じてしまう（枠外タップ判定）のを防ぐ
        const stopProp = e => e.stopPropagation();
        acPopup.addEventListener('mousedown', stopProp);
        acPopup.addEventListener('pointerdown', stopProp);
        acPopup.addEventListener('touchstart', stopProp, { passive: true });
        acPopup.addEventListener('touchend', stopProp);
        
        document.body.appendChild(acPopup);

        document.addEventListener('input', handleAcInput);
        document.addEventListener('keydown', handleAcKeydown, true);
        document.addEventListener('click', (e) => {
            if (acPopup.style.display !== 'none' && !acPopup.contains(e.target)) {
                hideAutocomplete();
            }
        });
    }

    async function handleAcInput(e) {
        if (typeof dpadInserting !== 'undefined' && dpadInserting) return;
        const pm = e.target && e.target.closest ? e.target.closest('.ProseMirror') : null;
        if (!pm) return;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return hideAutocomplete();
        
        if (!pm.contains(selection.focusNode)) return hideAutocomplete();

        // TreeWalkerを使って完全に同期されたカーソル位置とテキストを取得
        const absOffset = getAbsoluteOffset(pm, selection.focusNode, selection.focusOffset);
        const fullText = getFullText(pm);
        const text = fullText.substring(0, absOffset);
        
        const lastComma = Math.max(text.lastIndexOf(','), text.lastIndexOf('\n'));
        const currentWord = text.substring(lastComma + 1).trimStart();

        // NovelAIの重み付け構文(0.5::)や括弧({,[,()をプレフィックスとして分離
        const regex = /^((?:[\{\[\(\s]*[\-－−‐]?[0-9.]+::)?[\{\[\(\s]*)(.*)$/;
        const match = currentWord.match(regex);
        const prefix = match ? match[1] : '';
        const searchWord = match ? match[2] : currentWord;

        if (searchWord.length >= 2 && searchWord.length <= 50) {
            const query = searchWord.replace(/ /g, '_').toLowerCase();
            
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            if (rect.width !== 0 || rect.height !== 0) {
                const popupWidth = 320;
                let left = rect.x;
                // 画面右端ではみ出さないように補正
                if (left + popupWidth > window.innerWidth) {
                    left = window.innerWidth - popupWidth - 10;
                }
                if (left < 10) left = 10;
                
                acPopup.style.left = `${left}px`;
                acPopup.style.top = `${rect.y + rect.height + 5 + window.scrollY}px`;
            }

            acCurrentQuery = searchWord;
            acPrefix = prefix;
            acFullTypedWord = currentWord;
            
            acActivePm = pm;
            acAbsStart = absOffset - currentWord.length;
            acAbsEnd = absOffset;

            await fetchAndShowSuggestions(query);
        } else {
            hideAutocomplete();
        }
    }

    
    async function fetchAndShowSuggestions(query) {
        try {
            const data = await LocalDB.searchTags(query, acSource);
            showAutocomplete(data || [], query);
        } catch (err) {
            console.error('[N-Sync] Autocomplete error:', err);
        }
    }

    function showAutocomplete(items, query) {
        acSuggestions = items;
        acSelectedIndex = 0;
        acPopup.innerHTML = '';
        acPopup.style.display = 'flex';

        // ヘッダーと切り替えスイッチ
        const header = document.createElement('div');
        header.className = 'nsync-ac-header';
        header.innerHTML = `
            <span style="color:#9d7fd4;font-size:11px;font-weight:bold;">Tag Source</span>
            <div class="nsync-ac-toggle">
                <button class="${acSource === 'danbooru' ? 'active' : ''}" data-src="danbooru">Danbooru</button>
                <button class="${acSource === 'e621' ? 'active' : ''}" data-src="e621">e621</button>
            </div>
        `;
        acPopup.appendChild(header);

        // ソース切り替えイベント
        header.querySelectorAll('.nsync-ac-toggle button').forEach(btn => {
            let _toggled = false;
            // pointerdown: フォーカス喪失を防ぐ + 切り替えフラグ
            btn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                _toggled = false;
            });
            // pointerup: 実際の切り替え処理
            btn.addEventListener('pointerup', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (_toggled) return;
                _toggled = true;
                window._acSwitching = true;
                acSource = btn.dataset.src;
                localStorage.setItem('nsync-tag-source', acSource);
                if (acActivePm) acActivePm.focus();
                await fetchAndShowSuggestions(query);
                setTimeout(() => { window._acSwitching = false; }, 200);
            });
            // mousedown: デスクトップでのフォーカス喪失防止
            btn.addEventListener('mousedown', e => e.preventDefault());
        });

        const list = document.createElement('div');
        list.className = 'nsync-ac-list';

        if (items.length === 0) {
            list.innerHTML = `<div class="nsync-ac-empty">"${query}" に一致するタグがありません</div>`;
        } else {
            items.forEach((item, idx) => {
                const div = document.createElement('div');
                div.className = `nsync-ac-item nsync-ac-cat-${item.category}`;
                if (idx === 0) div.classList.add('selected');
                
                let fmtCount = item.post_count;
                if (fmtCount > 1000000) fmtCount = (fmtCount / 1000000).toFixed(1) + 'M';
                else if (fmtCount > 1000) fmtCount = (fmtCount / 1000).toFixed(1) + 'k';

                const dispName = item.name.replace(/_/g, ' ');
                const wikiUrl = acSource === 'e621' 
                    ? `https://e621.net/wiki_pages/${item.name}` 
                    : `https://danbooru.donmai.us/wiki_pages/${item.name}`;

                div.innerHTML = `
                    <div style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${dispName}</div>
                    <span class="nsync-ac-count">${fmtCount}</span>
                    <a href="${wikiUrl}" target="_blank" class="nsync-ac-wiki" title="Wikiを開く">🌐</a>
                `;
                
                // Wikiボタンのイベント停止
                const wikiBtn = div.querySelector('.nsync-ac-wiki');
                wikiBtn.addEventListener('mousedown', e => e.stopPropagation());
                wikiBtn.addEventListener('click', e => e.stopPropagation());

                div.addEventListener('mousedown', (e) => {
                    e.preventDefault(); 
                    insertSuggestion(item.name);
                });
                div.addEventListener('mouseenter', () => {
                    updateAcSelection(idx);
                });
                list.appendChild(div);
            });
        }
        
        acPopup.appendChild(list);
    }

    function hideAutocomplete() {
        if (window._acSwitching) return; // トグル切り替え中は非表示にしない
        if (acPopup) acPopup.style.display = 'none';
        acSuggestions = [];
        acSelectedIndex = -1;
    }

    function updateAcSelection(idx) {
        if (acSuggestions.length === 0) return;
        acSelectedIndex = idx;
        const items = acPopup.querySelectorAll('.nsync-ac-item');
        items.forEach((item, i) => {
            if (i === idx) {
                item.classList.add('selected');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('selected');
            }
        });
    }

    function handleAcKeydown(e) {
        if (!acPopup || acPopup.style.display === 'none') return;

        // 該当なしの場合でもEscapeで閉じられるようにする
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            hideAutocomplete();
            return;
        }

        if (acSuggestions.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            updateAcSelection((acSelectedIndex + 1) % acSuggestions.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            updateAcSelection((acSelectedIndex - 1 + acSuggestions.length) % acSuggestions.length);
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            if (acSelectedIndex >= 0 && acSelectedIndex < acSuggestions.length) {
                insertSuggestion(acSuggestions[acSelectedIndex].name);
            }
        }
    }

    function insertSuggestion(tagName) {
        if (!acActivePm) return hideAutocomplete();
        
        const fullText = getFullText(acActivePm);
        const remainder = fullText.substring(acAbsEnd);
        
        // 挿入位置の直後（スペースを挟んで）に既にコンマがある場合は、新たなコンマを追加しない
        let suffix = ', ';
        if (/^\s*,/.test(remainder)) {
            suffix = '';
        }

        // プレフィックス（重みや括弧）を復元して挿入
        const insertText = acPrefix + tagName.replace(/_/g, ' ') + suffix;
        
        const selection = window.getSelection();
        const range = getAbsoluteRange(acActivePm, acAbsStart, acAbsEnd);
        
        selection.removeAllRanges();
        selection.addRange(range);
        
        document.execCommand('insertText', false, insertText);

        hideAutocomplete();
    }

    // ============================================================
    // === 十字キー（プロンプト選択・強化UI） ===
    // ============================================================
    let dpadPopup = null;
    let dpadHighlightOverlay = null;
    let dpadStartIndex = 0;
    let dpadEndIndex = 0;
    let dpadActiveNode = null;
    let dpadTimer = null;
    let dpadInserting = false;

    function initDpad() {
        const style = document.createElement('style');
        style.textContent = `
            .nsync-dpad {
                position: absolute; z-index: 999998; display: none;
                background: rgba(17, 13, 24, 0.85);
                padding: 8px; border-radius: 12px;
                box-shadow: 0 4px 15px rgba(0,0,0,0.6);
                border: 1px solid #2d2040;
                backdrop-filter: blur(4px);
                user-select: none;
            }
            .nsync-dp-btn {
                width: 36px; height: 36px;
                display: flex; justify-content: center; align-items: center;
                color: #d1c4e9; font-size: 16px; cursor: pointer;
                border-radius: 6px; background: #2d2040; border: none;
                transition: background 0.1s; font-weight: bold;
            }
            .nsync-dp-btn:active { background: #6e40c9; color: white; }
            .nsync-dp-sub { font-size: 11px !important; }
        `;
        document.head.appendChild(style);

        dpadPopup = document.createElement('div');
        dpadPopup.className = 'nsync-dpad';
        dpadPopup.innerHTML = `
            <div style="display:grid; grid-template-columns:36px 36px 36px; gap:4px;">
                <div class="nsync-dp-btn nsync-dp-sub nsync-dpad-up05">+0.5</div>
                <div class="nsync-dp-btn nsync-dpad-up">▲</div>
                <div class="nsync-dp-btn nsync-dp-sub nsync-dpad-up1">+1.0</div>
                <div class="nsync-dp-btn nsync-dpad-left">◀</div>
                <div style="width:36px;height:36px;background:rgba(0,0,0,0.3);border-radius:4px;"></div>
                <div class="nsync-dp-btn nsync-dpad-right">▶</div>
                <div class="nsync-dp-btn nsync-dp-sub nsync-dpad-down05">-0.5</div>
                <div class="nsync-dp-btn nsync-dpad-down">▼</div>
                <div class="nsync-dp-btn nsync-dp-sub nsync-dpad-down1">-1.0</div>
            </div>
        `;
        
        const stopProp = e => { e.stopPropagation(); e.preventDefault(); };
        dpadPopup.addEventListener('mousedown', stopProp);
        dpadPopup.addEventListener('pointerdown', stopProp);
        dpadPopup.addEventListener('touchstart', stopProp, { passive: false });
        
        dpadPopup.querySelector('.nsync-dpad-up').addEventListener('pointerup', (e) => { e.preventDefault(); adjustWeight(0.1); });
        dpadPopup.querySelector('.nsync-dpad-down').addEventListener('pointerup', (e) => { e.preventDefault(); adjustWeight(-0.1); });
        dpadPopup.querySelector('.nsync-dpad-up05').addEventListener('pointerup', (e) => { e.preventDefault(); adjustWeight(0.5); });
        dpadPopup.querySelector('.nsync-dpad-down05').addEventListener('pointerup', (e) => { e.preventDefault(); adjustWeight(-0.5); });
        dpadPopup.querySelector('.nsync-dpad-up1').addEventListener('pointerup', (e) => { e.preventDefault(); adjustWeight(1.0); });
        dpadPopup.querySelector('.nsync-dpad-down1').addEventListener('pointerup', (e) => { e.preventDefault(); adjustWeight(-1.0); });
        dpadPopup.querySelector('.nsync-dpad-left').addEventListener('pointerup', (e) => { e.preventDefault(); expandSelection('left'); });
        dpadPopup.querySelector('.nsync-dpad-right').addEventListener('pointerup', (e) => { e.preventDefault(); expandSelection('right'); });

        document.body.appendChild(dpadPopup);
        
        dpadHighlightOverlay = document.createElement('div');
        dpadHighlightOverlay.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 999997;';
        document.body.appendChild(dpadHighlightOverlay);

        document.addEventListener('selectionchange', handleSelectionChange);
        document.addEventListener('input', () => { 
            if (!dpadInserting) hideDpad(); 
        });

        document.addEventListener('pointerdown', (e) => {
            // エディタ外、かつ十字キー外をタップした場合は強制的に非表示にする（画像生成ボタンタップ時など）
            if (dpadPopup.style.display !== 'none' && !dpadPopup.contains(e.target)) {
                if (!e.target.closest('.ProseMirror')) {
                    hideDpad();
                }
            }
        });
    }

    function handleSelectionChange() {
        if (dpadInserting) return;
        // ProseMirror外のフォーカス時は即リターン（高頻度イベント最適化）
        const sel0 = window.getSelection();
        if (!sel0 || !sel0.focusNode || !sel0.focusNode.parentElement?.closest('.ProseMirror')) {
            hideDpad(); return;
        }
        clearTimeout(dpadTimer);
        dpadTimer = setTimeout(() => {
            if (acPopup && acPopup.style.display !== 'none') {
                return hideDpad();
            }

            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return hideDpad();
            
            const node = sel.focusNode;
            if (!node || node.nodeType !== Node.TEXT_NODE) return hideDpad();
            
            const pm = node.parentElement ? node.parentElement.closest('.ProseMirror') : null;
            if (!pm) return hideDpad();

            dpadActiveNode = pm;
            const fullText = getFullText(pm);
            
            if (sel.isCollapsed) {
                const absOffset = getAbsoluteOffset(pm, node, sel.focusOffset);
                
                // カーソルが ::ブロック:: の中にある場合はそのブロック全体を選択
                const block = findEnclosingWeightBlock(fullText, absOffset);
                if (block) {
                    dpadStartIndex = block.start;
                    dpadEndIndex = block.end;
                } else {
                    let leftIdx = fullText.lastIndexOf(',', absOffset - 1);
                    let rightIdx = fullText.indexOf(',', absOffset);
                    
                    dpadStartIndex = leftIdx === -1 ? 0 : leftIdx + 1;
                    dpadEndIndex = rightIdx === -1 ? fullText.length : rightIdx;
                }
            } else {
                dpadStartIndex = getAbsoluteOffset(pm, sel.anchorNode, sel.anchorOffset);
                dpadEndIndex = getAbsoluteOffset(pm, sel.focusNode, sel.focusOffset);
                if (dpadStartIndex > dpadEndIndex) {
                    const t = dpadStartIndex; dpadStartIndex = dpadEndIndex; dpadEndIndex = t;
                }
            }
            
            updateDpadView();
        }, 300);
    }

    function updateDpadView() {
        if (!dpadActiveNode) return;

        // 表示条件チェック: 選択範囲のテキストが空白のみの場合は非表示
        // （最後のカンマの直後で何もタグがない場合、または「,,」の間にいる場合）
        const fullText = getFullText(dpadActiveNode);
        const selectedText = fullText.substring(dpadStartIndex, dpadEndIndex);
        
        if (selectedText.trim().length === 0) {
            return hideDpad();
        }
        
        const range = getAbsoluteRange(dpadActiveNode, dpadStartIndex, dpadEndIndex);
        
        // 実際のDOM選択はせず、フェイクのハイライトを描画する
        dpadHighlightOverlay.innerHTML = '';
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            const hl = document.createElement('div');
            hl.style.cssText = `
                position: absolute;
                left: ${r.left + window.scrollX}px;
                top: ${r.top + window.scrollY}px;
                width: ${r.width}px;
                height: ${r.height}px;
                background: rgba(110, 64, 201, 0.35);
                border-radius: 3px;
                pointer-events: none;
            `;
            dpadHighlightOverlay.appendChild(hl);
        }
        
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            dpadHighlightOverlay.innerHTML = '';
            return hideDpad();
        }

        dpadPopup.style.display = 'block';
        dpadPopup.style.left = `${Math.max(10, rect.left + rect.width / 2 - 60)}px`;
        dpadPopup.style.top = `${rect.bottom + window.scrollY + 10}px`;
    }

    function hideDpad() {
        if (dpadPopup) dpadPopup.style.display = 'none';
        if (dpadHighlightOverlay) dpadHighlightOverlay.innerHTML = '';
    }

    function expandSelection(dir) {
        if (!dpadActiveNode) return;
        const fullText = getFullText(dpadActiveNode);
        
        if (dir === 'left') {
            const startSearch = fullText[dpadStartIndex - 1] === ',' ? dpadStartIndex - 2 : dpadStartIndex - 1;
            let idx = fullText.lastIndexOf(',', startSearch);
            dpadStartIndex = idx === -1 ? 0 : idx + 1;
        } else {
            const startSearch = fullText[dpadEndIndex] === ',' ? dpadEndIndex + 1 : dpadEndIndex;
            let idx = fullText.indexOf(',', startSearch);
            dpadEndIndex = idx === -1 ? fullText.length : idx;
        }
        
        if (dpadStartIndex < 0) dpadStartIndex = 0;
        if (dpadEndIndex > fullText.length) dpadEndIndex = fullText.length;
        
        updateDpadView();
    }

    function adjustWeight(delta) {
        if (!dpadActiveNode) return;
        const fullText = getFullText(dpadActiveNode);
        const selectedText = fullText.substring(dpadStartIndex, dpadEndIndex);
        
        // マイナス（全角・各種ハイフン含む）を含む数値とカッコに対応
        const regex = /^(\s*)(?:([\-－−‐]?[0-9.]+)::)?(.*?)(?:::)?(\s*)$/;
        const match = selectedText.match(regex);
        if (!match) return;
        
        const leadSpace = match[1] || '';
        const currentWeightStr = match[2];
        const coreText = match[3] || '';
        const trailSpace = match[4] || '';
        
        let currentWeight = 1.0;
        if (currentWeightStr) {
            // 全角マイナス類を標準の半角ハイフンに置換してからパース
            const normalizedStr = currentWeightStr.replace(/^[－−‐]/, '-');
            currentWeight = parseFloat(normalizedStr);
        }
        
        let newWeight = currentWeight + delta;
        newWeight = Math.round(newWeight * 10) / 10;
        
        // 内部に存在するウェイトや閉じコロンを削除
        const cleanCore = coreText.replace(/[\-－−‐]?[0-9.]+::|::/g, '');
        
        let newTextStr = '';
        if (newWeight === 1.0) {
            newTextStr = leadSpace + cleanCore + trailSpace;
        } else {
            newTextStr = leadSpace + newWeight.toFixed(1) + '::' + cleanCore + '::' + trailSpace;
        }
        
        const range = getAbsoluteRange(dpadActiveNode, dpadStartIndex, dpadEndIndex);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        
        dpadInserting = true;
        document.execCommand('insertText', false, newTextStr);
        dpadEndIndex = dpadStartIndex + newTextStr.length;
        
        // 非同期に発火するselectionchangeイベントを無視するため、少し遅延させてからフラグを戻す
        setTimeout(() => {
            updateDpadView();
            dpadInserting = false;
        }, 50);
    }

    // ============================================================
    // === セッション画像グリッドビュー ===
    // ============================================================
    function showSessionGrid() {
        document.getElementById('nsync-grid-overlay')?.remove();

        // パネルを閉じる
        if (panelOpen) togglePanel();

        const overlay = document.createElement('div');
        overlay.id = 'nsync-grid-overlay';

        // ヘッダー
        const header = document.createElement('div');
        header.id = 'nsync-grid-header';
        header.innerHTML = `
            <div>
                <span id="nsync-grid-title">🖼 セッション画像</span>
                <span id="nsync-grid-count">読込中...</span>
            </div>
            <button id="nsync-grid-close">✕ 閉じる</button>
        `;
        overlay.appendChild(header);

        // グリッド本体
        const body = document.createElement('div');
        body.id = 'nsync-grid-body';
        body.innerHTML = '<div style="color:#7a5fa8;font-size:13px;padding:40px;text-align:center;">NovelAI IndexedDB から画像を読み込んでいます...</div>';
        overlay.appendChild(body);
        document.body.appendChild(overlay);

        // 閉じるボタン
        header.querySelector('#nsync-grid-close').addEventListener('click', () => {
            // 一時blob URLを解放
            body.querySelectorAll('img').forEach(img => {
                if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
            });
            overlay.remove();
        });

        // Escapeキーで閉じる
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                body.querySelectorAll('img').forEach(img => {
                    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
                });
                overlay.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        // NovelAI の IndexedDB から画像を読み込む
        const req = indexedDB.open('generated-images');
        req.onerror = () => {
            body.innerHTML = '<div style="color:#e55;font-size:13px;padding:40px;text-align:center;">❌ NovelAI の画像データベースを開けませんでした</div>';
        };
        req.onsuccess = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('images')) {
                body.innerHTML = '<div style="color:#e55;font-size:13px;padding:40px;text-align:center;">❌ images ストアが見つかりません</div>';
                db.close();
                return;
            }
            const tx = db.transaction('images', 'readonly');
            const store = tx.objectStore('images');
            const allReq = store.getAll();
            allReq.onsuccess = () => {
                const blobs = allReq.result;
                if (!blobs || blobs.length === 0) {
                    body.innerHTML = '<div style="color:#555;font-size:13px;padding:40px;text-align:center;">このセッションで生成された画像がまだありません</div>';
                    header.querySelector('#nsync-grid-count').textContent = '0枚';
                    db.close();
                    return;
                }
                header.querySelector('#nsync-grid-count').textContent = `${blobs.length}枚`;
                body.innerHTML = '';
                // 新しい画像を先頭に（逆順）
                blobs.reverse().forEach((blob, i) => {
                    const idx = blobs.length - i;
                    const url = (_origCreateObjectURL || URL.createObjectURL).call(URL, blob);
                    const item = document.createElement('div');
                    item.className = 'nsync-grid-item';
                    item.innerHTML = `
                        <img src="${url}" loading="lazy" alt="Generated #${idx}" />
                        <div class="nsync-grid-item-idx">#${idx}</div>
                    `;
                    item.addEventListener('click', () => openGridLightbox(url));
                    body.appendChild(item);
                });
                db.close();
            };
            allReq.onerror = () => {
                body.innerHTML = '<div style="color:#e55;font-size:13px;padding:40px;text-align:center;">❌ 画像の読み込みに失敗しました</div>';
                db.close();
            };
        };
    }

    function openGridLightbox(url) {
        document.getElementById('nsync-grid-lightbox')?.remove();

        const lb = document.createElement('div');
        lb.id = 'nsync-grid-lightbox';
        lb.innerHTML = `<img src="${url}" />`;
        lb.addEventListener('click', () => lb.remove());

        // Escapeキーで閉じる
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                lb.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(lb);
    }

    // ============================================================
    // === Input 診断ツール ===
    // ============================================================
    function inspectFileInputs() {
        document.getElementById('nsync-diag-overlay')?.remove();

        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const report = inputs.map((el, i) => {
            const getParentInfo = (el, depth) => {
                let p = el;
                const chain = [];
                for (let k = 0; k < depth; k++) {
                    p = p?.parentElement;
                    if (!p) break;
                    chain.push(`${p.tagName.toLowerCase()}${p.id ? '#'+p.id : ''}${p.className ? '.'+p.className.trim().split(/\s+/).slice(0,2).join('.') : ''}`);
                }
                return chain.join(' > ');
            };
            return {
                i,
                accept: el.accept || '(none)',
                multiple: el.multiple,
                id: el.id || '(none)',
                parents: getParentInfo(el, 4)
            };
        });

        const ov = document.createElement('div');
        ov.id = 'nsync-diag-overlay';
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:200001;display:flex;align-items:center;justify-content:center;padding:20px;';

        const box = document.createElement('div');
        box.style.cssText = 'background:#111118;border:1px solid #7c3aed;border-radius:12px;padding:20px 24px;max-width:700px;width:100%;max-height:80vh;overflow-y:auto;font-family:Consolas,monospace;';

        const title = document.createElement('div');
        title.style.cssText = 'font-size:15px;font-weight:700;color:#e2e8f0;margin-bottom:12px;';
        title.textContent = `🔍 file input 診断 (${inputs.length}件検出)`;
        box.appendChild(title);

        if (inputs.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:#e55;font-size:13px;';
            empty.textContent = '⚠ input[type="file"] が見つかりませんでした。ページが完全に読み込まれているか確認してください。';
            box.appendChild(empty);
        } else {
            report.forEach(r => {
                const item = document.createElement('div');
                item.style.cssText = 'border:1px solid #2a2a3a;border-radius:6px;padding:10px 12px;margin-bottom:8px;font-size:12px;';
                item.innerHTML = `
                    <div style="color:#a78bfa;font-weight:700;margin-bottom:4px;">[${r.i}] accept: <span style="color:#fbbf24;">${esc(r.accept)}</span>&nbsp;&nbsp;multiple: ${r.multiple}&nbsp;&nbsp;id: ${esc(r.id)}</div>
                    <div style="color:#94a3b8;word-break:break-all;">${esc(r.parents)}</div>
                `;
                box.appendChild(item);
            });
        }

        // JSONをコピーできるテキストエリア
        const pre = document.createElement('textarea');
        pre.style.cssText = 'width:100%;margin-top:12px;background:#0c0c14;color:#7dd3fc;border:1px solid #2a2a3a;border-radius:4px;padding:8px;font-size:11px;height:100px;resize:vertical;';
        pre.value = JSON.stringify(report, null, 2);
        pre.readOnly = true;
        box.appendChild(pre);

        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'margin-top:12px;background:#2a2a45;border:1px solid #3a3a5a;color:#ccc;padding:7px 18px;border-radius:6px;cursor:pointer;font-size:13px;';
        closeBtn.textContent = '閉じる';
        closeBtn.addEventListener('click', () => ov.remove());
        box.appendChild(closeBtn);

        ov.appendChild(box);
        ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
        document.body.appendChild(ov);
    }

    // ============================================================
    // === パネル開閉 ===
    // ============================================================
    function togglePanel() {
        panelOpen = !panelOpen;
        const panel = document.getElementById('nsync-panel');
        if (panelOpen) {
            panel.classList.add('open');
            if (historyData.length === 0) loadList(1);
        } else {
            panel.classList.remove('open');
        }
    }

    // ============================================================
    // === リスト読み込み（履歴 or お気に入り共通）===
    // ============================================================
    function processThumbnailData(item) {
        if (item && item.thumbnail && item.thumbnail.startsWith('{')) {
            try {
                const parsed = JSON.parse(item.thumbnail);
                item.thumbnail = parsed.image;
                item._metaB64 = parsed.meta;
            } catch(e) {}
        }
    }
    function loadList(page) {
        currentPage = page;
        const listEl = document.getElementById('nsync-list-container');
        if (!listEl) return;
        listEl.innerHTML = '<div style="color:#555;font-size:12px;padding:20px 14px;">読み込み中...</div>';

        if (window._isPreviewMode) {
            if (activeTab === 'favorites') {
                const arr = window._backupPreviewFavorites || [];
                const limit = LIMIT;
                const total = Math.ceil(arr.length / limit) || 1;
                const start = (page - 1) * limit;
                const slice = arr.slice(start, start + limit);
                document.getElementById('nsync-prev').disabled = page <= 1;
                document.getElementById('nsync-next').disabled = page >= total;
                document.getElementById('nsync-page-info').textContent = `[Preview] ${page} / ${total}`;
                
                listEl.innerHTML = '';
                slice.forEach(processThumbnailData);
                renderFavoritesList(slice);
            } else {
                const arr = window._backupPreviewSessions || [];
                const limit = LIMIT;
                const total = Math.ceil(arr.length / limit) || 1;
                const start = (page - 1) * limit;
                const slice = arr.slice(start, start + limit);
                document.getElementById('nsync-prev').disabled = page <= 1;
                document.getElementById('nsync-next').disabled = page >= total;
                document.getElementById('nsync-page-info').textContent = `[Preview] ${page} / ${total}`;
                
                renderSessionFolders(slice);
            }
            return;
        }

        if (activeTab === 'favorites') {
            loadFavorites();
            return;
        }

        if (currentSearch) {
            LocalDB.searchHistory(currentSearch, page, LIMIT).then(data => {
                historyData = data.data;
                currentPage = data.page;
                const total = data.total_pages;

                document.getElementById('nsync-prev').disabled = currentPage <= 1;
                document.getElementById('nsync-next').disabled = currentPage >= total;
                document.getElementById('nsync-page-info').textContent = `${currentPage} / ${total}`;

                listEl.innerHTML = '';
                if (historyData.length === 0) {
                    listEl.innerHTML = '<div style="color:#555;font-size:12px;padding:20px 14px;">履歴がありません</div>';
                } else {
                    historyData.forEach((item, idx) => {
                        processThumbnailData(item);
                        listEl.appendChild(createListItem(item, false, false, null));
                    });
                }
            });
        } else {
            LocalDB.getSessions(page, LIMIT).then(data => {
                historyData = data.data;
                currentPage = data.page;
                const total = data.total_pages;

                document.getElementById('nsync-prev').disabled = currentPage <= 1;
                document.getElementById('nsync-next').disabled = currentPage >= total;
                document.getElementById('nsync-page-info').textContent = `${currentPage} / ${total}`;

                renderSessionFolders(historyData);
            });
        }

    }

    function previewBackup(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (!data.history) throw new Error("無効なファイルです");
                
                const sessionsMap = new Map();
                const sortedHistory = data.history.sort((a,b) => b.created_at.localeCompare(a.created_at));
                sortedHistory.forEach(item => {
                    const sid = item.session_id || 'unknown';
                    if (!sessionsMap.has(sid)) {
                        sessionsMap.set(sid, { session_id: sid, count: 0, latest_date: item.created_at, items: [] });
                    }
                    const s = sessionsMap.get(sid);
                    s.count++;
                    if (s.items.length < 4) s.items.push(item);
                });
                
                const arr = Array.from(sessionsMap.values());
                arr.forEach(s => {
                    if (s.items.length > 0) s.prompt = s.items[0].prompt;
                    s.thumbnails = s.items.map(i => i.thumbnail);
                    s.last_updated = s.latest_date;
                });
                
                window._isPreviewMode = true;
                window._backupPreviewFavorites = data.favorites || [];
                window._backupPreviewSessions = arr;
                window._backupPreviewHistory = sortedHistory;
                
                activeTab = 'history';
                currentPage = 1;
                
                currentSearch = '';
                const searchInput = document.getElementById('nsync-search-input');
                if (searchInput) searchInput.value = '';

                document.querySelectorAll('.nsync-tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.nsync-tab-btn')[0].classList.add('active'); // Select history tab
                
                // Add Preview Exit UI
                const titleEl = document.getElementById('nsync-header-title');
                if (!document.getElementById('nsync-exit-preview')) {
                    titleEl.innerHTML = 'N-Sync <span style="color:#e55;font-size:11px;margin-left:4px;">[PREVIEW]</span> <button id="nsync-exit-preview" style="background:#e55;color:#fff;border:none;border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;margin-left:6px;">終了</button>';
                    document.getElementById('nsync-exit-preview').addEventListener('click', () => {
                        window._isPreviewMode = false;
                        window._backupPreviewSessions = null;
                        window._backupPreviewHistory = null;
                        window._backupPreviewFavorites = null;
                        titleEl.textContent = 'N-Sync';
                        activeTab = 'history';
                        document.querySelectorAll('.nsync-tab-btn').forEach(b => b.classList.remove('active'));
                        document.querySelectorAll('.nsync-tab-btn')[0].classList.add('active');
                        loadList(1);
                    });
                }

                loadList(1);
                showToast('プレビューモードに入りました（上書きされません）', 'ok');
            } catch (err) {
                showToast('プレビューに失敗: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
    }

    function loadFavorites() {
        LocalDB.getFavorites(currentPage, LIMIT).then(data => {
            const rows = data.data;
            rows.forEach(processThumbnailData);
            renderFavoritesList(rows);
        }).catch(e => {
            document.getElementById('nsync-list-container').innerHTML = '<div style="color:#e55;font-size:12px;padding:20px 14px;">❌ 接続エラー</div>';
        });
    }

    function loadSessionDetail(sessionId) {
        const listEl = document.getElementById('nsync-list-container');
        listEl.innerHTML = '<div style="color:#555;font-size:12px;padding:20px 14px;">画像を読み込み中...</div>';
        
        if (window._isPreviewMode) {
            const data = window._backupPreviewHistory.filter(h => h.session_id === sessionId);
            data.forEach(processThumbnailData);
            renderSessionDetailGrid(data, sessionId);
            return;
        }

        LocalDB.getSessionDetail(sessionId).then(data => {
            data.forEach(processThumbnailData);
            renderSessionDetailGrid(data, sessionId);
        }).catch(e => {
            listEl.innerHTML = '<div style="color:#e55;font-size:12px;padding:20px 14px;">❌ 取得に失敗しました</div>';
        });
    }

    // ============================================================
    // === リスト描画（セッションフォルダ）===
    // ============================================================
    function renderSessionFolders(sessions) {
        const listEl = document.getElementById('nsync-list-container');
        document.getElementById('nsync-prev').disabled = true;
        document.getElementById('nsync-next').disabled = true;
        document.getElementById('nsync-page-info').textContent = 'Sessions';

        if (!sessions || sessions.length === 0) {
            listEl.innerHTML = '<div style="color:#555;font-size:12px;padding:20px 14px;">履歴がありません</div>';
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'nsync-session-grid';

        sessions.forEach(s => {
            // サムネイルJSONのパース
            s.thumbnails.forEach((t, idx) => {
                if (t && t.startsWith('{')) {
                    try { s.thumbnails[idx] = JSON.parse(t).image; } catch(e){}
                }
            });

            const norm = (s.last_updated || '').replace(' ', 'T');
            const dt = s.last_updated ? new Date(norm.endsWith('Z') ? norm : norm + 'Z') : new Date();
            const timeStr = `${pad(dt.getMonth()+1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;

            let thumbsHtml = '';
            for (let i = 0; i < 4; i++) {
                if (s.thumbnails[i]) {
                    thumbsHtml += `<img src="${s.thumbnails[i]}" loading="lazy">`;
                } else {
                    thumbsHtml += `<div class="empty-thumb"></div>`;
                }
            }

            const folder = document.createElement('div');
            folder.className = 'nsync-folder';
            folder.innerHTML = `
                <div class="nsync-folder-thumbs">${thumbsHtml}</div>
                <div class="nsync-folder-info">
                    <span class="nsync-folder-count">${s.count}枚</span>
                    <span class="nsync-folder-time">${timeStr}</span>
                </div>
                <div class="nsync-folder-prompt">${esc(s.prompt || 'プロンプトなし')}</div>
            `;
            folder.addEventListener('click', () => loadSessionDetail(s.session_id));
            grid.appendChild(folder);
        });

        listEl.innerHTML = '';
        listEl.appendChild(grid);
    }

    // ============================================================
    // === リスト描画（セッション内グリッド詳細）===
    // ============================================================
    function renderSessionDetailGrid(images, sessionId) {
        const listEl = document.getElementById('nsync-list-container');
        listEl.innerHTML = '';

        const header = document.createElement('div');
        header.className = 'nsync-detail-grid-header';
        header.innerHTML = `
            <button class="nsync-back-btn">◀ 戻る</button>
            <span style="font-size:12px;color:#ccc;font-weight:bold;">${images.length}枚の生成画像</span>
        `;
        header.querySelector('.nsync-back-btn').addEventListener('click', () => loadList(1));
        listEl.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'nsync-detail-grid';

        images.forEach(img => {
            const item = document.createElement('div');
            item.className = 'nsync-detail-item';
            item.innerHTML = `
                <img src="${img.thumbnail || ''}" loading="lazy">
                <button class="nsync-detail-fav" data-id="${img.id}">☆</button>
            `;
            
            // 画像クリックで直接復元し、パネルを閉じる
            item.addEventListener('click', () => {
                if (img.thumbnail && img._metaB64) {
                    simulateDragAndDrop(img.thumbnail, img._metaB64);
                    showToast('画像を反映しました');
                    togglePanel(); // パネルを閉じる
                } else {
                    showToast('❌ 画像メタデータがありません', 'error');
                }
            });

            // お気に入りボタン
            const favBtn = item.querySelector('.nsync-detail-fav');
            if (window._isPreviewMode) {
                const favMatch = (window._backupPreviewFavorites || []).find(f => f.history_id === img.id);
                if (favMatch) {
                    favBtn.classList.add('on');
                    favBtn.textContent = '★';
                }
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showToast('プレビュー中は変更できません', 'error');
                });
            } else {
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleFavorite(favBtn, img.id);
                });
                loadFavIdThenRemove(favBtn, img.id, true);
            }

            grid.appendChild(item);
        });

        listEl.appendChild(grid);
    }

    // ============================================================
    // === リスト描画（お気に入り）===
    // ============================================================
    function renderFavoritesList(data) {
        const listEl = document.getElementById('nsync-list-container');
        document.getElementById('nsync-prev').disabled = true;
        document.getElementById('nsync-next').disabled = true;
        document.getElementById('nsync-page-info').textContent = '-';

        if (data.length === 0) {
            listEl.innerHTML = '<div style="color:#555;font-size:12px;padding:20px 14px;">お気に入りはまだありません<br>履歴の ⭐ ボタンで追加できます</div>';
            return;
        }
        listEl.innerHTML = '';
        data.forEach(item => {
            // favorites結合レスポンス形式: fav_id, label, + historyのフィールド
            const el = createListItem(item, false, true, item.fav_id);
            if (item.label) {
                const labelBadge = document.createElement('div');
                labelBadge.style.cssText = 'font-size:10px;color:#fbbf24;margin-top:2px;';
                labelBadge.textContent = `⭐ ${item.label}`;
                el.querySelector('.nsync-item-preview').appendChild(labelBadge);
            }
            listEl.appendChild(el);
        });
    }

    // ============================================================
    // === リストアイテム生成（共通）===
    // ============================================================
    function createListItem(item, isNew, isFavorite, favId) {
        // SQLiteの "YYYY-MM-DD HH:MM:SS" または APIの "....000Z" 形式を跨いで処理
        const dtStrVal = item.created_at || '';
        const norm = dtStrVal.replace(' ', 'T');
        const dt = dtStrVal ? new Date(norm.endsWith('Z') ? norm : norm + 'Z') : new Date();
        const dateStr = `${dt.getFullYear()}/${pad(dt.getMonth()+1)}/${pad(dt.getDate())}`;
        const timeStr = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
        const meta = [item.model, item.steps ? `${item.steps}st` : null, item.scale ? `CFG${item.scale}` : null, item.sampler].filter(Boolean).join('·');

        const el = document.createElement('div');
        el.className = 'nsync-item' + (isNew ? ' nsync-item-new' : '');
        el.dataset.id = item.id;

        el.innerHTML = `
            <div class="nsync-item-datetime">
                <span class="nsync-item-date">${dateStr}</span>
                <span class="nsync-item-time">${timeStr}</span>
            </div>
            ${item.thumbnail
                ? `<img src="${item.thumbnail}" class="nsync-thumbnail" title="クリックで復元">`
                : `<div style="width:48px;height:48px;border-radius:4px;border:1px dashed #2d2040;flex-shrink:0;"></div>`
            }
            <div class="nsync-item-spacer"></div>
            <button class="nsync-fav-star${isFavorite ? ' on' : ''}" data-history-id="${item.id}" data-fav-id="${favId || ''}" title="お気に入り">${isFavorite ? '★' : '☆'}</button>
        `;
        
        const thumb = el.querySelector('.nsync-thumbnail');
        if (thumb) {
            thumb.addEventListener('click', (e) => {
                e.stopPropagation();
                if (item.thumbnail && item._metaB64) {
                    simulateDragAndDrop(item.thumbnail, item._metaB64);
                    showToast('画像を反映しました');
                    togglePanel(); // パネルを閉じる
                } else {
                    showToast('❌ 画像メタデータがありません', 'error');
                }
            });
        }

        // タイムスタンプエリアクリック→直接復元
        el.querySelector('.nsync-item-datetime').addEventListener('click', () => {
            if (item.thumbnail && item._metaB64) {
                simulateDragAndDrop(item.thumbnail, item._metaB64);
                showToast('画像を反映しました');
                togglePanel();
            }
        });

        // サムネがない場合のスペーサークリック→直接復元
        const spacer = el.querySelector('.nsync-item-spacer');
        if (spacer) spacer.addEventListener('click', () => {
            if (item.thumbnail && item._metaB64) {
                simulateDragAndDrop(item.thumbnail, item._metaB64);
                showToast('画像を反映しました');
                togglePanel();
            }
        });

        const starBtn = el.querySelector('.nsync-fav-star');
        if (window._isPreviewMode) {
            const favMatch = (window._backupPreviewFavorites || []).find(f => f.history_id === item.id);
            if (favMatch && !isFavorite) {
                starBtn.classList.add('on');
                starBtn.textContent = '★';
            }
            starBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showToast('プレビュー中は変更できません', 'error');
            });
        } else {
            starBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFavorite(starBtn, item.id);
            });
        }

        return el;
    }

    // ============================================================
    // === お気に入りトグル ===
    // ============================================================
    function toggleFavorite(starBtn, historyId) {
        const isOn = starBtn.classList.contains('on');
        if (isOn) {
            const favId = starBtn.dataset.favId;
            if (!favId) { loadFavIdThenRemove(starBtn, historyId); return; }
            removeFavorite(starBtn, favId);
        } else {
            LocalDB.addFavorite(historyId)
                .then(r => {
                    if (!r) throw new Error();
                    starBtn.dataset.favId = r.fav_id;
                    starBtn.classList.add('on');
                    starBtn.textContent = '★'; // 登録→黄色実星
                    showToast('お気に入りに追加しました');
                })
                .catch(() => { showToast('追加に失敗しました', 'error'); });
        }
    }

    function loadFavIdThenRemove(starBtn, historyId, onlyCheck = false) {
        LocalDB.checkFavorite(historyId)
            .then(r => {
                if (r.is_favorite && r.fav_id) {
                    starBtn.dataset.favId = r.fav_id;
                    starBtn.classList.add('on');
                    starBtn.textContent = '★';
                    if (!onlyCheck) removeFavorite(starBtn, r.fav_id);
                }
            })
            .catch(() => {});
    }

    function removeFavorite(starBtn, favId) {
        LocalDB.removeFavorite(favId)
            .then(() => {
                starBtn.classList.remove('on');
                starBtn.textContent = '☆'; // 登録解除→白抜き星
                showToast('お気に入りから解除しました');
                if (activeTab === 'favorites') loadList(1);
            })
            .catch(() => { showToast('解除に失敗しました', 'error'); });
    }

    // ============================================================
    // === 詳細ポップアップ ===
    // ============================================================
    function showDetail(id) {
        LocalDB.getHistoryItem(id)
            .then(data => { 
                if (!data) throw new Error();
                processThumbnailData(data); 
                renderDetail(data); 
            })
            .catch(() => { showToast('詳細の取得に失敗しました', 'error'); });
    }

    function renderDetail(item) {
        document.getElementById('nsync-overlay')?.remove();

        const dtStrVal = item.created_at || '';
        const norm = dtStrVal.replace(' ', 'T');
        const dt = dtStrVal ? new Date(norm.endsWith('Z') ? norm : norm + 'Z') : new Date();
        const dtStr = `${dt.getFullYear()}/${pad(dt.getMonth()+1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())} JST`;

        // char_prompts_json をパース
        let charPrompts = [];
        try { charPrompts = item.char_prompts_json ? JSON.parse(item.char_prompts_json) : []; } catch(e) {}

        const charHtml = charPrompts.length > 0
            ? charPrompts.map((c, i) => {
                const pos = typeof c === 'object' ? (c.char_caption  || '') : String(c);
                const neg = typeof c === 'object' ? (c.char_negative || '') : '';
                return `
                <div class="nsync-ds">
                    <div class="nsync-dl">\uD83D\uDC64 \u30AD\u30E3\u30E9\u30AF\u30BF\u30FC ${i + 1}</div>
                    <div class="nsync-dv char">${esc(pos)}</div>
                    ${neg !== '' ? `<div class="nsync-dl" style="color:#e55;margin-top:4px;">&#x26D4; \u30CD\u30AC\u30C6\u30A3\u30D6</div><div class="nsync-dv char" style="color:#f87171;">${esc(neg)}</div>` : '<div style="font-size:10px;color:#555;margin-top:2px;">&#x26D4; \u30CD\u30AC\u30C6\u30A3\u30D6: (\u306A\u3057)</div>'}
                </div>`;
            }).join('')
            : '';

        // 追加パラメータ
        const extras = [];
        if (item.noise_schedule) extras.push(['Noise Sched.', item.noise_schedule]);
        if (item.cfg_rescale != null && item.cfg_rescale !== '') extras.push(['CFG Rescale', item.cfg_rescale]);
        if (item.smea) extras.push(['SMEA', item.smea_dyn ? 'DYN' : 'ON']);
        if (item.extra_noise_seed) extras.push(['Extra Seed', item.extra_noise_seed]);

        const overlay = document.createElement('div');
        overlay.id = 'nsync-overlay';
        overlay.innerHTML = `
            <div id="nsync-detail-box">
                <div class="nsync-dh">
                    <h3>📋 ${esc(dtStr)}</h3>
                    <button id="nsync-dc">✕</button>
                </div>
                <div class="nsync-db">
                    <div class="nsync-ds">
                        <div class="nsync-dl">🖊 ベースプロンプト</div>
                        <div class="nsync-dv">${esc(item.prompt || '(なし)')}</div>
                    </div>
                    ${charHtml}
                    <div class="nsync-ds">
                        <div class="nsync-dl">🚫 ネガティブプロンプト</div>
                        <div class="nsync-dv">${esc(item.negative_prompt || '(なし)')}</div>
                    </div>
                    <div class="nsync-ds">
                        <div class="nsync-dl">⚙️ 生成設定</div>
                        <div class="nsync-params">
                            <div class="nsync-param"><div class="nsync-param-n">Model</div><div class="nsync-param-v">${esc(item.model||'-')}</div></div>
                            <div class="nsync-param"><div class="nsync-param-n">Steps</div><div class="nsync-param-v">${item.steps||'-'}</div></div>
                            <div class="nsync-param"><div class="nsync-param-n">CFG (Scale)</div><div class="nsync-param-v">${item.scale||'-'}</div></div>
                            <div class="nsync-param"><div class="nsync-param-n">Sampler</div><div class="nsync-param-v">${esc(item.sampler||'-')}</div></div>
                            <div class="nsync-param"><div class="nsync-param-n">Seed</div><div class="nsync-param-v">${esc(item.seed||'-')}</div></div>
                            <div class="nsync-param"><div class="nsync-param-n">Size</div><div class="nsync-param-v">${item.width&&item.height ? `${item.width}×${item.height}` : '-'}</div></div>
                            ${extras.map(([n,v]) => `<div class="nsync-param"><div class="nsync-param-n">${esc(n)}</div><div class="nsync-param-v">${esc(String(v))}</div></div>`).join('')}
                        </div>
                    </div>
                </div>
                <div class="nsync-df">
                    <button class="nsync-btn-fav" id="nsync-d-fav">⭐ お気に入り</button>
                    <button class="nsync-btn-cancel" id="nsync-d-cancel">閉じる</button>
                    <button class="nsync-btn-apply" id="nsync-d-apply">✨ NAIに反映</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#nsync-dc').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#nsync-d-cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#nsync-d-apply').addEventListener('click', () => { 
            if (item.thumbnail) {
                simulateDragAndDrop(item.thumbnail, item._metaB64);
            } else {
                showToast('❌ この履歴には画像メタデータがありません', 'error');
            }
            overlay.remove(); 
        });
        overlay.querySelector('#nsync-d-fav').addEventListener('click', () => {
            fetch(`${HUB_URL}/api/favorites`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ history_id: item.id })
            })
                .then(() => { showToast('⭐ お気に入りに追加しました'); overlay.remove(); })
                .catch(() => { showToast('追加に失敗しました', 'error'); });
        });
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    // ============================================================
    // === PNGメタデータ抽出＆インジェクション ===
    // ============================================================
    function parsePngChunks(uint8) {
        if (uint8[0] !== 0x89 || uint8[1] !== 0x50 || uint8[2] !== 0x4E || uint8[3] !== 0x47) return null;
        let offset = 8;
        const chunks = [];
        while (offset < uint8.length) {
            if (offset + 8 > uint8.length) break;
            const len = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength).getUint32(offset);
            if (offset + 12 + len > uint8.length) break;
            const type = String.fromCharCode(...uint8.slice(offset+4, offset+8));
            const data = uint8.slice(offset+8, offset+8+len);
            const crc = uint8.slice(offset+8+len, offset+12+len);
            chunks.push({ type, len, data, crc, full: uint8.slice(offset, offset+12+len) });
            offset += 12 + len;
        }
        return chunks;
    }

    // CRC32 計算（PNGチャンク再構築用）
    const _crcTable = (function() {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c;
        }
        return t;
    })();
    function _crc32(buf) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) crc = _crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    // tEXtチャンクを再構築する
    function buildTEXtChunk(keyword, value) {
        const enc = new TextEncoder();
        const kwBuf = enc.encode(keyword);
        const valBuf = enc.encode(value);
        const data = new Uint8Array(kwBuf.length + 1 + valBuf.length);
        data.set(kwBuf, 0);
        data[kwBuf.length] = 0;
        data.set(valBuf, kwBuf.length + 1);
        const type = new Uint8Array([0x74, 0x45, 0x58, 0x74]); // 'tEXt'
        const typeAndData = new Uint8Array(4 + data.length);
        typeAndData.set(type, 0);
        typeAndData.set(data, 4);
        const crcVal = _crc32(typeAndData);
        const full = new Uint8Array(12 + data.length);
        new DataView(full.buffer).setUint32(0, data.length);
        full.set(typeAndData, 4);
        new DataView(full.buffer).setUint32(8 + data.length, crcVal);
        return { type: 'tEXt', full };
    }

    // メタデータチャンクから巨大フィールド（Vibe Transfer画像等）を除外
    const STRIP_META_FIELDS = ['reference_image_multiple', 'director_reference_images', 'reference_image'];
    function stripLargeMetaFields(metaChunks) {
        return metaChunks.map(chunk => {
            if (chunk.type !== 'tEXt') return chunk;
            const dec = new TextDecoder().decode(chunk.data);
            if (!dec.startsWith('Comment\0')) return chunk;
            try {
                const json = JSON.parse(dec.substring(8));
                let stripped = false;
                for (const field of STRIP_META_FIELDS) {
                    if (json[field] && JSON.stringify(json[field]).length > 100) {
                        delete json[field];
                        stripped = true;
                    }
                }
                if (stripped) return buildTEXtChunk('Comment', JSON.stringify(json));
            } catch(e) {}
            return chunk;
        });
    }

    function injectPngChunks(canvasUint8, metaChunks) {
        const chunks = parsePngChunks(canvasUint8);
        if (!chunks) return canvasUint8;
        const out = [canvasUint8.slice(0, 8)];
        let injected = false;
        for (const c of chunks) {
            // PNGの画像データ実体(IDAT)の直前に、NovelAIのメタデータテキスト(tEXt)を全て挿入する
            if (c.type === 'IDAT' && !injected) {
                metaChunks.forEach(mc => out.push(mc.full));
                injected = true;
            }
            out.push(c.full);
        }
        const totalLen = out.reduce((acc, v) => acc + v.length, 0);
        const res = new Uint8Array(totalLen);
        let off = 0;
        out.forEach(v => { res.set(v, off); off += v.length; });
        return res;
    }

    function uint8ToBase64(uint8) {
        let binary = '';
        const len = uint8.byteLength;
        const chunkSize = 8192;
        for (let i = 0; i < len; i += chunkSize) {
            binary += String.fromCharCode.apply(null, uint8.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    function base64ToUint8(base64) {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    async function webpToPngUint8(webpBase64) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const timeout = setTimeout(() => reject(new Error('WebP→PNG変換タイムアウト')), 10000);
            img.onerror = () => { clearTimeout(timeout); reject(new Error('WebP画像の読み込みに失敗')); };
            img.onload = () => {
                clearTimeout(timeout);
                const cvs = document.createElement('canvas');
                cvs.width = img.width;
                cvs.height = img.height;
                const ctx = cvs.getContext('2d');
                ctx.drawImage(img, 0, 0);
                cvs.toBlob(blob => {
                    if (!blob) { reject(new Error('PNG Blob生成失敗')); return; }
                    const reader = new FileReader();
                    reader.onload = e => resolve(new Uint8Array(e.target.result));
                    reader.onerror = () => reject(new Error('FileReader失敗'));
                    reader.readAsArrayBuffer(blob);
                }, 'image/png');
            };
            img.src = webpBase64;
        });
    }

    // ============================================================
    // === 擬似ドラッグ＆ドロップ (画像のD&Dネイティブリストア) ===
    // ============================================================
    async function simulateDragAndDrop(base64Data, metaB64) {
        try {
            window._nsyncIsRestoring = true;

            let finalBlob;
            if (metaB64) {
                // 手法4: WebP画像をCanvas経由でPNGに戻し、メタデータを注入して復元用画像を生成
                const basePngUint8 = await webpToPngUint8(base64Data);
                
                const metaUint8 = base64ToUint8(metaB64);
                const metaChunks = [];
                let offset = 0;
                const dv = new DataView(metaUint8.buffer, metaUint8.byteOffset, metaUint8.byteLength);
                let importedJson = null;
                while (offset < metaUint8.length) {
                    const len = dv.getUint32(offset);
                    const typeStr = String.fromCharCode(metaUint8[offset+4], metaUint8[offset+5], metaUint8[offset+6], metaUint8[offset+7]);
                    const data = metaUint8.slice(offset+8, offset+8+len);
                    if (typeStr === 'tEXt') {
                        const dec = new TextDecoder().decode(data);
                        if (dec.startsWith('Comment\0')) importedJson = dec.substring(8);
                    }
                    metaChunks.push({ full: metaUint8.slice(offset, offset + 12 + len) });
                    offset += 12 + len;
                }
                
                if (importedJson) {
                    window._nsyncSeenJSONs = window._nsyncSeenJSONs || new Set();
                    window._nsyncSeenJSONs.add(importedJson);
                }
                
                const finalUint8 = injectPngChunks(basePngUint8, metaChunks);
                finalBlob = new Blob([finalUint8], { type: 'image/png' });
            } else {
                // 従来方式（PNG画像そのものにメタデータが入っている）
                const res = await fetch(base64Data);
                finalBlob = await res.blob();
            }

            const file = new File([finalBlob], "restored_metadata.png", { type: "image/png" });
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);

            // ─── スマホ判定 (タッチデバイス or 画面幅768px以下) ───
            const isMobile = ('ontouchstart' in window) || window.innerWidth <= 768;

            if (isMobile) {
                // 診断データから判明: スマホ版インポートinputは
                // ".mobile-tray-contents" 内の最初の non-multiple input (index 4)
                const mobileInput = document.querySelector(
                    '.mobile-tray-contents input[type="file"]:not([multiple])'
                );
                if (mobileInput) {
                    try {
                        mobileInput.files = dataTransfer.files;
                        mobileInput.dispatchEvent(new Event('change', { bubbles: true }));
                        showToast('✅ スマホ用インポートで設定を復元しました', 'ok');
                    } catch(e) {
                        console.error('[N-Sync] mobile input injection error', e);
                        showToast('❌ スマホ復元に失敗しました', 'error');
                    }
                } else {
                    showToast('⚠ スマホ用インポート枠が見つかりませんでした', 'error');
                }
                setTimeout(() => { window._nsyncIsRestoring = false; }, 2000);
                return;
            }

            // ─── PC用: 擬似D&D発火 ───
            showToast('画像を適用中...', 'ok');
            const root = document.querySelector('#root') || document.body;

            const evEnter = new Event('dragenter', { bubbles: true, cancelable: true });
            Object.defineProperty(evEnter, 'dataTransfer', { value: dataTransfer });
            root.dispatchEvent(evEnter);

            setTimeout(() => {
                const dropTarget = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2) || root;

                const evOver = new Event('dragover', { bubbles: true, cancelable: true });
                Object.defineProperty(evOver, 'dataTransfer', { value: dataTransfer });
                dropTarget.dispatchEvent(evOver);

                const evDrop = new Event('drop', { bubbles: true, cancelable: true });
                Object.defineProperty(evDrop, 'dataTransfer', { value: dataTransfer });
                dropTarget.dispatchEvent(evDrop);

                setTimeout(() => {
                    root.dispatchEvent(new Event('dragleave', { bubbles: true, cancelable: true }));

                    // PCバックアップ: mobile-tray-contents外の最初のnon-multiple input (index 0相当)
                    const desktopInput = Array.from(
                        document.querySelectorAll('input[type="file"]:not([multiple])')
                    ).find(el => !el.closest('.mobile-tray-contents'));
                    if (desktopInput) {
                        try {
                            desktopInput.files = dataTransfer.files;
                            desktopInput.dispatchEvent(new Event('change', { bubbles: true }));
                        } catch(e) {}
                    }

                    setTimeout(() => { window._nsyncIsRestoring = false; }, 2000);
                }, 50);

                showToast('✅ 設定を復元しました', 'ok');
            }, 50);

        } catch (err) {
            console.error('[N-Sync] D&D simulation error', err);
            showToast('❌ 復元イベントの発火に失敗しました', 'error');
            window._nsyncIsRestoring = false;
        }
    }

    // ============================================================
    // === 画像生成監視 (URL.createObjectURL 完全負荷ゼロフック) ===
    // ============================================================
    function patchObjectURL() {
        _origCreateObjectURL = window.URL.createObjectURL;

        window.URL.createObjectURL = function(obj) {
            const url = _origCreateObjectURL.apply(this, arguments);
            if (obj && obj instanceof Blob && obj.type === 'image/png') {
                if (!obj._nsyncProcessed) {
                    obj._nsyncProcessed = true;
                    setTimeout(() => processGeneratedImage(obj), 50);
                }
            }
            return url;
        };

        // Generateボタンのタップ/クリックを検出し、生成カウンターをインクリメント
        // イベント委譲方式：ボタンがReactで再生成されても確実に検出できる
        function isGenerateButton(el) {
            let node = el;
            while (node && node !== document.body) {
                if (node.tagName === 'BUTTON') {
                    const span = node.querySelector('span');
                    if (span && /^Generate \d+ Image/.test(span.textContent)) {
                        return true;
                    }
                }
                node = node.parentElement;
            }
            return false;
        }

        document.addEventListener('pointerdown', (e) => {
            if (isGenerateButton(e.target)) {
                _nsyncPendingGenerations++;
                console.log(`[N-Sync] Generate tapped (pending: ${_nsyncPendingGenerations})`);
            }
        }, true);

        console.log('[N-Sync] URL.createObjectURL patched ✓');
    }

    function processGeneratedImage(blob) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const uint8 = new Uint8Array(e.target.result);
            const chunks = parsePngChunks(uint8);
            if (!chunks) return;

            const metaChunks = chunks.filter(c => c.type === 'tEXt' || c.type === 'iTXt');
            if (metaChunks.length === 0) return;

            let isNovelAIGen = false;
            let jsonString = null;
            for (const c of metaChunks) {
                if (c.type === 'tEXt') {
                    const dec = new TextDecoder().decode(c.data);
                    // NAIのパラメーターは "Comment" チャンクに格納される
                    if (dec.startsWith('Comment\0')) {
                        isNovelAIGen = true;
                        jsonString = dec.substring(8);
                        break;
                    }
                }
            }

            if (!isNovelAIGen || !jsonString) return;

            // 生成パラメータ（JSON）を記憶し、UI再描画などで同じ画像が複数回処理されるのを防ぐ
            window._nsyncSeenJSONs = window._nsyncSeenJSONs || new Set();
            if (window._nsyncSeenJSONs.size > 500) window._nsyncSeenJSONs.clear(); // メモリリーク防止
            if (window._nsyncSeenJSONs.has(jsonString)) {
                return; // すでに処理された画像なのでスキップ
            }
            window._nsyncSeenJSONs.add(jsonString);

            try {
                let apiData = {};
                try { apiData = JSON.parse(jsonString); } catch(err){}
                const prompt = apiData.prompt || '';
                const uc = apiData.uc || apiData.negative_prompt || '';

                // APIデータから各種パラメータを抽出
                const model = typeof apiData.model === 'string' ? apiData.model : null;
                const parameters = apiData.parameters || apiData || {};
                const scale = parameters.scale || parameters.guidance_scale || null;
                const steps = parameters.steps || null;
                const seed = parameters.seed || null;
                const sampler = parameters.sampler || null;
                const width = parameters.width || null;
                const height = parameters.height || null;

                // キャラクタープロンプト（V3およびV4対応）
                let charPromptsJson = null;
                try {
                    let cpArray = [];
                    // V3 の形式
                    if (parameters.characterPrompts) {
                        const parsedCP = Array.isArray(parameters.characterPrompts) 
                            ? parameters.characterPrompts 
                            : JSON.parse(parameters.characterPrompts);
                        cpArray = cpArray.concat(parsedCP.map(c => ({
                            char_caption: c.prompt || c.char_caption || '',
                            char_negative: c.uc || c.char_negative || ''
                        })));
                    }
                    // V4 の形式
                    const v4p = parameters.v4_prompt;
                    const v4n = parameters.v4_negative_prompt;
                    if (v4p && v4p.caption && Array.isArray(v4p.caption.char_captions)) {
                        const charCaps = v4p.caption.char_captions;
                        const charNegCaps = (v4n && v4n.caption && Array.isArray(v4n.caption.char_captions))
                            ? v4n.caption.char_captions : [];
                            
                        cpArray = cpArray.concat(charCaps.map((c, idx) => {
                            const negC = charNegCaps[idx] || {};
                            // すべてのプロパティ（centers座標など）を含めることで変更を完全検知
                            return Object.assign({}, c, {
                                char_caption: c.char_caption !== undefined ? c.char_caption : (c.prompt || ''),
                                char_negative: negC.char_caption !== undefined ? negC.char_caption : (negC.uc || '')
                            });
                        }));
                    }
                    if (cpArray.length > 0) {
                        charPromptsJson = JSON.stringify(cpArray);
                    }
                } catch(e) {
                    console.error('[N-Sync] Character prompt extraction error:', e);
                }

                const fullData = {
                    prompt, 
                    negative_prompt: uc,
                    model, scale, steps, seed, sampler, width, height,
                    char_prompts_json: charPromptsJson,
                    session_id: CURRENT_SESSION_ID
                };

                // Canvasで サムネイル（最短100px）化
                const maxEdge = 100;
                const img = new Image();
                img.onload = () => {
                    let w = img.width, h = img.height;
                    if (w > maxEdge || h > maxEdge) {
                        if (w > h) { h = Math.round(h * maxEdge / w); w = maxEdge; }
                        else { w = Math.round(w * maxEdge / h); h = maxEdge; }
                    }
                    const cvs = document.createElement('canvas');
                    cvs.width = w; cvs.height = h;
                    const ctx = cvs.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    
                    // WebP (品質0.6) で超高圧縮化
                    const webpData = cvs.toDataURL('image/webp', 0.6);
                    
                    // メタデータチャンクから巨大フィールド（Vibe画像等）を除外して軽量化
                    const strippedMeta = stripLargeMetaFields(metaChunks);
                    const totalLen = strippedMeta.reduce((acc, c) => acc + c.full.length, 0);
                    const combinedMeta = new Uint8Array(totalLen);
                    let off = 0;
                    strippedMeta.forEach(c => { combinedMeta.set(c.full, off); off += c.full.length; });
                    const metaB64 = uint8ToBase64(combinedMeta);
                    
                    fullData.thumbnail = JSON.stringify({ image: webpData, meta: metaB64 });
                    sendToHub(fullData);
                };
                img.src = _origCreateObjectURL.call(URL, blob); // フック再突入を回避

            } catch(e) { console.error('[N-Sync] Thumbnail processing error:', e); }
        };
        reader.readAsArrayBuffer(blob);
    }

    function sendToHub(data) {
        // Generateボタンが押されていない場合（手動インポート）は履歴に保存しない
        if (_nsyncPendingGenerations <= 0) {
            console.log('[N-Sync] Skipping history save (no pending generation – likely an import)');
            return;
        }
        _nsyncPendingGenerations--;

        if (!data.prompt) return;
        data.session_id = CURRENT_SESSION_ID;
        LocalDB.addHistory(data)
            .then(id => {
                data.id = id;
                prependToList(data);
                if (batchOnGenerated) batchOnGenerated();
            })
            .catch(err => {
                console.error('[N-Sync] Local DB save error:', err);
                showToast('❌ ローカル保存に失敗しました', 'error');
                if (batchOnGenerated) batchOnGenerated();
            });
    }

    // ============================================================
    // === バッチ（連続）生成 ===
    // ============================================================
    let wakeLock = null;

    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
            } catch (err) {
                console.warn('[N-Sync] Wake Lock request failed:', err);
            }
        }
    }

    function releaseWakeLock() {
        if (wakeLock !== null) {
            wakeLock.release().then(() => {
                wakeLock = null;
            });
        }
    }

    function findGenerateButton() {
        return Array.from(document.querySelectorAll('button')).find(btn => {
            const span = btn.querySelector('span');
            return span && /^Generate \d+ Image/.test(span.textContent);
        });
    }

    function toggleBatchGeneration() {
        if (batchRunning) {
            stopBatch();
        } else {
            startBatch();
        }
    }

    async function startBatch() {
        const input = document.getElementById('nsync-batch-input');
        const target = parseInt(input.value);
        if (!target || target < 1) {
            showToast('⚠ 生成回数を1以上で指定してください', 'error');
            return;
        }

        const genBtn = findGenerateButton();
        if (!genBtn) {
            showToast('⚠ Generate ボタンが見つかりません', 'error');
            return;
        }

        batchRunning = true;
        batchTarget = target;
        batchCount = 0;

        await requestWakeLock();

        // UI更新
        const btn = document.getElementById('nsync-batch-btn');
        btn.className = 'stop';
        btn.textContent = '■ 停止';
        input.disabled = true;
        updateBatchProgress();

        showToast(`🔄 連続生成を開始 (${target}回)`);
        runNextGeneration();
    }

    function stopBatch() {
        batchRunning = false;
        batchOnGenerated = null;

        releaseWakeLock();

        const btn = document.getElementById('nsync-batch-btn');
        const input = document.getElementById('nsync-batch-input');
        const progress = document.getElementById('nsync-batch-progress');
        btn.className = 'start';
        btn.textContent = '▶ 開始';
        input.disabled = false;
        progress.classList.remove('active');
        progress.textContent = batchCount > 0 ? `${batchCount}回完了` : '';

        if (batchCount > 0) {
            showToast(`✅ 連続生成を停止しました (${batchCount}/${batchTarget}回完了)`);
        }
    }

    function updateBatchProgress() {
        const progress = document.getElementById('nsync-batch-progress');
        if (progress) {
            progress.textContent = `${batchCount}/${batchTarget}`;
            progress.classList.add('active');
        }
    }

    function runNextGeneration() {
        if (!batchRunning) return;
        if (batchCount >= batchTarget) {
            showToast(`✅ 連続生成が完了しました (${batchTarget}回)`);
            stopBatch();
            return;
        }

        const genBtn = findGenerateButton();
        if (!genBtn) {
            showToast('⚠ Generate ボタンが見つかりません。中断します。', 'error');
            stopBatch();
            return;
        }

        // 生成完了時のコールバックを登録
        batchOnGenerated = () => {
            batchOnGenerated = null; // 一度だけ発火
            batchCount++;
            updateBatchProgress();

            if (!batchRunning) return;

            // 少し待ってから次の生成を開始（ボタンの状態回復を待つ）
            setTimeout(() => {
                runNextGeneration();
            }, 1500);
        };

        // ボタンをクリック（プログラム的なclickはpointerdownを発火しないため、手動でカウント）
        _nsyncPendingGenerations++;
        genBtn.click();
    }

    // ============================================================
    // === Socket.io ===
    // ============================================================
    function initSocket() {
        if (typeof io === 'undefined') {
            console.warn('[N-Sync] socket.io not available');
            return;
        }
        socket = io(HUB_URL, { transports: ['websocket', 'polling'] });

        socket.on('connect', () => {
            const el = document.getElementById('nsync-status');
            if (el) { el.textContent = '● 接続済み'; el.className = 'ok'; }
        });
        socket.on('disconnect', () => {
            const el = document.getElementById('nsync-status');
            if (el) { el.textContent = '● 切断'; el.className = ''; }
        });
        socket.on('SYNC_LATEST', (newEntry) => {
            // 別デバイスからの新規エントリを直接先頭に追加
            if (panelOpen && activeTab === 'history' && newEntry && newEntry.id) {
                prependToList(newEntry);
            }
        });
    }

    // ============================================================
    // === リストの先頭にエントリを追加（再読込み不要）===
    // ============================================================
    function prependToList(item) {
        if (!item || !item.id) return;
        if (activeTab !== 'history') return;
        const listEl = document.getElementById('nsync-list-container');
        if (!listEl) return;
        
        processThumbnailData(item);

        // グリッドコンテナがなければ作成（初回の生成時）
        let grid = listEl.querySelector('.nsync-detail-grid');
        if (!grid) {
            listEl.innerHTML = '';
            grid = document.createElement('div');
            grid.className = 'nsync-detail-grid';
            listEl.appendChild(grid);
        }

        // 同じIDが既に存在する場合は削除（重複防止）
        const existing = grid.querySelector(`[data-id="${item.id}"]`);
        if (existing) existing.remove();

        // 最新エントリの時刻がない場合は付与
        if (!item.created_at) {
            const now = new Date();
            item.created_at = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
        }

        // グリッドアイテムを作成
        const el = document.createElement('div');
        el.className = 'nsync-detail-item';
        el.dataset.id = item.id;
        el.innerHTML = `
            <img src="${item.thumbnail || ''}" loading="lazy">
            <button class="nsync-detail-fav" data-id="${item.id}">☆</button>
        `;

        // 画像タップで復元
        el.addEventListener('click', () => {
            if (item.thumbnail && item._metaB64) {
                simulateDragAndDrop(item.thumbnail, item._metaB64);
                showToast('画像を反映しました');
                togglePanel();
            } else {
                showToast('❌ 画像メタデータがありません', 'error');
            }
        });

        // お気に入りボタン
        const favBtn = el.querySelector('.nsync-detail-fav');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(favBtn, item.id);
        });

        // グリッドの先頭に挿入
        grid.insertBefore(el, grid.firstChild);

        // 点滅アニメーション
        el.style.opacity = '0';
        el.style.transform = 'scale(0.9)';
        el.style.transition = 'opacity 0.35s, transform 0.35s';
        requestAnimationFrame(() => {
            el.style.opacity = '1';
            el.style.transform = 'scale(1)';
        });
    }

    // ============================================================
    // === 初期化 ===
    // ============================================================
    function init() {
        injectStyles();

        // 起動確認バッジ（15秒後に消える）
        const marker = document.createElement('div');
        marker.style.cssText = 'position:fixed;bottom:8px;right:8px;background:#7c3aed;color:#fff;padding:3px 8px;border-radius:5px;font-size:11px;z-index:999999;pointer-events:none;font-family:sans-serif;';
        marker.textContent = '⚡N';
        (document.body || document.documentElement).appendChild(marker);
        setTimeout(() => marker.remove(), 15000);

        let done = false;
        function doInit() {
            if (done) return; done = true;
            
            LocalDB.init().then(() => {
                buildUI();
                patchObjectURL();
            });

            
            console.log('[N-Sync] v6.8.2 Ready');
        }

        const t = setInterval(() => {
            if (document.querySelector('.ProseMirror') || (document.body && document.body.children.length > 2)) {
                clearInterval(t); doInit();
            }
        }, 600);
        setTimeout(() => { clearInterval(t); doInit(); }, 5000);
    }

    init();

})();

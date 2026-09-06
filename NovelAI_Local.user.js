// ==UserScript==
// @name         NovelAI Local Panel (N-Local)
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  スマホ単独動作版のNovelAI設定同期ツール。サーバー不要で履歴保存・タグサジェストが可能です。
// @author       Antigravity
// @match        https://novelai.net/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      danbooru.donmai.us
// @connect      e621.net
// @updateURL    https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/NovelAI_Local.user.js
// @downloadURL  https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/NovelAI_Local.user.js
// ==/UserScript==

(function () {
    // --- GM_xmlhttpRequest Bridge (Sandbox Context) ---
    window.addEventListener('nsync-gm-fetch', (e) => {
        const { id, url, method, headers } = e.detail;
        GM_xmlhttpRequest({
            method: method || 'GET',
            url: url,
            headers: headers || {},
            onload: (res) => {
                let data = null;
                try { data = JSON.parse(res.responseText); } catch(err) {}
                window.dispatchEvent(new CustomEvent('nsync-gm-response-' + id, {
                    detail: {
                        ok: res.status >= 200 && res.status < 300,
                        status: res.status,
                        text: res.responseText,
                        json: data
                    }
                }));
            },
            onerror: (err) => {
                window.dispatchEvent(new CustomEvent('nsync-gm-response-' + id, {
                    detail: { error: true, text: err.error || 'Network Error' }
                }));
            }
        });
    });

    // --- Inject Main Script into Page Context ---
    const mainScript = function() {
        'use strict';
    if (window.__NLOCAL_MAIN_STARTED__) {
        document.documentElement.dataset.nlocalMainStarted = '1';
        return;
    }
    window.__NLOCAL_MAIN_STARTED__ = true;
    document.documentElement.dataset.nlocalMainStarted = '1';

    // ============================================================
    // === 設定 ===
    // 配信先URL（タグデータ）
    // ============================================================
    const TAG_DATA_VERSION = '2026-06';
    const TAGS_JSON_DANBOORU = `https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/danbooru_tags.json?v=${TAG_DATA_VERSION}`;
    const TAGS_JSON_E621 = `https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/e621_tags.json?v=${TAG_DATA_VERSION}`;

    // ============================================================
    // === グローバル状態 ===
    // ============================================================
    let panelOpen = false;
    let activeTab = 'history'; // 'history' or 'favorites'
    let currentPage = 1;
    let currentSearch = '';
    let LIMIT = 80;
    let viewedSessionId = null;
    let listRequestId = 0;
    
    // タグ画像キャッシュ (セッション内のみ)
    const tagImageCache = { danbooru: {}, e621: {} };
    
    // バッチ生成
    let batchRunning = false;
    let batchTarget = 0;
    let batchCount = 0;
    let batchOnGenerated = null; // 生成完了コールバック
    let batchWaitAttempts = 0;

    // 生成ボタンが押された回数をカウントし、手動インポートと区別する
    let generation = null;
    let generationTimer = null;
    let generationSettleTimer = null;

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
    // BEGIN LOCAL STORAGE
// Embedded into the installable userscript by scripts/build.js.
class HistoryStorage {
    static db = null;
    static opening = null;
    static writes = Promise.resolve();
    static migrating = false;
    static maxMetadata = 8 * 1024 * 1024;
    static viewIds = null;
    static viewRevision = 0;
    static beginView() { this.viewIds = null; this.viewRevision++; }
    static async ensureView() {
        if (this.viewIds) return this.viewIds;
        const revision = this.viewRevision;
        const ids = await this.request('history', store => store.getAllKeys());
        const snapshot = new Set(ids);
        if (revision === this.viewRevision) this.viewIds = snapshot;
        return snapshot;
    }

    static init() {
        if (this.db) return Promise.resolve();
        if (this.opening) return this.opening;
        this.opening = new Promise((resolve, reject) => {
            const request = indexedDB.open('NovelAILocalDB', 2);
            let blocked = false;
            request.onupgradeneeded = () => {
                const db = request.result;
                const history = db.objectStoreNames.contains('history') ? request.transaction.objectStore('history') : db.createObjectStore('history', { keyPath: 'id' });
                for (const [name, key] of [['session_id', 'session_id'], ['created_at', 'created_at'], ['session_created', ['session_id', 'created_at']]]) {
                    if (!history.indexNames.contains(name)) history.createIndex(name, key);
                }
                const favorites = db.objectStoreNames.contains('favorites') ? request.transaction.objectStore('favorites') : db.createObjectStore('favorites', { keyPath: 'fav_id' });
                if (!favorites.indexNames.contains('history_id')) favorites.createIndex('history_id', 'history_id');
                if (!db.objectStoreNames.contains('tags')) db.createObjectStore('tags');
                if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
            };
            request.onblocked = () => { blocked = true; reject(new Error('他のNovelAIタブを閉じてから再読み込みしてください')); };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                if (blocked) { request.result.close(); return; }
                this.db = request.result;
                this.db.onversionchange = () => { this.db.close(); this.db = null; };
                resolve();
            };
        }).finally(() => { this.opening = null; });
        return this.opening;
    }

    static transaction(names, mode, operation) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(names, mode);
            const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            try { operation(stores, value => { result = value; }); }
            catch (error) { tx.abort(); reject(error); }
        });
    }

    static request(name, operation) {
        return this.transaction([name], 'readonly', (stores, set) => {
            const request = operation(stores[name]);
            request.onsuccess = () => set(request.result);
        });
    }

    static mutate(work) {
        const run = () => typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('nlocal-storage-write', work) : work();
        const result = this.writes.then(run);
        this.writes = result.catch(() => {});
        return result;
    }

    static generateId() { return crypto.randomUUID(); }

    static async transform(blob, decompress = false) {
        const Stream = decompress ? DecompressionStream : CompressionStream;
        const reader = blob.stream().pipeThrough(new Stream('gzip')).getReader();
        const parts = []; let total = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                total += value.length;
                if (total > this.maxMetadata) { await reader.cancel(); throw new Error('メタデータの上限を超えています'); }
                parts.push(value);
            }
        } finally { reader.releaseLock(); }
        return new Blob(parts);
    }

    static decodeImage(uri) {
        const match = /^data:(image\/(?:png|webp|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(uri || '');
        if (!match) throw new Error('無効な画像データです');
        return new Blob([base64ToUint8(match[2])], { type: match[1] });
    }

    static async pack(row) {
        const record = { ...row };
        if (!record.thumbnail) return { record, asset: null };
        let image, meta;
        if (record.thumbnail.startsWith('{')) {
            const value = JSON.parse(record.thumbnail);
            image = this.decodeImage(value.image);
            if (typeof value.meta !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(value.meta)) throw new Error('無効なメタデータです');
            meta = new Blob([base64ToUint8(value.meta)]);
        } else {
            image = this.decodeImage(record.thumbnail);
        }
        if (meta && meta.size > this.maxMetadata) throw new Error('メタデータが大きすぎます');
        let encoding = 'raw';
        if (meta && typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined') {
            const compressed = await this.transform(meta);
            const restored = new Uint8Array(await (await this.transform(compressed, true)).arrayBuffer());
            const original = new Uint8Array(await meta.arrayBuffer());
            if (restored.length !== original.length || restored.some((byte, i) => byte !== original[i])) throw new Error('圧縮の検証に失敗しました');
            meta = compressed; encoding = 'gzip';
        }
        delete record.thumbnail;
        delete record._metaB64;
        record.storage_version = 2;
        return { record, asset: { id: record.id, image, metadata: meta || null, encoding } };
    }

    static async imageUri(blob) { return `data:${blob.type};base64,${uint8ToBase64(new Uint8Array(await blob.arrayBuffer()))}`; }

    static async restoreAsset(asset) {
        const image = await this.imageUri(asset.image);
        if (!asset.metadata) return image;
        const meta = asset.encoding === 'gzip' ? await this.transform(asset.metadata, true) : asset.metadata;
        return JSON.stringify({ image, meta: uint8ToBase64(new Uint8Array(await meta.arrayBuffer())) });
    }

    static addHistory(item) {
        return this.mutate(async () => {
            const id = item.event_id || item.id || this.generateId();
            const existing = await this.request('history', store => store.get(id));
            if (existing) return id;
            const row = { ...item, id, session_id: item.session_id || 'unknown',
                created_at: item.captured_at || item.created_at || new Date().toISOString(), saved_at: new Date().toISOString() };
            const { record, asset } = await this.pack(row);
            await this.transaction(['history', 'assets'], 'readwrite', stores => {
                stores.history.add(record);
                if (asset) stores.assets.put(asset);
            });
            return id;
        });
    }

    static async getHistoryItem(id) {
        const row = await this.request('history', store => store.get(id));
        if (!row) return null;
        const asset = await this.request('assets', store => store.get(id));
        return asset ? { ...row, thumbnail: await this.restoreAsset(asset) } : row;
    }

    // Cursor scans keep only the requested page or session summaries in memory.
    static scan(name, index, range, visit) {
        return this.transaction([name], 'readonly', stores => {
            const source = index ? stores[name].index(index) : stores[name];
            const request = source.openCursor(range, 'prev');
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor && visit(cursor.value) !== false) cursor.continue();
            };
        });
    }

    static async listRows(rows, includeFavorites = true) {
        const favorites = includeFavorites ? await this.request('favorites', store => store.getAll()) : [];
        const favoriteMap = new Map(favorites.map(f => [f.history_id, f.fav_id]));
        return Promise.all(rows.map(async row => {
            const asset = await this.request('assets', store => store.get(row.id));
            let thumbnail = row.thumbnail || null;
            if (asset) thumbnail = await this.imageUri(asset.image);
            else if (thumbnail?.startsWith('{')) thumbnail = JSON.parse(thumbnail).image;
            return { id: row.id, prompt: row.prompt, model: row.model, session_id: row.session_id, created_at: row.created_at,
                thumbnail, fav_id: row.fav_id || favoriteMap.get(row.id) || null };
        }));
    }

    static async getSessions(page, limit) {
        const viewIds = await this.ensureView();
        const sessions = new Map();
        await this.scan('history', 'created_at', null, row => {
            if (!viewIds.has(row.id)) return;
            const id = row.session_id || 'unknown';
            if (!sessions.has(id)) sessions.set(id, { session_id: id, count: 0, last_updated: row.created_at, ids: [] });
            const session = sessions.get(id); session.count++;
            if (session.ids.length < 4) session.ids.push(row.id);
        });
        const data = [...sessions.values()].slice((page - 1) * limit, page * limit);
        for (const session of data) {
            const rows = await Promise.all(session.ids.map(id => this.request('history', store => store.get(id))));
            session.thumbnails = (await this.listRows(rows, false)).map(row => row.thumbnail);
            delete session.ids;
        }
        return { data, page, total_pages: Math.max(1, Math.ceil(sessions.size / limit)) };
    }

    static matches(row, query) {
        const parts = query.toLowerCase().split('*');
        const text = ((row.prompt || '') + '\n' + (row.char_prompts_json || '')).toLowerCase();
        let offset = 0;
        for (const part of parts) { const at = text.indexOf(part, offset); if (at < 0) return false; offset = at + part.length; }
        return true;
    }

    static async pageHistory(page, limit, predicate, index = 'created_at', range = null) {
        const viewIds = await this.ensureView();
        const rows = []; let count = 0;
        await this.scan('history', index, range, row => {
            if (!viewIds.has(row.id) || !predicate(row)) return;
            if (count >= (page - 1) * limit && rows.length < limit) rows.push(row);
            count++;
        });
        return { data: await this.listRows(rows), page, total_pages: Math.max(1, Math.ceil(count / limit)) };
    }
    static searchHistory(query, page, limit) { return this.pageHistory(page, limit, row => this.matches(row, query)); }
    static getSessionDetail(id, page = 1, limit = 80) {
        return id === 'unknown' ? this.pageHistory(page, limit, row => !row.session_id || row.session_id === id) :
            this.pageHistory(page, limit, () => true, 'session_created', IDBKeyRange.bound([id], [id, '\uffff']));
    }

    static addFavorite(historyId) {
        return this.mutate(() => this.transaction(['history', 'favorites'], 'readwrite', (stores, set) => {
            const history = stores.history.get(historyId);
            history.onsuccess = () => {
                if (!history.result) { set(null); return; }
                const existing = stores.favorites.index('history_id').get(historyId);
                existing.onsuccess = () => {
                    if (existing.result) { set({ fav_id: existing.result.fav_id }); return; }
                    const favorite = { fav_id: this.generateId(), history_id: historyId, label: '', added_at: new Date().toISOString() };
                    stores.favorites.add(favorite); set({ fav_id: favorite.fav_id });
                };
            };
        }));
    }
    static removeFavorite(id) { return this.mutate(() => this.transaction(['favorites'], 'readwrite', stores => stores.favorites.delete(id))); }
    static async checkFavorite(id) {
        const row = await this.request('favorites', store => store.index('history_id').get(id));
        return { is_favorite: !!row, fav_id: row?.fav_id };
    }
    static async getFavorites(page, limit) {
        const favorites = await this.request('favorites', store => store.getAll());
        favorites.sort((a, b) => (b.added_at || '').localeCompare(a.added_at || '') || String(b.fav_id).localeCompare(String(a.fav_id)));
        const rows = await Promise.all(favorites.slice((page - 1) * limit, page * limit).map(async f => {
            const row = await this.request('history', store => store.get(f.history_id));
            return { ...(row || f), fav_id: f.fav_id };
        }));
        return { data: await this.listRows(rows), page, total_pages: Math.max(1, Math.ceil(favorites.length / limit)) };
    }
    static clearAll() {
        return this.mutate(() => this.transaction(['history', 'favorites', 'assets'], 'readwrite', stores => {
            for (const store of Object.values(stores)) store.clear();
        }));
    }

    static async migrateLegacy(onProgress = () => {}) {
        if (this.migrating) return 0;
        this.migrating = true;
        let converted = 0, after;
        try {
            while (true) {
                const batch = await this.request('history', store => store.getAll(after === undefined ? null : IDBKeyRange.lowerBound(after, true), 25));
                if (!batch.length) break;
                for (const candidate of batch) {
                    after = candidate.id;
                    if (!candidate.thumbnail) continue;
                    await this.mutate(async () => {
                        const row = await this.request('history', store => store.get(candidate.id));
                        if (!row?.thumbnail) return;
                        const { record, asset } = await this.pack(row);
                        await this.transaction(['history', 'assets'], 'readwrite', stores => { stores.history.put(record); stores.assets.put(asset); });
                        converted++;
                    });
                }
                onProgress(converted);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            await this.mutate(() => this.transaction(['history', 'favorites'], 'readwrite', stores => {
                const request = stores.favorites.openCursor();
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return;
                    const f = cursor.value;
                    const exists = stores.history.get(f.history_id);
                    exists.onsuccess = () => {
                        // Preserve legacy orphan favorites, which may be the only remaining copy.
                        if (exists.result) cursor.update({ fav_id: f.fav_id, history_id: f.history_id, label: f.label || '', added_at: f.added_at });
                        cursor.continue();
                    };
                };
            }));
            return converted;
        } finally { this.migrating = false; }
    }

    static async backupBlob() {
        const data = await this.transaction(['history', 'favorites', 'assets'], 'readonly', (stores, set) => {
            const result = { version: 2 };
            for (const name of ['history', 'favorites', 'assets']) {
                const request = stores[name].getAll(); request.onsuccess = () => { result[name] = request.result; };
            }
            set(result);
        });
        const parts = ['{"version":2,"history":', JSON.stringify(data.history), ',"favorites":', JSON.stringify(data.favorites), ',"assets":['];
        for (let i = 0; i < data.assets.length; i++) {
            const asset = data.assets[i];
            if (i) parts.push(',');
            parts.push(JSON.stringify({ id: asset.id, image: await this.imageUri(asset.image), encoding: asset.encoding,
                meta: asset.metadata ? uint8ToBase64(new Uint8Array(await asset.metadata.arrayBuffer())) : null }));
        }
        parts.push(']}');
        return new Blob(parts, { type: 'application/json' });
    }
    static async exportData() {
        const blob = await this.backupBlob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.href = url; link.download = `nsync_local_backup_${Date.now()}.json`;
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
        showToast('バックアップをダウンロードしました', 'ok');
    }
    static decodeAsset(asset) {
        if (!['gzip', 'raw'].includes(asset.encoding)) throw new Error('未対応の圧縮形式です');
        if (asset.meta != null && (typeof asset.meta !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(asset.meta))) throw new Error('無効なメタデータです');
        return { id: asset.id, image: this.decodeImage(asset.image), encoding: asset.encoding,
            metadata: asset.meta == null ? null : new Blob([base64ToUint8(asset.meta)]) };
    }
    static async readBackup(file) {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.history) || !Array.isArray(data.favorites) || (data.version != null && ![1, 2].includes(data.version))) throw new Error('無効なバックアップです');
        if (data.version === 2 && !Array.isArray(data.assets)) throw new Error('画像データがありません');
        return data;
    }
    static async importData(file) {
        const data = await this.readBackup(file);
        // Validate and convert everything BEFORE the clearing transaction.
        const assets = new Map();
        for (const encoded of data.assets || []) {
            if (assets.has(encoded.id)) throw new Error('画像IDが重複しています');
            const asset = this.decodeAsset(encoded); await this.restoreAsset(asset); assets.set(asset.id, asset);
        }
        const histories = [], ids = new Set(), favorites = [], favoriteIds = new Set();
        for (const row of data.history) {
            if (!row || !['string', 'number'].includes(typeof row.id) || ids.has(row.id) || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) throw new Error('無効な履歴ID・日時です');
            ids.add(row.id);
            const { record, asset } = await this.pack(row);
            if (asset) assets.set(row.id, asset);
            if (record.storage_version === 2 && !assets.has(row.id)) throw new Error('履歴の画像が不足しています');
            histories.push(record);
        }
        for (const f of data.favorites) {
            if (!f || !['string', 'number'].includes(typeof f.fav_id) || favoriteIds.has(f.fav_id)) throw new Error('無効なお気に入りIDです');
            favoriteIds.add(f.fav_id);
            if (ids.has(f.history_id)) favorites.push({ fav_id: f.fav_id, history_id: f.history_id, label: f.label || '', added_at: f.added_at });
            else if (f.thumbnail) { await this.pack(f); favorites.push(f); }
            else throw new Error('お気に入りの参照先がありません');
        }
        return this.mutate(() => this.transaction(['history', 'favorites', 'assets'], 'readwrite', stores => {
            for (const store of Object.values(stores)) store.clear();
            histories.forEach(row => stores.history.add(row));
            favorites.forEach(row => stores.favorites.add(row));
            assets.forEach(asset => stores.assets.add(asset));
        }));
    }
}

    // END LOCAL STORAGE
    class LocalDB extends HistoryStorage {
        static tagsCache = { danbooru: null, e621: null };
        static async loadTags(source) {
            if (this.tagsCache[source]) return this.tagsCache[source];
            const cacheKey = `${source}:${TAG_DATA_VERSION}`;
            
            // Check IndexedDB cache first
            const tx = this.db.transaction('tags', 'readonly');
            const req = tx.objectStore('tags').get(cacheKey);
            const cached = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
            
            if (cached) {
                this.tagsCache[source] = cached;
                return cached;
            }
            
            // Download from URL
            showToast(`${source} のタグデータをダウンロード中...`, 'ok');
            const url = source === 'danbooru' ? TAGS_JSON_DANBOORU : TAGS_JSON_E621;
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error('Tag download HTTP ' + res.status);
                const data = await res.json();
                
                const wTx = this.db.transaction('tags', 'readwrite');
                wTx.objectStore('tags').put(data, cacheKey);
                
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
            position:fixed; top:0; right:0;
            width:min(var(--nsync-panel-width, 340px), 92vw);
            min-width:min(260px, 90vw);
            max-width:92vw;
            height:var(--nsync-panel-height, 100dvh); z-index:99999;
            background:#12101a;
            border-left:1px solid #2d2040;
            display:flex; flex-direction:column;
            transform:translateX(100%);
            transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);
            pointer-events:none;
            box-shadow:-6px 0 24px rgba(0,0,0,0.7);
            font-family:'Segoe UI','Hiragino Sans',sans-serif;
        }
        #nsync-panel.open { transform:translateX(0); pointer-events:auto; }

        /* スマホ: 画面幋50%の右半分に和える */
        @media (max-width:768px) {
            #nsync-panel { width:min(var(--nsync-panel-width, 340px), 92vw); }
            #nsync-tab { font-size:11px; padding:12px 6px; }
        }
        #nsync-panel-resize {
            position:fixed; top:0; right:calc(min(var(--nsync-panel-width, 340px), 92vw) - 9px);
            width:22px; height:var(--nsync-panel-height, 100dvh);
            cursor:ew-resize; touch-action:none; z-index:100000;
            display:flex; align-items:center; justify-content:center;
            opacity:0; pointer-events:none;
        }
        #nsync-panel-resize::after {
            content:''; width:4px; height:54px; border-radius:999px;
            background:rgba(157,127,212,0.42);
            box-shadow:0 0 10px rgba(0,0,0,0.45);
            transition:background 0.2s, height 0.2s;
        }
        #nsync-panel.open ~ #nsync-panel-resize {
            opacity:1; pointer-events:auto;
        }
        #nsync-panel-resize:hover::after,
        #nsync-panel-resize.resizing::after {
            height:86px; background:rgba(196,168,232,0.78);
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
        .nsync-detail-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 6px; padding: 10px; }
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
    function getNsyncViewportHeight() {
        const vv = window.visualViewport;
        return Math.round(vv ? vv.height : window.innerHeight);
    }

    function applyNsyncPanelHeight() {
        const height = getNsyncViewportHeight();
        if (!height) return;
        document.documentElement.style.setProperty('--nsync-panel-height', height + 'px');
    }

    function initNsyncPanelHeightLock() {
        applyNsyncPanelHeight();

        if (window.__NLOCAL_HEIGHT_LOCK_STARTED__) return;
        window.__NLOCAL_HEIGHT_LOCK_STARTED__ = true;

        window.addEventListener('resize', applyNsyncPanelHeight, { passive: true });
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', applyNsyncPanelHeight, { passive: true });
            window.visualViewport.addEventListener('scroll', applyNsyncPanelHeight, { passive: true });
        }
    }

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
                <div id="nsync-header-title">N-Local</div>
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
                <button class="nsync-page-btn" id="nsync-prev">◀</button>
                <span id="nsync-page-info">1 / 1</span>
                <button class="nsync-page-btn" id="nsync-next">▶</button>
            </div>
            <div style="padding:10px; border-top:1px solid #3d2960; text-align:center;">
                <!-- 既存の「データ管理」ボタンを「設定 / データ」に変更 -->
                <button id="nsync-backup-btn" style="width:100%;padding:10px;background:#6e40c9;color:#fff;border:none;border-radius:5px;cursor:pointer;margin-bottom:8px;">⚙ 設定 / データ</button>
                
                <!-- 既存機能 -->
                <button id="nsync-grid-btn" style="width:100%;padding:10px;background:#2d2040;color:#c4a8e8;border:none;border-radius:5px;cursor:pointer;margin-bottom:8px;">🖼️ グリッド表示</button>
                
                <!-- 一括置換機能 -->
                <button id="nsync-replace-btn" style="width:100%;padding:10px;background:#2d2040;color:#c4a8e8;border:none;border-radius:5px;cursor:pointer;margin-bottom:8px;">🔍 一括置換</button>
                
                <label style="display:block;margin-bottom:6px;">生成回数 <input id="nsync-batch-input" type="number" min="1" max="10000" value="10" style="width:70px;"></label>
                <span id="nsync-batch-progress"></span>
                <button id="nsync-batch-btn" style="width:100%;padding:10px;background:#1a1025;color:#c4a8e8;border:1px solid #3d2960;border-radius:5px;cursor:pointer;">
                    ▶ 開始
                </button>
            </div>
        `;

        document.body.appendChild(panel);
        initPanelResize(panel);

        // トースト
        const toast = document.createElement('div');
        toast.id = 'nsync-toast';
        document.body.appendChild(toast);

        // イベント設定
        panel.querySelector('#nsync-close').addEventListener('click', togglePanel);
        panel.querySelector('#nsync-prev').addEventListener('click', () => loadPage(currentPage - 1));
        panel.querySelector('#nsync-next').addEventListener('click', () => loadPage(currentPage + 1));

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

        // バッチ生成
        panel.querySelector('#nsync-batch-btn').addEventListener('click', toggleBatchGeneration);

        // グリッドビュー
        
        panel.querySelector('#nsync-grid-btn').addEventListener('click', showSessionGrid);
        
        panel.querySelector('#nsync-backup-btn').addEventListener('click', () => {
            document.getElementById('nsync-overlay')?.remove();
            const overlay = document.createElement('div');
            overlay.id = 'nsync-overlay';
            
            const dbUser = localStorage.getItem('nsync-api-danbooru-user') || '';
            const dbKey = localStorage.getItem('nsync-api-danbooru-key') || '';
            const e6User = localStorage.getItem('nsync-api-e621-user') || '';
            const e6Key = localStorage.getItem('nsync-api-e621-key') || '';

            overlay.innerHTML = `
                <div id="nsync-detail-box" style="width:320px; padding:20px; text-align:center;">
                    <h3 style="color:#9d7fd4;margin-top:0;margin-bottom:15px;">⚙ 設定 / データ管理</h3>
                    
                    <!-- API設定 -->
                    <div style="text-align:left; margin-bottom:15px; padding:10px; background:#1a1025; border:1px solid #2d2040; border-radius:6px;">
                        <div style="color:#c4a8e8; font-size:12px; font-weight:bold; margin-bottom:8px;">Danbooru API連携</div>
                        <input id="set-db-user" type="text" placeholder="Username (任意)" value="${esc(dbUser)}" style="width:100%; box-sizing:border-box; margin-bottom:6px; padding:6px; background:#0a0910; border:1px solid #3d2960; color:#fff; border-radius:4px; font-size:11px;">
                        <input id="set-db-key" type="password" placeholder="API Key (任意)" value="${esc(dbKey)}" style="width:100%; box-sizing:border-box; padding:6px; background:#0a0910; border:1px solid #3d2960; color:#fff; border-radius:4px; font-size:11px;">
                        <div style="font-size:9px; color:#7a5fa8; margin-top:4px;">※未入力でも動作しますが、設定すると制限が緩和されます。</div>
                    </div>
                    
                    <div style="text-align:left; margin-bottom:15px; padding:10px; background:#1a1025; border:1px solid #2d2040; border-radius:6px;">
                        <div style="color:#c4a8e8; font-size:12px; font-weight:bold; margin-bottom:8px;">e621 API連携</div>
                        <input id="set-e6-user" type="text" placeholder="Username (任意 / User-Agent用)" value="${esc(e6User)}" style="width:100%; box-sizing:border-box; margin-bottom:6px; padding:6px; background:#0a0910; border:1px solid #3d2960; color:#fff; border-radius:4px; font-size:11px;">
                        <input id="set-e6-key" type="password" placeholder="API Key (任意)" value="${esc(e6Key)}" style="width:100%; box-sizing:border-box; padding:6px; background:#0a0910; border:1px solid #3d2960; color:#fff; border-radius:4px; font-size:11px;">
                    </div>
                    
                    <button id="nsync-save-settings" style="width:100%;padding:10px;margin-bottom:15px;background:#6e40c9;color:#fff;border:none;border-radius:5px;cursor:pointer;">⚙ 設定を保存する</button>

                    <div style="border-top:1px solid #2d2040; margin:15px 0;"></div>
                    
                    <!-- バックアップ -->
                    <h4 style="color:#9d7fd4;margin:0 0 10px 0;font-size:11px;text-align:left;">💾 ローカルデータ管理</h4>
                    <p style="font-size:10px;color:#888;margin-bottom:15px;text-align:left;line-height:1.4;">
                        スマホ単独版では画像履歴はブラウザ内部に保存されます。サイトデータの削除等で消える前にJSON形式でエクスポートして保護してください。
                    </p>
                    <button id="nsync-do-export" style="width:100%;padding:10px;margin-bottom:10px;background:#1a1025;color:#c4a8e8;border:1px solid #3d2960;border-radius:5px;cursor:pointer;">📥 バックアップをダウンロード</button>
                    
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
            
            // API設定の保存
            document.getElementById('nsync-save-settings').addEventListener('click', () => {
                localStorage.setItem('nsync-api-danbooru-user', document.getElementById('set-db-user').value.trim());
                localStorage.setItem('nsync-api-danbooru-key', document.getElementById('set-db-key').value.trim());
                localStorage.setItem('nsync-api-e621-user', document.getElementById('set-e6-user').value.trim());
                localStorage.setItem('nsync-api-e621-key', document.getElementById('set-e6-key').value.trim());
                showToast('API設定を保存しました', 'ok');
            });

            document.getElementById('nsync-close-backup').addEventListener('click', () => overlay.remove());
            document.getElementById('nsync-do-export').addEventListener('click', () => LocalDB.exportData().catch(error => showToast('バックアップ失敗: ' + error.message, 'error')));
            document.getElementById('nsync-do-preview').addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    previewBackup(e.target.files[0]);
                    overlay.remove();
                }
            });
            document.getElementById('nsync-do-clear').addEventListener('click', () => {
                if (confirm('ブラウザが保持している全履歴とお気に入りを消去します。本当によろしいですか？（ダウンロード済みのバックアップファイルは消えません）')) {
                    LocalDB.clearAll().then(() => {
                        failedSaves.clear(); updateSaveStatus();
                        showToast('すべての履歴を消去しました', 'ok');
                        if (activeTab !== 'backup_preview') loadList(1);
                        overlay.remove();
                    }).catch(error => showToast('削除失敗: ' + error.message, 'error'));
                }
            });
        });

        
        // 一括置換機能
        panel.querySelector('#nsync-replace-btn').addEventListener('click', () => {
            document.getElementById('nsync-overlay')?.remove();
            const overlay = document.createElement('div');
            overlay.id = 'nsync-overlay';
            overlay.innerHTML = `
                <div id="nsync-detail-box" style="width:320px; padding:20px; text-align:center;">
                    <h3 style="color:#9d7fd4;margin-top:0;">🔍 一括置換</h3>
                    <div style="text-align:left; font-size:12px; color:#c4a8e8; margin-bottom:15px;">
                        <label style="display:block; margin-bottom:5px;"><input type="checkbox" id="nsync-rep-main" checked> メインプロンプト</label>
                        <label style="display:block;"><input type="checkbox" id="nsync-rep-char" checked> キャラクタープロンプト</label>
                    </div>
                    <div style="margin-bottom:10px; position:relative;">
                        <input type="text" id="nsync-rep-search" autocomplete="off" placeholder="検索ワード (大文字小文字区別)" style="width:100%; padding:8px; box-sizing:border-box; background:#1a1025; color:#fff; border:1px solid #3d2960; border-radius:4px; margin-bottom:10px;">
                        <input type="text" id="nsync-rep-target" autocomplete="off" placeholder="置換ワード" style="width:100%; padding:8px; box-sizing:border-box; background:#1a1025; color:#fff; border:1px solid #3d2960; border-radius:4px;">
                    </div>
                    <button id="nsync-do-replace" style="width:100%;padding:10px;margin-bottom:10px;background:#6e40c9;color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:bold;">✅ 置換を実行</button>
                    <button id="nsync-close-replace" style="width:100%;padding:10px;background:#2d2040;color:#c4a8e8;border:none;border-radius:5px;cursor:pointer;">閉じる</button>
                    <div style="margin-top:10px; font-size:11px; color:#888; text-align:left;">
                        ※キャラクタープロンプトが閉じている場合は自動で展開して置換を試みます。
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const getTextWidth = (text, font) => {
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                context.font = font;
                return context.measureText(text).width;
            };

            // サジェスト機能の追加
            const bindAc = (inputId) => {
                const inputEl = document.getElementById(inputId);
                let debounceTimer;
                const sugBox = document.createElement('div');
                sugBox.style.cssText = 'position:fixed; background:#12101a; border:1px solid #3d2960; border-radius:6px; max-height:220px; overflow-y:auto; z-index:100002; display:none; text-align:left; box-shadow:0 4px 12px rgba(0,0,0,0.5); font-size:13px; color:#fff; min-width:250px;';
                document.body.appendChild(sugBox);

                const updatePos = () => {
                    const rect = inputEl.getBoundingClientRect();
                    const style = window.getComputedStyle(inputEl);
                    const font = `${style.fontWeight || 'normal'} ${style.fontSize} ${style.fontFamily}`;
                    const textBefore = inputEl.value.substring(0, inputEl.selectionStart);
                    
                    let caretX = getTextWidth(textBefore, font) + parseInt(style.paddingLeft);
                    caretX -= inputEl.scrollLeft;
                    
                    let left = rect.left + caretX;
                    if (left + 280 > window.innerWidth) left = window.innerWidth - 290;
                    
                    sugBox.style.left = left + 'px';
                    sugBox.style.bottom = 'auto';
                    sugBox.style.top = (rect.bottom + 5) + 'px';
                };

                inputEl.addEventListener('input', () => {
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(async () => {
                        const val = inputEl.value;
                        const match = val.match(/([^,]*)$/);
                        const query = match ? match[1].trim() : '';
                        if (query.length < 2) {
                            sugBox.style.display = 'none';
                            return;
                        }
                        
                        const source = localStorage.getItem('nsync-tag-source') || 'danbooru';
                        const results = await LocalDB.searchTags(query, source);
                        
                        if (results && results.length > 0) {
                            sugBox.innerHTML = '';
                            updatePos();

                            results.forEach(tag => {
                                const tagName = tag.name.replace(/_/g, ' ');
                                const item = document.createElement('div');
                                item.style.cssText = 'padding:8px 12px; cursor:pointer; color:#c4a8e8; font-size:13px; border-bottom:1px solid #2d2040; font-family:"Source Sans Pro",sans-serif;';
                                item.textContent = tagName;
                                item.addEventListener('mouseenter', () => item.style.background = '#2d2040');
                                item.addEventListener('mouseleave', () => item.style.background = 'transparent');
                                item.addEventListener('mousedown', (e) => { // blurより先に発火させる
                                    e.preventDefault();
                                    const before = val.substring(0, val.lastIndexOf(match[1]));
                                    inputEl.value = before + (before.endsWith(', ') || before === '' ? '' : before.endsWith(',') ? ' ' : '') + tagName;
                                    sugBox.style.display = 'none';
                                    inputEl.focus();
                                });
                                sugBox.appendChild(item);
                            });
                            sugBox.style.display = 'block';
                        } else {
                            sugBox.style.display = 'none';
                        }
                    }, 300);
                });
                
                inputEl.addEventListener('mousedown', (e) => {
                    if (document.activeElement === inputEl && sugBox.style.display === 'block') {
                        sugBox.style.display = 'none';
                        inputEl.dataset.forceClosed = "true";
                    } else {
                        inputEl.dataset.forceClosed = "false";
                    }
                });

                inputEl.addEventListener('focus', () => {
                    if (inputEl.dataset.forceClosed === "true") return;
                    inputEl.dispatchEvent(new Event('input'));
                });

                document.addEventListener('mousedown', (e) => {
                    if (sugBox.style.display !== 'none' && !inputEl.contains(e.target) && !sugBox.contains(e.target)) {
                        sugBox.style.display = 'none';
                    }
                }, true);
                document.addEventListener('touchstart', (e) => {
                    if (sugBox.style.display !== 'none' && !inputEl.contains(e.target) && !sugBox.contains(e.target)) {
                        sugBox.style.display = 'none';
                    }
                }, { capture: true, passive: true });

                const detailBox = document.getElementById('nsync-detail-box');
                if (detailBox) {
                    detailBox.addEventListener('scroll', () => {
                        if (sugBox.style.display === 'block') updatePos();
                    });
                }
                window.addEventListener('resize', () => {
                    if (sugBox.style.display === 'block') updatePos();
                });
            };

            bindAc('nsync-rep-search');
            bindAc('nsync-rep-target');

            document.getElementById('nsync-close-replace').addEventListener('click', () => overlay.remove());
            document.getElementById('nsync-do-replace').addEventListener('click', async () => {
                const doMain = document.getElementById('nsync-rep-main').checked;
                const doNeg = false;
                const doChar = document.getElementById('nsync-rep-char').checked;
                const searchStr = document.getElementById('nsync-rep-search').value;
                const targetStr = document.getElementById('nsync-rep-target').value;

                if (!searchStr) {
                    showToast('検索ワードを入力してください', 'error');
                    return;
                }

                const processVisiblePM = (pm) => {
                    const fullText = pm.innerText;
                    if (fullText.includes(searchStr)) {
                        pm.focus();
                        const range = document.createRange();
                        range.selectNodeContents(pm);
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(range);
                        
                        const newText = fullText.split(searchStr).join(targetStr);
                        document.execCommand('insertText', false, newText);
                        return true;
                    }
                    return false;
                };

                let replacedCount = 0;

                // 1. メインプロンプトとネガティブプロンプトの処理
                const allPms = Array.from(document.querySelectorAll('.ProseMirror'));
                const promptPms = allPms.filter(pm => {
                    return pm.offsetParent !== null &&
                        !pm.closest('.character-prompt-input') &&
                        !pm.closest('[class*="prompt-input-box-character-prompts"]');
                });
                const detectPromptScope = (pm, index) => {
                    if (pm.closest('[class*="prompt-input-box-base-prompt"]')) return 'main';
                    if (pm.closest('[class*="prompt-input-box-undesired"]') ||
                        pm.closest('[class*="prompt-input-box-negative"]') ||
                        pm.closest('[class*="prompt-input-box-uc"]')) {
                        return 'negative';
                    }
                    return index === 1 ? 'negative' : 'main';
                };

                for (let i = 0; i < promptPms.length; i++) {
                    const pm = promptPms[i];
                    const scope = detectPromptScope(pm, i);
                    if (scope === 'main' && doMain) {
                        if (processVisiblePM(pm)) replacedCount++;
                    } else if (scope === 'negative' && doNeg) {
                        if (processVisiblePM(pm)) replacedCount++;
                    }
                }

                // 2. キャラクタープロンプトの逐次処理（アコーディオン仕様のため1つずつ開いて置換する）
                if (doChar) {
                    let initiallyOpenIndex = -1;
                    let charInputs = document.querySelectorAll('.character-prompt-input');
                    
                    // 最初に開いていたものを記憶
                    for (let i = 0; i < charInputs.length; i++) {
                        const pm = charInputs[i].querySelector('.ProseMirror');
                        if (pm && pm.offsetParent !== null) {
                            initiallyOpenIndex = i;
                            break;
                        }
                    }

                    for (let i = 0; i < charInputs.length; i++) {
                        // Reactの再レンダリング対策として毎回取得し直す
                        charInputs = document.querySelectorAll('.character-prompt-input');
                        if (!charInputs[i]) break;
                        
                        const cp = charInputs[i];
                        let pm = cp.querySelector('.ProseMirror');
                        if (!pm) continue;
                        
                        // 閉じている場合は開く
                        if (pm.offsetParent === null) {
                            const btn = cp.querySelector('[role="button"]');
                            if (btn) {
                                btn.click();
                                await new Promise(r => setTimeout(r, 450)); // アニメーションを待機
                                pm = cp.querySelector('.ProseMirror'); // 要素を取り直す
                            }
                        }
                        
                        // 開いた状態で置換実行
                        if (pm && pm.offsetParent !== null) {
                            if (processVisiblePM(pm)) replacedCount++;
                        }
                    }

                    // 最初に開いていたプロンプトを復元する
                    if (initiallyOpenIndex !== -1) {
                        charInputs = document.querySelectorAll('.character-prompt-input');
                        if (charInputs[initiallyOpenIndex]) {
                            const pm = charInputs[initiallyOpenIndex].querySelector('.ProseMirror');
                            if (pm && pm.offsetParent === null) {
                                const btn = charInputs[initiallyOpenIndex].querySelector('[role="button"]');
                                if (btn) {
                                    btn.click();
                                    await new Promise(r => setTimeout(r, 400));
                                }
                            }
                        }
                    }
                }

                overlay.remove();
                if (replacedCount > 0) {
                    showToast(`${replacedCount}箇所のプロンプト枠で置換しました`, 'ok');
                } else {
                    showToast('対象のワードが見つかりませんでした', 'error');
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
    let acPrefix = '';
    let acActivePm = null;
    let acAbsStart = 0;
    let acAbsEnd = 0;
    let acQueryCandidates = [];
    let acSource = localStorage.getItem('nsync-tag-source') || 'danbooru'; // 'danbooru' or 'e621'
    
    // ============================================================
    // === お気に入りタグ（選択回数管理） ===
    // ============================================================
    const FAVORITE_KEY = 'nsync-tag-favorites';
    function getFavoriteCounts() {
        try {
            return JSON.parse(localStorage.getItem(FAVORITE_KEY) || '{}');
        } catch {
            return {};
        }
    }
    function incrementTagSelection(tagName) {
        const counts = getFavoriteCounts();
        counts[tagName] = (counts[tagName] || 0) + 1;
        localStorage.setItem(FAVORITE_KEY, JSON.stringify(counts));
    }
    function isFavoriteTag(tagName) {
        const counts = getFavoriteCounts();
        return (counts[tagName] || 0) >= 3;
    }

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
            .nsync-ac-item.nsync-ac-favorite {
                background: #fff9c4;
                color: #5d4e00;
            }
            .nsync-ac-item.nsync-ac-favorite:hover,
            .nsync-ac-item.nsync-ac-favorite.selected {
                background: #fff59d;
            }
            .nsync-ac-cat-0 { color: #d1c4e9; } /* General */
            .nsync-ac-cat-1 { color: #ff8a65; } /* Artist */
            .nsync-ac-cat-3 { color: #f06292; } /* Copyright */
            .nsync-ac-cat-4 { color: #81c784; } /* Character */
            .nsync-ac-cat-5 { color: #f48fb1; } /* Species (e621) / Meta */
            .nsync-ac-cat-8 { color: #81c784; } /* Lore (e621) */
            .nsync-ac-count { color: #7a5fa8; font-size: 11px; margin-left: auto; margin-right: 6px; }
            .nsync-ac-count-btn {
                min-width: 52px; padding: 6px 8px; border-radius: 999px;
                background: rgba(45,32,64,0.7); border: 1px solid rgba(122,95,168,0.55);
                text-align: center; line-height: 1; touch-action: manipulation;
            }
            .nsync-ac-count-btn:active { background: rgba(110,64,201,0.65); color: #fff; }
            .nsync-ac-wiki {
                text-decoration: none; font-size: 14px; opacity: 0.6; transition: opacity 0.2s;
            }
            .nsync-ac-wiki:hover { opacity: 1; }
            .nsync-ac-empty {
                padding: 12px; text-align: center; color: #7a5fa8; font-size: 12px;
            }
            .nsync-ac-tooltip {
                position: fixed; z-index: 1000000;
                background: #0a0910; border: 1px solid #3d2960; border-radius: 8px;
                padding: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.9);
                display: flex; gap: 6px; pointer-events: auto;
                overflow-x: auto; overflow-y: hidden; scrollbar-width: thin;
                max-width: min(520px, calc(100vw - 20px));
                opacity: 0; transition: opacity 0.2s;
            }
            .nsync-ac-tooltip-loading {
                min-width: 180px; min-height: 64px; align-items: center; justify-content: center;
                color: #c4a8e8; font-size: 12px;
            }
            .nsync-ac-tooltip img {
                width: 96px; height: 96px; object-fit: cover; border-radius: 4px; border: 1px solid #2d2040;
                background: #110d18;
                flex: 0 0 auto;
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
        const hideOnInteraction = (e) => {
            const inPreview = e.target && e.target.closest && e.target.closest('.nsync-ac-tooltip-popup');
            if (inPreview) {
                window._acPreviewInteracting = true;
                setTimeout(() => { window._acPreviewInteracting = false; }, 500);
                return;
            }
            if (acPopup.style.display !== 'none' && !acPopup.contains(e.target)) {
                hideAutocomplete();
                const pm = e.target && e.target.closest ? e.target.closest('.ProseMirror') : null;
                if (pm) {
                    _acForceClose = true;
                    _acLastText = pm.textContent || '';
                }
            }
        };
        // ProseMirrorがclickイベントの伝播を止めるため、captureフェーズのmousedown/touchstartで検知する
        document.addEventListener('mousedown', hideOnInteraction, true);
        document.addEventListener('touchstart', hideOnInteraction, { capture: true, passive: true });

        let _acLastFocusedPm = null;
        document.addEventListener('focusin', (e) => {
            const pm = e.target && e.target.closest ? e.target.closest('.ProseMirror') : null;
            if (pm && pm !== _acLastFocusedPm) {
                hideAutocomplete();
                _acLastQuery = '';
            }
            _acLastFocusedPm = pm || _acLastFocusedPm;
        });
        document.addEventListener('focusout', (e) => {
            setTimeout(() => {
                const active = document.activeElement;
                const inPm = active && active.closest && active.closest('.ProseMirror');
                const inAc = acPopup && acPopup.contains(active);
                if (window._acPreviewInteracting) return;
                if (!inPm && !inAc) {
                    hideAutocomplete();
                }
            }, 100);
        });
    }

    let _acDebounceTimer = null;
    let _acLastQuery = '';
    let _acForceClose = false;
    let _acLastText = '';

    async function handleAcInput(e) {
        if (typeof dpadInserting !== 'undefined' && dpadInserting) return;
        const pm = e.target && e.target.closest ? e.target.closest('.ProseMirror') : null;
        if (!pm) return;

        const currentText = pm.textContent || '';
        if (_acForceClose) {
            if (currentText === _acLastText) {
                // テキストが変更されていないのにinputイベントが発火した（カーソル移動など）場合は無視する
                return;
            } else {
                _acForceClose = false;
            }
        }
        _acLastText = currentText;

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return hideAutocomplete();
        
        if (!pm.contains(selection.focusNode)) return hideAutocomplete();

        // TreeWalkerを使って完全に同期されたカーソル位置とテキストを取得
        const absOffset = getAbsoluteOffset(pm, selection.focusNode, selection.focusOffset);
        const fullText = getFullText(pm);
        const text = fullText.substring(0, absOffset);
        
        const lastComma = Math.max(text.lastIndexOf(','), text.lastIndexOf('\n'));
        const currentWord = text.substring(lastComma + 1);

        // NovelAIの重み付け構文(0.5::)や括弧({,[,()をプレフィックスとして分離
        const regex = /^((?:[\{\[\(\s]*[\-－−‐]?[0-9.]+::)?[\{\[\(\s]*)(.*)$/;
        const match = currentWord.match(regex);
        const prefix = match ? match[1] : '';
        let searchWord = match ? match[2] : currentWord;

        // 末尾の :: や途中の :: を検索ワードから除去（強調構文内編集時の誤検索防止）
        searchWord = searchWord.replace(/::/g, '').trim();

        if (searchWord.length >= 2 && searchWord.length <= 50) {
            const query = searchWord.replace(/\s+/g, '_').toLowerCase();
            const candidates = [{ query, absStart: absOffset - currentWord.length, prefix }];
            const parts = searchWord.split(/\s+/).filter(Boolean);
            for (let i = 1; i < parts.length; i++) {
                const suffixText = parts.slice(i).join(' ');
                const suffixQuery = suffixText.replace(/\s+/g, '_').toLowerCase();
                if (suffixQuery.length >= 2 && suffixQuery.length <= 50 && !candidates.some(c => c.query === suffixQuery)) {
                    candidates.push({ query: suffixQuery, absStart: absOffset - suffixText.length, prefix: '' });
                }
            }
            
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

            acPrefix = prefix;
            
            acActivePm = pm;
            acAbsStart = candidates[0].absStart;
            acAbsEnd = absOffset;
            acQueryCandidates = candidates;

            // デバウンス + 同一クエリスキップで高速化・誤タップ防止
            if (_acDebounceTimer) clearTimeout(_acDebounceTimer);
            const queryKey = candidates.map(c => c.query).join('|');
            if (queryKey === _acLastQuery && acPopup.style.display !== 'none') return;
            _acDebounceTimer = setTimeout(async () => {
                _acLastQuery = queryKey;
                await fetchAndShowSuggestions(queryKey);
            }, 120);
        } else {
            hideAutocomplete();
        }
    }

    async function fetchTagImages(tagName, source) {
        if (!tagName) return { urls: [], error: null };
        if (tagImageCache[source] && tagImageCache[source][tagName]) {
            return { urls: tagImageCache[source][tagName], error: null };
        }
        
        let url = '';
        let headers = {};
        const limit = 5;
        
        if (source === 'danbooru') {
            const dbUser = localStorage.getItem('nsync-api-danbooru-user') || '';
            const dbKey = localStorage.getItem('nsync-api-danbooru-key') || '';
            const params = new URLSearchParams({
                tags: `${tagName} order:score`,
                limit: String(limit)
            });
            if (dbUser && dbKey) {
                params.set('login', dbUser);
                params.set('api_key', dbKey);
            }
            url = `https://danbooru.donmai.us/posts.json?${params.toString()}`;
            // CORS回避のためプロキシを経由 (Local版)
            
        } else if (source === 'e621') {
            const e6User = localStorage.getItem('nsync-api-e621-user') || '';
            const e6Key = localStorage.getItem('nsync-api-e621-key') || '';
            const params = new URLSearchParams({
                tags: `${tagName} order:score`,
                limit: String(limit)
            });
            url = `https://e621.net/posts.json?${params.toString()}`;
            headers['User-Agent'] = `${e6User || 'NSyncUser'}/1.0 (NovelAI Local Panel)`;
            if (e6User && e6Key) {
                headers['Authorization'] = 'Basic ' + btoa(`${e6User}:${e6Key}`);
            }
        } else {
            return { urls: [], error: 'Unknown source' };
        }
        
        try {
            
            // use GM_xmlhttpRequest bridge
            const res = await new Promise((resolve, reject) => {
                const id = Math.random().toString(36).substr(2, 9);
                const handler = (e) => {
                    window.removeEventListener('nsync-gm-response-' + id, handler);
                    if (e.detail.error) reject(new Error(e.detail.text));
                    else resolve(e.detail);
                };
                window.addEventListener('nsync-gm-response-' + id, handler);
                window.dispatchEvent(new CustomEvent('nsync-gm-fetch', { detail: { id, url, headers } }));
            });

            if (!res.ok) throw new Error('API error ' + res.status);
            
            let data = res.json;
            if (!data) throw new Error('Invalid JSON format');
            if (data.error) throw new Error(data.error || data.message);
            
            const urls = [];
            if (source === 'danbooru') {
                for (let p of data) {
                    const variants = (p.media_asset && Array.isArray(p.media_asset.variants)) ? p.media_asset.variants : [];
                    const picked =
                        variants.find(v => v.type === '180x180' && v.url) ||
                        variants.find(v => v.type === '360x360' && v.url) ||
                        variants.find(v => v.type === 'sample' && v.url);
                    let imgUrl = picked && picked.url;
                    if (!imgUrl) imgUrl = p.preview_file_url || p.large_file_url || p.file_url;
                    if (imgUrl && imgUrl.startsWith('/')) imgUrl = 'https://danbooru.donmai.us' + imgUrl;
                    if (imgUrl) urls.push(imgUrl);
                }
            } else if (source === 'e621') {
                const posts = data.posts || data;
                for (let p of posts) {
                    if (p.preview && p.preview.url) urls.push(p.preview.url);
                    else if (p.sample && p.sample.url) urls.push(p.sample.url);
                    else if (p.file && p.file.url) urls.push(p.file.url);
                }
            }
            
            tagImageCache[source][tagName] = urls;
            return { urls, error: null };
        } catch (e) {
            console.error('[N-Local] fetchTagImages error:', e);
            return { urls: [], error: e.message };
        }
    }

    async function fetchAndShowSuggestions(queryKey) {
        try {
            const candidates = acQueryCandidates.length
                ? acQueryCandidates
                : [{ query: queryKey, absStart: acAbsStart, prefix: acPrefix }];
            let emptyQuery = candidates[0].query;

            for (const candidate of candidates) {
                const data = await LocalDB.searchTags(candidate.query, acSource);
                if (data && data.length > 0) {
                    acAbsStart = candidate.absStart;
                    acPrefix = candidate.prefix;
                    showAutocomplete(data, candidate.query);
                    return;
                }
            }

            acAbsStart = candidates[0].absStart;
            acPrefix = candidates[0].prefix;
            showAutocomplete([], emptyQuery);
        } catch (err) {
            console.error('[N-Local] Autocomplete error:', err);
        }
    }

    function positionTagPreview(tooltip) {
        if (!tooltip || !acPopup) return;

        const margin = 10;
        const popupRect = acPopup.getBoundingClientRect();
        const ttW = Math.min(tooltip.offsetWidth || 220, window.innerWidth - margin * 2);
        const ttH = tooltip.offsetHeight || 82;

        let leftPos = popupRect.left + (popupRect.width - ttW) / 2;
        let topPos = popupRect.top - ttH - 8;

        if (topPos < margin) topPos = popupRect.bottom + 8;
        if (leftPos + ttW > window.innerWidth - margin) leftPos = window.innerWidth - ttW - margin;
        if (leftPos < margin) leftPos = margin;

        tooltip.style.left = `${leftPos}px`;
        tooltip.style.top = `${topPos}px`;
        tooltip.style.maxWidth = `${window.innerWidth - margin * 2}px`;
    }

    function showAutocomplete(items, query) {
        // お気に入りタグを上位にソート（3回以上選択されたものを優先）
        const counts = JSON.parse(localStorage.getItem('nsync-tag-favorites') || "{}");
        items.sort((a, b) => {
            const ca = counts[a.name] || 0;
            const cb = counts[b.name] || 0;
            if (ca >= 3 && cb < 3) return -1;
            if (cb >= 3 && ca < 3) return 1;
            if (ca !== cb) return cb - ca;
            return 0;
        });
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
                div.className = `nsync-ac-item nsync-ac-cat-${item.category}${isFavoriteTag(item.name) ? " nsync-ac-favorite" : ""}`;
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
                    <span class="nsync-ac-count nsync-ac-count-btn" style="cursor:pointer;" title="タップして上位画像を表示">${fmtCount}</span>
                    <a href="${wikiUrl}" target="_blank" class="nsync-ac-wiki" title="Wikiを開く">🌐</a>
                `;
                
                const countSpan = div.querySelector('.nsync-ac-count-btn');
                countSpan.dataset.tag = item.name;
                const keepAutocompleteOpen = (e) => {
                    window._acPreviewInteracting = true;
                    e.preventDefault();
                    e.stopPropagation();
                    setTimeout(() => { window._acPreviewInteracting = false; }, 500);
                };
                countSpan.addEventListener('pointerdown', keepAutocompleteOpen);
                countSpan.addEventListener('mousedown', keepAutocompleteOpen);
                countSpan.addEventListener('touchstart', keepAutocompleteOpen, { passive: false });
                const openTagPreview = async (e) => {
                    keepAutocompleteOpen(e);
                    const now = Date.now();
                    if (countSpan._lastPreviewTap && now - countSpan._lastPreviewTap < 350) return;
                    countSpan._lastPreviewTap = now;
                    e.stopPropagation();
                    const tagName = countSpan.dataset.tag;
                    
                    let existing = document.querySelector('.nsync-ac-tooltip-popup');
                    if (existing && existing.dataset.tag === tagName) {
                        existing.remove();
                    }
                    
                    document.querySelectorAll('.nsync-ac-tooltip-popup').forEach(el => el.remove());

                    const tooltip = document.createElement('div');
                    tooltip.className = 'nsync-ac-tooltip nsync-ac-tooltip-popup nsync-ac-tooltip-loading';
                    tooltip.dataset.tag = tagName;
                    tooltip.textContent = '画像を読み込み中...';
                    document.body.appendChild(tooltip);
                    positionTagPreview(tooltip);
                    requestAnimationFrame(() => {
                        tooltip.style.opacity = '1';
                    });
                    
                    const origText = countSpan.textContent;
                    countSpan.textContent = '⏳...';
                    
                    const result = await fetchTagImages(tagName, acSource);
                    countSpan.textContent = origText;
                    
                    if (result.error) {
                        showToast('取得エラー: ' + result.error, 'error');
                        return;
                    }
                    if (result.urls.length === 0) {
                        showToast('画像が見つかりませんでした', 'error');
                        return;
                    }
                    
                    const urls = result.urls;
                    tooltip.className = 'nsync-ac-tooltip nsync-ac-tooltip-popup';
                    tooltip.textContent = '';
                    
                    urls.forEach(u => {
                        const img = document.createElement('img');
                        img.src = u;
                        tooltip.appendChild(img);
                    });
                    
                    if (!tooltip.isConnected) document.body.appendChild(tooltip);
                    
                    // サジェストポップアップの上に表示
                    /*
                    const popupRect = acPopup.getBoundingClientRect();
                    const ttW = tooltip.offsetWidth;
                    const ttH = tooltip.offsetHeight;
                    
                    let leftPos = popupRect.left + (popupRect.width - ttW) / 2;
                    let topPos = popupRect.top - ttH - 8;
                    
                    // 上に収まらない場合は下に表示
                    if (topPos < 10) topPos = popupRect.bottom + 8;
                    // 左右のはみ出し補正
                    if (leftPos + ttW > window.innerWidth - 10) leftPos = window.innerWidth - ttW - 10;
                    if (leftPos < 10) leftPos = 10;
                    
                    tooltip.style.left = leftPos + 'px';
                    tooltip.style.top = topPos + 'px';
                    
                    requestAnimationFrame(() => {
                        tooltip.style.opacity = '1';
                    });
                    */
                    positionTagPreview(tooltip);
                };
                countSpan.addEventListener('pointerup', openTagPreview);
                countSpan.addEventListener('click', openTagPreview);
                
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
        if (window._acSwitching) return;
        if (acPopup) acPopup.style.display = 'none';
        document.querySelectorAll('.nsync-ac-tooltip-popup').forEach(el => el.remove());
        acSuggestions = [];
        acQueryCandidates = [];
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
    let dpadViewportTimer = null;
    let dpadRepositionTimer = null;
    let dpadPlaceToken = 0;
    let dpadInserting = false;

    function isMobileDpadViewport() {
        return !!window.visualViewport && (window.innerWidth <= 768 || window.matchMedia('(pointer: coarse)').matches);
    }

    function scheduleDpadViewportRefresh() {
        if (!dpadPopup || dpadPopup.style.display === 'none') return;
        dpadPopup.style.visibility = 'hidden';
        clearTimeout(dpadViewportTimer);
        dpadViewportTimer = setTimeout(() => updateDpadView(), 180);
    }

    function scheduleDpadReposition() {
        clearTimeout(dpadRepositionTimer);
        dpadRepositionTimer = setTimeout(() => updateDpadView(), 1000);
    }

    function initDpad() {
        const style = document.createElement('style');
        style.textContent = `
            .nsync-dpad {
                position: fixed; z-index: 999998; display: none;
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
            .nsync-dpad-delete {
                background: #4a1722; color: #ffb3c1; font-size: 11px !important;
                border: 1px solid #7a2638;
            }
            .nsync-dpad-delete:active { background: #8a2f46; color: #fff; }
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
                <div class="nsync-dp-btn nsync-dp-sub nsync-dpad-delete" title="選択タグを削除">Del</div>
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
        dpadPopup.querySelector('.nsync-dpad-delete').addEventListener('pointerup', (e) => { e.preventDefault(); deleteSelectedTag(); });

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

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', scheduleDpadViewportRefresh);
            window.visualViewport.addEventListener('scroll', scheduleDpadViewportRefresh);
        }
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
        }, isMobileDpadViewport() ? 650 : 300);
    }

    function updateDpadView(keepPosition = false) {
        if (!dpadActiveNode) return;

        const fullText = getFullText(dpadActiveNode);
        const selectedText = fullText.substring(dpadStartIndex, dpadEndIndex);

        if (selectedText.trim().length === 0) {
            return hideDpad();
        }

        const range = getAbsoluteRange(dpadActiveNode, dpadStartIndex, dpadEndIndex);
        const token = ++dpadPlaceToken;
        const deferReveal = isMobileDpadViewport();

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

        if (keepPosition && dpadPopup && dpadPopup.style.display !== 'none') {
            dpadPopup.style.visibility = 'visible';
            return;
        }

        const placeDpad = (reveal) => {
            if (token !== dpadPlaceToken) return;

            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
                dpadHighlightOverlay.innerHTML = '';
                return hideDpad();
            }

            const vv = window.visualViewport;
            const viewportLeft = vv ? vv.offsetLeft : 0;
            const viewportTop = vv ? vv.offsetTop : 0;
            const viewportWidth = vv ? vv.width : window.innerWidth;
            const viewportHeight = vv ? vv.height : window.innerHeight;
            const margin = 10;

            dpadPopup.style.visibility = 'hidden';
            dpadPopup.style.display = 'block';

            const popupRect = dpadPopup.getBoundingClientRect();
            const dpadW = popupRect.width || 128;
            const dpadH = popupRect.height || 128;

            let left = rect.left + rect.width / 2 - dpadW / 2;
            left = Math.max(
                viewportLeft + margin,
                Math.min(left, viewportLeft + viewportWidth - dpadW - margin)
            );

            const belowTop = rect.bottom + margin;
            const aboveTop = rect.top - dpadH - margin;
            const fitsBelow = belowTop + dpadH <= viewportTop + viewportHeight - margin;
            const fitsAbove = aboveTop >= viewportTop + margin;
            let top = fitsBelow || !fitsAbove ? belowTop : aboveTop;
            top = Math.max(
                viewportTop + margin,
                Math.min(top, viewportTop + viewportHeight - dpadH - margin)
            );

            dpadPopup.style.left = `${left}px`;
            dpadPopup.style.top = `${top}px`;
            dpadPopup.style.visibility = reveal ? 'visible' : 'hidden';
        };

        placeDpad(!deferReveal);
        requestAnimationFrame(() => placeDpad(!deferReveal));
        if (deferReveal) {
            setTimeout(() => placeDpad(false), 180);
            setTimeout(() => placeDpad(true), 420);
        }
    }

    function hideDpad() {
        dpadPlaceToken++;
        clearTimeout(dpadViewportTimer);
        clearTimeout(dpadRepositionTimer);
        if (dpadPopup) {
            dpadPopup.style.display = 'none';
            dpadPopup.style.visibility = 'visible';
        }
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
        
        updateDpadView(true);
        scheduleDpadReposition();
    }

    function deleteSelectedTag() {
        if (!dpadActiveNode) return;
        const fullText = getFullText(dpadActiveNode);
        let start = Math.max(0, Math.min(dpadStartIndex, fullText.length));
        let end = Math.max(start, Math.min(dpadEndIndex, fullText.length));

        if (fullText[end] === ',') {
            end += 1;
            if (start === 0) {
                while (end < fullText.length && /\s/.test(fullText[end])) end += 1;
            }
        } else {
            const prevComma = fullText.lastIndexOf(',', start - 1);
            if (prevComma !== -1 && fullText.slice(prevComma + 1, start).trim() === '') {
                start = prevComma;
            }
        }

        const range = getAbsoluteRange(dpadActiveNode, start, end);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        dpadInserting = true;
        document.execCommand('insertText', false, '');

        setTimeout(() => {
            dpadInserting = false;
            hideDpad();
        }, 50);
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
            updateDpadView(true);
            scheduleDpadReposition();
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

        const blobs = window._nsyncSessionBlobs || [];
        const sessionItems = window._nsyncSessionItems || blobs.map(blob => ({ blob, objectUrls: blob._nsyncObjectUrls || [] }));
        if (sessionItems.length === 0) {
            body.innerHTML = '<div style="color:#555;font-size:13px;padding:40px;text-align:center;">このセッションで生成された画像がまだありません</div>';
            header.querySelector('#nsync-grid-count').textContent = '0枚';
            return;
        }

        header.querySelector('#nsync-grid-count').textContent = `${sessionItems.length}枚`;
        body.innerHTML = '';
        
        // メモリ上の配列は生成順になっているので、そのまま逆順（新しい順）で表示
        sessionItems.slice().reverse().forEach((entry, i) => {
            const idx = sessionItems.length - i;
            const blob = entry.blob || entry;
            const url = (_origCreateObjectURL || URL.createObjectURL).call(URL, blob);
            const item = document.createElement('div');
            item.className = 'nsync-grid-item';
            item.innerHTML = `
                <img src="${url}" loading="lazy" alt="Generated #${idx}" />
                <div class="nsync-grid-item-idx">#${idx}</div>
            `;
            item.addEventListener('click', () => openGridLightbox(url, entry, i));
            body.appendChild(item);
        });
    }

    async function hashArrayBuffer(buffer) {
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function hashBlob(blob) {
        if (!blob) return '';
        if (blob._nsyncHash) return blob._nsyncHash;
        const hash = await hashArrayBuffer(await blob.arrayBuffer());
        blob._nsyncHash = hash;
        return hash;
    }

    async function hashImageUrl(url) {
        if (!url || !url.startsWith('blob:')) return '';
        try {
            const res = await fetch(url);
            const blob = await res.blob();
            return await hashBlob(blob);
        } catch (e) {
            return '';
        }
    }

    function clickNovelAIImageElement(el) {
        const target = el.closest('button,[role="button"],a') || el;
        target.scrollIntoView({ block: 'center', inline: 'center' });
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }

    async function selectNovelAIHistoryImage(entry, fallbackUrl, displayIndex) {
        const blob = entry.blob || entry;
        const urls = Array.from(new Set([...(entry.objectUrls || []), ...(blob._nsyncObjectUrls || []), fallbackUrl].filter(Boolean)));
        const overlay = document.getElementById('nsync-grid-overlay');
        const currentGridImgs = new Set(Array.from(overlay?.querySelectorAll('img') || []));

        for (const url of urls) {
            const img = Array.from(document.querySelectorAll('img')).find(el => {
                return (el.src === url || el.currentSrc === url) && !currentGridImgs.has(el) && !el.closest('#nsync-grid-overlay') && !el.closest('#nsync-grid-lightbox');
            });
            if (img) {
                overlay?.remove();
                clickNovelAIImageElement(img);
                showToast('NovelAI側の履歴画像を選択しました', 'ok');
                return;
            }
        }

        for (const url of urls) {
            const bgEl = Array.from(document.querySelectorAll('*')).find(el => {
                if (el.closest('#nsync-grid-overlay') || el.closest('#nsync-grid-lightbox')) return false;
                return (getComputedStyle(el).backgroundImage || '').includes(url);
            });
            if (bgEl) {
                overlay?.remove();
                clickNovelAIImageElement(bgEl);
                showToast('NovelAI側の履歴画像を選択しました', 'ok');
                return;
            }
        }

        const targetHash = entry.hash || blob._nsyncHash || (entry.hashPromise ? await entry.hashPromise : await hashBlob(blob));
        if (targetHash) {
            const candidateImgs = Array.from(document.querySelectorAll('img')).filter(el => {
                const src = el.currentSrc || el.src || '';
                return src.startsWith('blob:') && !currentGridImgs.has(el) && !el.closest('#nsync-grid-overlay') && !el.closest('#nsync-grid-lightbox');
            });
            for (const img of candidateImgs) {
                const hash = await hashImageUrl(img.currentSrc || img.src);
                if (hash && hash === targetHash) {
                    overlay?.remove();
                    clickNovelAIImageElement(img);
                    showToast('NovelAI側の履歴画像を選択しました', 'ok');
                    return;
                }
            }
        }

        const chooseButtons = Array.from(document.querySelectorAll('[role="button"][aria-label="choose image"]')).filter(el => {
            return !el.closest('#nsync-grid-overlay') && !el.closest('#nsync-grid-lightbox');
        });
        if (chooseButtons[displayIndex]) {
            overlay?.remove();
            clickNovelAIImageElement(chooseButtons[displayIndex]);
            showToast('NovelAI側の履歴画像を表示順で選択しました', 'ok');
            return;
        }

        showToast('NovelAI側の同じ画像が見つかりませんでした', 'error');
    }

    function openGridLightbox(url, entry = null, displayIndex = -1) {
        document.getElementById('nsync-grid-lightbox')?.remove();

        const lb = document.createElement('div');
        lb.id = 'nsync-grid-lightbox';
        lb.innerHTML = `<img src="${url}" />`;
        lb.addEventListener('click', () => lb.remove());
        const img = lb.querySelector('img');
        if (img && entry) {
            img.style.cursor = 'pointer';
            img.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                lb.remove();
                selectNovelAIHistoryImage(entry, url, displayIndex);
            });
        }

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
    // ============================================================
    // === パネル開閉 ===
    // ============================================================
    function togglePanel() {
        panelOpen = !panelOpen;
        const panel = document.getElementById('nsync-panel');
        if (panelOpen) {
            panel.classList.add('open');
            loadList(1);
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
    function loadList(page = 1) { viewedSessionId = null; LocalDB.beginView(); return loadPage(page); }
    function loadFavorites() { return loadList(1); }
    function loadSessionDetail(id) { viewedSessionId = id; LocalDB.beginView(); return loadPage(1); }
    async function loadPage(page) {
        if (page < 1) return;
        currentPage = page;
        const requestId = ++listRequestId;
        const list = document.getElementById('nsync-list-container');
        if (!list) return;
        list.textContent = '読み込み中...';
        document.getElementById('nsync-prev').disabled = true;
        document.getElementById('nsync-next').disabled = true;
        try {
            let result;
            if (window._isPreviewMode) {
                let rows;
                if (activeTab === 'favorites') rows = window._backupPreviewFavorites;
                else if (viewedSessionId) rows = window._backupPreviewHistory.filter(row => (row.session_id || 'unknown') === viewedSessionId);
                else if (currentSearch) rows = window._backupPreviewHistory.filter(row => LocalDB.matches(row, currentSearch));
                else rows = window._backupPreviewSessions;
                result = { data: rows.slice((page - 1) * LIMIT, page * LIMIT).map(row => ({...row})), total_pages: Math.max(1, Math.ceil(rows.length / LIMIT)) };
            } else if (activeTab === 'favorites') result = await LocalDB.getFavorites(page, LIMIT);
            else if (viewedSessionId) result = await LocalDB.getSessionDetail(viewedSessionId, page, LIMIT);
            else if (currentSearch) result = await LocalDB.searchHistory(currentSearch, page, LIMIT);
            else result = await LocalDB.getSessions(page, LIMIT);
            if (requestId !== listRequestId) return;
            if (activeTab === 'favorites') { result.data.forEach(processThumbnailData); renderFavoritesList(result.data); }
            else if (viewedSessionId) { result.data.forEach(processThumbnailData); renderSessionDetailGrid(result.data, viewedSessionId); }
            else if (currentSearch) {
                list.innerHTML = '';
                for (const row of result.data) { processThumbnailData(row); list.appendChild(createListItem(row, false, !!row.fav_id, row.fav_id)); }
                if (!result.data.length) list.textContent = '履歴がありません';
            } else renderSessionFolders(result.data);
            document.getElementById('nsync-prev').disabled = page <= 1;
            document.getElementById('nsync-next').disabled = page >= result.total_pages;
            document.getElementById('nsync-page-info').textContent = (window._isPreviewMode ? '[Preview] ' : '') + page + ' / ' + result.total_pages;
        } catch (error) {
            if (requestId === listRequestId) list.textContent = '履歴を読み込めませんでした。パネルを開き直してください';
            console.error('[N-Local] Read failed:', error);
        }
    }
    async function restoreHistory(item) {
        try {
            let row;
            if (window._isPreviewMode) {
                row = window._backupPreviewHistory.find(entry => entry.id === item.id) || item;
                row = { ...row };
                if (row._previewAsset) row.thumbnail = await LocalDB.restoreAsset(LocalDB.decodeAsset(row._previewAsset));
            } else {
                row = await LocalDB.getHistoryItem(item.id);
                if (!row && item.fav_id) row = await LocalDB.request('favorites', store => store.get(item.fav_id));
            }
            if (!row?.thumbnail) throw new Error('復元用画像がありません');
            processThumbnailData(row);
            cancelGeneration(); stopBatch();
            await simulateDragAndDrop(row.thumbnail, row._metaB64);
            if (panelOpen) togglePanel();
        } catch (error) { showToast('復元データを読み込めませんでした', 'error'); console.error(error); }
    }
    async function previewBackup(file) {
        try {
            const data = await LocalDB.readBackup(file);
            const assets = new Map((data.assets || []).map(asset => [asset.id, asset]));
            const history = data.history.map(row => ({ ...row, thumbnail: row.thumbnail || assets.get(row.id)?.image,
                _previewAsset: assets.get(row.id) })).sort((a,b) => b.created_at.localeCompare(a.created_at));
            const byId = new Map(history.map(row => [row.id, row]));
            const favorites = data.favorites.map(f => ({ ...(byId.get(f.history_id) || f), fav_id: f.fav_id, history_id: f.history_id }));
            const favoriteIds = new Map(favorites.map(f => [f.history_id, f.fav_id]));
            const sessions = new Map();
            for (const row of history) {
                row.fav_id = favoriteIds.get(row.id) || null;
                const sid = row.session_id || 'unknown';
                if (!sessions.has(sid)) sessions.set(sid, { session_id: sid, count: 0, last_updated: row.created_at, thumbnails: [] });
                const session = sessions.get(sid); session.count++;
                if (session.thumbnails.length < 4) session.thumbnails.push(row.thumbnail);
            }
            window._backupPreviewHistory = history;
            window._backupPreviewFavorites = favorites;
            window._backupPreviewSessions = [...sessions.values()];
            window._isPreviewMode = true;
            activeTab = 'history'; currentSearch = '';
            document.getElementById('nsync-search-input').value = '';
            document.querySelectorAll('.nsync-tab-btn').forEach((b,i) => b.classList.toggle('active', i === 0));
            const title = document.getElementById('nsync-header-title');
            title.textContent = 'N-Local [PREVIEW] ';
            const exit = document.createElement('button'); exit.textContent = '終了'; exit.id = 'nsync-exit-preview';
            exit.onclick = () => {
                window._isPreviewMode = false;
                window._backupPreviewHistory = window._backupPreviewFavorites = window._backupPreviewSessions = null;
                title.textContent = 'N-Local'; loadList(1);
            };
            title.appendChild(exit); loadList(1);
            showToast('バックアップをプレビューしています（上書きしません）', 'ok');
        } catch (error) { showToast('プレビューに失敗: ' + error.message, 'error'); }
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
        const back = document.createElement('button');
        back.textContent = '◀ 戻る';
        back.onclick = () => loadList(1);
        header.append(back, document.createTextNode(' このページ: ' + images.length + '枚'));
        listEl.appendChild(header);
        const grid = document.createElement('div');
        grid.className = 'nsync-detail-grid';
        images.forEach(item => {
            const el = document.createElement('div');
            el.className = 'nsync-detail-item';
            el.dataset.id = item.id;
            const image = document.createElement('img');
            image.alt = '保存画像';
            image.src = item.thumbnail || '';
            image.loading = 'lazy';
            image.onclick = () => restoreHistory(item);
            const star = document.createElement('button');
            star.className = 'nsync-detail-fav' + (item.fav_id ? ' on' : '');
            star.dataset.favId = item.fav_id || '';
            star.textContent = item.fav_id ? '★' : '☆';
            star.onclick = e => { e.stopPropagation(); toggleFavorite(star, item.id); };
            el.append(image, star);
            grid.appendChild(el);
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
            listEl.appendChild(el);
        });
    }

    // ============================================================
    // === リストアイテム生成（共通）===
    // ============================================================
    function createListItem(item, isNew, isFavorite, favId) {
        const el = document.createElement('div');
        el.className = 'nsync-item';
        el.dataset.id = item.id;
        const date = document.createElement('div');
        date.className = 'nsync-item-datetime';
        const normalized = String(item.created_at || '').replace(' ', 'T');
        const timestamp = new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z');
        date.textContent = `${timestamp.getFullYear()}/${pad(timestamp.getMonth() + 1)}/${pad(timestamp.getDate())} ${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())}`;
        const image = document.createElement('img');
        image.alt = '保存画像';
        image.className = 'nsync-thumbnail';
        image.src = item.thumbnail || '';
        image.loading = 'lazy';
        const spacer = document.createElement('div');
        spacer.className = 'nsync-item-spacer';
        const star = document.createElement('button');
        star.className = 'nsync-fav-star' + (favId ? ' on' : '');
        star.dataset.favId = favId || '';
        star.textContent = favId ? '★' : '☆';
        star.onclick = e => { e.stopPropagation(); toggleFavorite(star, item.id); };
        el.onclick = () => restoreHistory(item);
        el.append(date, image, spacer, star);
        return el;
    }

    // ============================================================
    // === お気に入りトグル ===
    // ============================================================
    function toggleFavorite(starBtn, historyId) {
        if (window._isPreviewMode) { showToast('プレビュー中は変更できません', 'error'); return; }
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
                while (offset < metaUint8.length) {
                    if (offset + 12 > metaUint8.length) throw new Error("Invalid metadata");
                    const len = dv.getUint32(offset);
                    if (offset + 12 + len > metaUint8.length) throw new Error("Invalid metadata length");
                    const typeStr = String.fromCharCode(metaUint8[offset+4], metaUint8[offset+5], metaUint8[offset+6], metaUint8[offset+7]);
                    const data = metaUint8.slice(offset+8, offset+8+len);
                    metaChunks.push({ full: metaUint8.slice(offset, offset + 12 + len) });
                    offset += 12 + len;
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

            const applyFileInput = (input) => {
                input.files = dataTransfer.files;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const findRestoreFileInputs = () => {
                const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
                return inputs.map((input, index) => {
                    const accept = (input.getAttribute('accept') || '').toLowerCase();
                    const label = [
                        input.getAttribute('aria-label') || '',
                        input.getAttribute('title') || '',
                        input.id || '',
                        input.name || '',
                        input.closest('[aria-label]')?.getAttribute('aria-label') || '',
                        input.closest('button,[role="button"],label')?.textContent || '',
                        input.parentElement?.textContent || ''
                    ].join(' ').toLowerCase();
                    let score = 0;
                    if (input.closest('.mobile-tray-contents')) score += 80;
                    if (!input.multiple) score += 30;
                    if (accept.includes('image') || accept.includes('png') || accept.includes('*/*')) score += 20;
                    if (/import|upload|image|file|settings|metadata|インポート|アップロード|画像|設定|読み込み/.test(label)) score += 35;
                    if (/mask|reference|vibe|director|素材|参照/.test(label)) score -= 25;
                    const rect = input.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) score += 10;
                    return { input, score, index };
                }).filter(item => item.score > 0)
                    .sort((a, b) => b.score - a.score || a.index - b.index)
                    .map(item => item.input);
            };

            // ─── スマホ判定 (タッチデバイス or 画面幅768px以下) ───
            const isMobile = ('ontouchstart' in window) || window.innerWidth <= 768;

            if (isMobile) {
                let restoredOnMobile = false;
                for (const mobileInput of findRestoreFileInputs()) {
                    try {
                        applyFileInput(mobileInput);
                        restoredOnMobile = true;
                        showToast('✅ スマホ用インポートで設定を復元しました', 'ok');
                        break;
                    } catch(e) {
                        console.error('[N-Local] mobile input injection error', e);
                    }
                }
                if (!restoredOnMobile) {
                    console.warn('[N-Local] restore file input not found; falling back to drop events');
                }
                if (restoredOnMobile) {
                    setTimeout(() => { window._nsyncIsRestoring = false; }, 2000);
                    return;
                }
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
            console.error('[N-Local] D&D simulation error', err);
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
            if (obj && obj instanceof Blob && obj.type && obj.type.startsWith('image/')) {
                obj._nsyncObjectUrls = obj._nsyncObjectUrls || [];
                obj._nsyncObjectUrls.push(url);
                window._nsyncBlobUrlMap = window._nsyncBlobUrlMap || new Map();
                window._nsyncBlobUrlMap.set(url, obj);
                let retained = 0;
                const entries = [...window._nsyncBlobUrlMap.entries()];
                for (let i = entries.length - 1; i >= 0; i--) {
                    retained += entries[i][1].size;
                    if (retained > 16 * 1024 * 1024 || entries.length - i > 100) window._nsyncBlobUrlMap.delete(entries[i][0]);
                }
                if (obj._nsyncObjectUrls.length > 8) obj._nsyncObjectUrls.shift();
                const context = window._nsyncIsRestoring ? null : generation;
                if (context && obj._nsyncProcessed !== context.id) {
                    obj._nsyncProcessed = context.id;
                    if (context) {
                        context.processing++;
                        setTimeout(() => processGeneratedImage(obj, context), 0);
                    }
                }
            }
            return url;
        };

        document.addEventListener('click', (e) => {
            if (e.isTrusted && isGenerateButton(e.target)) beginGeneration();
        }, true);
        // Native button keyboard activation also dispatches click.
        document.addEventListener('change', (e) => {
            if (e.target.matches?.('input[type="file"]')) cancelGeneration();
        }, true);
        document.addEventListener('drop', () => cancelGeneration(), true);

        console.log('[N-Local] URL.createObjectURL patched ✓');
    }

    function initJpegDownloadPopup() {
        if (window._nsyncJpegDownloadPopupReady) return;
        window._nsyncJpegDownloadPopupReady = true;

        const style = document.createElement('style');
        style.textContent = `
            .nsync-jpeg-popup {
                position: fixed; z-index: 1000002;
                display: flex; gap: 6px; align-items: center;
                padding: 6px; border-radius: 6px;
                background: rgba(10, 9, 16, 0.92);
                border: 1px solid #3d2960;
                box-shadow: 0 6px 18px rgba(0,0,0,0.55);
                font-family: 'Segoe UI', sans-serif;
            }
            .nsync-jpeg-popup button {
                background: #1a1025; color: #c4a8e8;
                border: 1px solid #6e40c9; border-radius: 4px;
                padding: 6px 8px; font-size: 11px; font-weight: 700;
                cursor: pointer; white-space: nowrap;
            }
            .nsync-jpeg-popup button:hover { background: #2d2040; color: #fff; }
            .nsync-jpeg-popup .nsync-jpeg-close {
                width: 24px; height: 24px; padding: 0;
                display: flex; align-items: center; justify-content: center;
                color: #8f7ab5;
            }
        `;
        document.head.appendChild(style);

        document.addEventListener('click', (e) => {
            const existing = document.getElementById('nsync-jpeg-popup');
            const inPopup = existing && existing.contains(e.target);
            if (inPopup) return;

            const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
            if (!img || img.closest('#nsync-panel, #nsync-grid-overlay, #nsync-grid-lightbox, #nsync-overlay')) {
                if (existing) existing.remove();
                return;
            }

            const src = img.currentSrc || img.src || '';
            if (!src.startsWith('blob:') && !src.startsWith('data:image/')) {
                if (existing) existing.remove();
                return;
            }

            showJpegDownloadPopup(img);
        }, true);
    }

    function showJpegDownloadPopup(img) {
        document.getElementById('nsync-jpeg-popup')?.remove();

        const rect = img.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 80) return;

        const popup = document.createElement('div');
        popup.id = 'nsync-jpeg-popup';
        popup.className = 'nsync-jpeg-popup';
        popup.innerHTML = `
            <button type="button" class="nsync-jpeg-download">JPEG保存</button>
            <button type="button" class="nsync-jpeg-close" title="閉じる">×</button>
        `;
        document.body.appendChild(popup);

        const popupRect = popup.getBoundingClientRect();
        const margin = 8;
        let left = rect.right - popupRect.width - margin;
        let top = rect.top + margin;
        left = Math.max(margin, Math.min(left, window.innerWidth - popupRect.width - margin));
        top = Math.max(margin, Math.min(top, window.innerHeight - popupRect.height - margin));
        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;

        popup.querySelector('.nsync-jpeg-close').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            popup.remove();
        });
        popup.querySelector('.nsync-jpeg-download').addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await downloadImageAsTwitterJpeg(img);
            popup.remove();
        });
    }

    async function downloadImageAsTwitterJpeg(img) {
        try {
            const src = img.currentSrc || img.src;
            const sourceBlob = window._nsyncBlobUrlMap && window._nsyncBlobUrlMap.get(src);
            const bitmap = sourceBlob
                ? await createImageBitmap(sourceBlob)
                : await new Promise((resolve, reject) => {
                    const image = new Image();
                    image.crossOrigin = 'anonymous';
                    image.onload = () => resolve(image);
                    image.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
                    image.src = src;
                });

            const maxSide = 4096;
            const maxBytes = 5 * 1024 * 1024;
            const maxBytesPerPixel = 1.0;
            const sourceW = bitmap.width || img.naturalWidth;
            const sourceH = bitmap.height || img.naturalHeight;
            if (!sourceW || !sourceH) throw new Error('Invalid image size');

            const encodeJpeg = (width, height, quality) => new Promise((resolve) => {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(bitmap, 0, 0, width, height);
                canvas.toBlob(resolve, 'image/jpeg', quality);
            });
            const fitsXJpegLimits = (candidate, width, height) => {
                if (!candidate) return false;
                if (width > maxSide || height > maxSide) return false;
                if (candidate.size > maxBytes) return false;
                return candidate.size / (width * height) <= maxBytesPerPixel;
            };

            let scale = Math.min(1, maxSide / Math.max(sourceW, sourceH));
            let outW = Math.max(1, Math.round(sourceW * scale));
            let outH = Math.max(1, Math.round(sourceH * scale));
            let blob = null;
            let usedQuality = 0.98;

            for (let resizeAttempt = 0; resizeAttempt < 10; resizeAttempt++) {
                for (const q of [0.98, 0.95, 0.92, 0.9, 0.88, 0.85, 0.82, 0.8, 0.76, 0.72, 0.68, 0.64, 0.6]) {
                    usedQuality = q;
                    blob = await encodeJpeg(outW, outH, q);
                    if (fitsXJpegLimits(blob, outW, outH)) break;
                }
                if (fitsXJpegLimits(blob, outW, outH)) break;
                scale *= 0.92;
                outW = Math.max(1, Math.round(sourceW * scale));
                outH = Math.max(1, Math.round(sourceH * scale));
            }

            if (bitmap.close) bitmap.close();

            if (!blob) throw new Error('JPEG conversion failed');
            if (!fitsXJpegLimits(blob, outW, outH)) throw new Error('Could not fit JPEG within X upload limits');
            const finalBytesPerPixel = blob.size / (outW * outH);
            const bppLabel = finalBytesPerPixel.toFixed(2);
            const bppFileLabel = bppLabel.replace('.', '-');

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            a.href = url;
            a.download = `novelai-x-jpeg-${outW}x${outH}-q${Math.round(usedQuality * 100)}-bpp${bppFileLabel}-${stamp}.jpg`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 3000);
            showToast(`X向けJPEGを書き出しました (${outW}x${outH}, ${(blob.size / 1024 / 1024).toFixed(2)}MB, ${bppLabel}B/px)`, 'ok');
        } catch (err) {
            console.error('[N-Local] JPEG download error:', err);
            showToast('JPEG書き出しに失敗しました', 'error');
        }
    }

    function getButtonLabel(btn) {
        return [
            btn.getAttribute('aria-label') || '',
            btn.getAttribute('title') || '',
            btn.getAttribute('data-testid') || '',
            btn.textContent || ''
        ].join(' ').replace(/\s+/g, ' ').trim();
    }

    function isUsableButton(btn) {
        if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
        const rect = btn.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function isGenerateButton(el) {
        let node = el;
        while (node && node !== document.body) {
            if (node.tagName === 'BUTTON') {
                const label = getButtonLabel(node);
                if (isGenerateButtonLabel(label)) {
                    return true;
                }
            }
            node = node.parentElement;
        }
        return false;
    }

    function isGenerateButtonLabel(label) {
        const normalized = String(label || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return false;
        if (/\bGenerate\b/i.test(normalized) && !/\b(prompt|seed|settings?|history|grid)\b/i.test(normalized)) return true;
        if (/生成/.test(normalized) && !/(履歴|設定|グリッド|プロンプト)/.test(normalized)) return true;
        return false;
    }

    function rememberSessionBlob(blob) {
        if (!blob || blob._nsyncSessionRemembered) return;
        blob._nsyncSessionRemembered = true;
        window._nsyncSessionBlobs = window._nsyncSessionBlobs || [];
        window._nsyncSessionBlobs.push(blob);
        window._nsyncSessionItems = window._nsyncSessionItems || [];
        const hashPromise = hashBlob(blob).catch(() => '');
        window._nsyncSessionItems.push({
            blob,
            objectUrls: blob._nsyncObjectUrls || [],
            hash: blob._nsyncHash || '',
            hashPromise
        });
        let bytes = window._nsyncSessionBlobs.reduce((sum, item) => sum + item.size, 0);
        while (window._nsyncSessionBlobs.length > 100 || bytes > 48 * 1024 * 1024) {
            const oldest = window._nsyncSessionBlobs.shift();
            window._nsyncSessionItems.shift();
            bytes -= oldest.size;
        }
    }

    function cancelGeneration() {
        clearTimeout(generationTimer);
        clearTimeout(generationSettleTimer);
        if (generation) generation.cancelled = true;
        generation = null;
    }
    function beginGeneration() {
        cancelGeneration();
        generation = { id: crypto.randomUUID(), hashes: new Set(), processing: 0, saved: 0, cancelled: false };
        const context = generation;
        generationTimer = setTimeout(() => {
            if (generation !== context) return;
            cancelGeneration();
            stopBatch();
            showToast('生成結果を確認できませんでした。連続生成を停止しました', 'error');
        }, 180000);
        navigator.storage?.persist?.().catch(() => {});
    }
    function settleGeneration(context) {
        if (generation !== context || context.cancelled || !context.saved || context.processing) return;
        clearTimeout(generationSettleTimer);
        generationSettleTimer = setTimeout(() => {
            if (generation !== context || context.processing) return;
            if (!findGenerateButton()) { settleGeneration(context); return; }
            cancelGeneration();
            if (batchOnGenerated) batchOnGenerated();
        }, 2500);
    }
    async function makeThumbnail(blob) {
        const url = _origCreateObjectURL.call(URL, blob);
        try {
            return await new Promise((resolve, reject) => {
                const img = new Image();
                const timer = setTimeout(() => reject(new Error('画像読み込みタイムアウト')), 15000);
                img.onerror = () => { clearTimeout(timer); reject(new Error('画像読み込み失敗')); };
                img.onload = () => {
                    clearTimeout(timer);
                    try {
                        const ratio = Math.min(1, 100 / Math.max(img.width, img.height));
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.max(1, Math.round(img.width * ratio));
                        canvas.height = Math.max(1, Math.round(img.height * ratio));
                        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                        resolve(canvas.toDataURL('image/webp', 0.6));
                    } catch (error) { reject(error); }
                };
                img.src = url;
            });
        } finally { URL.revokeObjectURL(url); }
    }
    async function processGeneratedImage(blob, context) {
        const capturedAt = new Date().toISOString();
        try {
            if (context.cancelled) return;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const chunks = parsePngChunks(bytes);
            const meta = (chunks || []).filter(c => c.type === 'tEXt' || c.type === 'iTXt');
            const comment = meta.find(c => c.type === 'tEXt' && new TextDecoder().decode(c.data).startsWith('Comment\0'));
            // Unrelated preview/reference blobs must not consume a generation slot.
            if (!comment) return;
            const apiData = JSON.parse(new TextDecoder().decode(comment.data).substring(8));
            const hash = await hashArrayBuffer(bytes.buffer);
            if (context.cancelled || context.hashes.has(hash)) return;
            context.hashes.add(hash);
            rememberSessionBlob(blob);
            const p = apiData.parameters || apiData;
            const chars = p.v4_prompt?.caption?.char_captions || [];
            const negatives = p.v4_negative_prompt?.caption?.char_captions || [];
            const cp = chars.length ? chars.map((c, i) => ({ ...c, char_negative: negatives[i]?.char_caption || '' })) :
                (typeof p.characterPrompts === 'string' ? JSON.parse(p.characterPrompts) : p.characterPrompts || []);
            const stripped = stripLargeMetaFields(meta);
            const combined = new Uint8Array(stripped.reduce((n, c) => n + c.full.length, 0));
            let offset = 0;
            for (const chunk of stripped) { combined.set(chunk.full, offset); offset += chunk.full.length; }
            const image = await makeThumbnail(blob);
            const data = {
                event_id: context.id + ':' + hash,
                prompt: p.v4_prompt?.caption?.base_caption ?? p.prompt ?? apiData.prompt ?? '',
                negative_prompt: p.v4_negative_prompt?.caption?.base_caption ?? p.uc ?? p.negative_prompt ?? '',
                model: typeof apiData.model === 'string' ? apiData.model : null,
                scale: p.scale ?? p.guidance_scale ?? null, steps: p.steps ?? null, seed: p.seed ?? null,
                sampler: p.sampler ?? null, width: p.width ?? null, height: p.height ?? null,
                char_prompts_json: cp.length ? JSON.stringify(cp) : null,
                session_id: CURRENT_SESSION_ID, captured_at: capturedAt,
                thumbnail: JSON.stringify({ image, meta: uint8ToBase64(combined) })
            };
            if (await sendToHub(data)) context.saved++;
        } catch (error) {
            stopBatch();
            console.error('[N-Local] Capture failed:', error);
            showToast('履歴の処理に失敗しました。元画像をダウンロードしてください', 'error');
        } finally {
            context.processing--;
            settleGeneration(context);
        }
    }

    const failedSaves = new Map();
    let retrySaveTimer = null;
    let retryingSaves = false;
    async function sendToHub(data) {
        data.id = data.event_id;
        failedSaves.set(data.id, data);
        try {
            await LocalDB.addHistory(data);
            failedSaves.delete(data.id);
            prependToList(data);
            updateSaveStatus();
            return true;
        } catch (error) {
            stopBatch();
            showToast('端末への保存に失敗しました。ページを閉じず空き容量を確認してください', 'error');
            console.error('[N-Local] Save failed:', error);
            updateSaveStatus();
            clearTimeout(retrySaveTimer);
            retrySaveTimer = setTimeout(retryFailedSaves, 10000);
            return false;
        }
    }
    function updateSaveStatus() {
        const badge = document.getElementById('nsync-status');
        if (badge) { badge.textContent = failedSaves.size ? '未保存 ' + failedSaves.size + '件（タップで再試行）' : '● ローカル保存'; badge.onclick = retryFailedSaves; }
    }
    async function retryFailedSaves() {
        if (retryingSaves) return;
        retryingSaves = true;
        try { for (const data of [...failedSaves.values()]) { if (!await sendToHub(data)) break; } }
        finally { retryingSaves = false; }
    }
    window.addEventListener('beforeunload', event => { if (failedSaves.size) { event.preventDefault(); event.returnValue = ''; } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && failedSaves.size) retryFailedSaves(); });

    // ============================================================
    // === バッチ（連続）生成 ===
    // ============================================================
    let wakeLock = null;

    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
            } catch (err) {
                console.warn('[N-Local] Wake Lock request failed:', err);
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
            if (!isUsableButton(btn)) return false;
            const label = getButtonLabel(btn);
            return isGenerateButtonLabel(label);
        });
    }

    function pressGenerateButton(btn) {
        const opts = { bubbles: true, cancelable: true, view: window };
        try {
            btn.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts)));
            btn.dispatchEvent(new MouseEvent('mousedown', opts));
            btn.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, opts)));
            btn.dispatchEvent(new MouseEvent('mouseup', opts));
            btn.dispatchEvent(new MouseEvent('click', opts));
        } catch(e) {
            btn.click();
        }
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
        const target = parseInt(input?.value || '10', 10);
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
        batchWaitAttempts = 0;

        await requestWakeLock();

        // UI更新
        const btn = document.getElementById('nsync-batch-btn');
        btn.className = 'stop';
        btn.textContent = '■ 停止';
        if (input) input.disabled = true;
        updateBatchProgress();

        showToast(`🔄 連続生成を開始 (${target}回)`);
        runNextGeneration();
    }

    function stopBatch() {
        batchRunning = false;
        batchOnGenerated = null;
        batchWaitAttempts = 0;

        releaseWakeLock();

        const btn = document.getElementById('nsync-batch-btn');
        const input = document.getElementById('nsync-batch-input');
        const progress = document.getElementById('nsync-batch-progress');
        if (btn) { btn.className = 'start'; btn.textContent = '▶ 開始'; }
        if (input) input.disabled = false;
        if (progress) {
            progress.classList.remove('active');
            progress.textContent = batchCount > 0 ? `${batchCount}回完了` : '';
        }

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
            batchWaitAttempts++;
            if (batchWaitAttempts <= 90) {
                const progress = document.getElementById('nsync-batch-progress');
                if (progress) {
                    progress.textContent = `${batchCount}/${batchTarget} 待機中`;
                    progress.classList.add('active');
                }
                setTimeout(() => runNextGeneration(), 1000);
            } else {
                showToast('⚠ Generate ボタンが再有効化されませんでした。中断します。', 'error');
                stopBatch();
            }
            return;
        }
        batchWaitAttempts = 0;

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
        beginGeneration();
        pressGenerateButton(genBtn);
    }


    // ============================================================
    // === リストの先頭にエントリを追加（再読込み不要）===
    // ============================================================
    let historyRefreshTimer = null;
    function prependToList(item) {
        if (!item?.id || !panelOpen || activeTab !== 'history' || window._isPreviewMode || currentPage !== 1) return;
        if (viewedSessionId && viewedSessionId !== item.session_id) return;
        clearTimeout(historyRefreshTimer);
        historyRefreshTimer = setTimeout(() => { LocalDB.beginView(); loadPage(1); }, 300);
    }

    // ============================================================
    // === 初期化 ===
    // ============================================================
    function initPanelResize(panel) {
        if (!panel || document.getElementById('nsync-panel-resize')) return;

        const savedWidth = parseInt(localStorage.getItem('nsync-history-panel-width') || '', 10);
        const clampWidth = (width) => {
            const max = Math.max(260, Math.floor(window.innerWidth * 0.92));
            const min = Math.min(260, max);
            return Math.max(min, Math.min(max, Math.round(width)));
        };
        const applyWidth = (width) => {
            const next = clampWidth(width);
            panel.style.width = `${next}px`;
            panel.style.setProperty('--nsync-panel-width', `${next}px`);
            document.documentElement.style.setProperty('--nsync-panel-width', `${next}px`);
            return next;
        };

        if (savedWidth) applyWidth(savedWidth);

        const handle = document.createElement('div');
        handle.id = 'nsync-panel-resize';
        handle.title = 'ドラッグして履歴パネルの幅を変更';
        panel.insertAdjacentElement('afterend', handle);

        let pointerId = null;
        let startX = 0;
        let startWidth = 0;

        const finish = () => {
            if (pointerId === null) return;
            pointerId = null;
            panel.classList.remove('resizing');
            handle.classList.remove('resizing');
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            localStorage.setItem('nsync-history-panel-width', `${panel.offsetWidth}px`);
        };

        handle.addEventListener('pointerdown', (e) => {
            pointerId = e.pointerId;
            startX = e.clientX;
            startWidth = panel.offsetWidth;
            panel.classList.add('resizing');
            handle.classList.add('resizing');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'ew-resize';
            handle.setPointerCapture(e.pointerId);
            e.preventDefault();
            e.stopPropagation();
        });

        handle.addEventListener('pointermove', (e) => {
            if (pointerId !== e.pointerId) return;
            applyWidth(startWidth + (startX - e.clientX));
            e.preventDefault();
        });
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
        window.addEventListener('resize', () => {
            if (panel.style.width) applyWidth(panel.offsetWidth);
        });
    }

    function init() {
        injectStyles();
        initNsyncPanelHeightLock();

        // 起動確認バッジ（15秒後に消える）
        const marker = document.createElement('div');
        marker.id = 'nsync-startup-marker';
        marker.style.cssText = 'position:fixed;bottom:8px;right:8px;background:#7c3aed;color:#fff;padding:3px 8px;border-radius:5px;font-size:11px;z-index:999999;pointer-events:none;font-family:sans-serif;';
        marker.textContent = '⚡N';
        (document.body || document.documentElement).appendChild(marker);
        setTimeout(() => marker.remove(), 15000);

        let done = false;
        let starting = false;
        async function doInit() {
            if (done) return true;
            if (starting || !document.body) return false;
            starting = true;
            try {
                await LocalDB.init();
                buildUI();
                patchObjectURL();
                updateSaveStatus();
                LocalDB.migrateLegacy().then(count => { if (count) showToast(count + "件の履歴を軽量化しました", "ok"); }).catch(error => showToast("軽量化を中断しました（元データは保持）: " + error.message, "error"));
                initJpegDownloadPopup();
                done = true;
                console.log('[N-Local] v1.2.0 Ready');
                return true;
            } catch (error) {
                console.error('[N-Local] Initialization failed; retrying:', error);
                return false;
            } finally {
                starting = false;
            }
        }

        const startedAt = Date.now();
        const t = setInterval(() => {
            const pageReady = document.querySelector('.ProseMirror') ||
                (document.readyState === 'complete' && document.body) ||
                Date.now() - startedAt >= 5000;
            if (pageReady) {
                doInit().then(initialized => {
                    if (initialized) clearInterval(t);
                });
            }
        }, 500);
        window.addEventListener('pageshow', () => {
            if (!done) doInit();
        }, { once: true });
    }

    init();


    
    };

    function injectMainScript() {
        const root = document.documentElement;
        if (!root) return false;
        if (root.dataset.nlocalMainStarted === '1') return true;
        const target = document.head || root;
        if (!target) return false;

        const scriptEl = document.createElement('script');
        scriptEl.textContent = '(' + mainScript.toString() + ')();\n//# sourceURL=NovelAI_Local_Injected.js';
        target.appendChild(scriptEl);
        scriptEl.remove();
        return root.dataset.nlocalMainStarted === '1';
    }

    if (!injectMainScript()) {
        const startedAt = Date.now();
        const retryTimer = setInterval(() => {
            if (injectMainScript() || Date.now() - startedAt >= 30000) {
                clearInterval(retryTimer);
            }
        }, 250);
    }
})();

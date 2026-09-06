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

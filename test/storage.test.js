const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const source = fs.readFileSync(path.join(__dirname, '../src/history-storage.js'), 'utf8');
function makeStorage(factory = new IDBFactory(), extra = {}) {
    const context = vm.createContext({ indexedDB: factory, IDBKeyRange, crypto: webcrypto, Blob, Response, CompressionStream, DecompressionStream,
        navigator: {}, setTimeout, Uint8Array, console,
        base64ToUint8: value => new Uint8Array(Buffer.from(value, 'base64')),
        uint8ToBase64: value => Buffer.from(value).toString('base64'), ...extra });
    vm.runInContext(source + '\nglobalThis.Store = HistoryStorage;', context);
    return context.Store;
}
const thumbnail = JSON.stringify({ image: 'data:image/webp;base64,UklGRg==', meta: Buffer.from('日本語 metadata '.repeat(80)).toString('base64') });
function row(id, session = 's') { return { id, prompt: 'test 日本語', seed: 0, session_id: session, created_at: '2026-01-01T00:00:00.000Z', thumbnail }; }

test('atomic save, same-event retry, separate generations, compression and favorites', async () => {
    const store = makeStorage(); await store.init();
    try {
        const results = await Promise.all(Array.from({ length: 8 }, () => store.addHistory({ ...row('a'), event_id: 'same' })));
        assert.ok(results.every(id => id === 'same'));
        assert.equal(await store.request('history', s => s.count()), 1);
        await store.addHistory({ ...row('b'), event_id: 'different' });
        assert.equal(await store.request('history', s => s.count()), 2);
        const stored = await store.request('history', s => s.get('same'));
        assert.equal(stored.thumbnail, undefined); assert.equal(stored.seed, 0);
        const asset = await store.request('assets', s => s.get('same'));
        assert.equal(asset.encoding, 'gzip'); assert.ok(asset.metadata.size < 200);
        assert.equal((await store.getHistoryItem('same')).thumbnail, thumbnail);
        const favorites = await Promise.all(Array.from({ length: 3 }, () => store.addFavorite('same')));
        assert.ok(favorites.every(f => f.fav_id === favorites[0].fav_id));
        const fav = await store.request('favorites', s => s.get(favorites[0].fav_id));
        assert.equal(fav.thumbnail, undefined);
        const page = await store.getSessionDetail('s', 1, 1);
        assert.equal(page.data.length, 1); assert.equal(page.total_pages, 2);
        assert.ok(!page.data[0]._metaB64); assert.ok(page.data[0].thumbnail.startsWith('data:image/webp'));
    } finally { store.db.close(); }
});

test('v1 upgrade, resumable migration, backup and atomic invalid-import rejection', async () => {
    const factory = new IDBFactory();
    const old = await new Promise((resolve, reject) => {
        const r = factory.open('NovelAILocalDB', 1);
        r.onupgradeneeded = () => {
            const h = r.result.createObjectStore('history', { keyPath: 'id' }); h.createIndex('created_at', 'created_at'); h.createIndex('session_id', 'session_id');
            const f = r.result.createObjectStore('favorites', { keyPath: 'fav_id' }); f.createIndex('history_id', 'history_id');
            r.result.createObjectStore('tags');
        };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
        const tx = old.transaction(['history','favorites'], 'readwrite');
        tx.objectStore('history').add(row('old'));
        tx.objectStore('favorites').add({ ...row('old'), fav_id: 'fav', history_id: 'old' });
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    }); old.close();
    const store = makeStorage(factory); await store.init();
    try {
        assert.equal((await store.getHistoryItem('old')).thumbnail, thumbnail);
        assert.equal(await store.migrateLegacy(), 1);
        assert.equal(await store.migrateLegacy(), 0);
        assert.equal((await store.getHistoryItem('old')).thumbnail, thumbnail);
        assert.equal((await store.request('favorites', s => s.get('fav'))).thumbnail, undefined);
        const backup = await store.backupBlob(); const data = JSON.parse(await backup.text());
        assert.equal(data.version, 2); assert.equal(data.assets.length, 1);
        const fresh = makeStorage(); await fresh.init();
        try {
            await fresh.importData(backup);
            assert.equal((await fresh.getHistoryItem('old')).thumbnail, thumbnail);
            assert.equal((await fresh.checkFavorite('old')).fav_id, 'fav');
            const broken = structuredClone(data); broken.assets = [];
            await assert.rejects(fresh.importData(new Blob([JSON.stringify(broken)])));
            assert.equal(await fresh.request('history', s => s.count()), 1);
            await assert.rejects(fresh.importData(new Blob([JSON.stringify({ history: [row('duplicate'), row('duplicate')], favorites: [] })])));
            assert.equal(await fresh.request('history', s => s.count()), 1);
            await fresh.importData(new Blob([JSON.stringify({ history: [row('legacy')], favorites: [] })]));
            assert.equal((await fresh.getHistoryItem('legacy')).thumbnail, thumbnail);
            await assert.rejects(fresh.transaction(['history','assets'], 'readwrite', stores => {
                stores.history.add(row('rollback')); stores.history.add(row('rollback'));
            }));
            assert.equal(await fresh.request('history', s => s.get('rollback')), undefined);
        } finally { fresh.db.close(); }
    } finally { store.db.close(); }
});

test('all old sessions reachable, accurate counts, wildcard search and stable page snapshot', async () => {
    const store = makeStorage(); await store.init();
    try {
        await store.transaction(['history'], 'readwrite', stores => {
            for (let i = 0; i < 2105; i++) { const value = row(String(i).padStart(5,'0'), 'session-' + i); delete value.thumbnail; stores.history.add(value); }
        });
        const first = await store.getSessions(1, 100); assert.equal(first.total_pages, 22);
        const last = await store.getSessions(22, 100); assert.equal(last.data.length, 5);
        const page1 = await store.searchHistory('test*日本語', 1, 80);
        await store.addHistory({ ...row('newest'), created_at: '2027-01-01T00:00:00Z' });
        const again = await store.searchHistory('test*日本語', 1, 80);
        assert.deepEqual(page1.data.map(r => r.id), again.data.map(r => r.id));
        store.beginView();
        assert.equal((await store.searchHistory('test*日本語', 1, 80)).data[0].id, 'newest');
    } finally { store.db.close(); }
});

test('browsers without compression streams still use lossless binary storage', async () => {
    const store = makeStorage(new IDBFactory(), { CompressionStream: undefined, DecompressionStream: undefined }); await store.init();
    try {
        await store.addHistory(row('raw'));
        assert.equal((await store.request('assets', s => s.get('raw'))).encoding, 'raw');
        assert.equal((await store.getHistoryItem('raw')).thumbnail, thumbnail);
    } finally { store.db.close(); }
});

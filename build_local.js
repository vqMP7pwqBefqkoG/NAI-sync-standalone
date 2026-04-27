const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '../NovelAI_Sync.user.js');
const dstPath = path.join(__dirname, 'NovelAI_Local.user.js');

let code = fs.readFileSync(srcPath, 'utf8');

// 1. Metadata
code = code.replace(/@name\s+NovelAI Sync Panel \(N-Sync\)/, '@name         NovelAI Local Panel (N-Local)');
code = code.replace(/@version\s+[\d\.]+/, '@version      1.0.0');
code = code.replace(/@description.*/, '@description  スマホ単独動作版のNovelAI設定同期ツール。サーバー不要で履歴保存・タグサジェストが可能です。');
code = code.replace(/\/\/ @updateURL.*\n/, '');
code = code.replace(/\/\/ @downloadURL.*\n/, '');

// 2. Remove HUB_URL and add TAGS_URL
code = code.replace(/const isMobile = .*\nconst HUB_SERVER_IP = .*\nconst HUB_PORT = .*\nconst HUB_URL = .*/, `
    // 配信先URL（タグデータ）
    const TAGS_JSON_DANBOORU = 'https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/danbooru_tags.json';
    const TAGS_JSON_E621 = 'https://raw.githubusercontent.com/vqMP7pwqBefqkoG/NAI-sync-standalone/main/e621_tags.json';
`);

// 3. Remove Socket.IO
code = code.replace(/\/\/ === socket\.io 動的ロード ===[\s\S]*?function loadSocketIO[^\}]+\}/, '');
code = code.replace(/loadSocketIO\(\(\) => initSocket\(\)\);/, '');
code = code.replace(/\/\/ === WebSocket 通信 ===[\s\S]*?function initSocket[^\}]+\}[\s\S]*?(?=\/\/ ===)/, '');
code = code.replace(/let socket;\n/, '');

// 4. Inject LocalDB
const localDbCode = `
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
            showToast(\`\${source} のタグデータをダウンロード中...\`, 'ok');
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
            a.download = \`nsync_local_backup_\${new Date().getTime()}.json\`;
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
`;

code = code.replace(/\/\/ === スタイル注入 ===/, localDbCode + '\n    // === スタイル注入 ===');

// 5. Update fetchAndShowSuggestions
code = code.replace(/async function fetchAndShowSuggestions[\s\S]*?function showAutocomplete/, `
    async function fetchAndShowSuggestions(query) {
        try {
            const data = await LocalDB.searchTags(query, acSource);
            showAutocomplete(data || [], query);
        } catch (err) {
            console.error('[N-Sync] Autocomplete error:', err);
        }
    }

    function showAutocomplete`);

// 6. Update sendToHub
code = code.replace(/function sendToHub[\s\S]*?\}\s*(?=\/\/ === リスト読み込み)/, `
    function sendToHub(payload) {
        if (!payload.prompt) return;
        payload.session_id = CURRENT_SESSION_ID;
        LocalDB.addHistory(payload).then(() => {
            if (activeTab === 'history') loadList(1);
        });
    }
`);

// 7. Update list & favorites loading (replace fetch)
code = code.replace(/fetch\(\`\$\{HUB_URL\}\/api\/history\/sessions[\s\S]*?\.catch[^\)]+\);/, `
        LocalDB.getSessions(page, LIMIT).then(data => {
            historyData = data.data;
            currentPage = data.page;
            const total = data.total_pages;

            document.getElementById('nsync-prev').disabled = currentPage <= 1;
            document.getElementById('nsync-next').disabled = currentPage >= total;
            document.getElementById('nsync-page-info').textContent = \`\${currentPage} / \${total}\`;

            renderSessionFolders(historyData);
        });
`);

code = code.replace(/fetch\(\`\$\{HUB_URL\}\/api\/history\?[\s\S]*?\.catch[^\)]+\);/, `
        LocalDB.searchHistory(currentSearch, page, LIMIT).then(data => {
            historyData = data.data;
            currentPage = data.page;
            const total = data.total_pages;

            document.getElementById('nsync-prev').disabled = currentPage <= 1;
            document.getElementById('nsync-next').disabled = currentPage >= total;
            document.getElementById('nsync-page-info').textContent = \`\${currentPage} / \${total}\`;

            renderSessionFolders(historyData); // Wait, if searching, render flat list?
            // Existing logic uses flat list rendering for search. Let's redirect to renderSearchList.
            const listEl = document.getElementById('nsync-list-container');
            listEl.innerHTML = '';
            if (historyData.length === 0) {
                listEl.innerHTML = '<div style="color:#555;font-size:12px;padding:20px 14px;">履歴がありません</div>';
            } else {
                historyData.forEach((item, idx) => {
                    listEl.appendChild(createListItem(item, false, false, null));
                });
            }
        });
`);

code = code.replace(/fetch\(\`\$\{HUB_URL\}\/api\/favorites\?[\s\S]*?\.catch[^\)]+\);/, `
        LocalDB.getFavorites(page, LIMIT).then(data => {
            historyData = data.data;
            currentPage = data.page;
            const total = data.total_pages;
            renderFavoritesList(historyData);
            document.getElementById('nsync-prev').disabled = currentPage <= 1;
            document.getElementById('nsync-next').disabled = currentPage >= total;
            document.getElementById('nsync-page-info').textContent = \`\${currentPage} / \${total}\`;
        });
`);

// 8. Update session detail loading
code = code.replace(/fetch\(\`\$\{HUB_URL\}\/api\/history\/sessions\/\$\{sessionId\}\`\)[\s\S]*?\.catch[^\)]+\);/, `
        LocalDB.getSessionDetail(sessionId).then(data => {
            renderSessionDetailGrid(data);
        });
`);

// 9. Update favorites toggle (removeFavorite, addFavorite)
code = code.replace(/fetch\(\`\$\{HUB_URL\}\/api\/favorites\`[\s\S]*?\.catch[^\)]+\);/, `
            LocalDB.addFavorite(historyId).then(r => {
                if (!r) return showToast('元データが見つかりません', 'error');
                starBtn.dataset.favId = r.fav_id;
                starBtn.classList.add('on');
                starBtn.textContent = '★';
                showToast('お気に入りに追加しました');
            });
`);

code = code.replace(/fetch\(\`\$\{HUB_URL\}\/api\/favorites\/check\/\$\{historyId\}\`\)[\s\S]*?\.catch[^\)]+\);/, `
        LocalDB.checkFavorite(historyId).then(r => {
            if (r.is_favorite && r.fav_id) {
                starBtn.dataset.favId = r.fav_id;
                starBtn.classList.add('on');
                starBtn.textContent = '★';
                if (!onlyCheck) removeFavorite(starBtn, r.fav_id);
            }
        });
`);

code = code.replace(/fetch\(\`\$\{HUB_URL\}\/api\/favorites\/\$\{favId\}\`[\s\S]*?\.catch[^\)]+\);/, `
        LocalDB.removeFavorite(favId).then(() => {
            starBtn.classList.remove('on');
            starBtn.textContent = '☆';
            showToast('お気に入りから解除しました');
            if (activeTab === 'favorites') loadList(1);
        });
`);

// 10. showDetail (if used, although we bypassed it for clicks, it might still exist)
code = code.replace(/fetch\(\`\$\{HUB_URL\}\/api\/history\/\$\{id\}\`\)[\s\S]*?\.catch[^\)]+\);/, `
        LocalDB.getHistoryItem(id).then(data => {
            if (data) { processThumbnailData(data); renderDetail(data); }
            else showToast('詳細の取得に失敗しました', 'error');
        });
`);

// 11. Add Backup/Restore UI to panel
code = code.replace(/🖼 グリッド表示<\/button>/, `🖼 グリッド表示</button>
                <button id="nsync-backup-btn" style="flex:1;background:#1a1025;border:1px solid #2d2040;color:#7a5fa8;padding:5px 8px;font-size:11px;border-radius:4px;cursor:pointer;font-weight:600;" title="履歴のバックアップ/復元">💾 データ管理</button>`);

// Add Backup popup handler in buildUI
code = code.replace(/panel\.querySelector\('#nsync-grid-btn'\)\.addEventListener\('click', showSessionGrid\);/, `
        panel.querySelector('#nsync-grid-btn').addEventListener('click', showSessionGrid);
        
        panel.querySelector('#nsync-backup-btn').addEventListener('click', () => {
            document.getElementById('nsync-overlay')?.remove();
            const overlay = document.createElement('div');
            overlay.id = 'nsync-overlay';
            overlay.innerHTML = \`
                <div id="nsync-detail-box" style="width:300px; padding:20px; text-align:center;">
                    <h3 style="color:#9d7fd4;margin-top:0;">💾 ローカルデータ管理</h3>
                    <p style="font-size:11px;color:#888;margin-bottom:20px;text-align:left;">
                        スマホ単独版では画像履歴はブラウザ内部に保存されます。キャッシュクリア等で消える前にZIP形式(JSON)でエクスポートして保護してください。
                    </p>
                    <button id="nsync-do-export" style="width:100%;padding:10px;margin-bottom:10px;background:#6e40c9;color:#fff;border:none;border-radius:5px;cursor:pointer;">📥 バックアップをダウンロード</button>
                    
                    <div style="border-top:1px solid #2d2040; margin:15px 0;"></div>
                    
                    <label style="display:block;width:100%;padding:10px;background:#1a1025;color:#c4a8e8;border:1px solid #2d2040;border-radius:5px;cursor:pointer;box-sizing:border-box;">
                        📤 バックアップから復元
                        <input type="file" id="nsync-do-import" accept=".json" style="display:none;">
                    </label>
                    <p style="font-size:10px;color:#e55;margin-top:5px;">※現在の履歴は上書きされます</p>
                    
                    <button id="nsync-close-backup" style="margin-top:15px;background:none;border:none;color:#888;cursor:pointer;">閉じる</button>
                </div>
            \`;
            document.body.appendChild(overlay);
            
            document.getElementById('nsync-close-backup').addEventListener('click', () => overlay.remove());
            document.getElementById('nsync-do-export').addEventListener('click', () => LocalDB.exportData());
            document.getElementById('nsync-do-import').addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    LocalDB.importData(e.target.files[0]).then(() => overlay.remove());
                }
            });
        });
`);

// 12. Fix the initial script run to init LocalDB first
code = code.replace(/buildUI\(\);\n\s*patchObjectURL\(\);/, `
            LocalDB.init().then(() => {
                buildUI();
                patchObjectURL();
            });
`);
code = code.replace(/document\.getElementById\('nsync-status'\)\.textContent = '● 接続済';/, `document.getElementById('nsync-status').textContent = '● ローカル起動'; document.getElementById('nsync-status').classList.add('ok');`);

fs.writeFileSync(dstPath, code);
console.log('Successfully created NovelAI_Local.user.js');

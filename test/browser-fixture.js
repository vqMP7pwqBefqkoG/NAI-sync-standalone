// Local-only smoke test, with its own browser origin and database.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function chunk(type, data) {
    const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8);
    let crc = 0xFFFFFFFF;
    for (const byte of out.subarray(4, data.length + 8)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1; }
    out.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, data.length + 8); return out;
}
const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
const pixels = Buffer.alloc(32 * 97);
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const i = y * 97 + x * 3 + 1; pixels[i] = 140; pixels[i + 1] = 90; pixels[i + 2] = 200; }
const meta = chunk('tEXt', Buffer.from('Comment\0' + JSON.stringify({ prompt: 'fixture 日本語', seed: 0, width: 32, height: 32, extra: 'lossless '.repeat(100) })));
const signature = Buffer.from([137,80,78,71,13,10,26,10]);
const png = Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const generated = Buffer.concat([signature, chunk('IHDR', header), meta, chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const thumbnail = JSON.stringify({ image: 'data:image/png;base64,' + png.toString('base64'), meta: meta.toString('base64') });
const html = `<!doctype html><meta charset="utf-8"><title>N-Local fixture</title>
<style>body{font:16px sans-serif;background:#18131e;color:white}button{padding:10px;margin:8px}.ProseMirror{border:1px solid gray;padding:15px}</style>
<h1>Local standalone test</h1><div class="ProseMirror" contenteditable="true">fixture prompt</div>
<button id="generate">Generate</button><input type="file" id="restore" accept="image/png"><span id="result"></span><img id="image">
<script>
document.getElementById('generate').onclick=async function(){this.disabled=true;document.getElementById('image').src=URL.createObjectURL(await(await fetch('/fixture.png')).blob());this.disabled=false};
document.getElementById('restore').onchange=()=>document.getElementById('result').textContent='Import received';
(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('NovelAILocalDB');r.onupgradeneeded=()=>{const h=r.result.createObjectStore('history',{keyPath:'id'});h.createIndex('created_at','created_at');h.createIndex('session_id','session_id');const f=r.result.createObjectStore('favorites',{keyPath:'fav_id'});f.createIndex('history_id','history_id');r.result.createObjectStore('tags');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
await new Promise((resolve,reject)=>{const tx=db.transaction(['history','favorites','tags'],'readwrite');const h=tx.objectStore('history');const r=h.count();r.onsuccess=()=>{if(!r.result){for(let i=0;i<170;i++)h.add({id:'old-'+i,prompt:'fixture',created_at:'2026-01-01T00:00:00.000Z',session_id:'session-'+i,thumbnail:${JSON.stringify(thumbnail)}});tx.objectStore('favorites').add({fav_id:'fav',history_id:'old-0',id:'old-0',thumbnail:${JSON.stringify(thumbnail)}});}tx.objectStore('tags').put([],'danbooru:2026-06');tx.objectStore('tags').put([],'e621:2026-06');};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();const s=document.createElement('script');s.src='/userscript.js';document.body.appendChild(s)})();
</script>`;
http.createServer((req, res) => {
    if (req.url === '/userscript.js') { res.setHeader('Content-Type', 'application/javascript; charset=utf-8'); res.end(fs.readFileSync(path.join(__dirname, '../NovelAI_Local.user.js'))); }
    else if (req.url === '/fixture.png') { res.setHeader('Content-Type', 'image/png'); res.end(generated); }
    else if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); }
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
}).listen(3041, '127.0.0.1', () => console.log('Standalone fixture http://127.0.0.1:3041'));

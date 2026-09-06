const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../NovelAI_Local.user.js'), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a,b); }
function context(extra = {}) {
    return vm.createContext({ Blob, TextDecoder, TextEncoder, Uint8Array, DataView, crypto: webcrypto, btoa, atob,
        console: { log() {}, error() {} }, setTimeout: () => 1, clearTimeout() {},
        navigator: {}, window: { addEventListener() {} }, document: { addEventListener() {}, getElementById: () => ({}) },
        showToast() {}, stopBatch() {}, prependToList() {}, CURRENT_SESSION_ID: 'session', ...extra });
}
test('same settings across generations, redraw deduplication and multiple images', async () => {
    const results = [];
    const c = context({ hashArrayBuffer: async bytes => Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex'),
        rememberSessionBlob() {}, sendToHub: async data => { results.push(data); return true; }, findGenerateButton: () => true });
    vm.runInContext('let generation=null, generationTimer=null, generationSettleTimer=null, batchOnGenerated=null;', c);
    vm.runInContext(section('    function parsePngChunks(', '    // ============================================================\n    // === 擬似'), c);
    vm.runInContext(section('    function cancelGeneration()', '    const failedSaves'), c);
    vm.runInContext("makeThumbnail=async()=> 'data:image/webp;base64,UklGRg=='", c);
    const comment = Buffer.from('Comment\0' + JSON.stringify({ prompt: 'same', seed: 0 }));
    const chunk = Buffer.alloc(comment.length + 12); chunk.writeUInt32BE(comment.length); chunk.write('tEXt', 4); comment.copy(chunk, 8);
    const signature = Buffer.from([137,80,78,71,13,10,26,10]);
    c.a = new Blob([signature,chunk], { type: 'image/png' }); c.b = new Blob([signature,chunk,Buffer.from([1])], { type: 'image/png' });
    vm.runInContext('beginGeneration();generation.processing=3', c);
    await vm.runInContext('Promise.all([processGeneratedImage(a,generation),processGeneratedImage(a,generation),processGeneratedImage(b,generation)])', c);
    assert.equal(results.length, 2); assert.equal(results[0].seed, 0);
    vm.runInContext('beginGeneration();generation.processing=1', c); await vm.runInContext('processGeneratedImage(a,generation)', c);
    assert.equal(results.length, 3); assert.notEqual(results[0].event_id, results[2].event_id);
});
test('write failure stops batch, keeps retry data and preserves event id', async () => {
    let fail = true, stopped = 0; const saved = [];
    const c = context({ stopBatch: () => stopped++, LocalDB: { addHistory: async data => { if (fail) throw Error('Quota'); saved.push(data.event_id); } } });
    vm.runInContext(section('    const failedSaves', '    // ============================================================\n    // === バッチ（連続）生成 ==='), c);
    assert.equal(await vm.runInContext("sendToHub({event_id:'pending'})", c), false);
    assert.equal(stopped, 1); assert.equal(vm.runInContext('failedSaves.size', c), 1);
    fail = false; await vm.runInContext('retryFailedSaves()', c);
    assert.equal(vm.runInContext('failedSaves.size', c), 0); assert.deepEqual(saved, ['pending']);
});

test('stopping outside batch UI is safe for restoration and save failures', () => {
    const c = context({ document: { getElementById: () => null }, releaseWakeLock() {} });
    vm.runInContext('let batchRunning=false,batchOnGenerated=null,batchWaitAttempts=0,batchCount=0,batchTarget=0;', c);
    vm.runInContext(section('    function stopBatch()', '    function updateBatchProgress()'), c);
    assert.doesNotThrow(() => vm.runInContext('stopBatch()', c));
});

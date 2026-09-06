const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const file = path.join(root, 'NovelAI_Local.user.js');
const source = fs.readFileSync(path.join(root, 'src/history-storage.js'), 'utf8').replace(/\r\n/g, '\n');
const script = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const start = '// BEGIN LOCAL STORAGE', end = '// END LOCAL STORAGE';
const a = script.indexOf(start), b = script.indexOf(end);
if (a < 0 || b < a) throw new Error('Storage markers missing');
const output = script.slice(0, a) + start + '\n' + source + '\n    ' + script.slice(b);
if (process.argv.includes('--check')) {
    if (output !== script) { console.error('Run npm run build'); process.exitCode = 1; }
} else fs.writeFileSync(file, output.replace(/\n/g, '\r\n'), 'utf8');

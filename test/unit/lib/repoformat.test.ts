import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatForRepo } from '../../../src/lib/repoformat';

function repoWithFakePrettier(withConfig: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-repoformat-'));
  if (withConfig) fs.writeFileSync(path.join(root, '.prettierrc.json'), '{"singleQuote": true}\n');
  const pkgDir = path.join(root, 'node_modules', 'prettier');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'prettier', bin: { prettier: 'bin.js' } }));
  // A stand-in formatter: records its flags, turns double quotes into single quotes, appends a marker.
  fs.writeFileSync(
    path.join(pkgDir, 'bin.js'),
    "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(d.replace(/\"/g, \"'\") + '# formatted ' + process.argv.slice(2).join(' ') + '\\n');});",
  );
  return root;
}

test("formatForRepo runs the repository's own Prettier on stdin with the file path, when configured", () => {
  const root = repoWithFakePrettier(true);
  const r = formatForRepo(root, 'tasks/T-1.md', '---\npaths: ["src/lib"]\n---\n');
  assert.equal(r.note, 'prettier');
  assert.match(r.text, /paths: \['src\/lib'\]/);
  assert.match(r.text, /# formatted --stdin-filepath tasks\/T-1\.md --no-color/);
});

test('formatForRepo leaves the text alone without a Prettier config, and without a binary', () => {
  const noCfg = repoWithFakePrettier(false);
  assert.deepEqual(formatForRepo(noCfg, 'tasks/T-1.md', 'x\n'), { text: 'x\n', note: 'no-config' });
  const noBin = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-repoformat-'));
  fs.writeFileSync(path.join(noBin, '.prettierrc'), '{}');
  assert.deepEqual(formatForRepo(noBin, 'a.md', 'x\n'), { text: 'x\n', note: 'no-binary' });
});

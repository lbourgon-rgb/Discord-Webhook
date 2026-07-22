import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/kai-category-scope.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { selectKaiCategoryMonitorChannels } = await import(moduleUrl);

test('category scope selects direct text channels and active forum threads only', () => {
  const selected = selectKaiCategoryMonitorChannels([
    { id: '100', name: 'Fae Burrow', type: 4 },
    { id: '200', name: 'kai-room', type: 0, parent_id: '100', last_message_id: '900' },
    { id: '201', name: 'archive', type: 15, parent_id: '100' },
    { id: '202', name: 'voice', type: 2, parent_id: '100' },
    { id: '300', name: 'elsewhere', type: 0, parent_id: '999' },
  ], [
    { id: '400', name: 'open-post', type: 11, parent_id: '201', last_message_id: '901' },
    { id: '401', name: 'outside-thread', type: 11, parent_id: '300' },
  ], ['100']);

  assert.deepEqual(selected, [
    { id: '200', name: 'kai-room', last_message_id: '900' },
    { id: '400', name: 'open-post', last_message_id: '901' },
  ]);
});

test('category scope deduplicates channels and rejects malformed ids', () => {
  const selected = selectKaiCategoryMonitorChannels([
    { id: '200', name: 'room', type: 0, parent_id: '100' },
    { id: '200', name: 'room-again', type: 0, parent_id: '100' },
    { id: 'not-a-snowflake', name: 'bad', type: 0, parent_id: '100' },
  ], [], ['100']);

  assert.deepEqual(selected, [{ id: '200', name: 'room-again' }]);
});

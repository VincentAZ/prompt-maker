import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modelFor, masterFor, fitToRoom, buildGenerateMessages } from '../lib/prompt.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-prompt-sets-'));
process.env.PROMPT_MAKER_DATA = scratch;
const store = await import('../lib/store.js');
test('a fresh install starts with empty prompt sets', async () => {
  await store.init();
  assert.deepEqual((await store.getSettings()).promptSets, []);
});
test('sets have no arbitrary count limit; validation, selection and deletion persist', async () => {
  const promptSets = Array.from({ length: 125 }, (_, i) => ({ name: `Brand ${i}`, examples: ['A blue box.'], enabled: i % 2 === 0 }));
  const saved = await store.updateSettings({ promptSets });
  assert.equal(saved.promptSets.length, 125);
  assert.equal(new Set(saved.promptSets.map(s => s.id)).size, 125);
  assert.deepEqual((await store.getSettings()).promptSets, saved.promptSets);
  await assert.rejects(store.updateSettings({ promptSets: [{name:'Blank',examples:[]}] }), /at least one/);
  await assert.rejects(store.updateSettings({ promptSets: [saved.promptSets[0], saved.promptSets[0]] }), /unique ID/);
  assert.equal((await store.getSettings()).promptSets.length, 125);
  await store.updateSettings({ promptSets: [] });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(scratch, 'settings.json'))).promptSets, []);
  assert.equal(JSON.parse(await fs.readFile(path.join(scratch, 'settings.json.bak'))).promptSets.length, 125, 'the .bak copy is the version from before the last save');
});
test('every model receives only checked sets, and context fitting can trim examples', () => {
  const settings = { masterPrompt: 'Write a prompt.', promptSets: [
    { name:'Brand', enabled:true, examples:['A blue box.'] },
    { name:'Other', enabled:false, examples:['A red box.'] },
  ] };
  for (const kind of ['image', 'video']) {
    const model = { name: 'Fixture', kind, instructions: 'Keep the format.', examples: ['A tree.'] };
    const composed = modelFor(model, settings);
    assert.deepEqual(composed.examples, ['[Brand] A blue box.', 'A tree.'], 'your sets first: a short Brain drops the model\'s examples before yours');
    assert.deepEqual(model.examples, ['A tree.']);
    assert.equal(masterFor(settings), 'Write a prompt.');
    const fitted = fitToRoom(composed, 1, m => buildGenerateMessages(masterFor(settings), m, {theme:'A park'}, null, {index:0,count:1,previous:[]}));
    assert.equal(fitted.dropped, 2);
    assert(!JSON.stringify(fitted.messages).includes('A blue box.'));
  }
});
test.after(async () => fs.rm(scratch, {recursive:true,force:true}));

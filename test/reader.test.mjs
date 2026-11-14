import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('叶条目使用指南内标识而非标题去重', async () => {
  assert.equal((await collect(client))[0].id, 'g1:item1');
  await assert.rejects(client('/objects/o1'), /403/);
});

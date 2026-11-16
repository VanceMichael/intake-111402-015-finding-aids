import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';
test('相同收件幂等，不同内容保留版本',async () => {
  const directory = await mkdtemp(join(tmpdir(),'archive-'));
  try {
    const archive = new Archive(directory);
    await Promise.all([archive.put([{id:'one',value:1}],{source:'local'}),archive.put([{id:'one',value:1}],{source:'local'})]);
    assert.equal((await archive.list()).length,1);
    await archive.put([{id:'one',value:2}],{source:'local'});
    assert.equal((await new Archive(directory).list()).length,2);
    await assert.rejects(archive.put([{value:3}],{}),/record id/);
    const api = await createApi(archive);
    try {const response = await fetch(`${api.origin}/records`);assert.equal((await response.json()).length,2);}
    finally {await api.close();}
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('馆员投影按条目定位原件、目录记录与受限数字对象',async () => {
  const directory = await mkdtemp(join(tmpdir(),'archive-entries-'));
  try {
    const archive = new Archive(directory);
    await archive.put([
      {id:'g1:item1',pathIds:['root','item1'],acquisition:{status:'restricted',holdsOriginal:false,catalogOnly:false,hasRestrictedObjects:true}},
      {id:'g1:root',pathIds:['root'],acquisition:{status:'catalog',holdsOriginal:false,catalogOnly:true,hasRestrictedObjects:false}},
      {id:'g2:item2',pathIds:['root','item2'],acquisition:{status:'original',holdsOriginal:true,catalogOnly:false,hasRestrictedObjects:false}}
    ],{source:'local'});
    // A revision of one entry is retained, but the projection shows the latest.
    await archive.put([
      {id:'g1:item1',pathIds:['root','series','item1'],acquisition:{status:'catalog',holdsOriginal:false,catalogOnly:true,hasRestrictedObjects:false}}
    ],{source:'revised'});

    assert.equal((await archive.entries()).length,3);
    assert.equal((await archive.history('g1:item1')).length,2);

    const api = await createApi(archive);
    try {
      const originals = await (await fetch(`${api.origin}/entries?status=originals`)).json();
      assert.deepEqual(originals.map(entry => entry.id),['g2:item2']);
      const catalog = await (await fetch(`${api.origin}/entries?status=catalog`)).json();
      assert.deepEqual(catalog.map(entry => entry.id).sort(),['g1:item1','g1:root']);
      const restricted = await (await fetch(`${api.origin}/entries?status=restricted`)).json();
      assert.equal(restricted.length,0);
      assert.equal((await fetch(`${api.origin}/entries?status=unknown`)).status,400);

      const history = await (await fetch(`${api.origin}/entries/g1%3Aitem1/history`)).json();
      assert.deepEqual(history.map(record => record.row.pathIds),[
        ['root','item1'],
        ['root','series','item1']
      ]);
    } finally {await api.close();}
  } finally {await rm(directory,{recursive:true,force:true});}
});

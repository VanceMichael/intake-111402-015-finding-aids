import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';

const byId = (rows,id) => rows.find(row => row.id === id);

test('每个层级组件保留路径、原文和继承上下文',async () => {
  const source = await createSource();
  try {
    const rows = await collect(createClient(source.origin));
    const item = byId(rows,'g1:item1');
    const root = byId(rows,'g1:root');

    // The full path including this component is kept, not just the leaf.
    assert.deepEqual(item.pathIds,['root','item1']);
    assert.equal(item.parentId,'g1:root');
    assert.equal(item.pathKey,'g1:root/item1');
    assert.equal(root.pathIds.length,1);
    assert.equal(root.isLeaf,false);

    // The child wrote no restriction: it inherits the parent's wording but
    // never receives it as its own verbatim text.
    assert.equal(Object.hasOwn(item,'accessrestrict'),false);
    assert.equal(Object.hasOwn(item.description,'accessrestrict'),false);
    assert.equal(item.access.state,'restricted');
    assert.equal(item.access.text,'需馆员批准');
    assert.equal(item.access.inherited,true);
    assert.equal(item.access.sourceId,'g1:root');
    assert.deepEqual(item.accessChain.map(entry => entry.localId),['root']);

    // The parent's own wording remains available unchanged.
    assert.deepEqual(root.accessrestrict,{state:'restricted',text:'需馆员批准'});
    assert.equal(root.access.inherited,false);
  } finally {await source.close();}
});

test('数字对象只按条目自身声明领取，并区分原件与受限',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const rows = await collect(client);

    const item = byId(rows,'g1:item1');
    assert.deepEqual(item.objects.map(object => object.ref),['/objects/o1']);
    assert.equal(item.objects[0].status,'restricted');
    assert.equal(item.objects[0].httpStatus,403);
    assert.equal(item.objects[0].available,false);
    assert.equal(item.objects[0].restricted,true);
    assert.equal(item.objects[0].acquired,false);
    assert.equal(item.acquisition.holdsOriginal,false);
    assert.equal(item.acquisition.hasRestrictedObjects,true);
    assert.equal(item.acquisition.objectCount,1);
    assert.deepEqual(item.acquisition.restrictedRefs,['/objects/o1']);

    const open = byId(rows,'g2:item2');
    assert.equal(open.objects[0].status,'acquired');
    assert.equal(open.objects[0].owner,'g2:item2');
    assert.equal(open.objects[0].ownerMatches,true);
    assert.equal(open.objects[0].content,'bG9jYWwtZ3VpZGU=');
    assert.equal(open.acquisition.status,'original');
    assert.equal(open.acquisition.holdsOriginal,true);
    assert.equal(open.acquisition.catalogOnly,false);

    // Containers that declare nothing are hierarchy nodes rather than
    // catalog records of an item.
    const root = byId(rows,'g2:root');
    assert.equal(root.objects.length,0);
    assert.equal(root.acquisition.status,'container');
    assert.equal(root.acquisition.catalogOnly,false);
    assert.equal(root.acquisition.isContainer,true);
    assert.equal(root.acquisition.holdsOriginal,false);
  } finally {await source.close();}
});

test('同标题不同位置的条目仍按 localId 与路径区分',async () => {
  const directory = await mkdtemp(join(tmpdir(),'fixture-'));
  const fixture = {
    exchanges:[
      {path:'/guides',method:'GET',body:{items:[{guideId:'g3',version:'v1'}]},requires:{},sets:{},status:200,query:{}},
      {path:'/guides/g3',method:'GET',body:{guideId:'g3',version:'v1',component:{
        localId:'root',level:'fonds',title:'档案',
        accessrestrict:{state:'public',text:'公开'},
        children:[
          {localId:'seriesA',level:'series',title:'系列一',unitid:'BOX-A',children:[
            {localId:'a1',level:'item',title:'同名条目',children:[]}
          ]},
          {localId:'seriesB',level:'series',title:'系列一',unitid:'BOX-B',children:[
            {localId:'b1',level:'item',title:'同名条目',children:[]}
          ]}
        ]
      }},requires:{},sets:{},status:200,query:{}}
    ],
    cases:{}
  };
  try {
    await writeFile(join(directory,'source.json'),JSON.stringify(fixture));
    const source = await createSource({fixture:join(directory,'source.json')});
    try {
      const rows = await collect(createClient(source.origin));
      const a1 = byId(rows,'g3:a1');
      const b1 = byId(rows,'g3:b1');
      assert.equal(a1.title,b1.title);
      assert.notEqual(a1.id,b1.id);
      assert.notEqual(a1.pathKey,b1.pathKey);
      assert.deepEqual(a1.pathIds,['root','seriesA','a1']);
      assert.deepEqual(b1.pathIds,['root','seriesB','b1']);
      // Neither item wrote a box: each inherits its own series' box, which
      // identical titles would have made indistinguishable. The resolved box
      // is reported while ownUnitid records that neither wrote one.
      assert.equal(a1.ownUnitid,null);
      assert.equal(b1.ownUnitid,null);
      assert.equal(a1.unitid,'BOX-A');
      assert.equal(b1.unitid,'BOX-B');
      assert.equal(a1.effectiveUnitid,'BOX-A');
      assert.equal(b1.effectiveUnitid,'BOX-B');
      assert.equal(a1.inheritedUnitid.sourceId,'g3:seriesA');
      assert.equal(b1.inheritedUnitid.sourceId,'g3:seriesB');
      // Both inherit the fonds restriction rather than claiming it as text.
      assert.equal(a1.access.inherited,true);
      assert.equal(b1.access.inherited,true);
      assert.equal(Object.hasOwn(a1,'accessrestrict'),false);
    } finally {await source.close();}
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('修订移动层级并收紧系列时保留可追溯路径且不无限展开外部引用',async () => {
  const source = await createSource({scenario:'moved'});
  try {
    const client = createClient(source.origin);
    const rows = await collect(client);
    const item = byId(rows,'g1:item1');
    const series = byId(rows,'g1:series');

    // The entry keeps the revised path, so the moved hierarchy is traceable.
    assert.deepEqual(item.pathIds,['root','series','item1']);
    assert.equal(item.pathKey,'g1:root/series/item1');
    assert.equal(item.guideId,'g1');
    assert.equal(item.version,'v2');
    assert.deepEqual(item.provenance.pathIds,['root','series','item1']);

    // The tightened series restriction is inherited, not copied as the
    // child's own wording; the source only wrote it on the series.
    assert.equal(item.access.state,'restricted');
    assert.equal(item.access.text,'暂缓开放');
    assert.equal(item.access.inherited,true);
    assert.equal(item.access.sourceId,'g1:series');
    assert.equal(Object.hasOwn(item,'accessrestrict'),false);
    assert.deepEqual(series.accessrestrict,{state:'restricted',text:'暂缓开放'});

    // A component with no restriction anywhere is unresolved, never public.
    const root = byId(rows,'g1:root');
    assert.equal(root.access.state,'unstated');
    assert.equal(root.isPublic,false);
    assert.equal(root.isRestricted,false);
    assert.equal(Object.hasOwn(root,'accessrestrict'),false);

    // The self-referencing external guide is a boundary, not a page to follow.
    assert.equal(series.externalGuide,'g1');
    const reference = series.externalReferences.find(entry => entry.guideId === 'g1');
    assert.ok(reference);
    assert.equal(reference.status,'cycle');
    assert.equal(reference.cycle,true);
    assert.equal(reference.expanded,false);
    const audit = await client('/__audit');
    assert.equal(audit.requests.filter(request => request.path === '/guides/g1').length,1);
  } finally {await source.close();}
});

test('修订前后内容分别归档，历史出处可追查',async () => {  const directory = await mkdtemp(join(tmpdir(),'history-'));
  const {Archive} = await import('../src/archive.mjs');
  const normal = await createSource({scenario:'normal'});
  const moved = await createSource({scenario:'moved'});
  try {
    const archive = new Archive(directory);
    const before = await collect(createClient(normal.origin));
    await archive.put(before,{source:'normal',adapter:'current'});
    await archive.put(before,{source:'normal',adapter:'current'});
    assert.equal((await archive.list()).length,before.length);

    const after = await collect(createClient(moved.origin));
    await archive.put(after,{source:'moved',adapter:'current'});
    const records = await archive.list();
    const itemVersions = records.filter(record => record.row.id === 'g1:item1');
    assert.equal(itemVersions.length,2);
    assert.deepEqual(
      itemVersions.map(record => record.row.pathIds),
      [['root','item1'],['root','series','item1']]
    );
    assert.deepEqual(
      itemVersions.map(record => record.row.access.text),
      ['需馆员批准','暂缓开放']
    );
    assert.ok(itemVersions.every(record => record.provenance.adapter === 'current'));
  } finally {
    await Promise.all([normal.close(),moved.close()]);
    await rm(directory,{recursive:true,force:true});
  }
});

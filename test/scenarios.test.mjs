import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('moved');
const root = (await client('/guides/g1')).component;
const series = root.children[0];
assert.equal(series.accessrestrict.state,'restricted');
assert.equal(series.children[0].accessrestrict,undefined);
assert.equal(series.externalGuide,'g1');
} finally {await source.close();}
});

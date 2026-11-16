import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open} from 'node:fs/promises';
import {join} from 'node:path';

export class Archive {
  constructor(directory) { this.directory = directory; this.serial = Promise.resolve(); }
  async list() {
    try {return JSON.parse(await readFile(join(this.directory,'records.json'),'utf8'));}
    catch(error) {if(error.code === 'ENOENT') return [];throw error;}
  }
  // The original archive keeps every distinct receipt. This is a separate
  // read-only projection for the librarian: the most recently received
  // record per entry id, with the receipt count and provenance attached.
  // It deliberately says nothing about which guide version is "current".
  async entries() {
    const records = await this.list();
    const latest = new Map();
    const receipts = new Map();
    for (const record of records) {
      const id = record.row?.id;
      if (typeof id !== 'string') continue;
      latest.set(id,record);
      receipts.set(id,(receipts.get(id) ?? 0) + 1);
    }
    return [...latest.values()].map(record => ({
      ...record.row,
      receiptCount:receipts.get(record.row.id) ?? 1,
      receipt:{provenance:record.provenance,digest:record.digest}
    }));
  }
  async history(id) {
    const records = await this.list();
    return records.filter(record => record.row?.id === id);
  }
  put(rows, provenance) {
    const operation = this.serial.then(async () => {
      if (!Array.isArray(rows) || rows.some(row => typeof row.id !== 'string' || !row.id)) throw new Error('record id required');
      await mkdir(this.directory,{recursive:true});
      const current = await this.list();
      const known = new Set(current.map(entry => entry.digest));
      let added = 0;
      for (const row of rows) {
        const digest = createHash('sha256').update(JSON.stringify({row,provenance})).digest('hex');
        if (!known.has(digest)) {current.push({row,provenance,digest});known.add(digest);added++;}
      }
      const temporary = join(this.directory,`${randomUUID()}.tmp`);
      await writeFile(temporary,JSON.stringify(current,null,2)+'\n');
      const handle = await open(temporary,'r');
      try {await handle.sync();} finally {await handle.close();}
      await rename(temporary,join(this.directory,'records.json'));
      return {added,total:current.length};
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
}

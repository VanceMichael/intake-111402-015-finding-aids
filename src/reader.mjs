function leaves(node, rows) {
  if (!node.children?.length) rows.push({localId:node.localId,unitid:node.unitid,title:node.title});
  else for (const child of node.children) leaves(child, rows);
}
export async function collect(client) {
  const guides = await client('/guides');
  const rows = [];
  for (const item of guides.items) {
    const guide = await client(`/guides/${item.guideId}`);
    const entries = []; leaves(guide.component, entries);
    rows.push(...entries.map(entry => ({...entry,id:`${guide.guideId}:${entry.localId}`,version:guide.version})));
  }
  return rows;
}

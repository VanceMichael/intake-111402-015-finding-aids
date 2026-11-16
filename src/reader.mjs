import {createHash} from 'node:crypto';
import {SourceError} from './transport.mjs';

const ACCESS_STATES = new Set(['public','restricted']);
const STRUCTURAL_FIELDS = new Set(['localId','children']);

function written(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

// Only the accessrestrict this component itself wrote is read here. An
// absent, blank or incomplete value is not a declaration that lifts an
// inherited restriction, so it is treated as absent and resolved against the
// enclosing components. If no level declares anything, the result is
// "unstated" rather than "public".
function ownAccessrestrict(node) {
  const value = node.accessrestrict;
  if (typeof value === 'string') {
    const state = value.trim();
    return ACCESS_STATES.has(state) ? {state,text:null} : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!ACCESS_STATES.has(value.state)) return null;
  return {state:value.state,text:typeof value.text === 'string' ? value.text : null};
}

// The fields the component actually wrote. Structural links (localId and
// children) are represented by the row and its path; everything else is kept
// verbatim as description. Inherited values never enter this object, so a
// parent's restriction wording cannot masquerade as the child's own text.
function writtenDescription(node) {
  const description = {};
  for (const [key,value] of Object.entries(node)) {
    if (STRUCTURAL_FIELDS.has(key) || value === undefined) continue;
    description[key] = value;
  }
  return description;
}

// Only digital objects this component itself declares are returned. A DAO on
// an ancestor, or an inherited box number, is not a claim of the child.
function declaredObjects(node) {
  const value = node.dao;
  if (value === undefined || value === null) return [];
  const candidates = Array.isArray(value) ? value : [value];
  const references = [];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      if (written(candidate)) references.push(candidate.trim());
    } else if (candidate && typeof candidate === 'object') {
      const reference = written(candidate.href) ?? written(candidate.url);
      if (reference) references.push(reference.trim());
    }
  }
  return [...new Set(references)];
}

function externalGuideId(node) {
  const value = node.externalGuide;
  const raw = typeof value === 'string'
    ? written(value)
    : value && typeof value === 'object'
      ? (written(value.guideId) ?? written(value.href) ?? written(value.url))
      : null;
  if (!raw) return null;
  const match = raw.match(/\/guides\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : raw;
}

// A component without unitid belongs to the nearest enclosing box, which may
// itself have inherited it. The resolved value, its origin and whether it was
// inherited are all kept so a moved hierarchy stays auditable.
function resolveUnitid(node, inherited) {
  const own = written(node.unitid);
  if (own) {
    return {value:own,source:node.localId,sourceId:null,inherited:false,resolved:true};
  }
  if (inherited && inherited.value !== null) return {...inherited,inherited:true};
  return {value:null,sourceId:null,source:null,inherited:false,resolved:false};
}

// EAD inheritance: an absent accessrestrict carries the nearest enclosing
// declaration. The chain records every explicit declaration that participated
// (with its own id and level), so a later revision can be traced to its source.
function resolveAccessrestrict(node, guideId, inheritedChain) {
  const own = ownAccessrestrict(node);
  if (own) {
    const entry = {
      id:`${guideId}:${node.localId}`,
      localId:node.localId,
      level:node.level ?? null,
      state:own.state,
      text:own.text
    };
    return {
      effective:{
        state:own.state,
        text:own.text,
        source:node.localId,
        sourceId:entry.id,
        sourceLevel:entry.level,
        inherited:false,
        resolved:true
      },
      chain:[...inheritedChain,entry]
    };
  }
  if (inheritedChain.length) {
    const nearest = inheritedChain[inheritedChain.length - 1];
    return {
      effective:{
        state:nearest.state,
        text:nearest.text,
        source:nearest.localId,
        sourceId:nearest.id,
        sourceLevel:nearest.level,
        inherited:true,
        resolved:true
      },
      chain:inheritedChain
    };
  }
  return {
    effective:{
      state:'unstated',
      text:null,
      source:null,
      sourceId:null,
      sourceLevel:null,
      inherited:false,
      resolved:false
    },
    chain:[]
  };
}

function pathEntry(node, guideId, unitid, access) {
  return {
    id:`${guideId}:${node.localId}`,
    localId:node.localId,
    level:node.level ?? null,
    title:node.title ?? null,
    unitid:written(node.unitid),
    effectiveUnitid:unitid.value,
    description:writtenDescription(node),
    effectiveAccessrestrict:{...access}
  };
}

function acquisition(objects, isLeaf) {
  const acquired = objects.filter(object => object.status === 'acquired').length;
  const restricted = objects.filter(object => object.status === 'restricted').length;
  const errors = objects.filter(object => object.status === 'error').length;
  let status;
  if (acquired && (restricted || errors)) status = 'mixed';
  else if (acquired) status = 'original';
  else if (restricted) status = 'restricted';
  else if (errors) status = 'error';
  else status = isLeaf ? 'catalog' : 'container';
  return {
    status,
    holdsOriginal:acquired > 0,
    // "Catalog only" describes an item-level entry with no digital object.
    // A container with no object of its own is a hierarchy node, not a
    // catalog record of an item, and is reported as isContainer instead.
    catalogOnly:status === 'catalog',
    isContainer:!isLeaf,
    hasRestrictedObjects:restricted > 0,
    objectCount:objects.length,
    acquiredCount:acquired,
    restrictedCount:restricted,
    errorCount:errors,
    acquiredRefs:objects.filter(object => object.status === 'acquired').map(object => object.ref),
    restrictedRefs:objects.filter(object => object.status === 'restricted').map(object => object.ref),
    errorRefs:objects.filter(object => object.status === 'error').map(object => object.ref)
  };
}

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function claimObject(client, reference) {
  const outcome = {ref:reference};
  try {
    const body = await client(reference);
    // A success envelope that only reports an error is still a failed claim;
    // it is never treated as business content.
    if (body && typeof body === 'object' && !Array.isArray(body) &&
        Object.hasOwn(body,'error') && !Object.hasOwn(body,'data')) {
      outcome.status = 'error';
      outcome.available = false;
      outcome.acquired = false;
      outcome.restricted = false;
      outcome.httpStatus = 200;
      outcome.error = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
      return outcome;
    }
    const hasData = body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body,'data');
    const content = hasData ? body.data : body;
    outcome.status = 'acquired';
    outcome.available = true;
    outcome.acquired = true;
    outcome.restricted = false;
    outcome.httpStatus = 200;
    outcome.content = content;
    outcome.digest = digestOf(content);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (typeof body.owner === 'string') outcome.owner = body.owner;
      if (typeof body.version === 'string') outcome.objectVersion = body.version;
    }
  } catch (error) {
    const isSourceError = error instanceof SourceError;
    const status = isSourceError
      ? error.status
      : (error && typeof error === 'object' && Number.isInteger(error.status) ? error.status : null);
    const data = isSourceError ? error.data : (error && typeof error === 'object' ? error.data : undefined);
    // A 403 is a restricted object, not an original we managed to receive.
    outcome.status = status === 403 ? 'restricted' : 'error';
    outcome.available = false;
    outcome.acquired = false;
    outcome.restricted = status === 403;
    outcome.httpStatus = status;
    outcome.error = data && typeof data === 'object'
      ? (data.error ?? data.message ?? JSON.stringify(data))
      : (data ?? error.message);
  }
  return outcome;
}

function buildGuide(guide) {
  if (!guide || typeof guide !== 'object' || !guide.component || typeof guide.component !== 'object') {
    throw new Error('guide component required');
  }
  const rows = [];
  const ownReferences = new Map();
  const localIds = new Set();

  function visit(node, context) {
    if (typeof node.localId !== 'string' || !node.localId) throw new Error('component localId required');
    if (localIds.has(node.localId)) throw new Error(`duplicate component localId: ${node.localId}`);
    localIds.add(node.localId);

    const id = `${guide.guideId}:${node.localId}`;
    const unitid = resolveUnitid(node,context.unitid);
    if (unitid.sourceId === null && unitid.source !== null) {
      unitid.sourceId = `${guide.guideId}:${unitid.source}`;
    }
    const access = resolveAccessrestrict(node,guide.guideId,context.accessChain);
    const path = [...context.path,pathEntry(node,guide.guideId,unitid,access.effective)];
    const description = writtenDescription(node);
    const ownUnitid = written(node.unitid);
    const isLeaf = !Array.isArray(node.children) || node.children.length === 0;
    const externalGuide = externalGuideId(node);

    if (externalGuide) {
      // Following an external reference must never revisit a guide already on
      // this chain; the reference is kept as a boundary instead.
      const boundary = externalGuide === guide.guideId || context.ancestry.includes(externalGuide);
      ownReferences.set(id,[{
        declaredBy:id,
        guideId:externalGuide,
        status:boundary ? 'cycle' : 'pending',
        cycle:boundary,
        boundary:'notExpanded'
      }]);
    }

    // Only inherited values appear here. A component that wrote its own value
    // has null in the corresponding inherited slot, so written and inherited
    // context can never be confused when the guide is revised.
    const inherited = {
      unitid:unitid.inherited ? {...unitid} : null,
      accessrestrict:access.effective.inherited ? {...access.effective} : null,
      chain:access.chain
    };

    const row = {
      id,
      guideId:guide.guideId,
      version:guide.version,
      localId:node.localId,
      level:node.level ?? null,
      title:node.title ?? null,
      parentId:context.parentId,
      depth:path.length - 1,
      isLeaf,
      // Complete hierarchy path including this component. Each entry carries
      // its own written description and the restriction in force there.
      path,
      ancestors:path.slice(0,-1),
      ancestorIds:path.slice(0,-1).map(entry => entry.id),
      pathIds:path.map(entry => entry.localId),
      pathKey:`${guide.guideId}:${path.map(entry => entry.localId).join('/')}`,
      // `unitid` is the box the entry actually sits in. It may be inherited;
      // `ownUnitid` keeps the literal written value and `inheritedUnitid`
      // records which ancestor supplied it.
      unitid:unitid.value,
      ownUnitid,
      effectiveUnitid:unitid.value,
      inheritedUnitid:unitid.inherited ? {...unitid} : null,
      // Written fields only; inherited access text is never copied here.
      description,
      explicit:description,
      ownAccessrestrict:ownAccessrestrict(node),
      // Effective restriction in force for this entry, with its origin.
      access:access.effective,
      accessChain:access.chain,
      isPublic:access.effective.state === 'public',
      isRestricted:access.effective.state === 'restricted',
      isUnstated:access.effective.state === 'unstated',
      inherited,
      externalReferences:[],
      externalGuideIds:[],
      objects:[],
      acquisition:acquisition([],isLeaf),
      provenance:{
        guideId:guide.guideId,
        guideVersion:guide.version,
        pathKey:`${guide.guideId}:${path.map(entry => entry.localId).join('/')}`,
        pathIds:path.map(entry => entry.localId),
        pathTitles:path.map(entry => entry.title),
        pathLevels:path.map(entry => entry.level)
      }
    };
    // The written restriction stays verbatim, only when the component itself
    // wrote one. A blank value is preserved as written but never lifts an
    // inherited restriction; consumers of inherited wording use `access`.
    if (Object.hasOwn(node,'accessrestrict')) row.accessrestrict = node.accessrestrict;
    if (externalGuide) row.externalGuide = externalGuide;
    // Other written description fields (extent, scopecontent, physloc, ...)
    // remain at the top level unless they would shadow a resolved field.
    for (const [key,value] of Object.entries(description)) {
      if (value === null || value === '') continue;
      if (!Object.hasOwn(row,key)) row[key] = value;
    }

    const childContext = {
      path,
      parentId:id,
      accessChain:access.chain,
      unitid,
      ancestry:[...context.ancestry,guide.guideId]
    };
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child,childContext);
    }

    // Post-order preserves the original leaf-first row order while every
    // enclosing component is also exported with its own written context.
    rows.push(row);
  }

  visit(guide.component,{path:[],parentId:null,accessChain:[],unitid:null,ancestry:[]});
  return {rows,ownReferences};
}

function reaches(graph,start,goal) {
  if (start === goal) return true;
  const pending = [start];
  const seen = new Set([start]);
  while (pending.length) {
    const current = pending.pop();
    for (const next of graph.get(current) ?? []) {
      if (next === goal) return true;
      if (!seen.has(next)) {seen.add(next);pending.push(next);}
    }
  }
  return false;
}

function classifyReferences(rows, referencesByOwner, loadedGuides) {
  const graph = new Map();
  const references = [];
  for (const [ownerId,declared] of referencesByOwner) {
    const from = ownerId.slice(0,ownerId.indexOf(':'));
    for (const reference of declared) {
      references.push({reference,from});
      if (!graph.has(from)) graph.set(from,new Set());
      graph.get(from).add(reference.guideId);
    }
  }
  for (const {reference,from} of references) {
    if (reference.guideId === from) reference.status = 'cycle';
    else if (!loadedGuides.has(reference.guideId)) reference.status = 'unresolved';
    else if (reaches(graph,reference.guideId,from)) reference.status = 'cycle';
    else reference.status = 'external';
    reference.cycle = reference.status === 'cycle';
    // External guides are boundaries; their trees are never inlined here.
    reference.expanded = false;
  }

  // An external guide is a boundary, not a subtree to inline. A descendant
  // sees the references declared by its enclosing components so the boundary
  // stays visible without fetching or duplicating another guide's content.
  const byId = new Map(rows.map(row => [row.id,row]));
  for (const row of rows) {
    const scoped = [];
    const seen = new Set();
    for (const pathId of row.pathIds) {
      const owner = byId.get(`${row.guideId}:${pathId}`);
      for (const reference of referencesByOwner.get(owner?.id) ?? []) {
        const key = `${reference.declaredBy}->${reference.guideId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scoped.push({...reference,inherited:reference.declaredBy !== row.id});
      }
    }
    row.externalReferences = scoped;
    row.externalGuideIds = [...new Set(scoped.map(reference => reference.guideId))];
  }
}

export async function collect(client, options = {}) {
  const listing = await client('/guides');
  if (!Array.isArray(listing.items)) throw new Error('guide list required');

  const guides = [];
  const loadedGuides = new Set();
  for (const item of listing.items) {
    const guideId = written(item?.guideId);
    if (!guideId) throw new Error('guide id required');
    if (loadedGuides.has(guideId)) continue;
    const guide = await client(`/guides/${guideId}`);
    guides.push(buildGuide({
      ...guide,
      guideId:written(guide?.guideId) ?? guideId,
      version:written(guide?.version) ?? written(item.version)
    }));
    loadedGuides.add(guideId);
  }

  const allRows = guides.flatMap(entry => entry.rows);
  const referencesByOwner = new Map();
  for (const entry of guides) {
    for (const [ownerId,declared] of entry.ownReferences) {
      referencesByOwner.set(ownerId,declared);
    }
  }
  classifyReferences(allRows,referencesByOwner,loadedGuides);

  const rows = options.leavesOnly ? allRows.filter(row => row.isLeaf) : allRows;

  // Every entry claims only the objects it declares. A repeated declaration
  // is claimed again: the source permits re-claiming, and each entry's object
  // record is its own receipt evidence rather than a shared cache entry.
  for (const row of rows) {
    for (const reference of declaredObjects({dao:row.dao})) {
      const outcome = await claimObject(client,reference);
      const object = {...outcome,declaredBy:row.id};
      if (outcome.owner !== undefined) object.ownerMatches = outcome.owner === row.id;
      row.objects.push(object);
    }
    row.acquisition = acquisition(row.objects,row.isLeaf);
  }
  return rows;
}

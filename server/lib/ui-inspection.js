export const UI_INSPECTION_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 256,
  maxPathSegments: 64,
});

function invalid(message, details = undefined) {
  const error = new TypeError(message);
  error.code = 'INVALID_REQUEST';
  if (details !== undefined) error.details = details;
  return error;
}

function normalizePath(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > UI_INSPECTION_LIMITS.maxPathSegments) {
    throw invalid(`${field} must be a non-empty array of at most ${UI_INSPECTION_LIMITS.maxPathSegments} component ids`);
  }
  return value.map((segment, index) => {
    if (typeof segment !== 'string' || segment.trim() === '' || segment.length > 256) {
      throw invalid(`${field}[${index}] must be a non-empty component id string`);
    }
    return segment.trim();
  });
}

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function normalizeUiInspectionArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw invalid('inspection arguments must be an object');
  }
  if (typeof args.component_id !== 'string' || args.component_id.trim() === '' || args.component_id.length > 256) {
    throw invalid('component_id must be a non-empty string');
  }

  const componentId = args.component_id.trim();
  const path = normalizePath(args.path, 'path');
  const parentPath = normalizePath(args.parent_path, 'parent_path');
  if (path && parentPath) throw invalid('use either path or parent_path, not both');
  if (path && path[path.length - 1] !== componentId) {
    throw invalid('path must end with component_id', { component_id: componentId, path });
  }

  return {
    component_id: componentId,
    ...(path ? { path } : {}),
    ...(parentPath ? { parent_path: parentPath } : {}),
    max_depth: clampInteger(args.max_depth, 2, 0, UI_INSPECTION_LIMITS.maxDepth),
    max_nodes: clampInteger(args.max_nodes, 64, 1, UI_INSPECTION_LIMITS.maxNodes),
  };
}

// A tiny game-interface model used by offline tests. Production inspection is
// performed inside WH3/Lua, but this mirrors the selector/bounds contract so
// ambiguity and traversal behaviour remain regression-tested without claiming
// that a JavaScript mock proves the live UI API.
export function inspectMockUiTree(root, rawArgs = {}) {
  const args = normalizeUiInspectionArgs(rawArgs);
  const errors = [];
  if (!root) {
    return {
      found: false,
      component_id: args.component_id,
      path: null,
      parent_id: null,
      visible: null,
      position: null,
      size: null,
      text: null,
      state: null,
      child_count: null,
      children: [],
      root_size: null,
      errors: [{ code: 'NO_UI_ROOT', message: 'UI root is unavailable' }],
      truncated: false,
    };
  }

  const idOf = (node) => node?.id ?? null;
  const childrenOf = (node) => Array.isArray(node?.children) ? node.children : [];
  const direct = (node, id) => childrenOf(node).filter((child) => idOf(child) === id);
  const rootPath = idOf(root) ? [idOf(root)] : [];

  function resolveExactPath(path) {
    let node = root;
    let built = rootPath.slice();
    let start = 0;
    if (path[0] === idOf(root)) start = 1;
    for (let i = start; i < path.length; i += 1) {
      const matches = direct(node, path[i]);
      if (matches.length === 0) return { node: null, path: null, code: 'NOT_FOUND' };
      if (matches.length > 1) return { node: null, path: null, code: 'AMBIGUOUS_PATH' };
      node = matches[0];
      built.push(path[i]);
    }
    return { node, path: built };
  }

  let selected = null;
  let selectedPath = null;
  if (args.path) {
    const resolved = resolveExactPath(args.path);
    if (resolved.code) errors.push({ code: resolved.code, message: 'exact path did not resolve uniquely' });
    else {
      selected = resolved.node;
      selectedPath = resolved.path;
    }
  } else if (args.parent_path) {
    const parent = resolveExactPath(args.parent_path);
    if (parent.code) errors.push({ code: parent.code, message: 'parent_path did not resolve uniquely' });
    else {
      const matches = direct(parent.node, args.component_id);
      if (matches.length === 1) {
        selected = matches[0];
        selectedPath = [...parent.path, args.component_id];
      } else if (matches.length > 1) {
        errors.push({ code: 'AMBIGUOUS_MATCH', message: 'multiple direct children match component_id' });
      } else {
        errors.push({ code: 'NOT_FOUND', message: 'component_id was not found under parent_path' });
      }
    }
  } else {
    const stack = [{ node: root, path: rootPath }];
    const matches = [];
    const seen = new Set();
    let scanned = 0;
    while (stack.length > 0 && scanned < 4096) {
      const current = stack.pop();
      if (!current?.node || seen.has(current.node)) continue;
      seen.add(current.node);
      scanned += 1;
      if (idOf(current.node) === args.component_id) matches.push(current);
      const kids = childrenOf(current.node);
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        stack.push({ node: kids[i], path: [...current.path, idOf(kids[i])].filter(Boolean) });
      }
    }
    if (stack.length > 0) errors.push({ code: 'LOOKUP_TRUNCATED', message: 'lookup scan reached its safety bound' });
    if (matches.length === 1) {
      selected = matches[0].node;
      selectedPath = matches[0].path;
    } else if (matches.length > 1) {
      errors.push({ code: 'AMBIGUOUS_MATCH', message: 'multiple components match component_id' });
    } else if (!errors.some((entry) => entry.code === 'LOOKUP_TRUNCATED')) {
      errors.push({ code: 'NOT_FOUND', message: 'component_id was not found' });
    }
  }

  const base = {
    found: Boolean(selected),
    component_id: args.component_id,
    path: selectedPath,
    parent_id: null,
    visible: null,
    position: null,
    size: null,
    text: null,
    state: null,
    child_count: null,
    children: [],
    root_size: root.size ?? null,
    errors,
    truncated: errors.some((entry) => entry.code === 'LOOKUP_TRUNCATED'),
  };
  if (!selected) return base;

  const descendants = [];
  const queue = [{ node: selected, path: selectedPath, depth: 0, parentId: null }];
  const seen = new Set();
  let nodes = 0;
  let truncated = base.truncated;
  let selectedParentId = null;
  if (selectedPath && selectedPath.length > 1) selectedParentId = selectedPath[selectedPath.length - 2];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current?.node || seen.has(current.node)) continue;
    seen.add(current.node);
    if (nodes >= args.max_nodes) {
      truncated = true;
      break;
    }
    nodes += 1;
    if (current.depth > 0) {
      descendants.push({
        component_id: idOf(current.node),
        path: current.path,
        parent_id: current.parentId,
        visible: current.node.visible ?? null,
        position: current.node.position ?? null,
        size: current.node.size ?? null,
        text: current.node.text ?? null,
        state: current.node.state ?? null,
        child_count: childrenOf(current.node).length,
        depth: current.depth,
        errors: [],
      });
    }
    if (current.depth >= args.max_depth) {
      if (childrenOf(current.node).length > 0) truncated = true;
      continue;
    }
    for (const child of childrenOf(current.node)) {
      queue.push({
        node: child,
        path: [...current.path, idOf(child)].filter(Boolean),
        depth: current.depth + 1,
        parentId: idOf(current.node),
      });
    }
  }

  return {
    ...base,
    found: true,
    parent_id: selectedParentId,
    visible: selected.visible ?? null,
    position: selected.position ?? null,
    size: selected.size ?? null,
    text: selected.text ?? null,
    state: selected.state ?? null,
    child_count: childrenOf(selected).length,
    children: descendants,
    truncated,
  };
}

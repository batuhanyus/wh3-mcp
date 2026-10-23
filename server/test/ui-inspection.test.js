import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMockUiTree, normalizeUiInspectionArgs, UI_INSPECTION_LIMITS } from '../lib/ui-inspection.js';

const tree = {
  id: 'root', size: { width: 1920, height: 1080 }, children: [
    { id: 'left', children: [{ id: 'target', visible: true, position: { x: 10, y: 20 }, size: { width: 30, height: 40 }, children: [] }] },
    { id: 'right', children: [{ id: 'target', visible: false, children: [{ id: 'leaf', children: [] }] }] },
  ],
};

test('inspection selector rejects ambiguous exact-id matches instead of choosing one', () => {
  const result = inspectMockUiTree(tree, { component_id: 'target' });
  assert.equal(result.found, false);
  assert.equal(result.errors.some((entry) => entry.code === 'AMBIGUOUS_MATCH'), true);
});

test('parent_path and full path deterministically disambiguate a component', () => {
  const byParent = inspectMockUiTree(tree, { component_id: 'target', parent_path: ['root', 'left'] });
  assert.equal(byParent.found, true);
  assert.deepEqual(byParent.path, ['root', 'left', 'target']);
  assert.equal(byParent.parent_id, 'left');
  assert.deepEqual(byParent.position, { x: 10, y: 20 });

  const byPath = inspectMockUiTree(tree, { component_id: 'target', path: ['root', 'right', 'target'] });
  assert.equal(byPath.found, true);
  assert.equal(byPath.visible, false);
});

test('descendant traversal obeys depth and node bounds and reports truncation', () => {
  const result = inspectMockUiTree(tree, {
    component_id: 'right',
    path: ['root', 'right'],
    max_depth: 0,
    max_nodes: 9999,
  });
  assert.equal(result.found, true);
  assert.equal(result.children.length, 0);
  assert.equal(result.truncated, true);
  assert.equal(normalizeUiInspectionArgs({ component_id: 'right', max_nodes: 9999 }).max_nodes, UI_INSPECTION_LIMITS.maxNodes);
});

test('absent UI root is a typed result', () => {
  const result = inspectMockUiTree(null, { component_id: 'target' });
  assert.equal(result.found, false);
  assert.equal(result.errors[0].code, 'NO_UI_ROOT');
});

test('malformed selectors fail before transport use', () => {
  assert.throws(() => normalizeUiInspectionArgs({}), /component_id/);
  assert.throws(() => normalizeUiInspectionArgs({ component_id: 'x', path: ['root', 'other'] }), /path must end/);
  assert.throws(() => normalizeUiInspectionArgs({ component_id: 'x', path: ['root', 'x'], parent_path: ['root'] }), /either path or parent_path/);
});

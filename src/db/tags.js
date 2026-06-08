import { db } from './index.js';

const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
const selectTagId = db.prepare('SELECT id FROM tags WHERE name = ?'); // NOCASE column collation
const linkStmt = db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)');
const unlinkStmt = db.prepare('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?');

const listStmt = db.prepare(`
  SELECT t.name AS name, COUNT(pt.photo_id) AS count
  FROM tags t
  LEFT JOIN photo_tags pt ON pt.tag_id = t.id
  GROUP BY t.id
  ORDER BY count DESC, t.name ASC
`);

const photoTagsStmt = db.prepare(`
  SELECT t.name FROM photo_tags pt
  JOIN tags t ON t.id = pt.tag_id
  WHERE pt.photo_id = ?
  ORDER BY t.name ASC
`);

function getOrCreateTagId(name) {
  insertTag.run(name);
  return selectTagId.get(name).id;
}

export function listTags() {
  return listStmt.all();
}

export function getPhotoTags(photoId) {
  return photoTagsStmt.all(photoId).map((r) => r.name);
}

// Bulk add: tagNames x photoIds, creating tags as needed. Returns rows changed.
export const applyTags = db.transaction((photoIds, tagNames) => {
  const tagIds = tagNames.map(getOrCreateTagId);
  let n = 0;
  for (const pid of photoIds) for (const tid of tagIds) n += linkStmt.run(pid, tid).changes;
  return n;
});

// Bulk remove: only affects existing tags. Returns rows changed.
export const removeTags = db.transaction((photoIds, tagNames) => {
  const tagIds = tagNames.map((nm) => selectTagId.get(nm)).filter(Boolean).map((r) => r.id);
  let n = 0;
  for (const pid of photoIds) for (const tid of tagIds) n += unlinkStmt.run(pid, tid).changes;
  return n;
});

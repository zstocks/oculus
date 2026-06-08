// Compile a query AST (from parse.js) into a SQL WHERE fragment + bound params.
// The fragment is evaluated per row of `photos p`; each tag predicate becomes an
// EXISTS subquery against the photo_tags/tags join. Tag names are always bound as
// parameters, never interpolated.

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

const EXISTS_HEAD =
  'EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = p.id AND ';

function tagPredicate(node, params) {
  if (node.match === 'exact') {
    params.push(node.name); // tags.name is COLLATE NOCASE -> case-insensitive equality
    return EXISTS_HEAD + 't.name = ?)';
  }
  let pattern;
  if (node.match === 'contains') pattern = '%' + escapeLike(node.name) + '%';
  else if (node.match === 'prefix') pattern = escapeLike(node.name) + '%';
  else pattern = '%' + escapeLike(node.name); // suffix
  params.push(pattern);
  return EXISTS_HEAD + "t.name LIKE ? ESCAPE '\\')";
}

function build(node, params) {
  switch (node.type) {
    case 'tag': return tagPredicate(node, params);
    case 'not': return 'NOT (' + build(node.child, params) + ')';
    case 'and': return '(' + build(node.left, params) + ' AND ' + build(node.right, params) + ')';
    case 'or':  return '(' + build(node.left, params) + ' OR ' + build(node.right, params) + ')';
    default: throw new Error(`Unknown node type: ${node.type}`);
  }
}

// ast may be null (empty query) -> match everything.
export function compile(ast) {
  if (!ast) return { where: '1 = 1', params: [] };
  const params = [];
  const where = build(ast, params);
  return { where, params };
}

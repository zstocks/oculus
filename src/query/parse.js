// Tokenizer + recursive-descent parser for the tag query language.
//
// Grammar (lowest -> highest precedence):
//   expr := or
//   or   := and ( "OR" and )*
//   and  := not ( ("AND")? not )*        // adjacency = implicit AND, e.g. `beach sunset`
//   not  := "NOT" not | atom
//   atom := "(" or ")" | TERM
//
// A TERM is a bare word or a "quoted phrase". On bare words, a leading/trailing '*'
// selects substring matching:  beach* (prefix), *beach (suffix), *beach* (contains).
// Quote a term to match it exactly, or to include spaces / the literal words and/or/not.

export class QueryError extends Error {}

const KEYWORDS = new Set(['AND', 'OR', 'NOT']);
const BREAK = ' \t\n\r()"';

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'rparen' }); i++; continue; }

    if (c === '"') {
      i++;
      let val = '';
      while (i < n && input[i] !== '"') { val += input[i]; i++; }
      if (i >= n) throw new QueryError('Unterminated quoted term');
      i++; // consume closing quote
      tokens.push({ type: 'term', value: val, quoted: true });
      continue;
    }

    const start = i;
    while (i < n && !BREAK.includes(input[i])) i++;
    const raw = input.slice(start, i);
    const upper = raw.toUpperCase();
    if (KEYWORDS.has(upper)) tokens.push({ type: upper.toLowerCase() });
    else tokens.push({ type: 'term', value: raw, quoted: false });
  }
  return tokens;
}

function termToNode(tok) {
  if (tok.quoted) {
    const name = tok.value.trim();
    if (!name) throw new QueryError('Empty tag name');
    return { type: 'tag', match: 'exact', name };
  }
  let v = tok.value;
  const lead = v.startsWith('*');
  const trail = v.endsWith('*');
  if (lead) v = v.slice(1);
  if (trail) v = v.slice(0, -1);
  if (!v) throw new QueryError('Empty tag name');

  let match = 'exact';
  if (lead && trail) match = 'contains';
  else if (trail) match = 'prefix';
  else if (lead) match = 'suffix';
  return { type: 'tag', match, name: v };
}

// Returns an AST node, or null for an empty query (which means "match everything").
export function parse(input) {
  const tokens = tokenize(input);
  if (tokens.length === 0) return null;

  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr() {
    let node = parseAnd();
    while (peek() && peek().type === 'or') {
      next();
      node = { type: 'or', left: node, right: parseAnd() };
    }
    return node;
  }

  function parseAnd() {
    let node = parseNot();
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.type === 'and') { next(); node = { type: 'and', left: node, right: parseNot() }; continue; }
      // Implicit AND: another factor follows with no explicit operator.
      if (t.type === 'term' || t.type === 'not' || t.type === 'lparen') {
        node = { type: 'and', left: node, right: parseNot() };
        continue;
      }
      break;
    }
    return node;
  }

  function parseNot() {
    if (peek() && peek().type === 'not') { next(); return { type: 'not', child: parseNot() }; }
    return parseAtom();
  }

  function parseAtom() {
    const t = peek();
    if (!t) throw new QueryError('Unexpected end of query');
    if (t.type === 'lparen') {
      next();
      const node = parseOr();
      const close = next();
      if (!close || close.type !== 'rparen') throw new QueryError('Missing closing parenthesis');
      return node;
    }
    if (t.type === 'term') { next(); return termToNode(t); }
    throw new QueryError(`Unexpected token: ${t.type}`);
  }

  const ast = parseOr();
  if (pos < tokens.length) throw new QueryError(`Unexpected token: ${peek().type}`);
  return ast;
}

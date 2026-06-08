import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, QueryError } from '../src/query/parse.js';
import { compile } from '../src/query/compile.js';

const tag = (name, match = 'exact') => ({ type: 'tag', match, name });

test('single tag', () => {
  assert.deepEqual(parse('beach'), tag('beach'));
});

test('wildcards select match mode', () => {
  assert.deepEqual(parse('beach*'), tag('beach', 'prefix'));
  assert.deepEqual(parse('*beach'), tag('beach', 'suffix'));
  assert.deepEqual(parse('*beach*'), tag('beach', 'contains'));
});

test('quoted term is exact and may contain spaces', () => {
  assert.deepEqual(parse('"family vacation"'), tag('family vacation'));
  // quoting lets you match a tag literally named "and"
  assert.deepEqual(parse('"and"'), tag('and'));
});

test('AND / OR / NOT structure', () => {
  assert.deepEqual(parse('a AND b'), { type: 'and', left: tag('a'), right: tag('b') });
  assert.deepEqual(parse('a OR b'), { type: 'or', left: tag('a'), right: tag('b') });
  assert.deepEqual(parse('NOT a'), { type: 'not', child: tag('a') });
});

test('precedence: OR is lowest, NOT is highest', () => {
  // a OR b AND c  ==  a OR (b AND c)
  assert.deepEqual(parse('a OR b AND c'), {
    type: 'or', left: tag('a'), right: { type: 'and', left: tag('b'), right: tag('c') },
  });
  // NOT a AND b  ==  (NOT a) AND b
  assert.deepEqual(parse('NOT a AND b'), {
    type: 'and', left: { type: 'not', child: tag('a') }, right: tag('b'),
  });
});

test('parentheses override precedence', () => {
  assert.deepEqual(parse('(a OR b) AND c'), {
    type: 'and', left: { type: 'or', left: tag('a'), right: tag('b') }, right: tag('c'),
  });
});

test('adjacency is an implicit AND', () => {
  assert.deepEqual(parse('a b'), { type: 'and', left: tag('a'), right: tag('b') });
});

test('double negation', () => {
  assert.deepEqual(parse('NOT NOT a'), { type: 'not', child: { type: 'not', child: tag('a') } });
});

test('empty query parses to null (match everything)', () => {
  assert.equal(parse(''), null);
  assert.equal(parse('   '), null);
});

test('malformed queries throw QueryError', () => {
  assert.throws(() => parse('(a'), QueryError);
  assert.throws(() => parse('a )'), QueryError);
  assert.throws(() => parse('"unterminated'), QueryError);
  assert.throws(() => parse('AND a'), QueryError);
});

test('compile: exact tag -> equality, parameterized', () => {
  const { where, params } = compile(parse('beach'));
  assert.match(where, /t\.name = \?/);
  assert.deepEqual(params, ['beach']);
});

test('compile: contains -> LIKE with %wrapped% pattern', () => {
  const { where, params } = compile(parse('*beach*'));
  assert.match(where, /t\.name LIKE \? ESCAPE/);
  assert.deepEqual(params, ['%beach%']);
});

test('compile: prefix / suffix patterns', () => {
  assert.deepEqual(compile(parse('beach*')).params, ['beach%']);
  assert.deepEqual(compile(parse('*beach')).params, ['%beach']);
});

test('compile: LIKE wildcards in tag names are escaped', () => {
  assert.deepEqual(compile(parse('*50%off*')).params, ['%50\\%off%']);
});

test('compile: boolean shapes and param order', () => {
  const { where, params } = compile(parse('(beach OR ocean) AND NOT crowded'));
  assert.match(where, /OR/);
  assert.match(where, /AND NOT/);
  assert.deepEqual(params, ['beach', 'ocean', 'crowded']);
});

test('compile: empty AST matches everything', () => {
  assert.deepEqual(compile(null), { where: '1 = 1', params: [] });
});

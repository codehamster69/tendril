// Shiki/TextMate grammar for Sprout, built from the language package so highlighting tracks the real keyword list.
import { API, CONSTANTS, KEYWORDS } from '@tendril/lang';

const words = (xs: string[]) => `\\b(?:${xs.join('|')})\\b`;
const builtins = API.filter((a) => a.kind !== 'constant').map((a) => a.name);
const control = ['if', 'elif', 'else', 'while', 'repeat', 'forever', 'times', 'for', 'each', 'in', 'from', 'to', 'step', 'return', 'break', 'continue', 'pass', 'stop', 'global', 'set'];
const operators = KEYWORDS.filter((k) => ['and', 'or', 'not', 'is'].includes(k));

export const sprout = {
  name: 'sprout',
  scopeName: 'source.sprout',
  aliases: ['spr'],
  patterns: [
    { name: 'comment.line.number-sign.sprout', match: '#.*$' },
    {
      name: 'string.quoted.double.sprout', begin: '"', end: '"',
      patterns: [
        { name: 'constant.character.escape.sprout', match: '\\\\.' },
        { name: 'meta.interpolation.sprout', begin: '\\{(?!\\{)', end: '\\}', beginCaptures: { 0: { name: 'punctuation.section.interpolation.sprout' } }, endCaptures: { 0: { name: 'punctuation.section.interpolation.sprout' } }, patterns: [{ include: '$self' }] },
      ],
    },
    { name: 'string.quoted.single.sprout', begin: "'", end: "'", patterns: [{ name: 'constant.character.escape.sprout', match: '\\\\.' }] },
    { match: '\\b(define|def)\\s+([A-Za-z_]\\w*)', captures: { 1: { name: 'storage.type.function.sprout' }, 2: { name: 'entity.name.function.sprout' } } },
    { name: 'keyword.control.sprout', match: words(control) },
    { name: 'keyword.operator.logical.sprout', match: words(operators) },
    { name: 'constant.language.sprout', match: words(['true', 'false', 'none']) },
    { name: 'constant.numeric.integer.sprout', match: '\\b\\d[\\d_]*\\b' },
    { name: 'support.function.builtin.sprout', match: words(builtins) },
    { name: 'support.constant.sprout', match: words(CONSTANTS) },
    { name: 'keyword.operator.sprout', match: '==|!=|<=|>=|\\+=|-=|\\*=|[-+*/%<>=]' },
  ],
};

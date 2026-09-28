/**
 * Fidelity corpus.
 *
 * Why these are JavaScript literals and not `.md` files:
 * the fixtures deliberately carry byte-level details — CRLF line endings, a UTF-8
 * BOM, a missing trailing newline. Git's autocrlf / eol normalization rewrites those
 * on checkout, which would quietly break the very thing being tested: the suite would
 * still pass, but it would be validating a file git had already modified.
 *
 * String literals sidestep version control entirely.
 */

/** @type {{name:string, why:string, src:string}[]} */
export const fixtures = [
  {
    name: '01-emphasis-variants',
    why: 'two emphasis markers and three bullet characters: same tree, different bytes',
    src: '*star italic* and _underscore italic_\n\n**star bold** and __underscore bold__\n\n- dash item\n\n* star item\n\n+ plus item\n',
  },
  {
    name: '02-heading-styles',
    why: 'ATX and setext headings are structurally identical once parsed',
    src: '# ATX heading\n\nSetext heading\n==============\n\nAnother setext\n--------------\n\n### ATX with closing ###\n',
  },
  {
    name: '03-list-indent',
    why: '2/3/4 space and tab indentation; known to be normalized to 2 spaces',
    src: '- a\n  - two space\n- b\n   - three space\n- c\n    - four space\n- d\n\t- tab indent\n',
  },
  {
    name: '04-fence-styles',
    why: 'both fence characters plus an indented code block',
    src: '```js\nconst a = 1;\n```\n\n~~~python\nx = 1\n~~~\n\n    indented code block\n    second line\n',
  },
  {
    name: '05-raw-html-columns',
    why: 'the side-by-side column structure; must survive byte for byte',
    src: '<div class="bmd-row">\n<div class="bmd-col">\n\nLeft column, where **bold** still parses\n\n</div>\n<div class="bmd-col">\n\nRight column\n\n</div>\n</div>\n',
  },
  {
    name: '06-html-entities',
    why: 'entities are decoded at parse time and come back as raw characters',
    src: 'A &amp; B, 5 &lt; 6, &quot;quoted&quot;, &copy; 2026, &#x2713;\n',
  },
  {
    name: '07-image-in-link',
    why: 'image wrapped in a link, the common README badge shape',
    src: '[![alt text](img.png)](https://example.com)\n\n[![badge](https://img.shields.io/badge/a-b.svg)](https://example.com/x)\n',
  },
  {
    name: '08-escaped-markers',
    why: 'block markers escaped with a backslash',
    src: '\\- not a list item\n\n\\# not a heading\n\n\\> not a quote\n\n\\*not emphasis\\*\n',
  },
  {
    name: '09-footnotes',
    why: 'GFM footnotes',
    src: 'Text with a footnote[^1] and another[^note].\n\n[^1]: First footnote.\n\n[^note]: Second one.\n',
  },
  {
    name: '10-tables-alignment',
    why: 'GFM table alignment markers and column padding',
    src: '| left | center | right |\n|:-----|:------:|------:|\n| a    |   b    |     c |\n| longer cell | x | y |\n',
  },
  {
    name: '11-hard-breaks',
    why: 'two-space hard breaks; trailing whitespace is trivially stripped by accident',
    src: 'line one  \nline two after two-space break\n\nline three\\\nline four after backslash break\n',
  },
  {
    name: '12-reference-links',
    why: 'link definitions — absent on the Milkdown side, held by the splice layer',
    src: 'See [the docs][docs] and [inline](https://example.com).\n\n[docs]: https://example.com/docs "Title Here"\n',
  },
  {
    name: '13-frontmatter',
    why: 'YAML front matter must round-trip untouched',
    src: '---\ntitle: Test\ntags: [a, b]\nnested:\n  key: value\n---\n\n# Body\n',
  },
  {
    name: '14-nested-quote-list',
    why: 'nested blockquote and list indentation combinations',
    src: '> outer quote\n>\n> > nested quote\n>\n> - list in quote\n>   - deeper\n\n1. ordered\n   1. nested ordered\n2. second\n',
  },
  {
    name: '15-cjk-emoji-zwsp',
    why: 'CJK, emoji and zero-width characters: offsets are UTF-16 units, emoji are surrogate pairs',
    src: '中文段落，mixed with English.\n\nEmoji 🍼🔐📝 and a zero-width space a​b here.\n\n日本語のテキストと 한국어 mixed.\n',
  },
  {
    name: '16-crlf',
    why: 'CRLF line endings must be preserved',
    src: '# CRLF doc\r\n\r\nA paragraph.\r\n\r\n- item one\r\n- item two\r\n',
  },
  {
    name: '17-no-trailing-newline',
    why: 'no trailing newline — the thing serializers love to add back',
    src: '# No trailing newline\n\nLast line without newline',
  },
  {
    name: '18-bom',
    why: 'UTF-8 BOM: leaving it in shifts every offset by one and silently truncates nodes',
    src: '﻿# Doc with BOM\n\nBody text.\n',
  },
  {
    name: '19-blank-line-runs',
    why: 'runs of blank lines must not be collapsed',
    src: '# Heading\n\n\n\nThree blank lines above.\n\n\n\n\nFour blank lines above.\n',
  },
  {
    name: '20-thematic-and-inlinecode',
    why: 'three thematic break spellings plus backtick counting in inline code',
    src: '---\n\n***\n\n___\n\nInline `code` and ``code with ` backtick`` here.\n',
  },
  {
    name: '21-definitions-interleaved',
    why: 'link definitions interleaved with prose; must stay put across a reorder',
    src: 'First paragraph with [a link][one].\n\n[one]: https://example.com/1\n\nSecond paragraph with [another][two].\n\n[two]: https://example.com/2\n\nThird paragraph.\n',
  },
  {
    name: '22-definitions-trailing',
    why: 'the common README shape: every definition stacked at the end',
    src: '# Title\n\nSome text with [x][a] and [y][b].\n\nMore text.\n\n[a]: https://example.com/a\n[b]: https://example.com/b\n',
  },
  {
    name: '23-math',
    why: 'math is its own block type once remark-math is on: both sides must agree, or every block after it shifts',
    src: 'Inline $E=mc^2$ and $$x$$ in text.\n\n$$\na^2 + b^2 = c^2\n$$\n\nIt costs $5 and $10.\n\n$$ \\sum_{i=1}^n i $$\n\nAfter the math.\n',
  },
  {
    name: '24-toggle',
    why: 'a <details> toggle is three or more sibling mdast nodes; both sides must group them into one block',
    src: 'Before.\n\n<details>\n<summary>Click to open</summary>\n\nHidden **bold** text.\n\n- a\n- b\n\n</details>\n\n<details open>\n<summary>Open &amp; shut</summary>\n\n</details>\n\nAfter.\n',
  },
  {
    name: '25-columns',
    why: 'ADR-004 columns: html dividers with blank lines, content in between; grouped into one block on both sides',
    src: '# Two columns\n\n<div class="bmd-row">\n<div class="bmd-col">\n\nLeft *side*.\n\n```js\nx = 1\n```\n\n</div>\n<div class="bmd-col">\n\n- right\n- list\n\n</div>\n</div>\n\nAfter.\n',
  },
  {
    name: '26-containers-malformed',
    why: 'an unclosed <details> and a stray bmd-col must stay raw HTML, not swallow the rest of the file',
    src: '<details>\n<summary>Never closed</summary>\n\nText.\n\n<div class="bmd-col">\n\nStray.\n\n</div>\n\nEnd.\n',
  },
  {
    name: '27-mixed-eol',
    why: 'CRLF and LF in one file (pasted from two sources): every line must keep its own ending; it used to come back all-CRLF',
    src: '# Title\r\n\r\nWindows line\r\nUnix line\n\n- a\r\n- b\n',
  },
];

/** Look up a fixture by name. */
export const byName = (name) => fixtures.find((f) => f.name === name);

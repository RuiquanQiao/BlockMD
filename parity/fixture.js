// The parity document: one of every block and inline feature marked "must" in
// notion.json. A JS string rather than a .md file, for the same reason as
// test/fixtures.js: git's line-ending handling must not be able to rewrite it.

export const FIXTURE = `# Heading one

## Heading two

### Heading three

Plain paragraph with **bold**, _italic_, \`code\`, ~~strike~~ and a [link](https://example.com).

- bullet one
- bullet two
  - nested bullet

1. first
2. second

- [ ] open task
- [x] done task

> A plain quote

> [!TIP]
> A callout

---

\`\`\`js
const answer = 42;
\`\`\`

| Name | Value |
| ---- | ----- |
| a    | 1     |

![local image](img/dot.png)

![web image](https://ruiquanqiao.github.io/BlockMD/icon.png)

Inline math $E=mc^2$ here.

$$
a^2 + b^2 = c^2
$$
`;

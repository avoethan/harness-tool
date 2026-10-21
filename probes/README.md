# Probe library

Probes are the conventions `harness discover` knows how to count. Each one
names its sites (what is counted), its variants (the ways a site can be
written), and for the variants that can become a standard: a statement
template, a fix text and, optionally, phrases that corroborate it in written
docs. Discovery counts every probe over every file; which variant dominates,
at what share, over how many sites and packages decides whether a standard
exists and how strong it is.

```
probes/<family>/<name>.yml        one probe
probes/__tests__/<name>-test.yml  its valid/invalid cases (ast-grep's `sg test` layout)
```

`harness discover --self-test` (and the unit tests) run every case: the
ast-grep probes through `ast-grep test --skip-snapshot-tests`, the regex
probes through the harness's own runner. A probe without cases fails the
self-test.

## Engines

| engine | file shape | a site is | variants are |
| --- | --- | --- | --- |
| `ast-grep` (default) | one ast-grep rule document per variant, separated by `---`; harness fields under `metadata.harness` | a node matched by any variant's rule | the rules; a node matched by several is in all of them |
| `filename` | a single document with `engine: filename` and `variants: [{name, pattern}]` | a file matching `files`/`exclude` | regexes over the file name |
| `path` | `engine: path`, `params.target: dirname` or `src-folder` | a folder (or a file under src/) | regexes over the folder name |
| `content` | `engine: content`, `params.unit: file` or `match` | a file, or each regex match | regexes over the content |
| `subjects` | `engine: subjects` | a non-merge commit subject (last 2,000 per repo) | regexes over the subject |
| `builtin` | `engine: builtin`, `builtin: <name>` | defined in `src/discover/builtins.ts` | named in the file |

An ast-grep probe file is a valid ast-grep rule file: `ast-grep scan -r
probes/lint/eqeqeq.yml <dir>` runs it directly. Probes target TypeScript and
TSX by default; `metadata.harness.languages` adds JavaScript.

## Fields (probe level; on the first document of an ast-grep probe)

| field | meaning |
| --- | --- |
| `probe` / `id` | `<family>.<slug>`; the ledger record id stem |
| `family` | lint, format, types, naming, layout, sql, tests, errors, logging, api, async, imports, validation, ci, ... |
| `title`, `site`, `conforming` | plain words: what is counted and what counts as following it |
| `files`, `exclude` | globs relative to the repository root |
| `polarity` | `fixed` (only variants with a statement can be standards) or `either` |
| `overlapping` | variants overlap (file-name case); a standard then needs sites that only it explains |
| `declaredBy` | config that declares it: `eslint: [rule]`, `prettier: {option: {value: variant}}`, `biome`, `editorconfig`, `commitlint`, `testRunner` |
| `check` | what the standard's check is: `eslint` (with `ref`), `ast-grep`, `regex`, `config` |
| `capture` | an ast-grep metavariable whose most common text fills `{NAME}` in statements |
| `hygiene` | never a standard; occurrences of the non-default variants are reported as findings |
| `record: false` | informational only (reported, fed to the judgment bundle) |
| `formatterOwned` | folded into the formatter record when Prettier or Biome is configured |

Variant fields: `variant` (ast-grep) or `name`, `statement`, `fixText`,
`prose` (case-insensitive regexes over written sentences that corroborate
it) and `default: true` for a community default (recorded only when a config
declares it).

## Adding a probe

1. Write `probes/<family>/<name>.yml` with at least two variants (one for a
   hygiene probe) and a statement plus fix text on each variant that may
   become a standard.
2. Write `probes/__tests__/<name>-test.yml` with one document per variant id
   (`<probe>/<variant>`): `valid` cases the variant must not match, `invalid`
   cases it must match.
3. Run `harness discover --self-test`.

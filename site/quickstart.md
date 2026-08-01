# Quickstart

About five minutes. The order below is deliberate: **no step claims mehmory knows something
it can't yet know.**

## 1. Install

The CLI publishes to GitHub Packages, not npmjs.org, so npm needs to be told where the
`@elderfo` scope lives and given a GitHub token with `read:packages`:

```bash
npm config set @elderfo:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken <your-github-token>
npm install -g @elderfo/mehmory
```

The token is required even for a public package — GitHub Packages has no anonymous read.

Then install the Claude Code plugin from the marketplace. `mehmory init` prints the pinned
install command if it doesn't find the plugin already installed.

## 2. Initialize the store

```bash
mehmory init
```

Creates `~/.mehmory` (or `$MEHMORY_HOME`), a `.gitignore`, an empty `config.json`, and a git
repo. Checks your Node version and whether the plugin is installed. Running it twice is a
no-op.

## 3. Onboard from the sessions you already have

```bash
mehmory onboard          # add --dry-run to see what would be captured
```

Scans `~/.claude/projects/*/` for past Claude Code sessions in this project, distills the
recent ones into the inbox (default cap: 30 sessions / 500 KB), redacts secrets, and writes a
one-line stub `project.md`.

Never had a session in this project? Then this is the expected output, and it's exit 0, not a
failure:

```
no transcripts found — run /mehmory:onboard-session inside a Claude Code session in your project instead
```

## 4. First session — integrate

Start `claude` as usual. `SessionStart` injects `identity.md`, `project.md` and `index.md`
inside an 800-token budget, and nudges you once the inbox has enough in it to be worth
integrating.

```
/mehmory:integrate
```

This is model-driven, in-session work: it reads the inbox and `SCHEMA.md`, decides where each
fact belongs, writes pages, updates the index, and commits.

::: warning It writes outside your project directory
`~/.mehmory` is outside your repo, so Claude Code prompts for permission the first time.
Denying is safe — the entries stay in the inbox, capture keeps working through the hooks, and
the next `/mehmory:integrate` picks up where you left off.
:::

## 5. Second session — this is the one

Start a new `claude`. **Now** `project.md` carries what integrate actually wrote, not the
onboarding stub. This is the session where "it already knows my project" becomes true — not
the first one.

## 6. Anytime

```bash
mehmory search "what did we decide about auth"
mehmory status
mehmory doctor
```

`doctor` runs a fixed health-check list and prints copy-paste fixes for whatever it flags.

## Next

- Every command, flag and exit code — [CLI reference](https://github.com/elderfo/mehmory/blob/main/docs/CLI.md)
- Every config key and its real default — [Config](https://github.com/elderfo/mehmory/blob/main/docs/CONFIG.md)
- Redaction limits, what `purge` reaches, uninstall vs. delete — [Privacy](https://github.com/elderfo/mehmory/blob/main/docs/PRIVACY.md)
- An error message you want decoded — [Troubleshooting](https://github.com/elderfo/mehmory/blob/main/docs/TROUBLESHOOTING.md)

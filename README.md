# pi-goodies

Personal [pi](https://pi.dev) package: extensions, prompts, and skills.

## Install

```bash
pi install ~/Documents/Git/pi-goodies          # local, loaded in place
pi install git:github.com/<user>/pi-goodies    # from git
```

## Layout

```text
extensions/   # *.ts files or directories with index.ts
prompts/      # *.md prompt templates
skills/       # skill directories containing SKILL.md
```

## Development

```bash
npm install        # also enables the pre-commit hook (core.hooksPath)
npm run check      # typecheck + lint
npm run lint:fix   # autofix lint and formatting
```

Run `/reload` in pi after editing an extension.

# Configuration files are data: JSON and JSONC read as text, c12 dropped

- Status: accepted
- Date: 2026-10-03

## Context and problem statement

The kernel merges `~/.bytebureau/config.json`, `<project>/bytebureau.json`, `<project>/bytebureau.local.json`, `BYTEBUREAU_*` variables and flags, and a project file comes from a repository the user has just cloned. The first loader was c12. With its RC files, dotenv, environment-specific keys, `package.json`, `extends` and giget switched off it was still a code loader and a normaliser: it imported the target of a symbolic link, turned a scalar root into `{}` and dropped top-level `null` sections and `$meta` before validation, so a file the schema would have rejected passed.

## Decision

The kernel reads `bytebureau.json` or `.jsonc`, `bytebureau.local.json` or `.jsonc` and `~/.bytebureau/config.json` or `.jsonc` as text and parses it with `jsonc-parser@3.3.1` (comments and trailing commas allowed); nothing is imported or run. Of the two extensions at most one may exist per layer, and only a regular file counts: a link to a file is read, a link to nowhere is an error, a directory of that name is ignored. A syntax error names its code, line and column, and a root that is not an object is an error of its file. The merged layers are validated with `effect/Schema` (unknown keys are errors), and every issue carries a JSON pointer and the layer that holds it: the file, `env:<NAME>` for a `BYTEBUREAU_*` variable or `flag:<key>` for a flag. The `extends` of team presets from the spec is deferred to a later phase as a kernel-native feature: JSON or JSONC presets by relative path, merged as the lowest project layer, with cycle detection. The binaries are built with `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig` for the same reason: Bun would otherwise read a `.env` and run a `bunfig.toml` preload from the directory the binary starts in.

## Consequences

A configuration file can never run code, and a file that does not fit the schema is reported where it is wrong instead of being repaired silently. There are no `.ts` or `.js` config files, no dotenv loading and no remote presets, and until presets return `extends` is an unknown key. The loader is a small module the project owns and tests (`packages/kernel/src/config`) instead of a dependency to configure away.

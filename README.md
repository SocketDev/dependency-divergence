## About

This GitHub action will compare the various package managers. It can be used to see how safe swapping between package managers may be or compare performance at a glance between them.

Currently supported package managers for the action are listed in [./.github/workflows/compare.yml].

You can add it to your repository and run it on PRs with a specific label by adding the following GitHub Action:

```yaml
# ./github/workflows/compare-on-pr-label.yml
name: Run On Label

on:
    pull_request:
        types: [labeled]

jobs:
    compare:
        if: ${{ github.event.label.name == 'compare' }}
        uses: "bmeck/dependency-divergence/.github/workflows/compare.yml@main"
        with:
            managers: "bun,npm" # omit to use all possible options
            cwd: "." # change to your subdirectory in the repo as desired
```

This will produce a check that always passes but gives a summary of various information from
Package managers.

## Contributions

Enhancements and extensions within reason are welcome. Expanding to new languages are also welcome.

## Contributors

* [Socket.dev](https://socket.dev/)

## FAQ

### Why are you shipping build artifacts like `dist/` in the repo?

This increases stability and improves performance at the cost of needing to manually update things.

### Does this scan my source code?

No. It only runs the package managers and view the results of their installation using manifest files. GitHub lacks a simple way to filter what files it needs to read for actions/applications unfortunately. Workarounds require problematic levels of complexity to my knowledge.

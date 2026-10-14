#!/usr/bin/env bash
# Bring this fork up to date with vsitzmann/deckwerk, keeping our changes.
#
#   scripts/sync-upstream.sh            merge the newest upstream into `research`, test, push
#   scripts/sync-upstream.sh --no-push  the same, but leave pushing to you
#   scripts/sync-upstream.sh --keep     on a failing test, keep the merge to fix it
#                                       (default: undo it, so `research` never breaks)
#
# Remotes: `upstream` is vsitzmann/deckwerk (fetch only), `origin` is the fork.
# `main` mirrors upstream exactly; our work lives on `research`, which takes
# upstream by merge, never by rebase, so pushing it never rewrites history.
set -euo pipefail

push=true
keep=false
for arg in "$@"; do
  case "$arg" in
    --no-push) push=false ;;
    --keep) keep=true ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
branch=research

if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes. Commit or stash them first:" >&2
  git status --short >&2
  exit 1
fi

echo "==> Fetching upstream and the fork"
git fetch --quiet upstream
git fetch --quiet origin

# main is a plain mirror of upstream; it never carries our commits.
git branch --force main upstream/main >/dev/null
if $push; then git push --quiet origin upstream/main:main; fi

git switch --quiet "$branch"
before=$(git rev-parse HEAD)
new=$(git rev-list --count HEAD..upstream/main)
if [ "$new" -eq 0 ]; then
  echo "==> $branch already has every upstream commit ($(git log -1 --format='%h %s' upstream/main))"
  exit 0
fi

echo "==> $new new upstream commit(s):"
git log --oneline HEAD..upstream/main

if ! git merge --no-edit --quiet upstream/main; then
  echo >&2
  echo "Upstream conflicts with our changes in:" >&2
  git diff --name-only --diff-filter=U >&2
  git merge --abort
  echo "The merge was undone; $branch is as it was. Resolve by hand: git merge upstream/main" >&2
  exit 1
fi

if ! git diff --quiet "$before" HEAD -- package-lock.json; then
  echo "==> Dependencies changed upstream: npm ci"
  npm ci --no-audit --no-fund
fi

undo() {
  if $keep; then
    echo "Kept the merge (--keep). To undo it: git reset --hard $before" >&2
  else
    git reset --quiet --hard "$before"
    echo "The merge was undone; $branch is as it was. Re-run with --keep to fix it in place." >&2
  fi
  exit 1
}

echo "==> Typecheck"
npx tsc --noEmit -p . || { echo "Typecheck failed after the merge." >&2; undo; }

echo "==> Unit tests (npm run test:unit)"
npm run --silent test:unit || { echo "Unit tests failed after the merge." >&2; undo; }

if $push; then
  echo "==> Pushing $branch to the fork"
  git push --quiet origin "$branch"
fi
echo "==> Done: $branch now includes upstream $(git log -1 --format='%h %s' upstream/main)"

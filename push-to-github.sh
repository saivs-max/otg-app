#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Commit the current v0.66 app + Fly.io deploy files and push to GitHub.
#
# Run this on YOUR Mac (not inside Cowork), from the repo root:
#     cd ~/Downloads/otg-app
#     bash push-to-github.sh
#
# It stages everything except what's in .gitignore (so the 60 MB of *.tar.gz
# archives, web-dist/, the nested otg-app/ copy, and scratch files are skipped),
# commits, then PRINTS the push commands for you to choose from. It does NOT
# push automatically — you pick safe vs. replace-main at the end.
# ---------------------------------------------------------------------------
set -eo pipefail
cd "$(dirname "$0")"

# 1. Make sure git knows who you are (only sets these if not already configured)
git config user.name  >/dev/null 2>&1 || git config user.name  "Sai V."
git config user.email >/dev/null 2>&1 || git config user.email "sai.vs@instacart.com"

# 2. Refresh remote state (read-only) so --force-with-lease works safely later
git fetch origin --prune || true

# 3. Stage everything that isn't ignored
git add -A

# 4. Sanity check — show what's staged and flag anything large
echo
echo "=== Files staged for this commit ==="
git status -s
echo
echo "=== Anything larger than 1 MB staged? (should be nothing) ==="
git diff --cached --name-only | while read -r f; do
  if [ -f "$f" ]; then
    s=$(wc -c <"$f")
    if [ "$s" -gt 1048576 ]; then echo "  $((s/1024/1024)) MB  $f"; fi
  fi
done
echo "(if the line above is empty, you're good)"
echo

# 5. Commit
git commit -m "Caper CostWise v0.66 — app + Fly.io deploy config (Dockerfile, fly.toml, DEPLOY-FLY.md)"

cat <<'NEXT'

✅ Committed locally.

Now push — pick ONE (copy/paste it):

  # A) RECOMMENDED — make GitHub 'main' your v0.66.
  #    Replaces the obsolete "otg-app v48" placeholder on main. That old commit
  #    is NOT lost — it still lives on the existing 'flyio-new-files' branch.
  git push --force-with-lease origin HEAD:main

  # B) SAFER — push to a new branch and open a Pull Request on GitHub to review
  #    before it becomes main.
  git push origin HEAD:v0.66-deploy

NEXT

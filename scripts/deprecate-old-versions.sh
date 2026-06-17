#!/usr/bin/env bash
#
# Deprecate all previously-published @muhkoo/connect alpha versions, leaving the
# current 0.7.0-alpha.4 as the only non-deprecated release. `npm deprecate` is
# reversible (re-run with an empty message ""), unlike `npm unpublish`, which is
# permanent and breaks anyone pinned to that version — so we deprecate, not unpublish.
#
# Prereqs: `npm login` (you must be a maintainer of @muhkoo/connect), and the new
# version published first:  npm publish --tag alpha
#
#   bash scripts/deprecate-old-versions.sh
#
set -euo pipefail

MSG="Old alpha — please upgrade to the latest @muhkoo/connect (npm i @muhkoo/connect@alpha)."

OLD_VERSIONS=(
  "0.1.0-alpha.1"
  "0.1.0-alpha.2"
  "0.2.0-alpha.1"
  "0.2.0-alpha.2"
  "0.3.0-alpha.0"
  "0.4.0-alpha.1"
  "0.6.0-alpha.1"
  "0.6.0-alpha.11"
  "0.7.0-alpha.3"
)

for v in "${OLD_VERSIONS[@]}"; do
  echo "→ deprecating @muhkoo/connect@${v}"
  npm deprecate "@muhkoo/connect@${v}" "$MSG"
done

echo "✓ Deprecated ${#OLD_VERSIONS[@]} versions. 'latest'/'alpha' now point at 0.7.0-alpha.4."

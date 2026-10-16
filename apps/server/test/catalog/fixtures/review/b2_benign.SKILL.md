---
name: review-checklist
description: Reviews a diff for correctness issues and missing tests, then reports findings.
---
# Review checklist

1. Read the diff and the files it touches.
2. For each change, check: off-by-one and boundary cases, error handling at trust boundaries, and whether a test covers the new branch.
3. Report each finding as `file:line - problem - suggested fix`. Do not edit files.
4. If nothing is wrong, say so in one line.

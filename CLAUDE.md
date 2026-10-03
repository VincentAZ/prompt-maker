# Instructions for Claude

- Every commit updates the version number in `package.json`: bump the patch number (1.0.1 → 1.0.2) by default,
  the minor number (1.0.x → 1.1.0) for a notable new feature, and only bump the major number when the user says so.
  Settings shows this version, so people can say which one they run when they report a problem.
- Any new, changed or removed feature is reflected in `README.md` in the same commit.

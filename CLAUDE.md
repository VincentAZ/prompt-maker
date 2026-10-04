# Instructions for Claude

- Every commit updates the version number in `package.json`: bump the patch number (1.0.1 → 1.0.2) by default,
  the minor number (1.0.x → 1.1.0) for a notable new feature, and only bump the major number when the user says so.
  Settings shows this version, so people can say which one they run when they report a problem.
- Any new, changed or removed feature is reflected in `README.md` in the same commit.

## Who this app is for

- **Creators first**: people who make images and videos as their work or their content.
  **Image/video hobbyists second.** Creators are *less* technical than hobbyists, so build for them:
  - Results come first. What they made (renders, prompts) is big, on screen and easy to compare; settings come second.
  - Plain words, no jargon: "Very good", not "score 2"; "This session", not "cache". Explain a term the first
    time a screen uses it, or leave it out.
  - One click over a setting; a sensible default over a question. Nothing needs a terminal.
  - Help them judge and keep their best work: rating, comparing, finding it again.
- When a request could be built the hobbyist way (more knobs) or the creator way (fewer, clearer choices), pick the
  creator way and keep the knobs out of sight (a ⚙ or a fold) for those who want them.

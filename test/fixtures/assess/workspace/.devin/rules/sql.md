---
trigger: glob
globs: "**/*.sql"
---

# SQL files

Always use named parameters, never string concatenation, when writing SQL.
Keep one migration per change; name it after the table it touches.

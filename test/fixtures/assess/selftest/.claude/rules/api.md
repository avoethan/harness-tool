---
paths: ["src/routes/**"]
---

# Route handlers

Return errors as `{ error: { code, message } }` with a matching HTTP status.
Never log request bodies; they can hold passwords.
Validate input with the schema in `src/routes/schemas.js` before calling a service.

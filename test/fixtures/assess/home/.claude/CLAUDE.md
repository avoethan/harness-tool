# How I work with coding agents

I maintain small Node services in one workspace folder.

## Working style

- Prefer small commits with one logical change each.
- Explain what you changed in plain words.
- Use tabs for indentation, never spaces.
- Run the full test suite with `npm test` before every commit.

## Code rules

- Use === and !==, never == or !=.
- File names are kebab-case.
- Every new module under src/ gets a unit test under test/.

## Database

The local database runs in Docker on port 5432; every service reads
DB_HOST, DB_NAME and DB_USER from its environment. The shared test database
is called app_test and is reset by the db-helper skill.

- Apply migrations to the local test database without asking.
- Never commit secrets or `.env` files.

## Notes

- Claude Code does not support hooks, so the checks above are manual.

---
name: db-helper
description: Use when a task needs the local test database reset, seeded or inspected.
---

# Database helper

The local database runs in Docker on port 5432; every service reads
DB_HOST, DB_NAME and DB_USER from its environment. The shared test database
is called app_test and is reset by the db-helper skill.

1. Stop the service that holds a connection.
2. Reset the test database with the reset script of the service.
3. Seed it, then start the service again.

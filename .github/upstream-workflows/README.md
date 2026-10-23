# Archived upstream workflows

These workflows came from `koala73/worldmonitor` v2.11.3. They are retained as
reference outside `.github/workflows/`, so GitHub Actions does not discover or
execute them here. This includes scheduled production monitoring, Railway and
Cloudflare deployment, Convex deployment, desktop releases and package publishing.

The active fork workflow is [os0x-ci.yml](../workflows/os0x-ci.yml). It checks the
self-hosted web dashboard and does not deploy, publish, update schedules or use
production credentials.

To restore one upstream workflow, copy only that reviewed file back into
`.github/workflows/`, replace upstream repository and service targets, review its
permissions, triggers, environments and credentials, and update the CI/CD table
in `ARCHITECTURE.md`. Do not restore the directory wholesale.

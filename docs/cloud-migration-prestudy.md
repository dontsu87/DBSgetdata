# Cloud Migration Prestudy

Status: paused as a future option.

This note records the July 2026 prestudy for moving the Docomo Bike Share battery-data update flow from the Windows Task Scheduler PC to a cloud runner.

## Why This Was Investigated

The current 5-minute update depends on a local Windows PC. If that PC is powered off or unavailable, map data updates stop. Cloud execution would improve availability and reduce dependency on a single local machine.

## What Was Learned

The existing Selenium scraper reads vehicle data from an HTML table after logging into the management screen. A browserless HTTP approach was tested and reached the same vehicle ID set as the production Selenium CSV in the first comparison.

Observed comparison from the trial:

- Production Selenium CSV rows: 1288
- HTTP experiment CSV rows: 1288
- Common vehicle IDs: 1288
- Missing IDs in HTTP output: 0
- Extra IDs in HTTP output: 0

Some field differences appeared in status, port, voltage, and AT timestamp. Those fields can change between runs, so longer parallel testing would be needed before any production switch.

## Implemented Trial Assets

The following assets were added for future testing only:

- `src/api_probe.py`: sanitized Selenium network/form probe.
- `src/http_probe.py`: minimal browserless login and first vehicle-page probe.
- `src/http_scraper.py`: experimental browserless all-area scraper writing to `output/http_experimental/`.
- `src/compare_scrapers.py`: comparison tool for production Selenium CSV vs HTTP experiment CSV.
- `Dockerfile.cloudrun-http`: HTTP-only Cloud Run Jobs trial image.
- `cloudbuild.http-job.yaml`: Cloud Build config for the trial image.
- `requirements-http.txt`: reduced dependency set for the HTTP trial image.
- `docs/cloud-run-http-job.md`: Cloud Run Jobs setup and free-tier estimate notes.

The normal Selenium production path remains available and was not replaced.

## Current Recommendation

Do not proceed with production cloud migration before the noll brand/system migration planned for August 2026.

Reason: the new management screen may introduce new authentication behavior, including possible two-factor authentication. If that happens, the main engineering problem changes from runner hosting to session maintenance, reauthentication, and operational recovery. That should be solved first on the PC-based production environment.

## Future Decision Points

After the noll management screen is available, reassess:

- Whether vehicle data can still be fetched by simple HTTP form replay.
- Whether two-factor authentication is required.
- Whether long-lived sessions can be kept safely and reliably.
- Whether automatic reauthentication is allowed and practical.
- Whether the production data path should be Cloud Run, GitHub Actions, or remain PC-based.
- Whether Power BI source files should remain in OneDrive or move to R2 plus Power Automate copying.

## Safe Resume Plan

When this work resumes:

1. Keep the PC/Selenium production task running.
2. Build the noll-compatible scraper on the PC first.
3. Run any HTTP/browserless engine in parallel output only.
4. Compare row counts, vehicle ID sets, and critical fields over multiple days.
5. Only then consider switching the production engine.
6. Keep the Selenium engine as a fallback even after any switch.

## Cost Notes From The Trial

If the HTTP engine remains viable, Cloud Run Jobs may fit within the free tier at 5-minute intervals using a small allocation such as 0.25 vCPU and 512 MiB, because Cloud Run Jobs have a 60-second minimum charge per task.

Approximate 5-minute schedule estimate:

```text
8,640 executions/month * 60 seconds = 518,400 charged seconds/month
vCPU-seconds at 0.25 vCPU = 129,600/month
GiB-seconds at 512 MiB = 259,200/month
```

This was only a preliminary estimate. It must be recalculated with actual Cloud Run execution metrics after the post-noll implementation exists.